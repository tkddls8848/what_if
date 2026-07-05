# Novel IF Reader

한국어 소설 원문에서 인물, 장소, 사건, 인물 상태와 관계를 추출하고 독서 진행 위치에 맞춰 시각화하는 로컬 웹 애플리케이션입니다. 기본 규칙 분석은 브라우저에서 실행되며, 선택적으로 Ollama의 4B~7B 로컬 모델을 이용해 작품별 분석 seed를 생성할 수 있습니다.

## 주요 기능

- 이상 「날개」와 김동인 「감자」 샘플 제공
- 로컬 TXT 파일 업로드 및 편집한 원문 재분석
- 문단 기반 세그먼트·장면 구성
- 인물, 장소, 사건, 상태 변화와 관계 추출
- 브라우저 규칙 분석 및 Ollama 기반 동적 seed 분석
- 독서 위치 슬라이더와 이후 정보 숨김(스포일러 차단)
- 관계 그래프, 사건 타임라인, 인물별 상태·관계·이동 경로 표시
- `/check` 화면에서 추출 결과 확정·수정·제외 및 사건 수동 추가
- 현재 원문과 분석 결과를 브라우저 `localStorage`에 저장·복원
- JSON, CSV, Markdown, TimelineJS, Graph JSON 형식 출력 및 클립보드 복사

## 요구 사항

- Node.js 18 이상
- npm

Ollama 분석을 사용할 때만 다음 항목이 추가로 필요합니다.

- Ollama 서버
- 태그 또는 모델 정보로 판별 가능한 4B~7B completion 모델
- 선택 사항: Python 3와 `kiwipiepy`

Python이나 `kiwipiepy`를 사용할 수 없으면 서버의 정규식 전처리로 자동 대체되므로 브라우저 규칙 분석에는 영향을 주지 않습니다.

## 설치 및 실행

```powershell
cd D:\novel_if
npm install
npm start
```

PowerShell 실행 정책으로 `npm.ps1`이 차단되는 환경에서는 `npm` 대신 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npm.cmd start
```

서버가 시작되면 다음 주소를 엽니다.

- 분석 화면: <http://localhost:3000/>
- 결과 검수 화면: <http://localhost:3000/check>

개발 중 파일 변경을 감시하려면 다음 명령을 사용합니다.

```powershell
npm run dev
```

분석기 회귀 테스트는 다음 명령으로 실행합니다.

```powershell
npm test
```

## Ollama 분석 설정

기본 Ollama API 주소는 `http://127.0.0.1:11434`, 기본 모델은 `qwen3.5:4b`입니다. 화면의 **분석 방식**에서 `로컬 LLM Seed`를 선택하거나 **LLM Seed 재생성**을 누르면 서버가 Ollama에 구조화된 JSON 분석을 요청하고, 그 결과를 브라우저 분석기와 병합합니다.

화면에는 서버에서 확인된 4B~7B 모델과 다음 기본 후보가 표시됩니다.

- `qwen3.5:4b`
- `gemma4:e4b`
- `gemma3:4b`
- `qwen3:4b`

필요하면 실행 전에 환경 변수를 지정할 수 있습니다.

```powershell
$env:PORT = "3000"
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:PYTHON = "python"
npm.cmd start
```

형태소 분석을 사용하려면 선택적으로 설치합니다.

```powershell
python -m pip install kiwipiepy
```

## 사용 흐름

1. 샘플을 선택하거나 **TXT 열기**로 원문을 불러옵니다.
2. 분석 방식을 선택하고 **원문 분석**을 실행합니다.
3. 독서 위치와 스포일러 차단 여부를 조절하며 관계 지도, 사건 흐름, 인물 상태를 확인합니다.
4. **검수** 화면에서 결과의 상태와 내용을 수정합니다.
5. 현재 결과를 브라우저에 저장하거나 필요한 형식으로 출력해 복사합니다.

## 프로젝트 구조

