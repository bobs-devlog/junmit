#!/usr/bin/env python3
"""로컬 LLM 회의록 작성 (Gemma 4 12B, MLX) — AI 구독 없는 사용자용 기본 티어.

`/meeting`의 회의록 작성을 결정론적 파이프라인으로 근사한다 (에이전트 아님):
  1) 화자 매핑 준비 — 기존 매핑 보존(재작성 시) + 녹음 힌트(결정론). LLM 제안 없음
  2) 회의록 초안 — 전사(교정본 우선)로 작성. 긴 회의(LONG_NOTE_TOKENS 초과)는 map-reduce
  3) 자기검증 패스 — 초안을 전사 전체와 대조해 시제·상태·누락 결정 교정 (실측: 확정 recall
     5/6→6/6, 상태 반전 1→0. 4B급에선 불가능했던 12B 전용 능력)
  4) 결정론 후처리 — 헤더 주입·라벨 정리·추측 병기 제거 등 (프롬프트가 아닌 코드로 보장)

모델: Gemma 4 12B (Apache 2.0) 2종 중 사용자 선택 — 표준(순수 4bit, 6.8GB, 16GB Mac) /
고품질(혼합 정밀도, 11GB, 24GB+ Mac). 선택은 `local_model` 파일(단일 진실 원천, Rust가 기록).
런타임은 mlx-vlm (Gemma 4 unified 아키텍처가 mlx-lm 정식 릴리스에 아직 없음 — 2026-07 실측).

호출: python3 local_meeting.py [session_dir]   (없으면 $APP_SESSION_DIR)
"""
import sys, os, json, re
from pathlib import Path

SPEAKER_RE = re.compile(r"SPEAKER_\d{2}")

# 실질 발화 임계 — 전사에서 [SPEAKER_XX M:SS] 마커를 뺀 발화 텍스트가 이 미만이면 사실상
# 빈 전사로 보고 회의록 생성을 건너뛴다. 무음 녹음을 escape hatch("그래도 회의록 작성하기")로
# 강제 진행한 경우 등. 12B는 빈 전사 + 제목·참석자만으로 회의 전체를 confabulate하므로
# (실측: 15초 무음 → 제목 "데이터 인사이트 세션"만 보고 SPEAKER_01~09 가짜 회의 생성),
# 프롬프트 지침이 아닌 결정론 코드로 차단한다.
# 스코프 주의 — 이 임계는 "빈 전사" 그물이지 환각 필터가 아니다. 문자 수로는 환각과 진짜
# 발화를 못 가른다("시청해주셔서 감사합니다" 류 크레딧 환각은 15자 초과). 환각 방어는 상류가
# 담당: transcribe.sh no_speech 볼륨 게이트(무음이면 프론트가 회의록 자체를 skip)+ whisper-parse
# 무음구간/크레딧 denylist 필터. 여기까지 오는 건 사용자가 escape hatch로 강제 진행한 경우뿐.
MIN_TRANSCRIPT_CHARS = 15
TRANSCRIPT_MARKER_RE = re.compile(r"\[SPEAKER_\d{2}\s+\d+:\d{2}\]")


def transcript_speech(raw: str) -> str:
    """전사에서 [SPEAKER_XX M:SS] 마커를 제거한 실제 발화 텍스트(공백 정규화)."""
    return re.sub(r"\s+", " ", TRANSCRIPT_MARKER_RE.sub("", raw)).strip()

APP_DATA = Path.home() / "Library/Application Support/app.junmit"
TEMPLATES = APP_DATA / "templates"
VOCAB_FILE = APP_DATA / "vocabulary.json"
MODEL_DIR = APP_DATA / "models" / "mlx"
RULES_FILE = Path(__file__).parent / "local_rules.md"

# 긴 회의 임계 — 실측(2026-07): 소형 모델은 전사가 ~10k 토큰을 넘으면 단일샷에서 요약을 포기하고
# 축자 받아쓰기로 퇴행. 구간 요약(map)이 압축을 강제한다. 12B에서도 단일샷 확대는 기각됨
# (전역 연결 이점은 자기검증 패스가 더 안전하게 제공, lost-in-the-middle 재발 확인).
# 주의: 이 임계는 전사 토큰만 세고 유형 가이드 본문은 고정 오버헤드로 별도 얹힘 — 9k 실측은
# 2026-07 시드 개정(note 가이드 +~0.5k 토큰) 이전 기준이며, 사용자 편집 가이드는 더 길 수 있음.
# 메모리 봉투 재실측 시 가이드 오버헤드 포함해 측정할 것.
LONG_NOTE_TOKENS = 9000
NOTE_MAX_TOKENS = 4000
# 자기검증 패스의 전사 입력 상한 — 초과 시 앞 3k + 뒤 8k만 사용(결정·정리는 후반에
# 몰리는 실측 경향, 앞부분은 초안이 이미 커버). 주의: 검증 프롬프트 전체는 전사(≤11k) +
# 초안(≤4k) + 지시문이라 최악 ~15k — 16GB 표준판의 9k 실측(피크 9.4GB)을 넘는 구간은
# 미실측이며, Metal 상한 초과 시 verify_note의 except가 초안 유지로 폴백해 하한을 보장한다.
VERIFY_HEAD_TOKENS = 3000
VERIFY_TAIL_TOKENS = 8000


