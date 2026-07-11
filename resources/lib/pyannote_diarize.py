"""
화자 분리 (pyannote.audio, MPS GPU 가속).

사용: python pyannote_diarize.py <audio_path> <output_diarize.json> <model_dir> [max_speakers]

출력 포맷: [{"start": <sec>, "end": <sec>, "speaker_id": <int>}, ...]
"""
import warnings
warnings.filterwarnings("ignore", category=UserWarning)

import json
import os
import signal
import sys
import time

# 모델은 앱 번들에 동봉된다 (resources/models/pyannote — CC-BY-4.0, © pyannoteAI).
# config.yaml이 $model/ 상대 경로로 segmentation·embedding·plda를 참조하는 자기완결
# 디렉토리라 로컬 직로드 가능. HF_HUB_OFFLINE=1로 네트워크 호출을 원천 차단 — 토큰·캐시 불필요.
os.environ["HF_HUB_OFFLINE"] = "1"

import torch
from pyannote.audio import Pipeline


def _sigint_handler(sig, frame):
    print("\n화자 분리 중단됨", file=sys.stderr)
    os._exit(130)


signal.signal(signal.SIGINT, _sigint_handler)
signal.signal(signal.SIGTERM, _sigint_handler)

if len(sys.argv) < 4:
    print("Usage: python pyannote_diarize.py <audio_path> <output.json> <model_dir> [max_speakers]", file=sys.stderr)
    sys.exit(1)

audio_path = sys.argv[1]
output_path = sys.argv[2]
model_dir = sys.argv[3]
max_speakers = int(sys.argv[4]) if len(sys.argv) > 4 else 10

# MPS (Apple Silicon GPU) 우선, 없으면 CPU
if torch.backends.mps.is_available():
    device = torch.device("mps")
    print("pyannote.audio: MPS (Metal GPU) 가속 사용", file=sys.stderr)
else:
    device = torch.device("cpu")
    print("pyannote.audio: CPU 모드 (MPS 미지원)", file=sys.stderr)

print("pyannote.audio: 모델 로딩 중 (앱 번들에서)...", file=sys.stderr)
try:
    pipeline = Pipeline.from_pretrained(model_dir)
except Exception as e:
    print(
        f"번들 화자분리 모델 로드 실패: {model_dir}\n"
        "앱이 손상되었을 수 있습니다. 앱을 다시 설치해주세요.\n"
        f"원인: {e}",
        file=sys.stderr,
    )
    sys.exit(1)
pipeline.to(device)

# community-1 기본(Fa=0.07)은 발화량 적은 화자를 옆 화자에 흡수(over-merge)한다.
# VBx Fa를 0.10으로 올려 분리한다 — 한국어 회의 녹음 기준, 0.07은 발화 적은 화자를
# 흡수해 화자 수가 모자라고, 0.10이 정답 화자 수를 회복한다. 0.20+는 화자 수는 같아도
# 발화가 한 화자로 쏠려 왜곡되므로 0.10이 적정.
# config.yaml은 gitignored 모델 번들이라 재빌드 때 덮어쓰이므로 코드에서 오버라이드.
_params = pipeline.parameters(instantiated=True)
_params["clustering"]["Fa"] = 0.10
pipeline.instantiate(_params)

# GPU 활용 극대화
if hasattr(pipeline, "_segmentation") and hasattr(pipeline._segmentation, "batch_size"):
    pipeline._segmentation.batch_size = 32
if hasattr(pipeline, "_embedding") and hasattr(pipeline._embedding, "batch_size"):
    pipeline._embedding.batch_size = 32

print("pyannote.audio: 오디오 로딩 중...", file=sys.stderr)
# 표준 라이브러리 wave로 직접 로드 — torchaudio 2.11+의 load()는 torchcodec에 위임하는데,
# torchcodec은 시스템 ffmpeg 동적 라이브러리(libavutil 등)를 dlopen해 사전 설치 없는 사용자
# 머신에서 실패한다(실측 2026-07-04). 입력은 convert 단계가 만든 16k mono PCM16 wav로
# 형식이 고정이라 stdlib로 충분하고, 디코더 계열 의존이 통째로 사라진다.
import wave

