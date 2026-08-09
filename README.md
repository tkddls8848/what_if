# Novel IF Reader

한국어 소설에서 인물·장소·사건·상태 변화를 추출하고, 독서 시점 기준으로 조회하거나 what-if 분기를 만드는 로컬 웹 앱입니다. 규칙 기반 분석은 즉시 실행되고, Ollama 4B~7B 모델을 사용하면 상세 분석을 추가할 수 있습니다.

## 실행

요구 사항은 Node.js와 npm입니다(v23.3에서 검증). 상세 분석과 what-if에는 별도로 실행 중인 Ollama가 필요합니다. EPUB 읽기는 표준 `DecompressionStream("deflate-raw")`에 의존하므로, 이 API가 없는 구버전 Node에서는 EPUB 경로와 해당 테스트가 동작하지 않습니다.

```powershell
npm install
npm start
```

- 분석: <http://localhost:3000/>
- 검수: <http://localhost:3000/check>
- 테스트: `npm test`
- 개발 감시: `npm run dev`

기본 Ollama 주소는 `http://127.0.0.1:11434`, 기본 모델은 `qwen3.5:4b`입니다.

```powershell
$env:PORT = "3000"
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_TIMEOUT_MS = "120000"
npm start
```

분석 캐시는 `cache/`에 저장됩니다. `NOVEL_IF_CACHE=0`으로 끄거나 `NOVEL_IF_CACHE_DIR`로 위치를 바꿀 수 있습니다.

## 기능

- 「날개」, 「감자」 샘플과 TXT·EPUB·위키문헌 입력
- 규칙 기반 빠른 분석과 Ollama 장면 단위 상세 분석
- 독서 위치 이후 정보를 숨기는 as-of 조회
- 관계 지도, 사건 흐름, 인물 상태, 근거 검수
- 분석 결과 수정·제외와 수동 사건 추가
- what-if 사건·상태 생성 및 원작 이후 내용 누출 검사
- JSON, CSV, Markdown, TimelineJS, Graph, ink, Twee 출력
- 브라우저 `localStorage` 저장
- 읽기 전용 MCP 도구

EPUB은 챕터 경계를 Scene으로 사용합니다. 위키문헌 입력의 권리는 자동 판정하지 않으며 `unverified`로 기록합니다.

## 상세 분석 계약

`POST /api/analyze/ollama`는 원문을 약 1,000자 장면으로 나누고 다음 순서로 처리합니다.

1. 인물·장소 추출
2. 사건 프레임·상태 변화 추출
3. 전체 관계 추출
4. 원문 근거 검증과 규칙 분석 결과 병합

요청 body는 `{ text, model, force? }`입니다. `Accept: text/event-stream`을 보내면 `progress`와 `done` 또는 `error` 이벤트를 반환합니다.

그 밖의 API:

- `GET /api/ollama/health`
- `GET /api/ollama/models`
- `GET /api/import/wikisource?url=...`
- `POST /api/whatif`

what-if 요청은 `{ seed, premise?, count?, model }` 형식입니다. `seed`에는 분기 시점 스냅샷만 허용하며 원문이나 이후 사건은 허용하지 않습니다.

## MCP

```powershell
npm run mcp
```

MCP 서버는 `mcp/server.js`입니다. `NOVEL_IF_LIBRARY`를 지정하지 않으면 `texts/`를 읽습니다.

제공 도구:

- `list_works`
- `state_as_of`
- `who_is`
- `timeline_as_of`
- `graph_as_of`
- `evidence_for`
- `arc_summary`
- `whatif_seed`
- `read_segment`

사실 조회에는 `as_of`가 필요합니다. `rights`가 `public-domain`으로 시작하지 않는 작품은 원문 단락을 반환하지 않습니다.

## 구조

```text
server.js                 Express 서버와 API
src/analyzer.js           규칙 분석과 Ollama 결과 병합
src/core/                 as-of, 감사, 근거, EPUB, 분기, 출력, 정규화
src/server/               Ollama 장면 파이프라인, what-if 생성, 위키문헌
src/app/                  브라우저 상태·이벤트·뷰
mcp/                      읽기 전용 MCP 어댑터
scripts/                  평가·감사 CLI
tests/                    회귀 테스트와 fixture
texts/                    기본 작품
doc/                      기술 설계와 데이터 계약
doc_nextsession/          다음 작업 목록
.claude/skills/           분석·검수·평가 절차
```

모듈 종류는 디렉터리별 `package.json`이 정한다. `src/`와 `mcp/`는 ESM,
`src/server/`와 루트 `server.js`는 CommonJS다.

설계 근거와 데이터 계약은 [`doc/README.md`](doc/README.md),
다음 우선순위는 [`doc_nextsession/README.md`](doc_nextsession/README.md)에 있다.

## 평가

```powershell
npm run eval
npm run eval -- --live qwen3.5:4b
npm run eval:qa
npm run audit -- --doc gamja --severity error
```

규칙 분석은 패턴 기반이므로 생략된 주체와 문학적 중의성을 완전히 판정하지 못합니다. 상세 분석 결과와 what-if 생성물은 자동 확정하지 않고 `suggested` 상태로 보관합니다.
