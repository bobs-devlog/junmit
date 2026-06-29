# 오픈소스 라이선스 고지

Junmit은 아래 오픈소스 컴포넌트를 포함·사용하며, 각 라이선스가 요구하는 출처·저작권 고지를
한곳에 모았습니다. 이 문서는 앱이 사용하는 의존성에서 자동 생성됩니다.

Junmit 자체 코드는 MIT 라이선스(저장소 `LICENSE` 파일)를 따릅니다. `swift-cli/`에서 빌드되어
앱에 포함되는 자체 바이너리(diarize · whisper-parse · adf · apply-edits · mention-cache ·
libNative.dylib)도 이 라이선스에 포함됩니다.

---

## 앱에 포함·사용하는 구성요소

`.dmg`에 포함되어 재배포되는 것과 설치 시 내려받아 구동되는 것을 모두 적습니다.
MIT · Apache-2.0 · BSD-3-Clause 전문은 아래 "Rust 의존성 (cargo)" 섹션에 동일하게
포함되어 있습니다. CC-BY-4.0(pyannote 모델)과 OFL-1.1(D2Coding)은 이 섹션에 따로
명시합니다.

| 컴포넌트 | 역할 | 저작권 | 라이선스 |
|---|---|---|---|
| [pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) | 화자분리 모델 (앱에 포함) | © pyannoteAI | CC-BY-4.0 |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | 화자분리 라이브러리 (설치 시 사용) | © CNRS | MIT |
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | 전사 엔진 (앱에 포함) | © The ggml authors | MIT |
| [FFmpeg](https://ffmpeg.org) | 오디오 변환·전처리 (앱에 포함) | © FFmpeg 개발자 | LGPL-2.1-or-later |
| [Whisper large-v3-turbo](https://github.com/openai/whisper) | 전사 모델 (설치 시 다운로드) | © OpenAI | MIT |
| [PyTorch (torch · torchaudio)](https://github.com/pytorch/pytorch) | 화자분리 모델 실행 런타임 (설치 시 사용) | © Meta Platforms 외 | BSD-3-Clause |
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
교체·재빌드할 수 있습니다(LGPL-2.1 대응 소스·재링크 요건 충족). 소스는 https://ffmpeg.org
에서 받을 수 있고, 라이선스 전문: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html

### D2Coding — SIL Open Font License 1.1

코드 표시용 글꼴 D2Coding은 Naver Corp.가 SIL Open Font License 1.1(OFL-1.1)로 배포합니다.
라이선스 전문은 앱에 포함된 글꼴 라이선스 파일(`public/fonts/D2Coding-LICENSE.md`) 및
https://github.com/naver/d2codingfont/wiki/Open-Font-License 를 참고하세요.

---

## Swift 의존성 (swift-cli 바이너리)

`swift-cli/`에서 빌드되어 앱에 포함되는 바이너리(diarize · whisper-parse · adf 등)는 아래
Swift 패키지를 정적 링크합니다. (Rust·npm 도구가 수집하지 못하므로 여기 따로 적습니다.)

| 패키지 | 사용 바이너리 | 저작권 | 라이선스 |
|---|---|---|---|
| [swift-argument-parser](https://github.com/apple/swift-argument-parser) | diarize · whisper-parse · apply-edits · mention-cache · adf | © Apple Inc. | Apache-2.0 |
| [swift-markdown](https://github.com/apple/swift-markdown) | adf | © Apple Inc. | Apache-2.0 |
| [swift-cmark (cmark-gfm)](https://github.com/swiftlang/swift-cmark) | adf (swift-markdown 경유) | © John MacFarlane 외 | BSD-2-Clause 외 |

swift-argument-parser·swift-markdown의 Apache License 2.0 전문은 아래 "Rust 의존성 (cargo)"
섹션에 동일하게 포함되어 있습니다. Apache-2.0 §4(d)에 따라 swift-markdown의 NOTICE 고지를
아래에 전파합니다:

```
                            The Swift Markdown Project
                            ==========================

Copyright (c) 2021 Apple Inc. and the Swift project authors

The Swift Project licenses this file to you under the Apache License,
version 2.0 (the "License"); you may not use this file except in compliance
with the License. You may obtain a copy of the License at:

  https://www.apache.org/licenses/LICENSE-2.0

This product contains Swift Argument Parser.
  * Apache License 2.0 · https://github.com/apple/swift-argument-parser

This product contains a derivation of the cmark-gfm project.
  * BSD-2-Clause · https://github.com/github/cmark-gfm
```

cmark-gfm은 BSD-2-Clause를 기본으로 일부 파일이 MIT·CC-BY-SA 4.0 등 복합 라이선스를
따르며, 원본 `COPYING` 전문은 다음과 같습니다:

```
Copyright (c) 2014, John MacFarlane

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

-----

houdini.h, houdini_href_e.c, houdini_html_e.c, houdini_html_u.c
derive from https://github.com/vmg/houdini, Copyright (C) 2012 Vicent Martí — MIT License.

buffer.h, buffer.c, chunk.h are derived from code (C) 2012 Github, Inc. — MIT License.

utf8.c is derived from utf8proc, (C) 2009 Public Software Group e. V., Berlin, Germany — MIT License.

The CommonMark spec (test/spec.txt) is Copyright (C) 2014-15 John MacFarlane,
released under Creative Commons CC-BY-SA 4.0 (http://creativecommons.org/licenses/by-sa/4.0/).

(MIT/BSD 조항 전문은 위 BSD-2-Clause 및 본 문서의 다른 MIT 항목과 동일합니다.
전체 원문: https://github.com/swiftlang/swift-cmark/blob/gfm/COPYING)
```

---