def local_model_name():
    """선택된 로컬 모델 (models/mlx/ 하위 디렉토리명). Rust cmd_set_local_model이 기록하는
    `local_model` 파일이 단일 진실 원천. env LOCAL_MODEL_NAME은 실험용 override."""
    env = os.environ.get("LOCAL_MODEL_NAME")
    if env:
        return env
    try:
        v = (APP_DATA / "local_model").read_text().strip()
        if v:
            return v
    except Exception:
        pass
    return "gemma-4-12b-4bit"  # 표준판 기본


MODEL_NAME = local_model_name()


# ---- 앱 신호 (signal.sh와 동일 규약: tty면 OSC 7777, 아니면 신호파일 append) ----
def signal(payload: dict):
    s = json.dumps(payload, ensure_ascii=False)
    try:
        if sys.stdout.isatty():
            sys.stdout.write(f"\033]7777;{s}\007")
            sys.stdout.flush()
            return
    except Exception:
        pass
    sig_dir = os.environ.get("APP_SIGNAL_DIR") or os.environ.get("TMPDIR") or "/tmp"
    try:
        with open(os.path.join(sig_dir, ".app-signal"), "a") as f:
            f.write(s + "\n")
    except Exception:
        pass


def emit(msg=""):
    print(msg, flush=True)


def fail(msg):
    emit(f"\n❌ {msg}")
    signal({"type": "phase_error", "msg": msg})
    sys.exit(1)


def load_rules():
    try:
        return RULES_FILE.read_text().split("아래 규칙을 지켜", 1)[-1]
    except Exception:
        return ""


def load_vocab():
    """용어 사전(vocabulary.json) — 교정 힌트. `{ "terms": [...] }`, 문자열 또는 {term}."""
    try:
        data = json.loads(VOCAB_FILE.read_text())
        terms = []
        for t in data.get("terms", []):
            terms.append(t if isinstance(t, str) else str(t.get("term", "")))
        return ", ".join(x for x in terms if x)[:8000]
    except Exception:
        return ""


# ---- 공용 생성 헬퍼 (mlx-vlm) ----
def make_generator():
    from mlx_vlm import load, stream_generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
    import mlx.core as mx

    model_path = str(MODEL_DIR / MODEL_NAME)
    model, processor = load(model_path)
    config = load_config(model_path)
    tok = processor.tokenizer if hasattr(processor, "tokenizer") else processor

    # 주: 생성 가속·메모리 옵션을 실측 후 의도적으로 켜지 않는다 —
    #   kv_bits(KV 양자화): Gemma 4 슬라이딩 윈도우 레이어에서 "RotatingKVCache Quantization
    #     NYI" 크래시 (트리거 조건이 컨텍스트 길이에 따라 비결정적).
    #   MTP drafter(speculative decoding): 파이프라인 이득 ~11%뿐인데, 켠 실행에서 화자 라벨
    #     장식 배정·상태 반전 등 품질 열화가 2/3 세션에서 재현 (repetition penalty·온도 샘플링과
    #     결합 시 분포 보존이 깨지는 것으로 추정) — 끄면 일관 양호.
    def gen(system, user, max_tokens, temp, echo=False):
        # Gemma는 system 턴을 첫 user 턴에 병합하는 관례 — 실측 검증된 방식으로 합쳐 전달.
        prompt = apply_chat_template(processor, config, system + "\n\n" + user, num_images=0)
        mx.reset_peak_memory()
        text = ""
        for chunk in stream_generate(model, processor, prompt, max_tokens=max_tokens,
                                     temperature=temp, top_p=0.95,
                                     repetition_penalty=1.15, repetition_context_size=256):
            piece = chunk.text if hasattr(chunk, "text") else str(chunk)
            text += piece
            if echo:
                # 원문을 그대로 흘리지 않는다(회의록은 앱 탭에 표시됨). 진행 카운터만 갱신.
                sys.stdout.write(f"\r   작성 중… {len(text)}자")
                sys.stdout.flush()
        if echo:
            # 진행 카운터 마무리 — TTY면 지우고, 파이프(앱 실행)면 줄만 닫는다.
            # 파이프에서 공백 지우기를 쓰면 Rust flush_line이 24칸 공백을 한 줄로 흘린다.
            sys.stdout.write("\r" + " " * 24 + "\r" if sys.stdout.isatty() else "\n")
            sys.stdout.flush()
        # 한도 절단 감지 — 문장 중간에 끊긴 마지막 줄은 버린다(불완전 문장 노출 방지).
        try:
            if len(tok.encode(text)) >= max_tokens - 2 and "\n" in text:
                text = text.rsplit("\n", 1)[0]
        except Exception:
            pass
        return text.strip()

    return gen, tok


def budget_transcript(tok, raw):
    """자기검증 입력용 전사 — 메모리 예산 내로 자르되 결정이 몰리는 후반을 보존."""
    ids = tok.encode(raw)
    limit = VERIFY_HEAD_TOKENS + VERIFY_TAIL_TOKENS
    if len(ids) <= limit:
        return raw
    head = tok.decode(ids[:VERIFY_HEAD_TOKENS])
    tail = tok.decode(ids[-VERIFY_TAIL_TOKENS:])
    return head + "\n…(중략)…\n" + tail


