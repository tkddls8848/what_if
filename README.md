# Novel IF Reader

**이 저장소는 피보팅 중입니다.** 지금은 두 앱이 한 서버 위에 함께 있습니다.

- **인터랙티브 소설**(`/play`) — 캐릭터 카드와 세계관을 재료로, 장면 서술을 스트리밍하고 선택지 3개를 제시합니다. 사용자는 행동을 직접 쓰거나 선택지를 고릅니다. 서술은 Cloudflare Workers AI가 생성합니다. M1까지 구현했습니다.
- **소설 분석기**(`/`, `/check`) — 한국어 소설에서 인물·장소·사건·상태 변화를 추출하고, 독서 시점 기준으로 조회하거나 what-if 분기를 만듭니다. 규칙 기반 분석은 즉시 실행되고, Ollama 4B~7B 모델로 상세 분석을 추가할 수 있습니다. 피보팅이 끝나면 걷어냅니다.

피보팅의 방향과 남은 마일스톤은 [`doc/2026-09-05-interactive-fiction-pivot-design.md`](doc/2026-09-05-interactive-fiction-pivot-design.md)에, 설계 근거는 [`doc/README.md`](doc/README.md)에 있습니다.

## 실행

요구 사항은 Node.js와 npm입니다(v23.3에서 검증). `/play`에는 Cloudflare Workers AI API 토큰이, 분석기의 상세 분석과 what-if에는 별도로 실행 중인 Ollama가 필요합니다. EPUB 읽기는 표준 `DecompressionStream("deflate-raw")`에 의존하므로, 이 API가 없는 구버전 Node에서는 EPUB 경로와 해당 테스트가 동작하지 않습니다.

```powershell
npm install
Copy-Item .env.example .env
notepad .env   # CF_ACCOUNT_ID, CF_API_TOKEN을 채운다 (GEMINI_API_KEY는 선택)
npm start
```

- 플레이: <http://localhost:3000/play>
- 분석: <http://localhost:3000/>
- 검수: <http://localhost:3000/check>
- 테스트: `npm test`
- 개발 감시: `npm run dev`

`/play`는 Cloudflare Workers AI 자격 증명이 필요합니다. `.env.example`을 `.env`로
복사하고 두 값을 채우세요. 토큰에는 `Workers AI - Read`와 `Workers AI - Edit` 두
권한이 필요한데, Cloudflare 대시보드에서 "Workers AI" 템플릿으로 토큰을 만들면 두
권한이 함께 부여됩니다. Account ID는 대시보드 계정 홈 우측 사이드바에 있습니다.

```
# .env
CF_ACCOUNT_ID=<account id>
CF_API_TOKEN=<Workers AI 토큰>
```

`.env`는 `.gitignore`에 있어 커밋되지 않습니다. **실제 환경변수가 항상
우선합니다** — `$env:CF_API_TOKEN = "..."`처럼 셸에서 직접 넣거나 CI/배포가
주입한 값이 있으면 `.env`의 같은 키는 무시됩니다. `.env` 없이 예전처럼 셸에
직접 넣어도 그대로 동작합니다.

무료 할당은 하루 10,000 Neurons이고, 기본 모델 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 기준으로 턴당 약 200 Neurons — **하루 약 50턴**입니다. 남은 양은 화면 오른쪽 위에 표시됩니다.

### 장면 판정 (배경 그림)

배경 그림은 장면이 바뀐 턴에만 다시 그립니다. "지금 어디인가"는 서술과 분리된
호출(TypeSafe Jev)이 매 턴 판정하고, 고를 수 있는 장소·시간대·날씨는 세계관 파일의
`world.stage`에 **미리 적어 둔 닫힌 목록**입니다 — 목록 밖의 값이 나오는 일이
구조적으로 없어서 같은 장소는 항상 같은 그림 파일이 됩니다.

**Jev는 Workers AI 무료 할당 밖입니다.** 서드파티 모델이라 AI Gateway 통합 과금으로
계산되고, 게이트웨이에 선불 크레딧이 없으면 매 호출이 402로 떨어집니다. 그래도
**턴은 성공한 채 끝나고** 배경만 직전 것이 유지됩니다(응답의 `scene_unavailable`이
`true`가 됩니다). 자격증명은 `CF_ACCOUNT_ID`/`CF_API_TOKEN`을 그대로 쓰며 새 키는
필요 없습니다. 선택 설정은 `.env.example`의 `CF_GATEWAY_ID`·`SCENE_CONFIDENCE`를
보세요.

장소를 세계관에 안 적으면 그 장소는 영영 안 그려집니다. 신뢰도가 모자라 장면을
유지한 턴은 `[director]` 로그로 남으니, 그걸 읽고 `world.stage`에 빠진 장소를
추가하면 됩니다.

### Gemini 무료 티어 폴백 (선택 사항)