with wave.open(audio_path, "rb") as wf:
    if wf.getsampwidth() != 2:
        print(f"[오류] PCM16 wav가 아닙니다 (sampwidth={wf.getsampwidth()})", file=sys.stderr)
        sys.exit(1)
    sample_rate = wf.getframerate()
    nch = wf.getnchannels()
    frames = wf.readframes(wf.getnframes())
import numpy as np

pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
waveform = torch.from_numpy(pcm.reshape(-1, nch).T.copy())  # (channels, samples)
audio_input = {"waveform": waveform, "sample_rate": sample_rate}

# 화자 수 힌트: max_speakers를 상한으로 전달.
# attendees는 예정 참석자라 실제 발화자 수와 다를 수 있어(불참자/외부 참여자/배경 음성)
# num_speakers로 강제하면 over-split·over-merge가 발생하므로 max_speakers만 사용한다.
diarize_params = {"max_speakers": max_speakers}
print(f"pyannote.audio: 화자 수 자동 감지 (max_speakers={max_speakers})", file=sys.stderr)

print("pyannote.audio: 화자 분리 시작...", file=sys.stderr)


# 진행률 hook — 파이프라인이 배치마다 (step_name, completed/total)을 콜백한다.
# 무거운 두 단계만 퍼센트로 노출하고(같은 값 반복 억제), 앱 진행 패널이 이 라인을
# 파싱해 게이지로 표시한다(형식 변경 시 ProcessingPanel의 파서와 함께 수정).
# completed가 total을 넘는 경우가 있어(배치 경계, 실측 128/114) 100으로 클램프.
_PROGRESS_LABELS = {"segmentation": "구간 분석", "embeddings": "화자 특징 추출"}
_progress_last: dict[str, int] = {}