# ---- 긴 회의 map-reduce — 절단 대신 구간별 요약 후 통합 ----
MAP_SYS = (
    "당신은 회의 구간 요약자입니다. 해당 구간의 핵심(논의 요점·결정·할 일)만 항목으로 뽑고, "
    "출석·인사·잡담은 제외합니다. 전사에 없는 내용은 만들지 않습니다. "
    "합의가 명시된 것만 '결정'으로 표시하고(고민·보류는 보류로), 예정/완료 상태를 전사 그대로 유지합니다."
)


def _chunk_by_tokens(tok, text, budget):
    chunks, cur, cur_tok = [], [], 0
    for ln in text.splitlines():
        t = len(tok.encode(ln)) + 1
        if cur and cur_tok + t > budget:
            chunks.append("\n".join(cur))
            cur, cur_tok = [], 0
        cur.append(ln)
        cur_tok += t
    if cur:
        chunks.append("\n".join(cur))
    return chunks


def write_note_mapreduce(gen, tok, session, raw, attendees):
    """긴 회의 — 전사를 구간으로 나눠 각 요약(map) 후, 요약들을 통합해 회의록 작성(reduce).
    절단으로 뒷부분을 버리지 않고 전체를 커버한다. 구간 경계에서 생기는 손실은
    자기검증 패스(전사 대조)가 보강한다."""
    chunks = _chunk_by_tokens(tok, raw, 8000)
    memos = user_memos(session)
    memo_line = ""
    if memos:
        # 사용자 메모 앵커 — 메모가 가리키는 논의는 map 단계에서 살아남아야 reduce가 반영할 수 있다.
        memo_line = ("- 다음 사용자 메모와 관련된 논의가 이 구간에 있으면 반드시 포함:\n  "
                     + "\n  ".join(memos) + "\n")
    partials = []
    for i, ch in enumerate(chunks):
        emit(f"   긴 회의 — 구간 {i + 1}/{len(chunks)} 요약 중…")
        user = (
            "아래 회의 전사 구간의 핵심을 간결한 항목으로 정리하세요.\n"
            "- 논의 요점·결정·할 일 중심. 출석·인사·잡담 제외.\n"
            f"{memo_line}"
            "- 명시적으로 합의된 것만 '결정:'으로, 결론 없이 미룬 것은 '보류:'로 표시.\n"
            "- 예정/진행 중/완료 상태를 전사 그대로 유지(예정을 완료로 바꾸지 말 것).\n"
            "- 발화자는 SPEAKER_XX 라벨 유지(이름 추측 금지). 누가 말했는지 불확실하면 라벨 생략. "
            "전사에 없는 내용 금지.\n"
            "- 항목 목록만 출력(설명·머리말 금지).\n\n"
            f"참석자: {attendees}\n\n[전사 구간]\n{ch}"
        )
        try:
            partials.append(gen(MAP_SYS, user, max_tokens=1500, temp=0.25))
        except Exception:
            pass
    merged = "\n\n".join(p for p in partials if p)
    if not merged.strip():
        return ""
    emit("   구간 요약을 모아 회의록 작성 중…")
    try:
        note = gen(NOTE_SYS, build_note_prompt(session, merged),
                   max_tokens=NOTE_MAX_TOKENS, temp=0.25, echo=True)
    except Exception:
        return clean_output(merged)
    return clean_output(note)


# ---- 자기검증 패스 — 초안을 전사와 대조해 교정 (오타 교정 겸함) ----
# 실측(2026-07): +50~90초로 확정 recall 5/6→6/6, 상태 반전 1→0. "미해결 삭제 금지" 제약이
# 없으면 검증이 확신 없는 항목을 깎는 부작용(이중 스크롤 소실 실측) — 반드시 유지.
VERIFY_SYS = (
    "당신은 회의록 검증자입니다. 회의록 초안을 전사와 대조해 오류만 바로잡습니다. "
    "새로 지어내지 않고, 전사에 근거한 수정만 합니다."
)


