# Junmit

> ### 녹음 버튼만 누르면, 회의록이 준비됩니다.
>
> 회의를 녹음하면 전사와 화자분리를 거쳐 회의록 초안까지 한 흐름으로 이어집니다. 이미 쓰고 있는 Claude·ChatGPT 구독으로 작성되어 **추가 비용이 들지 않습니다.**

```
녹음 → 전사 (whisper.cpp) → 화자분리 (pyannote.audio) → 회의록 (Claude Code / Codex) → Confluence
```

<!-- 스크린샷 자리: 1) 회의 선택 화면  2) 회의록 문서 화면 (공개 전 추가) -->

---

## 다운로드

### [⬇ 최신 버전 받기 (.dmg)](../../releases/latest)

macOS 14.4+, Apple Silicon 전용. 처음 실행할 땐 보안 우회가 한 번 필요합니다([설치 안내](#1-설치와-첫-실행) 참고). 아직 공개된 릴리스가 없으면 [소스에서 직접 빌드](#개발)할 수 있습니다.

---

## 특징

- **녹음 버튼만 누르면 끝.** 녹음을 멈추면 전사, 화자분리, 회의록 초안까지 자동으로 이어집니다. 확인하고 다듬기만 하면 됩니다.
- **이미 쓰는 AI 구독을 그대로.** 회의록은 [Claude Code](https://claude.com/claude-code)(Claude Pro/Max)나 [Codex](https://developers.openai.com/codex/cli)(ChatGPT Plus/Pro 등)가 작성합니다. 별도 API 키나 종량 결제가 없습니다.
- **원격회의 상대방 음성까지.** 구글 밋·줌 등에서 내 마이크와 상대방 음성을 함께 녹음합니다.
- **오디오는 기기에서 처리.** 전사와 화자분리가 로컬에서 이뤄져 오디오가 클라우드로 올라가지 않습니다. (회의록 작성 단계의 전사 텍스트는 Claude·ChatGPT로 전달됩니다. [데이터](#데이터) 참고.)
- **우리 팀 방식대로.** 발표/세미나, 일반 회의, 리뷰 유형을 기본 제공하고, 팀에 맞춘 유형을 AI로 만들거나 직접 다듬을 수 있습니다. auto 모드는 회의 내용을 보고 유형을 자동 판단합니다.
- **녹음 중 메모.** 화자 힌트나 자유 메모를 남기면 회의록 작성 시 화자 식별과 맥락에 반영됩니다.
- **회의록 다음 작업까지.** 회의록 수정은 물론 Jira 티켓 만들기, Slack·메일 요약 공유, 일정 등록을 대화로 맡길 수 있습니다(연동 서비스 한정).
- **용어 사전.** 자주 나오는 용어를 등록하면 전사 정확도와 회의록 교정 품질이 올라갑니다.

---

## 시스템 요구사항

- **macOS 14.4 (Sonoma) 이상, Apple Silicon.** Metal/MPS GPU 가속을 쓰고, 원격회의 시스템 오디오 캡처(CoreAudio Process Tap)가 macOS 14.4+를 요구합니다.
- **AI 도구 구독.** 회의록 작성에 [Claude Code](https://claude.com/claude-code)(Claude Pro/Max)나 [Codex](https://developers.openai.com/codex/cli)(ChatGPT Plus/Pro 등) 중 하나의 구독이 필요합니다. CLI 설치와 로그인은 앱이 첫 실행 때 안내하므로 미리 준비할 것은 없습니다.
- **디스크 여유 약 3GB.** Whisper 모델(약 1.5GB)과 Python 환경(약 0.9GB), 앱을 합한 용량입니다. 한국어 전사 정확도를 위해 large급 모델(large-v3-turbo)을 써서 모델이 큽니다. 이후 회의 녹음과 결과물이 회의마다 더 쌓입니다(녹음 길이에 따라 수십에서 수백 MB).

> Python 3.12는 앱이 portable 인터프리터를 자동으로 내려받습니다(uv). Python이나 Node.js를 따로 설치할 필요가 없습니다.

---

## 시작하기

### 1. 설치와 첫 실행

[다운로드](#다운로드)에서 최신 `.dmg`를 받아 마운트한 뒤 `Junmit.app`을 `/Applications`로 드래그합니다.

코드 서명을 하지 않으므로 처음 열면 "확인되지 않은 개발자입니다" 다이얼로그가 뜹니다. [확인]을 누른 뒤 시스템 설정 → 개인정보 보호 및 보안 → 하단의 `"Junmit.app"이(가) 차단되었습니다` → "차단되었지만 열기"를 누르세요. 첫 실행에 한 번만 하면 됩니다.

이후 업데이트는 앱 안에서 처리됩니다. 새 버전이 나오면 사이드바에 "↑ 업데이트 가능" 버튼이 뜨고, 설정 → 앱 업데이트에서 설치하면 됩니다. 설치 시 `/Applications` 교체를 위해 macOS가 관리자 암호를 한 번 물을 수 있고, 위의 보안 경고는 다시 뜨지 않습니다.

### 2. AI 도구 선택과 로그인

앱을 처음 열면 사용할 AI 도구(Claude Code 또는 Codex)를 고르는 화면이 먼저 나옵니다. 카드를 선택하면 앱이 설치와 로그인을 앱 안의 터미널에서 바로 진행합니다(별도 설치나 복사·붙여넣기가 필요 없습니다). 로그인까지 끝나면 다음 단계로 넘어갑니다.

> 로그인은 Junmit 전용 환경 기준입니다. 평소 개인 터미널에서 이미 로그인돼 있어도 앱 안에서 한 번 더 로그인해야 합니다(개인 설정·기록과 격리됩니다).

### 3. 초기 설정(Setup)

Setup 화면에서 "설치 시작"을 누르면 회의 처리에 필요한 자원을 내려받습니다.

- Whisper 모델(약 1.5GB)과 PyTorch·pyannote.audio 등 Python 환경(합쳐 수 GB)을 받습니다. 인터넷 속도에 따라 10–20분 정도 걸릴 수 있습니다.
- 화자분리 모델은 앱에 동봉되어 있어 별도 계정이나 토큰이 필요 없습니다.

### 4. macOS 권한 (마이크, 시스템 오디오, 캘린더)

권한은 실제로 그 기능을 처음 쓸 때 macOS가 허용 여부를 물어봅니다. 녹음할 때 마이크(내 목소리)와 시스템 오디오 녹음(원격회의 상대방 음성)을, 캘린더 일정을 불러올 때 캘린더 권한을 묻습니다. 시스템 오디오 녹음을 허용하지 않아도 마이크 녹음은 정상 동작하지만, 헤드폰 사용 시 상대방 음성이 빠질 수 있습니다. 미리 허용해두려면 사이드바 설정 → 권한 화면에서 상태를 확인하고 요청할 수 있습니다.

### 5. (선택) 캘린더 연동

회의 일정을 자동으로 불러오려면 일정이 macOS 캘린더(Apple 캘린더)에 있어야 합니다.

- 외부 캘린더(Google/Microsoft 등)를 쓴다면 시스템 설정 → 인터넷 계정에서 계정을 추가하고 캘린더 동기화를 켜세요. 그러면 해당 일정이 macOS 캘린더에 들어와 앱에 표시됩니다.
- 연동하지 않아도 됩니다. 앱에서 회의 제목과 참석자를 직접 입력해도 동일하게 사용할 수 있습니다.

### 6. (선택) Confluence 발행

회의록을 Confluence에 등록하려면 Atlassian 계정 연결이 한 번 필요합니다. 처음 발행할 때 터미널에 연결 승인이 뜨므로 미리 준비할 것은 없습니다([사용법](#사용법) 7번, [트러블슈팅](#트러블슈팅) 참고).

---

## 사용법

1. **회의 선택.** 시작 화면에서 캘린더 일정을 고르거나 직접 입력합니다. 같은 화면에서 제목, 참석자, 회의 유형(발표/세미나, 일반 회의, 리뷰, 자동 판단, 직접 추가 가능)을 함께 정합니다.
2. **녹음.** 녹음 시작 후 오디오 레벨 게이지로 입력을 확인하고 중지합니다. 녹음 중 하단에서 화자 힌트나 자유 메모를 남길 수 있습니다.
3. **전사와 화자분리.** 녹음을 멈추면 자동으로 진행됩니다. 진행 상황만 보면 되고 따로 조작할 것은 없습니다.
4. **회의록 작성.** 이어서 앱이 자동으로 AI(Claude Code/Codex)를 실행해 전사 교정, 화자 식별, 회의록 초안을 만듭니다. 터미널 패널에 작업 과정이 그대로 표시되며, 명령을 직접 입력할 필요는 없습니다.
5. **문서 확인.** "문서" 탭에서 교정본, 화자 매칭, 회의록 본문을 확인하고 복사할 수 있습니다. 화자 이름이 틀렸으면 직접 고친 뒤 회의록을 다시 작성하게 할 수 있습니다.
6. **추가 요청 (선택).** 사이드바의 "AI에게 추가 요청"으로 회의록 수정과 요약은 물론, 결정사항으로 Jira 티켓 만들기, Slack·메일로 요약 공유, 후속 일정 등록 같은 후속 작업도 대화로 요청할 수 있습니다(외부 서비스 연동 시 첫 연결 승인이 필요할 수 있습니다. [트러블슈팅](#트러블슈팅) 참고).
7. **Confluence 등록 (선택).** "Confluence 등록" 버튼을 누르면 발행됩니다. 처음 발행할 때만 터미널에 Atlassian 연결 승인이 한 번 뜹니다([트러블슈팅](#트러블슈팅) 참고).

사이드바에서 다음을 관리합니다.

- **회의 기록.** 저장된 세션을 열어 미완료 회의를 이어서 진행하거나 완료된 회의록을 다시 봅니다.
- **용어 사전.** 자주 나오는 용어를 등록하면 전사 정확도와 교정 품질이 올라갑니다. 한 줄이나 쉼표로 여러 개를 한꺼번에 붙여넣을 수 있습니다(사람 이름은 참석자에서 자동 반영되므로 넣지 않아도 됩니다).
- **회의 유형.** 팀·조직에 맞춘 회의록 유형을 AI로 새로 만들거나 다듬습니다.
- **설정.** 권한 상태 확인, 앱 업데이트, 오픈소스 라이선스 고지 등.

---

## 데이터

| 종류 | 경로 |
|------|------|
| 모델, Python venv, 회의 결과물(`output/`) | `~/Library/Application Support/app.junmit/` |
| 앱 (화자분리 모델 동봉) | `/Applications/Junmit.app` |

오디오는 기기에서 전사·화자분리되며 클라우드 전사 서비스로 올라가지 않습니다. 단, 회의록 작성 단계에서는 전사된 텍스트가 사용하는 AI(Claude Code는 Anthropic, Codex는 OpenAI)로 전달되고, Confluence에 발행하면 회의록이 Atlassian으로 전달됩니다. 정리하면 오디오는 로컬에서 처리되고 텍스트는 외부 AI·발행 서비스로 나갑니다.

앱을 삭제해도 위 데이터는 남습니다. 완전히 지우려면:

```bash
rm -rf "$HOME/Library/Application Support/app.junmit"
```

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|------------|
| 첫 실행 시 "확인되지 않은 개발자입니다" | 정상입니다(코드 서명 없음). 시스템 설정 → 개인정보 보호 및 보안 → "차단되었지만 열기" |
| 처리 중 터미널에 영어로 허용을 묻는 질문이 뜸 | 외부 서비스를 처음 연결할 때 나오는 정상 동작입니다. 방향키로 허용(Yes)을 고르고 Enter. 아래 설명 참고 |
| "화자분리 모델이 없습니다" 오류 | 앱 번들 손상입니다. 앱을 재설치하세요 |
| 캘린더 일정이 안 보임 | 외부 캘린더는 시스템 설정 → 인터넷 계정에서 동기화를 켜야 macOS 캘린더에 들어옵니다. 또는 회의 정보를 직접 입력해도 됩니다 |
| Setup(설치)이 중간에 실패함 | 인터넷 연결과 디스크 여유 공간을 확인하고 다시 시도하세요. 자세한 원인은 설치 로그 `~/Library/Logs/app.junmit/install.log`에서 볼 수 있습니다 |

### 처리 중 권한 질문이 뜨면

회의록 작성은 보통 질문 없이 끝까지 진행됩니다. 다만 외부 서비스를 처음 연결하는 순간에는 터미널에 영어로 허용 여부를 한 번 물어볼 수 있습니다. 당황하지 말고 방향키(↑/↓)로 허용(Yes)을 고른 뒤 Enter를 누르면 그대로 진행됩니다. 주로 이런 경우입니다.

- Confluence에 처음 발행할 때 Atlassian 연결을 한 번 승인합니다.
- 추가 요청으로 외부 서비스를 쓸 때, 회의록 작성 후 Gmail·Slack·캘린더·Notion 등과 연동하는 요청을 보내면 해당 서비스 연결을 승인합니다.

---

## 라이선스

[MIT](LICENSE)

앱은 아래 오픈소스 컴포넌트를 동봉·사용합니다(앱 내 설정 → 오픈소스 라이선스에서도 확인할 수 있습니다).

| 컴포넌트 | 역할 | 라이선스 |
|---------|------|---------|
| [pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (© pyannoteAI) | 화자분리 모델 (앱 동봉) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | 화자분리 라이브러리 | MIT |
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | 전사 엔진 (앱 동봉) | MIT |
| [Whisper large-v3-turbo](https://github.com/openai/whisper) (© OpenAI) | 전사 모델 | MIT |
| [FFmpeg](https://ffmpeg.org) | 오디오 변환·전처리 (앱 동봉, audio-only 빌드) | LGPL-2.1-or-later |
| [PyTorch](https://github.com/pytorch/pytorch) | 화자분리 모델 실행 런타임 | BSD-3-Clause |
| [uv](https://github.com/astral-sh/uv) (© Astral) | Python 인터프리터·패키지 관리 (앱 동봉) | Apache-2.0 / MIT |
| [D2Coding](https://github.com/naver/d2codingfont) (© Naver) | 코드 표시용 글꼴 (앱 동봉) | OFL-1.1 |

위 표는 주요 컴포넌트입니다. 앱에 링크·동봉되는 모든 의존성(npm, Rust crate 포함)의 라이선스 전문은 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)에 모았습니다. 의존성이 바뀌면 `scripts/licenses/regen.sh`로 다시 생성합니다(`cargo install cargo-about --features cli` 선행).

---

## 개발

이 아래는 소스에서 빌드하거나 기여하려는 사람을 위한 내용입니다. 앱을 쓰기만 한다면 위 [시작하기](#시작하기)로 충분합니다.

### 빌드 환경

- macOS 14.4+, Apple Silicon
- Xcode Command Line Tools (`xcode-select --install`)
- Rust ([rustup](https://rustup.rs))
- Node.js (`brew install node`), 프론트엔드 빌드용
- cmake (`brew install cmake`), whisper.cpp 빌드용
- HuggingFace 토큰 (무료, 최초 1회). 앱에 동봉할 pyannote 모델 다운로드용입니다. [모델 페이지](https://huggingface.co/pyannote/speaker-diarization-community-1)에서 약관 동의 후 `HF_TOKEN=hf_... npm run build-binaries` (HF 캐시에 모델이 이미 있으면 불필요).

### 명령어

| 명령 | 용도 |
|------|------|
| `npm run app-dev` | dev 모드 (Vite HMR + Tauri debug + hot reload) |
| `npm run build-binaries` | sidecar 바이너리(whisper-cli, diarize 등) 빌드. 처음 한 번 또는 whisper.cpp 업데이트 시 |
| `npm run app-build` | release 빌드 + 워크스페이스 복사 + 자동 실행 (빠른 검증용) |
| `npm run dmg` | 로컬 검증용 dmg 생성 (node_modules → sidecar → tauri build 일괄) |
| `npm run release -- 0.1.1` | 정식 릴리스. 버전 동기화 + 태그 + push (이후는 CI가 처리) |

정식 릴리스는 `npm run release -- <버전>`이 버전 3곳(package.json, tauri.conf.json, Cargo.toml)을 맞추고 태그를 push하면, [`.github/workflows/release.yml`](.github/workflows/release.yml)이 빌드, ad-hoc 서명, 업데이터 서명, GitHub Release, `latest.json` 생성을 자동 처리합니다.

### 첫 빌드

```bash
git clone <repository-url>
cd junmit
npm run dmg
# → src-tauri/target/release/bundle/dmg/Junmit_*.dmg
```

### dev 모드의 알려진 한계

dev 빌드는 `.app` 번들이 아니라 macOS 권한 시스템이 적용되지 않아 캘린더가 동작하지 않습니다. 캘린더 검증은 `npm run app-build`(release 빌드)로 하세요.

dev 모드에선 워크스페이스의 `resources/` 자산이 그대로 사용되며, `resources/.claude/skills/` 편집은 즉시 반영됩니다.

> `.claude/`가 `resources/` 안에 있는 이유: root에 두면 IDE Claude Code도 `skills/`를 슬래시 명령으로 노출합니다. `resources/` 아래에 두면 IDE 컨텍스트와 앱 런타임 PTY가 분리됩니다([src-tauri/src/session.rs](src-tauri/src/session.rs)의 `resource_dir`이 dev에선 `<workspace>/resources/`, release에선 `Contents/Resources/`를 반환).

### 프로젝트 구조

```
src/                  Tauri frontend (React + TypeScript)
src-tauri/            Tauri backend (Rust)
swift-cli/            Swift sidecar 소스 (diarize 패키지 + system 패키지(libNative.dylib))
scripts/              빌드/배포 도구 (build-binaries.sh, release.sh, release-tag.sh)
resources/            앱 동봉 자산 (release 시 .app/Contents/Resources/로 복사, dev에선 PTY cwd)
├── .claude/          Claude Code 설정 + skills
├── lib/              앱이 런타임에 호출하는 스크립트 (bash 파이프라인 + Python pyannote)
├── bin/              빌드된 sidecar 바이너리 + 동봉 (gitignored)
├── templates/        회의 유형 시드 (첫 실행 시 app-support로 복사)
├── vocabulary.json   용어 사전 시드 (첫 실행 시 app-support로 복사)
└── install.sh        Setup 진입점 (앱 Setup 화면에서 실행)
```

언어 선택: ML이나 외부 Python 라이브러리는 Python, macOS 네이티브 API와 텍스트 처리·CLI는 Swift, 외부 명령 오케스트레이션은 bash. Python 의존은 ML 영역에 한정합니다.

세션은 `~/Library/Application Support/app.junmit/output/{timestamp}_{title}/`에 저장됩니다.

### 로그 위치

| 종류 | 위치 |
|------|------|
| Setup 로그 (install.sh) | `~/Library/Logs/app.junmit/install.log` |
| 회의 처리 로그 (전사/화자분리) | `~/Library/Application Support/app.junmit/output/{timestamp}_{title}/pipeline.log` |

Setup 로그는 macOS Console.app에서도 검색됩니다.

---

이름 **Junmit**의 *-mit*은 transmit(전사), omit(후보정), commit(결정 정리), submit(발행)에서 따왔습니다.

동봉 화자분리 모델: pyannote speaker-diarization-community-1, © pyannoteAI, [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