```text
novel_if/
├─ index.html                 # 분석 및 검수 화면 마크업
├─ styles.css                # 전체 UI 스타일
├─ server.js                 # Express 정적 서버와 Ollama API 중계
├─ src/
│  ├─ config.js              # 샘플, 상태, seed, 사건·상태 사전
│  ├─ analyzer.js            # 규칙 분석 및 Ollama 결과 병합
│  └─ app/
│     ├─ controller.js        # 초기화, 입력, 분석, 저장 이벤트
│     ├─ context.js           # 애플리케이션 상태와 DOM 참조
│     ├─ editing.js           # 검수 상태 변경과 수동 편집
│     └─ view/                # Reader, Map, Timeline, Character, Review, Export
├─ scripts/
│  └─ korean_morph.py         # Kiwi/정규식 기반 한국어 전처리
└─ texts/
   ├─ wings.txt              # 이상 「날개」
   └─ gamja.txt               # 김동인 「감자」
```

별도의 빌드 단계나 데이터베이스는 없습니다. 브라우저 코드는 ES modules로 로드되고, 저장 기능은 현재 브라우저의 `localStorage`만 사용합니다.

## 서버 API

- `GET /api/ollama/health`: Ollama 도달성, 허용 모델, Python 전처리 가용성, 캐시 상태 진단
- `GET /api/ollama/models`: 연결된 Ollama에서 사용 가능한 4B~7B completion 모델 조회
- `POST /api/analyze/ollama`: 원문과 모델명을 받아 LLM 구조화 분석 실행
  - body: `{ text, model, mode, force }`
  - `mode: "scene"`(기본) — 원문을 장면 단위로 나눠 인물·장소 → 사건·상태 →
    관계 순서로 소형 호출을 반복하는 map-reduce 파이프라인. **원문 길이 제한이
    없고** 컨텍스트 절단이 발생하지 않는다
  - `mode: "single"` — 기존 단발 프롬프트 (비교·회귀용, 긴 원문은 절단될 수 있음)
  - `force: true` — 서버 캐시를 우회하고 새로 분석 ("LLM Seed 재생성" 버튼)
  - `Accept: text/event-stream`이면 SSE로 `progress`(장면 진행) → `done`/`error`
    이벤트를 보낸다. 화면은 장면 진행률을 버튼에 표시한다
- 오류는 `{ok:false, error_code, message, retryable}` 형식이다
  (`CONNECTION_FAILED`, `TIMEOUT`, `UPSTREAM_ERROR`, `PARSE_FAILED` 등)

같은 원문·모델·모드의 결과는 `cache/`에 저장되어 즉시 재사용된다.
환경 변수: `OLLAMA_TIMEOUT_MS`(기본 120000), `NOVEL_IF_CACHE=0`(캐시 비활성),
`NOVEL_IF_CACHE_DIR`(캐시 위치).

## 추출 품질 평가

골든셋(`tests/fixtures/golden/`) 기준 precision/recall 리포트:

```powershell
node scripts/eval_extraction.mjs                      # 규칙 채널 + fixture LLM 채널
node scripts/eval_extraction.mjs --live qwen3.5:4b    # 실제 Ollama 장면 파이프라인 포함
```

## 현재 제약

- 규칙 분석은 사전과 패턴 기반이므로 문학적 중의성, 생략된 주체, 상징 관계를 정확히 판정하지 못할 수 있습니다.
- Ollama 분석 품질과 처리 시간은 선택한 로컬 모델과 실행 환경에 따라 달라집니다.
- 저장 결과는 서버가 아니라 현재 브라우저에만 남으며 사용자·기기 간 동기화되지 않습니다.
- 내보내기는 다운로드 파일을 생성하지 않고 텍스트 출력과 클립보드 복사를 제공합니다.
- 분석 결과는 자동 확정값이 아니라 근거 문장과 신뢰도를 확인하고 검수하는 것을 전제로 합니다.