def verify_note(gen, tok, note, transcript, vocab, memos=None):
    v = f"\n- 다음 용어와 비슷하면 그 용어로 교정: {vocab}" if vocab else ""
    m = ""
    if memos:
        m = ("\n- 다음 사용자 메모(녹음 중 표시)가 가리키는 논의가 초안에 빠졌으면 전사에서 찾아 추가:\n  "
             + "\n  ".join(memos))
    user = (
        "아래 [회의록 초안]을 [전사]와 대조해 다음 기준으로만 수정한 최종본을 출력하세요.\n"
        "- 전사와 다른 사실·수치·시제·상태(예정/진행/완료, 보류/확정)를 전사대로 바로잡기.\n"
        "- 전사에서 명시적으로 정해진 결정·할 일·담당(SPEAKER_XX)이 초안에 빠졌으면 추가하기."
        f"{m}\n"
        "- 초안의 '결정' 항목 각각에 대해: 전사에서 합의가 선언된 발화를 찾을 수 없으면 보류로 바꾸거나 삭제하기. "
        "특히 담당 배정(누가 무엇을 맡음)은 전사에 그 배정 발화가 실제로 있을 때만 남기기.\n"
        "- 초안의 화자 라벨(SPEAKER_XX)이 전사의 실제 발화자와 다르면 라벨을 바로잡거나 제거하기.\n"
        "- 전사에 근거 없는 내용은 삭제하기.\n"
        "- 미해결·보류 항목은 삭제하지 말 것 — 상태 표기만 교정.\n"
        "- 초안의 섹션 구조·형식·화자 라벨(SPEAKER_XX)은 유지. 참석자 이름을 화자에 추측해 붙이지 말 것.\n"
        f"- 오타·음성인식 오인식 교정(예: '재유청'→'재요청').{v}\n"
        "- 설명·머리말 없이 수정된 회의록 전체만 출력.\n\n"
        f"[전사]\n{budget_transcript(tok, transcript)}\n\n[회의록 초안]\n{note}"
    )
    try:
        # echo=True — 50~90초 걸리는 단계라 카운터 없이는 멈춘 것처럼 보인다.
        # max_tokens는 초안 상한(NOTE_MAX_TOKENS)보다 여유 있게 — 검증 출력이 초안보다
        # 짧게 잘리면 뒷섹션 유실이 0.5 길이 안전망을 통과해 조용히 채택된다.
        out = gen(VERIFY_SYS, user, max_tokens=NOTE_MAX_TOKENS + 500, temp=0.2, echo=True)
        out = clean_output(out)
        # 안전망: 결과가 너무 짧으면(붕괴·과삭제) 초안 유지
        return out if len(out.strip()) >= 0.5 * len(note.strip()) else note
    except Exception:
        return note


# ---- 화자 매핑 — 기존 매핑 보존 + 녹음 힌트(결정론). LLM 제안은 제거됨 ----
# 회의록은 SPEAKER_XX를 유지하고(오귀속 방지), 앱 UI는 speaker_mapping.json으로 이름을 치환한다.
# 실패해도 모든 SPEAKER에 빈 엔트리를 남겨(→UI "참석자 N") raw SPEAKER_XX 노출을 막는다.
TIME_RE = re.compile(r"\[(SPEAKER_\d{2})\s+(\d+):(\d{2})\]")


def hints_mapping(session, transcript):
    """녹음 중 사용자가 찍은 화자 힌트(notes.json) → {SPEAKER_XX: name} (결정론적, 최우선).
    각 힌트 시각 t의 [t-10, t+2]초 윈도우에서 지배 화자를 그 이름으로 본다."""
    try:
        notes = json.loads((session / "notes.json").read_text()).get("notes", [])
    except Exception:
        return {}
    hints = [(int(n.get("t", 0)), n.get("speaker", "").strip())
             for n in notes if n.get("kind") == "speaker" and n.get("speaker")]
    if not hints:
        return {}
    lines = [(int(mm) * 60 + int(ss), sp) for (sp, mm, ss) in TIME_RE.findall(transcript)]
    res = {}
    for t, name in hints:
        window = [sp for (sec, sp) in lines if t - 10 <= sec <= t + 2]
        if window:
            res[max(set(window), key=window.count)] = name
    return res


def resolve_speakers(transcript, attendees_list, session):
    """speaker_mapping 엔트리 생성 — 우선순위:
    ① 기존 매핑의 이름(재작성 시 사용자 지정 보존 — claude 재작성 모드가 1단계 skip으로
       매핑을 유지하는 것과 등가. 덮어쓰면 사용자가 지정한 이름이 전량 소실된다)
    ② 녹음 힌트(결정론, 녹음 화면 참석자 칩 탭) ③ 나머지는 빈 이름("참석자 N" → 앱에서 지정/수정).
    주: LLM 화자 제안(고품질판 전용, +~1.5분)은 2026-07 실측 후 제거 — 영문 닉네임 조직 ×
    한국어 회의에선 이름 단서가 전사에서 살아남지 못해 채택 0/2, 기대값이 비용을 못 넘음.
    전사에 이름이 살아나는 개선(참석자 이름의 용어 사전 등록)이 확인되면 재도입 검토."""
    speakers = sorted(set(SPEAKER_RE.findall(transcript)))
    entries = {s: {"name": "", "reason": ""} for s in speakers}
    try:
        prev = json.loads((session / "speaker_mapping.json").read_text())["speaker_mapping"]
        for sp, v in prev.items():
            if sp in entries and (v.get("name") or "").strip():
                entries[sp] = {"name": v["name"].strip(), "reason": v.get("reason", "")}
    except Exception:
        pass
    for sp, name in hints_mapping(session, transcript).items():
        if name in attendees_list and sp in entries and not entries[sp]["name"]:
            entries[sp] = {"name": name, "reason": "녹음 중 화자 힌트"}
    return entries


def write_speaker_mapping(session, entries):
    atomic_write(session / "speaker_mapping.json",
                 json.dumps({"speaker_mapping": entries}, ensure_ascii=False, indent=2))