`GEMINI_API_KEY`를 채우면 Cloudflare 할당이 마른 뒤(`QUOTA_EXHAUSTED`)에도 서술이
끊기지 않고 Google AI Studio의 무료 티어로 이어집니다. 키는
[aistudio.google.com](https://aistudio.google.com/)에서 신용카드 없이 발급합니다.

```
# .env
GEMINI_API_KEY=<AI Studio 키>
GEMINI_MODEL=            # 비우면 gemini-2.5-flash
```

두 무료 할당은 재는 단위가 다릅니다 — Cloudflare는 **토큰량**(하루 10,000
Neurons), Gemini는 **요청 수**(RPD/RPM)입니다. 그래서 토큰 예산을 먼저 다 쓰고
요청 수로 넘어가는 이 순서가 하루 턴 수를 가장 크게 만듭니다. 실제 RPD 한도는
모델마다 다르고 자주 바뀌므로 AI Studio 콘솔에서 확인하세요.

폴백은 다음과 같이 동작합니다.

- 비워 두면 폴백 없이 지금까지와 똑같습니다. 반대로 `CF_*` 없이 이것만 채우면 Gemini 단독으로도 돕니다.
- 설정과 순서는 `GET /api/cf/health`의 `providers`에서 확인합니다. 폴백은 평소에 한 번도 안 불리므로, 정작 필요한 날에 키가 비어 있었다는 걸 그때 알면 늦습니다.
- 폴백이 쓰인 턴은 응답의 `provider`가 `"gemini"`이고 `budget_unknown`이 `true`가 됩니다. Neuron은 Cloudflare의 단위라 Gemini가 쓴 양은 Neuron으로 잴 수 없기 때문입니다 — 비용을 모른다는 뜻이 아니라 그 장부의 대상이 아니라는 뜻입니다.
- **서술만** 폴백합니다. 장면 배경 이미지는 Cloudflare 전용이고, 실패해도 턴은 성공한 채 끝납니다.
- 서술이 이미 화면에 흐르기 시작한 뒤에는 폴백하지 않습니다. 이미 나간 글자는 되돌릴 수 없으므로, 겹쳐 쓰는 대신 거기서 끊고 `truncated`로 알립니다.

분석기의 기본 Ollama 주소는 `http://127.0.0.1:11434`, 기본 모델은 `qwen3.5:4b`입니다. `PORT`, `OLLAMA_URL`, `OLLAMA_TIMEOUT_MS`도 같은 `.env`에 선택적으로 채울 수 있습니다(기본값은 `.env.example`에 적혀 있습니다).

```
# .env
PORT=3000
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_TIMEOUT_MS=120000
```

분석 캐시는 `cache/`에 저장됩니다. `NOVEL_IF_CACHE=0`으로 끄거나 `NOVEL_IF_CACHE_DIR`로 위치를 바꿀 수 있습니다.

## 기능

### 인터랙티브 소설 (`/play`)

- `data/worlds/*.json`의 세계관·캐릭터 카드로 장면을 생성
- 닫힌 무대 집합(`world.stage`) 기반 장면 판정과 배경 이미지 생성·캐시
- 3인칭 장면 서술 SSE 스트리밍과 선택지 3개
- 자유 입력과 선택지 병행
- Neuron 사용량 계량과 잔량 표시
- 스트림이 중간에 끊기면 독자에게 알림
- 세션은 브라우저 `localStorage`에 저장

아직 없는 것: 캐릭터 카드 자동 생성(M2), 상태 그래프와 설정 붕괴 감사(M3), 요약 압축과 RAG(M4), 분기·내보내기(M5).

### 소설 분석기 (`/`, `/check`)

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
server.js                 Express 서버와 API (두 앱 공용)
src/llm/                  모델 어댑터 — Workers AI 클라이언트, Neuron 계량 (CommonJS)
play.html                 플레이 화면
data/worlds/              세계관·캐릭터 카드
src/analyzer.js           규칙 분석과 Ollama 결과 병합
src/core/                 카드, 세션·턴, 서술/선택지 분리, 프롬프트 조립,
                          as-of, 조합 질의, 요약, 감사, 근거, EPUB, 분기, 출력
src/server/               턴 오케스트레이터, Ollama 장면 파이프라인, what-if 생성, 위키문헌
src/app/                  브라우저 상태·이벤트·뷰
mcp/                      읽기 전용 MCP 어댑터
scripts/                  평가·감사 CLI
tests/                    회귀 테스트와 fixture
texts/                    기본 작품
doc/                      기술 설계와 데이터 계약
.claude/skills/           분석·검수·평가 절차
```

모듈 종류는 디렉터리별 `package.json`이 정한다. `src/`와 `mcp/`는 ESM,
`src/server/`·`src/llm/`과 루트 `server.js`는 CommonJS다. CommonJS에서 `src/core/`를
쓸 때는 `await import()`를 쓴다.

설계 근거와 데이터 계약은 [`doc/README.md`](doc/README.md),
피보팅의 방향과 남은 마일스톤은
[`doc/2026-09-05-interactive-fiction-pivot-design.md`](doc/2026-09-05-interactive-fiction-pivot-design.md)에 있다.

## 평가

```powershell
npm run eval
npm run eval -- --live qwen3.5:4b
npm run eval:qa
npm run eval:scene            # 장면 판정 골든셋 (실제 Jev 호출 — 과금됩니다)
npm run eval:scene -- --dry   # 호출 없이 골든셋 점검만
npm run audit -- --doc gamja --severity error
```

규칙 분석은 패턴 기반이므로 생략된 주체와 문학적 중의성을 완전히 판정하지 못합니다. 상세 분석 결과와 what-if 생성물은 자동 확정하지 않고 `suggested` 상태로 보관합니다.
