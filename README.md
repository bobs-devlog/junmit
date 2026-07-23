# Junmit

> ### 녹음 버튼만 누르면, 회의록이 준비됩니다.

회의를 녹음하기만 하면 Junmit이 말한 내용을 글로 옮기고(전사), 누가 말했는지 구분하고(화자분리), 회의록 초안까지 만들어 줍니다.

- **회의 음성이 Mac 밖으로 나가지 않습니다.** 전사와 화자분리는 기기 안에서 처리되고, 녹음 원본은 처리가 끝나면 자동 삭제됩니다. 회의록 작성에는 텍스트만 쓰이며, 로컬 AI를 고르면 텍스트도 나가지 않습니다([내 데이터는 어디에 저장되나요](#내-데이터는-어디에-저장되나요) 참고).
- **추가 비용이 없습니다.** 이미 쓰고 있는 Claude·ChatGPT·Google AI 구독으로 동작하고, 구독이 없다면 무료 로컬 AI로 전부 오프라인 처리할 수 있습니다.
- **한국어 회의 기준으로 만들었습니다.** 기기 안에서 도는 모델 중 한국어 전사 품질을 기준으로 엔진을 골랐고, 팀 용어 사전으로 받아쓰기 정확도를 높입니다.

https://github.com/user-attachments/assets/bc688e98-08c8-4898-9960-5de9c422a8b9

---

## 설치

Apple Silicon Mac(M1 이후), macOS 14.4 이상에서 동작합니다.

터미널을 열고(`Command(⌘) + 스페이스` → "터미널" 입력 → Return) 아래 한 줄을 붙여넣고 Return 키를 누르세요.

```sh
curl -fsSL https://github.com/bobs-devlog/junmit/releases/latest/download/install.sh | sh
```

다운로드가 끝나면 Junmit이 자동으로 열립니다. 처음 열면 앱이 AI 선택·필요한 파일 내려받기·권한을 순서대로 안내합니다([첫 실행](#첫-실행-앱이-이끌어-줍니다) 참고). 이후 새 버전은 앱 사이드바의 "↑ 업데이트 가능"에서 바로 설치합니다.

<details>
<summary><b>터미널 대신 파일(.dmg)로 설치하기</b> — 눌러서 펼치기</summary>

1. [최신 버전 받기](../../releases/latest)에서 `.dmg` 파일을 받아 연 뒤, `Junmit` 아이콘을 응용 프로그램(`Applications`) 폴더로 드래그합니다.
2. 처음 열면 "확인되지 않은 개발자입니다" 경고가 뜹니다. 아직 Apple 코드 서명이 없어 나타나는 정상적인 경고이며, 한 번만 허용하면 됩니다.
   - 경고 창에서 **확인**을 누릅니다.
   - **시스템 설정 → 개인정보 보호 및 보안**으로 이동합니다.
   - 아래쪽 `"Junmit"을(를) 차단했습니다` 옆 "**그래도 열기**"를 누릅니다.

<img width="706" height="184" alt="차단되었지만 열기 버튼 위치" src="https://github.com/user-attachments/assets/f3bcd032-c1a1-47ea-b831-32573c4d6166" />

이 확인은 처음 한 번뿐입니다. 터미널로 설치하면 이 경고가 아예 뜨지 않습니다.

</details>

---

## 무엇을 해 주나요

- **녹음 버튼만 누르면 끝.** 녹음을 멈추면 전사·화자분리·회의록 초안 작성까지 자동으로 이어집니다. 확인하고 다듬기만 하면 됩니다.
- **회의 유형에 맞춰 씁니다.** 발표·일반 회의·리뷰·회고·1on1 유형을 기본 제공하고, 팀에 맞는 유형을 직접 만들어 쓸 수 있습니다.
- **원격회의 상대방 음성까지.** 구글 밋·줌 등에서 내 목소리와 상대방 목소리를 함께 녹음합니다.
- **녹음 중 메모.** "지금 말하는 사람은 홍길동" 같은 화자 힌트나 자유 메모를 남기면 회의록에 반영됩니다.
- **회의록 다음 작업까지.** 회의록 수정과 요약은 물론 Slack·메일 요약 공유, 일정 등록을 대화로 맡길 수 있습니다(연동 서비스 한정).
- **용어 사전.** 팀에서 자주 쓰는 용어를 등록하면 받아쓰기 정확도와 교정 품질이 올라갑니다.

---

## 준비물

세 가지만 확인하면 됩니다.

1. **Apple Silicon Mac(M1 이후) + macOS 14.4 이상.** 원격회의 상대방 음성 녹음 기능이 macOS 14.4 이상을 필요로 합니다.
2. **회의록을 작성할 AI 하나.** 쓰고 있는 AI 구독(Claude·ChatGPT·Google AI)이 있으면 그대로 쓰고, 없으면 무료 로컬 AI를 선택하면 됩니다. 바로 아래 [어떤 AI를 고를까요](#어떤-ai를-고를까요)를 참고하세요.
3. **디스크 여유 공간 약 2GB.** 첫 설치 때 음성 인식에 필요한 파일을 내려받습니다(로컬 AI 선택 시 모델에 따라 6.8~11GB 추가). 회의 결과물은 텍스트 위주라 용량 부담이 적고, 녹음 원본은 처리 후 자동 삭제됩니다.

<details>
<summary>약 2GB에는 무엇이 들어 있나요?</summary>

음성 인식 모델 Whisper large-v3-turbo(약 870MB, q8_0 양자화. 전사 품질은 FP16과 동급)와 화자분리를 위한 Python 실행 환경(약 0.9GB), 앱 본체입니다. 한국어 전사 정확도를 위해 large급 모델을 사용합니다. Python을 포함해 필요한 것은 앱이 알아서 내려받으므로 따로 설치할 것은 없습니다.

</details>

### 어떤 AI를 고를까요

첫 실행 때 화면에서 고르고, 설치와 로그인은 앱이 안내합니다. 나중에 설정에서 바꿀 수 있습니다.

| 선택지 | 필요한 구독 | 참고 |
|--------|------------|------|
| [Claude Code](https://claude.com/claude-code) | Claude (Pro·Max 등) | |
| [Codex](https://developers.openai.com/codex/cli) | ChatGPT (Plus·Pro 등) | |
| [Antigravity](https://antigravity.google) | Google AI (Pro·Ultra 등) | Gemini 기반 |
| 로컬 AI (Gemma 4) | 필요 없음 (무료) | 메모리 16GB 이상. 아래 설명 참고 |

**로컬 AI는 이런 선택지입니다.** AI 구독이 없거나, 회의 내용을 한 글자도 밖으로 보내고 싶지 않다면 좋은 선택입니다. 회의록 작성까지 전부 내 Mac 안에서 처리됩니다. 대신 두 가지를 감안하세요.

- **품질과 기기 사양.** 구독 AI보다 회의록 품질이 아쉬울 수 있습니다. 모델은 두 가지 중 고릅니다. 표준(저장 공간 6.8GB·메모리 16GB 이상)은 더 빠르고 가볍게 동작하고, 고품질(11GB·메모리 24GB 이상)은 더 꼼꼼하고 안정적인 회의록을 만듭니다.
- **기능 범위.** 회의록 작성까지만 담당합니다. AI 다듬기(화자 자동 매칭·전사 오탈자 교정)와 작성 후 "AI에게 추가 요청"은 구독 AI에서만 지원됩니다.

---

## 첫 실행 (앱이 이끌어 줍니다)

설치한 Junmit을 처음 열면 아래를 순서대로 안내합니다. 화면을 따라가기만 하면 됩니다.

**1. AI 도구 선택과 로그인.** 회의록을 작성할 AI 도구를 고르는 화면이 나옵니다. 쓰고 있는 구독에 맞는 카드를 선택하면 설치와 로그인이 앱 안에서 바로 진행됩니다. 화면 안내에 따라 로그인만 하면 됩니다. 로컬 AI를 선택한 경우에는 로그인 없이 모델 내려받기만 진행됩니다. (어떤 AI가 좋을지는 [어떤 AI를 고를까요](#어떤-ai를-고를까요)를 참고하세요.)

> 평소 컴퓨터에서 이미 로그인돼 있어도 앱 안에서 한 번 더 로그인해야 합니다. Junmit은 개인 설정·기록과 섞이지 않도록 분리된 환경을 쓰기 때문입니다.

**2. 필요한 파일 내려받기 (10~20분).** Setup 화면에서 "설치 시작"을 누르면 음성 인식에 필요한 파일들을 내려받습니다. 인터넷 속도에 따라 10~20분 정도 걸리니 잠시 다른 일을 해도 됩니다. 별도 가입이나 계정은 필요 없습니다.

**3. 권한 허용.** 각 기능을 처음 쓸 때 macOS가 권한을 물어봅니다. 허용해 주세요.

| 권한 | 언제 물어보나요 | 용도 |
|------|----------------|------|
| 마이크 | 첫 녹음 시작 시 | 내 목소리 녹음 |
| 시스템 오디오 녹음 | 첫 녹음 시작 시 | 원격회의 상대방 목소리 녹음 |
| 캘린더 | 일정을 불러올 때 | 회의 일정·참석자 자동 입력 |

시스템 오디오 녹음을 허용하지 않아도 마이크 녹음은 정상 동작하지만, 헤드폰을 쓰면 상대방 목소리가 녹음에서 빠질 수 있습니다. 사이드바 설정 → 권한 화면에서 미리 확인하고 요청해 둘 수도 있습니다.

**(선택) 캘린더 연동.** 회의 일정을 자동으로 불러오려면 일정이 macOS 캘린더(Apple 캘린더)에 있어야 합니다. Google·Microsoft 등 외부 캘린더를 쓴다면 시스템 설정 → 인터넷 계정에서 계정을 추가하고 캘린더 동기화를 켜 주세요. 연동하지 않고 회의 제목과 참석자를 직접 입력해도 똑같이 쓸 수 있습니다.

---

## 사용하기

회의 한 번의 흐름은 이렇습니다.

1. **회의 선택.** 시작 화면에서 캘린더 일정을 고르거나 직접 입력합니다. 제목, 참석자, 회의 유형(발표/세미나·일반 회의·리뷰·회고·1on1, 또는 자동 판단)도 여기서 정합니다. 구독 AI를 쓴다면 시간·토큰 절약 옵션(AI 다듬기·회의록 검증 끄기)도 여기서 조정할 수 있습니다.
2. **녹음.** 녹음을 시작하면 소리 게이지로 입력이 잘 들어오는지 확인할 수 있습니다. 녹음 중 하단에서 화자 힌트나 자유 메모를 남길 수 있습니다.
3. **자동 처리.** 녹음을 멈추면 전사와 화자분리가 자동으로 진행됩니다. 지켜보기만 하면 됩니다.
4. **회의록 작성.** 이어서 AI가 전사 교정, 화자 식별을 거쳐 회의록 초안을 만듭니다. 화면에 작업 과정이 표시되지만 직접 입력할 것은 없습니다.
5. **확인과 수정.** "문서" 탭에서 교정본, 화자 이름, 회의록 본문을 확인하고 복사할 수 있습니다. 화자 이름이 틀렸으면 직접 고친 뒤 회의록을 다시 작성하게 할 수 있습니다.
6. **추가 요청 (선택).** 사이드바의 "AI에게 추가 요청"으로 회의록 수정과 요약은 물론, Slack·메일로 요약 공유, 후속 일정 등록 같은 후속 작업도 대화로 맡길 수 있습니다.

> 로컬 AI를 쓰는 경우 6번(추가 요청)은 제공되지 않습니다.

시작 화면 사이드바에서는 다음을 관리합니다.

- **회의 기록.** 지난 회의록을 다시 보거나, 중간에 멈춘 회의를 이어서 진행합니다.
- **용어 사전.** 팀에서 자주 쓰는 용어·제품명을 등록합니다. 쉼표로 여러 개를 한꺼번에 붙여넣을 수 있고, 사람 이름은 참석자 정보에서 자동 반영되므로 넣지 않아도 됩니다.
- **회의 유형.** 팀·조직에 맞춘 회의록 양식을 AI와 대화하며 새로 만들거나 다듬습니다.
- **설정.** 권한 상태 확인, 앱 업데이트, 오픈소스 라이선스 고지.

---

## 자주 묻는 질문

**"확인되지 않은 개발자입니다" 경고가 떠서 앱이 안 열려요.**

정상입니다(코드 서명 없음). `.dmg`로 설치하면 나타나며, [설치](#설치)의 "터미널 대신 파일(.dmg)로 설치하기"를 펼쳐 안내대로 한 번만 허용하면 됩니다. 이 경고가 아예 뜨지 않게 하려면 [터미널로 설치](#설치)하세요.

**앱을 업데이트했더니 마이크 등 권한을 다시 물어봐요.**

정상입니다. macOS는 권한을 "앱의 서명 신원"에 묶어 기억하는데, Junmit은 아직 Apple 코드 서명이 없어 업데이트된 앱을 새 앱으로 간주합니다. 그래서 업데이트 후 각 권한을 처음 쓸 때 한 번씩 다시 물어봅니다 — 허용해 주면 됩니다. 실수로 거절했다면 사이드바 설정 → 권한 화면의 안내를 따라 시스템 설정에서 다시 켜 주세요(적용을 위해 앱을 종료했다가 다시 열어야 할 수 있습니다).

**AI 구독이 없는데 쓸 수 있나요?**

네. 첫 실행 화면에서 로컬 AI(Gemma 4)를 선택하면 구독·로그인 없이 무료로 쓸 수 있습니다. 품질과 기능 제약은 [어떤 AI를 고를까요](#어떤-ai를-고를까요)를 참고하세요.

**작업 화면(터미널)에 영어로 허용을 묻는 질문이 떴어요.**

외부 서비스를 처음 연결할 때 나오는 정상적인 확인 절차입니다. 키보드 방향키(↑/↓)로 허용(Yes)을 고르고 Enter를 누르면 그대로 진행됩니다. 주로 추가 요청으로 Gmail·Slack·캘린더·Notion 등 외부 서비스를 처음 연결할 때 나옵니다.

**AI가 내 컴퓨터에서 마음대로 작업하는 건 아닌가요?**

회의록 작성을 맡겨두고 자리를 비워도 끊기지 않도록, AI는 매번 확인을 묻지 않는 자동 모드로 실행됩니다. 대신 각 동작을 실행 전에 위험하지 않은지 스스로 점검해 안전한 것만 실행하고, 작업 범위도 앱 데이터 폴더 안으로 제한됩니다. 드물게 잘못 판단할 수 있으니 민감한 작업은 결과를 한 번 확인해 주세요.

**캘린더 일정이 안 보여요.**

Google 등 외부 캘린더는 macOS에 연결돼 있어야 앱에 보입니다. 시스템 설정 → 인터넷 계정에서 계정을 추가하고 캘린더 동기화를 켜 주세요. 연동하지 않고 회의 정보를 직접 입력해도 됩니다.

**설치(Setup)가 중간에 실패해요.**

인터넷 연결과 디스크 여유 공간을 확인하고 다시 시도해 주세요. 해결되지 않으면 설치 기록 파일(`~/Library/Logs/app.junmit/install.log`)에서 원인을 확인할 수 있습니다.

**"화자분리 모델이 없습니다" 오류가 떠요.**

앱 파일이 손상된 경우입니다. 앱을 지우고 다시 설치해 주세요.

**녹음한 내용이 외부로 나가지는 않나요?**

목소리(오디오)는 내 Mac 안에서만 처리되고 처리 후 자동 삭제됩니다. 회의록을 만들 때는 전사된 텍스트만 선택한 AI로 전달되며, 로컬 AI를 선택하면 이 텍스트조차 외부로 나가지 않습니다. 자세한 내용은 [내 데이터는 어디에 저장되나요](#내-데이터는-어디에-저장되나요)를 참고하세요.

---

## 내 데이터는 어디에 저장되나요

녹음과 회의록은 모두 내 Mac에 저장됩니다.

| 종류 | 경로 |
|------|------|
| 회의 결과물, 모델, 실행 환경 | `~/Library/Application Support/app.junmit/` |
| 앱 본체 (화자분리 모델 동봉) | `/Applications/Junmit.app` |

외부로 나가는 것과 나가지 않는 것을 정리하면 이렇습니다.

- **오디오(목소리)는 외부로 나가지 않습니다.** 전사와 화자분리 모두 내 Mac에서 처리되며, 녹음 원본은 화자분리가 끝나면 자동 삭제됩니다.
- 회의록을 만들 때는 **전사된 텍스트**가 선택한 AI 서비스(Claude Code는 Anthropic, Codex는 OpenAI, Antigravity는 Google)로 전달됩니다. **로컬 AI를 선택하면 이 단계도 내 Mac에서 처리되어 아무것도 전달되지 않습니다.**

앱을 삭제해도 위 데이터 폴더는 남습니다. 완전히 지우려면 터미널에서 다음을 실행하세요.

```bash
rm -rf "$HOME/Library/Application Support/app.junmit"
```

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
| [Gemma 4 12B](https://huggingface.co/google/gemma-4-12b-it) (© Google DeepMind) | 로컬 AI 회의록 모델 (로컬 AI 선택 시 내려받음) | [Apache-2.0](https://ai.google.dev/gemma/docs/gemma_4_license) |
| [FFmpeg](https://ffmpeg.org) | 오디오 변환·전처리 (앱 동봉, audio-only 빌드) | LGPL-2.1-or-later |
| [PyTorch](https://github.com/pytorch/pytorch) | 화자분리 모델 실행 런타임 | BSD-3-Clause |
| [uv](https://github.com/astral-sh/uv) (© Astral) | Python 인터프리터·패키지 관리 (앱 동봉) | Apache-2.0 / MIT |
| [D2Coding](https://github.com/naver/d2codingfont) (© Naver) | 코드 표시용 글꼴 (앱 동봉) | OFL-1.1 |

위 표는 주요 컴포넌트입니다. 앱에 링크·동봉되는 모든 의존성(npm, Rust crate 포함)의 라이선스 전문은 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)에 모았습니다.

---

## 개발

이 아래는 소스에서 빌드하거나 기여하려는 사람을 위한 내용입니다. 앱을 쓰기만 한다면 위 [설치](#설치)로 충분합니다.

```
녹음 → 전사 (whisper.cpp) → 화자분리 (pyannote.audio) → 회의록 (Claude Code / Codex / Antigravity / 로컬 Gemma·mlx)
```

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

라이선스 고지([THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md))는 의존성이 바뀌면 `scripts/licenses/regen.sh`로 다시 생성합니다(`cargo install cargo-about --features cli` 선행).

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

이름 **Junmit**의 *-mit*은 회의록이 완성되는 네 단계에서 따왔습니다 — 말을 글로 옮기고(transmit), 군더더기를 덜어내고(omit), 결정을 정리하고(commit), 결과를 내보내는(submit).

동봉 화자분리 모델: pyannote speaker-diarization-community-1, © pyannoteAI, [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