# ---- 회의록 작성 ----
NOTE_SYS = (
    "당신은 한국어 회의록 작성자입니다. [작성 가이드]의 형식·섹션 구성을 따르고, 아래 [필수 규칙]을 지켜 "
    "[전사]를 바탕으로 마크다운 회의록을 쓰세요. 서두·설명·회의 제목(H1) 없이 본문만 출력합니다.\n\n"
    "[필수 규칙 — 가이드보다 우선]\n"
    "- 회의에 등장하지 않은 정보(날짜·수치·문서명·코드 표기·담당자·할 일)를 지어내지 마세요. "
    "Action Items·향후 일정은 회의에서 명시적으로 정해진 것만 적고, 논의를 그럴듯한 할 일로 부풀리지 마세요.\n"
    "- **'결정'은 회의에서 합의가 명시적으로 선언된 것만 쓰세요.** 개인 의견·불만·고민·\"더 고민해 보자\"는 "
    "결정이 아닙니다 — 합의가 없으면 보류/미결로 적으세요. 결정·할 일을 실제보다 확정적으로 쓰지 마세요.\n"
    "- **예정/진행 중/완료 상태와 시제를 전사 그대로 유지하세요.** 예정된 일을 완료된 것처럼, "
    "완료된 일을 예정처럼 바꿔 쓰지 마세요.\n"
    "- **발언 원문을 여러 문장 그대로 옮겨 적지 마세요.** 긴 발언도 핵심만 1~2줄로 압축합니다 "
    "(가이드가 축어록·원문 인용을 명시 요구할 때만 예외).\n"
    "- **화자는 발표자 포함 모두 SPEAKER_XX 라벨로만 표기하세요.** 참석자 이름을 발언·담당자·발표자에 "
    "추측해 붙이거나 괄호로 병기하지 마세요. 화자 이름은 앱이 매핑으로 자동 치환합니다 "
    "(예: `**SPEAKER_03**: …`; 가이드에 발표자 필드가 있으면 `발표자: SPEAKER_02`처럼 라벨로, 특정 못 하면 그 줄 생략).\n"
    "- **화자 라벨은 그 발언이 정말 그 화자의 것일 때만 붙이세요.** 여러 사람의 발언을 한 화자 라벨 아래 "
    "합치지 마세요. 누가 말했는지 불확실하면 라벨 없이 내용만 적으세요 (틀린 귀속보다 낫습니다).\n"
    "- 상단 `- 참석자:` 줄은 [회의 정보]의 참석자 명단(실명)을 평문으로 씁니다 (예: `- 참석자: Bobs, Darin`. @ 접두 금지).\n"
    "- Action Items 담당자는 `@SPEAKER_XX`만 쓰세요(이름 추측 금지). 불분명하면 담당자 없이 할 일만.\n"
    "- [회의 정보] 참석자 명단에 없는 사람 이름을 만들지 마세요.\n"
    "- 반드시 한국어로만 작성하세요(한자·외국 문자 금지). 뜻이 불분명한 단어에 '(병?)' 같은 추측 주석 금지.\n"
    "- 가이드의 `{중괄호}` 표기는 채워 넣는 자리표시일 뿐입니다 — 출력에 `{`·`}`를 남기지 마세요.\n\n"
    "[가이드가 정하는 것 — 가이드를 따르세요]\n"
    "- 섹션 구성·형식은 [작성 가이드]를 따릅니다.\n"
    "- 발언을 '요점 압축'할지 '원문 그대로 인용(축어록)'할지: 가이드가 원문 인용·축어록을 요구하면 그대로 옮기고, "
    "별다른 요구가 없으면 요점만 압축합니다.\n"
    "- 출석 확인·인사 같은 절차적 잡담은, 가이드가 전체 기록을 요구하지 않는 한 회의록에 넣지 않습니다."
)


# ---- 회의 유형 자동 분류 (type=auto·가이드 부재 시) ----
# Claude 경로의 "frontmatter summary 매칭"을 짧은 생성 1회로 근사. 실패·불일치는 자유 구성 폴백.
CLASSIFY_SYS = (
    "당신은 회의 유형 분류기입니다. 전사 첫 부분을 보고 가장 맞는 유형 하나의 이름만 출력합니다."
)
_RESOLVED_TYPE = None  # main()이 1회 결정 — build_note_prompt(map-reduce 경로 포함)가 공유


def template_candidates():
    """templates/*.md의 frontmatter(name=파일명, label, summary) 목록."""
    cands = []
    for p in sorted(TEMPLATES.glob("*.md")):
        try:
            m = re.match(r"^---\n(.*?)\n---", p.read_text(), re.S)
        except Exception:
            continue
        if not m:
            continue
        fm = m.group(1)
        lm_ = re.search(r"^label:\s*(.+)$", fm, re.M)
        sm = re.search(r"^summary:\s*\|\n((?:[ \t]+\S.*\n?)+)", fm, re.M)
        summary = re.sub(r"^[ \t]+", "", sm.group(1), flags=re.M).replace("\n", " ").strip() if sm else ""
        cands.append((p.stem, lm_.group(1).strip() if lm_ else p.stem, summary))
    return cands


