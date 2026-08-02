# 오픈소스 라이선스 고지

Junmit은 아래 오픈소스 컴포넌트를 포함·사용하며, 각 라이선스가 요구하는 출처·저작권 고지를
한곳에 모았습니다. 이 문서는 앱이 사용하는 의존성에서 자동 생성됩니다.

Junmit 자체 코드는 MIT 라이선스(저장소 `LICENSE` 파일)를 따릅니다. `swift-cli/`에서 빌드되어
앱에 포함되는 자체 바이너리(diarize · whisper-parse · apply-edits · libNative.dylib)도
이 라이선스에 포함됩니다.

---

## 앱에 포함·사용하는 구성요소

`.dmg`에 포함되어 **재배포되는** 구성요소는 빠짐없이 적습니다. **설치 시 사용자 기기로 내려받는**
것은 주요 구성요소만 적습니다 — 이쪽은 설치 시점에 `uv`가 의존성을 해석해 받아오므로 전이
의존성까지 열거하지 않으며(화자분리 런타임 한 벌만 100개 남짓), 각 패키지는 자기 배포물 안에
라이선스를 포함합니다. 재배포가 아니므로 이 문서에 전문을 싣지 않습니다.

재배포 구성요소의 라이선스 전문 위치는 이렇습니다. MIT · Apache-2.0 · BSD-3-Clause는 아래
"Rust 의존성 (cargo)" 섹션에, LGPL-2.1(FFmpeg)은 문서 맨 끝에 있습니다. CC-BY-4.0(pyannote
모델)과 OFL-1.1(D2Coding)은 이 섹션에서 따로 명시합니다.

| 컴포넌트 | 역할 | 저작권 | 라이선스 |
|---|---|---|---|
| [pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) | 화자분리 모델 (앱에 포함) | © pyannoteAI | CC-BY-4.0 |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | 화자분리 라이브러리 (설치 시 사용) | © CNRS | MIT |
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | 전사 엔진 (앱에 포함) | © The ggml authors | MIT |
| [FFmpeg](https://ffmpeg.org) | 오디오 변환·전처리 (앱에 포함) | © FFmpeg 개발자 | LGPL-2.1-or-later |
| [Whisper large-v3-turbo](https://github.com/openai/whisper) | 전사 모델 (설치 시 [whisper.cpp 배포본](https://huggingface.co/ggerganov/whisper.cpp)의 GGML 양자화 변환본 `ggml-large-v3-turbo-q8_0.bin`을 다운로드) | © OpenAI | MIT |
| [Gemma 4 12B](https://huggingface.co/google/gemma-4-12B-it) | 로컬 회의록 모델 (로컬 AI 선택 시 `mlx-community` 양자화본 다운로드) | © Google DeepMind | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| [mlx-lm](https://github.com/ml-explore/mlx-lm) | 로컬 회의록 모델 실행 런타임 (로컬 AI 선택 시 설치) | © Apple Inc. | MIT |
| [PyTorch (torch)](https://github.com/pytorch/pytorch) | 화자분리 모델 실행 런타임 (설치 시 사용) | © Meta Platforms 외 | BSD-3-Clause |
| [torchaudio](https://github.com/pytorch/audio) | 오디오 입출력 런타임 (설치 시 사용) | © Facebook Inc. | BSD-2-Clause |
| [uv](https://github.com/astral-sh/uv) | Python 인터프리터·패키지 관리 (앱에 포함) | © Astral Software Inc. | Apache-2.0 OR MIT |
| [D2Coding](https://github.com/naver/d2codingfont) | 코드 표시용 글꼴 (앱에 포함) | © Naver Corp. | OFL-1.1 |

### pyannote speaker-diarization-community-1 — CC-BY-4.0

화자분리 모델은 pyannoteAI가 배포한 `pyannote/speaker-diarization-community-1`이며
Creative Commons Attribution 4.0 International(CC-BY-4.0) 하에 재배포합니다. 원저작권은
pyannoteAI에 있으며, 모델에 변경을 가하지 않고 원본 스냅샷을 그대로 포함합니다.
라이선스 전문: https://creativecommons.org/licenses/by/4.0/legalcode

### FFmpeg — LGPL-2.1-or-later

오디오 변환·전처리에 쓰는 FFmpeg는 **audio-only · GPL 컴포넌트 제외** 구성으로 빌드해
LGPL version 2.1 or later 하에 동봉합니다(`--disable-gpl --disable-nonfree`, x264 등 GPL/비자유
코덱 미포함 — Junmit은 오디오만 사용). 동봉 버전은 **n8.1.2**이며 무수정 빌드입니다. 정확한
빌드 구성·버전은 `scripts/build-binaries.sh`에 공개됩니다. FFmpeg는 앱에 정적 링크되지 않고
별도 실행 파일(`resources/bin/ffmpeg`)로 동봉되어, 사용자가 동일 인터페이스의 바이너리로
교체·재빌드할 수 있습니다(LGPL-2.1 대응 소스·재링크 요건 충족).

대응 소스는 FFmpeg git tag **n8.1.2**(무수정)이며 https://ffmpeg.org 또는
https://github.com/FFmpeg/FFmpeg/tree/n8.1.2 에서 받을 수 있습니다. 본 배포일로부터 3년간
동일 소스 사본의 제공 요청을 받습니다(저장소 이슈로 문의). 라이선스 전문은 이 문서 맨 끝
"FFmpeg LGPL-2.1 전문"에 수록합니다.

### D2Coding — SIL Open Font License 1.1

코드 표시용 글꼴 D2Coding은 Naver Corp.가 SIL Open Font License 1.1(OFL-1.1)로 배포합니다.
라이선스 전문은 앱에 포함된 글꼴 라이선스 파일(`public/fonts/D2Coding-LICENSE.md`) 및
https://github.com/naver/d2codingfont/wiki/Open-Font-License 를 참고하세요.

---

## Swift 의존성 (swift-cli 바이너리)

`swift-cli/`에서 빌드되어 앱에 포함되는 바이너리(diarize · whisper-parse · apply-edits)는 아래
Swift 패키지를 정적 링크합니다. (Rust·npm 도구가 수집하지 못하므로 여기 따로 적습니다.)

| 패키지 | 사용 바이너리 | 저작권 | 라이선스 |
|---|---|---|---|
| [swift-argument-parser](https://github.com/apple/swift-argument-parser) | diarize · whisper-parse · apply-edits | © Apple Inc. | Apache-2.0 |

swift-argument-parser의 Apache License 2.0 전문은 아래 "Rust 의존성 (cargo)" 섹션에 동일하게
포함되어 있습니다.

---