def _progress_hook(step_name, step_artifact, file=None, total=None, completed=None):
    label = _PROGRESS_LABELS.get(step_name)
    if label is None or not total or completed is None:
        return
    pct = min(100, completed * 100 // total)
    if _progress_last.get(step_name) == pct:
        return
    _progress_last[step_name] = pct
    print(f"pyannote.audio: {label} {pct}%", file=sys.stderr, flush=True)


start = time.time()
result = pipeline(audio_input, hook=_progress_hook, **diarize_params)
elapsed = time.time() - start
print(f"pyannote.audio: 화자 분리 완료 ({elapsed:.1f}초)", file=sys.stderr)

# 4.x DiarizeOutput 또는 3.x Annotation 대응
diarization = getattr(result, "speaker_diarization", result)

segments = []
for turn, _, speaker in diarization.itertracks(yield_label=True):
    segments.append({
        "start": round(turn.start, 2),
        "end": round(turn.end, 2),
        "speaker_id": int(speaker.replace("SPEAKER_", "")),
    })

with open(output_path, "w") as f:
    json.dump(segments, f, ensure_ascii=False, indent=2)

speakers = set(s["speaker_id"] for s in segments)
print(f"pyannote.audio: {len(segments)} segments, {len(speakers)} speakers → {output_path}",
      file=sys.stderr)

# ── 화자 합치기 제안 후보 (쌍별 임베딩 코사인 유사도) ─────────────────
# pyannote 과분할(한 사람이 여러 SPEAKER로 쪼개짐)은 천장으로 남는다. 이를 자동 병합으로
# 고치지 않고 — 두 사람을 잘못 합치면 분리 UI가 없어 영구 복구 불가 — 사용자에게 "이 두
# 화자가 같은 분인가요?"를 제안하기 위한 후보쌍만 계산한다. 자동 병합은 절대 하지 않는다.
# 화자별로 길이 ≥0.8초 세그먼트 상위 8개의 임베딩을 평균→L2정규화해 대표 벡터로 삼고,
# 쌍별 코사인 ≥0.75를 similarity 내림차순으로 speaker_similarity.json에 기록한다.
# (06-23 실측: 동일인 Kai 쌍 0.83, 그 다음 높은 다른 화자 쌍 0.55 — 깨끗한 격차)
SIMILARITY_THRESHOLD = 0.75
EMBED_MIN_DUR = 0.8
EMBED_TOP_N = 8
similarity_path = os.path.join(os.path.dirname(output_path), "speaker_similarity.json")
try:
    import numpy as np
    from pyannote.audio import Model, Inference
    from pyannote.core import Segment

    emb_model_path = os.path.join(model_dir, "embedding", "pytorch_model.bin")
    emb_inference = Inference(Model.from_pretrained(emb_model_path), window="whole")
    emb_inference.to(device)

    # 화자별 세그먼트 모으기 (raw pyannote 라벨 = SPEAKER_XX 정수 id)
    by_speaker = {}
    for s in segments:
        by_speaker.setdefault(s["speaker_id"], []).append((s["start"], s["end"]))

    speaker_vecs = {}
    for spk, segs in by_speaker.items():
        # 길이 내림차순, ≥0.8초만, 상위 8개
        long_segs = sorted(
            ((e - st, st, e) for st, e in segs if e - st >= EMBED_MIN_DUR),
            reverse=True,
        )[:EMBED_TOP_N]
        if not long_segs:
            # ≥0.8초 세그먼트가 없음 = 조용한 화자. 임베딩 근거가 부족해 신뢰할 수 없으므로
            # 스킵한다 ("짧은 유령" 후보를 자연히 후순위로 배제).
            continue
        vecs = []
        # 파일 끝 클램프 — Audio.crop은 end가 duration과 같거나 넘으면 raise한다(실측: 등호 포함).
        # 발화 중 녹음을 끊으면 마지막 세그먼트 end가 정확히 파일 끝이라 상습 재현 —
        # 예외 하나가 try 전체를 중단시켜 그 세션의 합치기 제안이 통째로 사라진다.
        duration = waveform.shape[1] / sample_rate
        for _dur, st, e in long_segs:
            # 파일 경로 대신 메모리의 파형을 넘긴다 — 경로를 주면 pyannote가 torchcodec으로
            # 다시 디코딩하려다 실패한다 (위 오디오 로딩 주 참조).
            emb = emb_inference.crop(audio_input, Segment(st, min(e, duration - 1e-3)))
            vecs.append(np.asarray(emb).reshape(-1))
        mean = np.mean(vecs, axis=0)
        speaker_vecs[spk] = mean / (np.linalg.norm(mean) + 1e-9)

    candidates = []
    ids = sorted(speaker_vecs.keys())
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            cos = float(np.dot(speaker_vecs[a], speaker_vecs[b]))
            if cos >= SIMILARITY_THRESHOLD:
                candidates.append({
                    "a": f"SPEAKER_{a:02d}",
                    "b": f"SPEAKER_{b:02d}",
                    "similarity": round(cos, 3),
                })
    candidates.sort(key=lambda c: c["similarity"], reverse=True)

    with open(similarity_path, "w") as f:
        json.dump(
            {"threshold": SIMILARITY_THRESHOLD, "candidates": candidates, "dismissed": []},
            f, ensure_ascii=False, indent=2,
        )
    print(f"pyannote.audio: 합치기 후보 {len(candidates)}쌍 → {similarity_path}", file=sys.stderr)
except Exception as e:
    # 유사도 계산 실패는 화자분리 자체를 막지 않는다 (합치기 제안은 부가 기능).
    print(f"pyannote.audio: 합치기 후보 계산 생략 ({e})", file=sys.stderr)