def classify_type(gen, tok, transcript):
    """유형 자동 판별 — 후보 이름 그대로 답할 때만 채택(그 외·none은 자유 구성)."""
    cands = template_candidates()
    if not cands:
        return None
    head = tok.decode(tok.encode(transcript)[:2500])
    listing = "\n".join(f"- {n}: {label} — {summary}" for n, label, summary in cands)
    user = (
        "아래 회의 전사의 첫 부분을 읽고, 다음 유형 중 가장 맞는 것 **하나의 이름만** 출력하세요.\n"
        "어느 유형에도 맞지 않으면 none 이라고만 출력하세요. 설명 금지.\n\n"
        f"[유형 후보]\n{listing}\n\n[전사 첫 부분]\n{head}"
    )
    try:
        out = gen(CLASSIFY_SYS, user, max_tokens=12, temp=0.1)
    except Exception:
        return None
    ans = out.strip().split()[0].strip("`\"'.,") if out.strip() else ""
    return ans if any(ans == n for n, _, _ in cands) else None


def user_memos(session):
    """녹음 중 사용자가 남긴 자유 메모(notes.json kind=text) — Granola식 앵커.
    사용자가 중요하다고 표시한 신호이므로, 초안이 해당 내용을 반드시 다루게 한다."""
    try:
        notes = json.loads((session / "notes.json").read_text()).get("notes", [])
    except Exception:
        return []
    out = []
    for n in notes:
        if n.get("kind") == "text" and n.get("text", "").strip():
            t = int(n.get("t", 0))
            out.append(f"- [{t // 60}:{t % 60:02d}] {n['text'].strip()}")
    return out


def build_note_prompt(session, transcript):
    meta = json.loads((session / "meeting.json").read_text())
    mtype = _RESOLVED_TYPE or meta.get("type", "auto")
    tpl_path = TEMPLATES / f"{mtype}.md"
    if tpl_path.exists():
        template = tpl_path.read_text().split("## 예시 회의록")[0].rstrip()
    else:
        template = "(지정 유형 없음 — 회의 성격에 맞춰 자유 구성)"
    attendees = ", ".join(meta.get("attendees", [])) or "-"
    memos = user_memos(session)
    memo_block = ""
    if memos:
        memo_block = (
            "[사용자 메모 — 녹음 중 참석자가 중요하다고 표시한 지점]\n"
            "아래 각 메모가 가리키는 내용(표기 시각 부근의 논의)을 회의록에 반드시 반영하세요. "
            "메모 자체를 그대로 옮기지 말고, 해당 논의를 전사에서 찾아 정리하세요.\n"
            + "\n".join(memos) + "\n\n"
        )
    user = (
        f"[회의 정보]\n제목: {meta.get('title','')}\n날짜: {meta.get('date','')}\n"
        f"참석자: {attendees}\n\n"
        f"[작성 가이드]\n{template}\n\n"
        f"[규칙]\n{load_rules()}\n\n"
        f"{memo_block}"
        f"[전사]\n{transcript}\n\n"
        f"위 가이드·규칙에 따라 '{meta.get('title','')}' 회의록을 작성하세요."
    )
    return user


# 한자 + 일본어 가나 — 한국어 회의록에 불필요한 문자 런. 소형 모델이 간혹 섞는다(실측: "ために").
CJK_RUN = re.compile(r"[一-鿿぀-ヿ]+")


def clean_output(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3].rstrip()
    # 모델이 습관적으로 붙이는 "[회의록]" 머리말 제거 (Gemma 실측)
    t = re.sub(r"^\[회의록\]\s*\n", "", t)
    t = CJK_RUN.sub("", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"[ \t]+([,.])", r"\1", t)
    return dedup_lines(t) + "\n"


def dedup_lines(text: str) -> str:
    """반복 붕괴/구간 병합 중복 안전망.
    - 실질 내용 줄(>20자): 전역 중복 제거(map-reduce가 겹치는 요약을 합칠 때의 중복 차단).
    - 짧은 줄(헤더·"(없음)" 등): 최근 8줄 내 중복만(정상 반복 문구 오제거 방지)."""
    out, recent, seen = [], [], set()
    for line in text.split("\n"):
        s = line.strip()
        # "(없음)"은 면제 — 규칙(local_rules)이 빈 섹션마다 요구하는 정당한 반복이라
        # 중복 제거하면 헤더만 남는다 (짧은 회의에서 결정·향후 일정이 연달아 빔).
        if s and "(없음)" not in s:
            if len(s) > 20:
                if s in seen:
                    continue
                seen.add(s)
            elif s in recent:
                continue
        out.append(line)
        if s:
            recent.append(s)
            if len(recent) > 8:
                recent.pop(0)
    return "\n".join(out)


def ensure_header(note, meta):
    """헤더(날짜·참석자) 결정론 주입 — 자기검증 패스가 헤더를 깎는 부작용(실측) 방어.
    - 헤더 영역(첫 섹션 제목 이전, 헤딩이 아예 없는 출력 방어로 최대 앞 10줄)의
      날짜·참석자 줄은 무조건 제거 후 meeting.json 기반으로 재생성.
    - 본문 중간의 참석자 줄은 헤더 에코(실측: 명단이 본문에 복제됨)일 때만 제거 —
      @멘션 또는 실제 참석자 이름이 들어 있는 줄. "참석자: 5명으로 늘리기로 결정" 같은
      내용 불릿과 "- 날짜: 미정(다음 회의에서 확정)" 같은 본문 날짜 불릿은 보존."""
    names = [a for a in meta.get("attendees", []) if a]
    meta_re = re.compile(r"^\s*-?\s*\*{0,2}(날짜|참석자)\*{0,2}\s*:")
    att_re = re.compile(r"^\s*-?\s*\*{0,2}참석자\*{0,2}\s*:(.*)$")
    body_lines, in_body = [], False
    for i, ln in enumerate(note.split("\n")):
        if i >= 10 or ln.lstrip().startswith("#"):
            in_body = True
        if not in_body and meta_re.match(ln):
            continue
        m = att_re.match(ln)
        if m and ("@" in m.group(1) or any(n in m.group(1) for n in names)):
            continue
        body_lines.append(ln)
    body = "\n".join(body_lines).lstrip("\n")
    attendees = ", ".join(a for a in meta.get("attendees", []) if a)
    header = f"- 날짜: {meta.get('date', '')}"
    header += f"\n- 참석자: {attendees or '-'}"
    return f"{header}\n\n{body}"


def post_process_note(note):
    """결정론적 마무리 — 아키텍처 규칙만 보장(스타일은 가이드에 위임).
    ① 발표자 줄: `SPEAKER_XX`면 유지(앱이 매핑 치환), 미확인·이름 등이면 제거,
       본문 `발표자: 내용` 라벨은 벗기고 내용 유지.
    ② Action Item 줄의 @SPEAKER_XX 외 담당자 멘션(@이름) 전부 제거(이름 추측 금지).
    ③ 템플릿 리터럴 잔존({중괄호}·번호 없는 SPEAKER_XX 라벨) 정리 + 추측 병기 주석 제거.
    참석자 줄은 건드리지 않는다 — 직후 ensure_header가 삭제 후 meta에서 @접두로 재생성."""
    # ④ 결정론 정리 — 실측된 템플릿 리터럴 복사 3종 + 추측 병기:
    note = re.sub(r"\bSP(?:E|EA|EAK|EAKE)?_(\d{2})\b", r"SPEAKER_\1", note)  # 깨진 라벨 실측("@SPE_08"·"@SP_07") 정규화
    note = re.sub(r"\*{0,2}(→\s*)?\*{0,2}SPEAKER_XX\*{0,2}\s*:\s*", r"\1", note)
    note = re.sub(r"\{([^{}\n]+)\}", r"\1", note)
    note = re.sub(r"\s*\([^()\n]{1,14}\?\)", "", note)
    # 라벨 뒤 괄호 이름 병기 제거 — "SPEAKER_08 (Olivia)" 류. 실측상 절반 이상이 오식별.
    note = re.sub(r"(SPEAKER_\d{2})\s*\([A-Za-z가-힣][A-Za-z가-힣, ]{0,19}\)", r"\1", note)
    out = []
    for ln in note.split("\n"):
        m = re.match(r"^(\s*-?\s*)\*{0,2}발표자\*{0,2}\s*:\s*(.*)$", ln)
        if m:
            prefix, val = m.group(1), m.group(2).strip()
            if re.fullmatch(r"@?SPEAKER_\d{2}", val):
                out.append(ln)      # 발표자: SPEAKER_XX → 유지(매핑됨)
                continue
            if len(val) <= 18:
                continue            # 미확인·이름 등 짧은 값 → 발표자 메타줄 제거
            ln = prefix + val       # 본문 '발표자: 내용' → 라벨만 제거, 내용 유지
        if re.match(r"^\s*-\s*\[[ xX]?\]", ln):
            # 담당자는 @SPEAKER_XX만 허용 — 그 외 @이름은 전부 추측이므로 제거. 참석자 명단 대조가
            # 아니라 화이트리스트로 거른다(실측: 명단에 없는 오기 "@Bibs"가 명단 대조를 통과했음).
            # @ 직전이 단어 문자면 이메일(bobs.kim@soomgo.com)의 도메인이므로 건드리지 않는다.
            ln = re.sub(r"\s*(?<![\w.가-힣])@(?!SPEAKER_\d{2})[A-Za-z가-힣][\w가-힣.]*", "", ln)
            ln = re.sub(r"\s*\(\s*\)", "", ln)  # "(@이름)" 제거 후 남는 빈 괄호 정리
        out.append(ln)
    return "\n".join(out)


def atomic_write(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    os.replace(tmp, path)


def main():
    session = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ.get("APP_SESSION_DIR", ""))
    if not session or not (session / "meeting.json").exists():
        fail(f"세션 정보를 찾을 수 없습니다: {session}")
    if not (session / "transcript.txt").exists():
        fail("전사본이 아직 없습니다. 전사·화자분리를 먼저 완료해주세요.")
    if not (MODEL_DIR / MODEL_NAME / "config.json").exists():
        fail(f"로컬 AI 모델이 설치되지 않았습니다: {MODEL_DIR / MODEL_NAME}")

    # 이모지는 기존 스킬 출력 어휘(🎤 화자 / 📝 작성 / ✅ 완료)에 맞춘다 — 🧠류 의인화 지양.
    emit("📝 로컬 AI로 회의록을 작성합니다")

    try:
        meta = json.loads((session / "meeting.json").read_text())
        attendees = ", ".join(meta.get("attendees", [])) or "-"
        # 교정본 우선 — claude 1단계(라벨 재할당)나 사용자 수동 교정 산출물. 원본을 쓰면
        # 회의록 귀속·화자 매핑이 화면에 보이는 전사본(교정본 우선 표시)과 어긋난다.
        corrected = session / "transcript_corrected.txt"
        raw = (corrected if corrected.exists() else session / "transcript.txt").read_text()
    except Exception as e:
        fail(f"회의 정보를 읽지 못했습니다: {e}")

    # 빈 전사 가드 — 인식된 발화가 없으면 모델을 로드하지 않고 중단한다(지어내기 방지).
    # 무음 판정을 escape hatch로 강제 진행한 경우 등. 결정론적이라 모델 상태와 무관하게 보장.
    if len(transcript_speech(raw)) < MIN_TRANSCRIPT_CHARS:
        emit("   인식된 발화가 없어 회의록을 작성하지 않았습니다")
        try:
            write_speaker_mapping(session, resolve_speakers(raw, meta.get("attendees", []), session))
        except Exception:
            pass
        atomic_write(session / "meeting-notes.md", ensure_header(
            "인식된 발화가 없어 회의록을 작성하지 못했습니다. 녹음에 음성이 제대로 담겼는지 확인해주세요.",
            meta))
        signal({"type": "phase_done"})
        return

    emit("   모델 로딩 중…")
    try:
        gen, tok = make_generator()
    except Exception as e:
        fail(f"로컬 AI 런타임/모델 로딩 실패: {e}")

    vocab = load_vocab()

    # 0) 회의 유형 — auto(자동 판단)거나 가이드가 삭제된 유형이면 분류 생성 1회로 판별.
    #    실패하면 자유 구성 폴백 (meeting.json은 건드리지 않음 — 유형 변경은 앱 UI 소관).
    global _RESOLVED_TYPE
    mtype = meta.get("type", "auto")
    if mtype == "auto" or not (TEMPLATES / f"{mtype}.md").exists():
        emit("   회의 유형 파악 중…")
        _RESOLVED_TYPE = classify_type(gen, tok, raw)
        if _RESOLVED_TYPE:
            label = next((l for n, l, _ in template_candidates() if n == _RESOLVED_TYPE),
                         _RESOLVED_TYPE)
            emit(f"   회의 유형: {label}")
        else:
            # 분류 실패/미매칭 폴백 — 침묵하면 "파악 중"이 미완처럼 남는다.
            emit("   회의 유형: 자유 형식으로 작성")

    # 1) 화자 매핑 준비 — 기존 매핑 보존 + 녹음 힌트(결정론). LLM 제안은 제거(resolve_speakers 주 참조).
    emit("   화자 목록 정리 중…")
    try:
        entries = resolve_speakers(raw, meta.get("attendees", []), session)
        write_speaker_mapping(session, entries)
        # 반영 인원수 보고는 안 한다 — 남은 출처(재작성 보존·녹음 힌트)는 둘 다 사용자가
        # 이미 아는 정보라 노이즈. 화자 수(과분할 가늠)와 다음 행동만.
        emit(f"   화자 {len(entries)}명 — 전사본 탭에서 이름을 확인·지정해주세요")
    except Exception as e:
        emit(f"   (화자 정리 생략 — {e})")

    # 2) 회의록 초안 — 짧으면 단일샷, 길면 map-reduce
    is_long = len(tok.encode(raw)) > LONG_NOTE_TOKENS
    if is_long:
        # ⚠️ 없이 — 긴 회의 분할은 정상 동작이지 경고가 아니다.
        emit("   긴 회의라 구간별로 나눠 분석합니다")
        out = write_note_mapreduce(gen, tok, session, raw, attendees)
    else:
        out = ""
    if not out.strip():
        emit("   회의록 작성 중…")
        source = raw
        if is_long:
            # map-reduce 실패 시 최후 fallback — 예산 내로 절단해 단일샷
            source = tok.decode(tok.encode(raw)[:LONG_NOTE_TOKENS])
        try:
            out = clean_output(gen(NOTE_SYS, build_note_prompt(session, source),
                                   max_tokens=NOTE_MAX_TOKENS, temp=0.25, echo=True))
        except Exception as e:
            fail(f"회의록 생성 중 오류가 발생했습니다: {e}")

    # 3) 자기검증 — 전사 대조로 시제·상태·누락 교정 (오타 교정 겸함, 사용자 메모 반영 포함)
    emit("   전사와 대조해 다듬는 중…")
    out = verify_note(gen, tok, out, raw, vocab, memos=user_memos(session))

    # 4) 결정론 후처리 + 헤더 주입
    out = post_process_note(out)
    out = ensure_header(out, meta)
    if len(out.strip()) < 20:
        fail("회의록이 비어 있습니다. 다시 시도해주세요.")

    try:
        atomic_write(session / "meeting-notes.md", out)
    except Exception as e:
        fail(f"회의록 저장 실패: {e}")

    # 완료 문구는 출력하지 않는다 — phase_done이 띄우는 완료 띠("✓ 회의록 작성 완료")와 중복 표기.
    signal({"type": "phase_done"})
    # macOS 알림 — 로컬 생성은 수 분 걸려 자리를 비우는 경우가 흔하다 (claude 경로의 app_notify와 동일 규약)
    signal({"type": "notify", "msg": "회의록이 준비되었습니다. 확인해주세요."})


if __name__ == "__main__":
    main()
