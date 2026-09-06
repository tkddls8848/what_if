# 기술 설계

Updated: 2026-09-05

설치·실행·API 요약은 [루트 README](../README.md)에 있다. 이 문서는 **왜 그렇게
만들었는지**와 데이터 계약을 다룬다.

## 0. 현재 상태 — 저장소는 피보팅 중이다

이 저장소는 한국어 소설 **분석기**에서 AI **인터랙티브 소설**로 피보팅하는 중이고,
지금은 두 앱이 한 서버 위에 함께 있다.

| 경로 | 앱 | 상태 |
| --- | --- | --- |
| `/` | 랜딩 페이지 | 새로 추가 |
| `/play` | 인터랙티브 소설 (새 앱) | M1 완료 |
| `/analyze`, `/check` | 소설 분석기 (옛 앱) | 동작한다. M3에서 걷어낸다 |
| `/api/turn`, `/api/cf/health` | 인터랙티브 소설 | M1 완료 |
| `/api/analyze/ollama`, `/api/import/wikisource`, `/api/whatif` | 분석기 | 동작한다 |

피보팅의 방향과 마일스톤은
[`doc_nextsession/2026-09-05-interactive-fiction-pivot-design.md`](../doc_nextsession/2026-09-05-interactive-fiction-pivot-design.md)에
있고, 그 문서가 이 문서의 상위 권위다. M1의 태스크별 구현 계획은
[`doc_nextsession/2026-09-05-m1-turn-loop-plan.md`](../doc_nextsession/2026-09-05-m1-turn-loop-plan.md)에 있다.

**M1이 끝났고 M2~M5가 남았다.** M1은 순수 추가였다 — 옛 앱의 코드를 한 줄도 바꾸지
않았고, 그래서 `npm test`는 기존 161건과 새 123건을 합쳐 284건 전부 통과한다. 피보팅
계획은 M1에서 기존 테스트가 깨질 것을 전제했으나 그럴 일이 없었다.

이 문서의 1~8절은 새 앱을, 9절 이후는 아직 살아 있는 옛 앱을 다룬다.

## 1. 원칙

옛 앱의 원칙 다섯 중 셋은 그대로 살아남았고 둘은 뒤집혔다. 뒤집힌 자리가 이 피보팅의
성격을 가장 잘 보여 준다.

| 원칙 | 상태 |
| --- | --- |
| 자동 추출은 사실이 아니라 후보다. 검수를 거친다 | **유지.** 카드는 `suggested`로 들어오고 사람이 확정한다 |
| 스포일러 판정은 뷰 필터가 아니라 질의 원시연산이다 | **유지.** 판정 코드는 여전히 `core/asof.js` 한 벌뿐이다 |
| 오탐보다 누락을 택한다 | **유지** |
| 모든 주장은 원문 문자 offset으로 되짚을 수 있어야 한다 | **앵커 교체.** 생성물에는 되짚을 원문이 없다. 대신 모든 사건이 자기를 만든 `turn_index`로 되짚인다 |
| LLM은 선택 채널이다. Ollama가 없어도 앱은 완전히 동작한다 | **뒤집혔다.** 이제 필수는 클라우드고 선택이 로컬이다 |

## 2. 모듈 경계

```text
src/core/     ← 런타임 공용. DOM·네트워크·전역 상태 없음 (ESM)
   ↑
src/analyzer.js   규칙 분석과 LLM 결과 병합 (ESM) — 옛 앱
   ↑                    ↑
src/app/  브라우저      mcp/  읽기 전용 어댑터 (ESM) — 동결
                        ↑
src/server/  Express·Ollama·외부 가져오기 (CommonJS)
   ↑
src/llm/      모델 어댑터 (CommonJS)
```

모듈 종류는 디렉터리별 `package.json`이 명시한다 — `src/`와 `mcp/`는 `"type": "module"`,
`src/server/`와 `src/llm/`은 `"type": "commonjs"`다. 루트 `server.js`도 CommonJS다.

**`src/llm/`이 CommonJS인 것은 의도다.** 소비자(`server.js`, `src/server/turn.js`)가 전부
CommonJS이고, 매 요청 경로에서 `await import()`를 도는 것은 얻는 것이 없다. 피보팅 설계
문서 9절은 처음에 ESM으로 적었고 구현 시작 시점에 이 판단으로 바로잡았다.

의존 방향은 한쪽이다.

- `src/core/`는 자기들끼리와 `src/config.js`만 import한다. **`src/llm/`도 참조하지 않는다.**
- **`src/llm/`은 `src/core/`를 참조하지 않는다.** 어댑터는 프롬프트 문자열과 스키마만 받고
  도메인을 모른다. 프롬프트 조립은 `core/memory.js`가, 호출은 `src/llm/`이 한다.
- CommonJS인 `src/server/`가 ESM인 `src/core/`를 쓸 때는 `await import()`를 쓴다.
  선례는 `src/server/wikisource.js`다.

이 방향 때문에 한국어 기준 문자/토큰 상수(`1.2`)가 `src/core/memory.js`와
`src/llm/budget.js`에 각각 있다. 중복이지만 의존 방향을 깨는 것보다 낫다고 판단했다.
두 값이 조용히 갈라질 수 있다는 것이 이 선택의 대가다.

## 3. 턴 루프

### 3-1. 두 종류의 호출

한 턴은 성격이 완전히 다른 두 호출로 이뤄진다.

| | ① 서술 생성 | ② 상태 추출 |
| --- | --- | --- |
| 무엇 | 장면 산문 + 선택지 3개 | 그 턴의 사건·상태 변화 |
| 출력 형식 | 자유 텍스트 | JSON Schema 강제 |
| 스트리밍 | **필수** | 불필요 |
| 담당 | Cloudflare Workers AI 70B | 로컬 Ollama 4B |
| 상태 | M1에서 구현 | **M3** |

**이 분리는 선택이 아니라 강제다.** Workers AI의 JSON 모드는 스트리밍을 지원하지
않는다. 한 호출로 산문과 구조화 데이터를 같이 받으려면 스트리밍을 포기해야 하고,
그러면 매 턴 수 초의 백지 대기가 생긴다.

M1이 만든 것은 ①뿐이다. ②는 M3에서 `src/server/turn.js` 끝에 비동기로 붙는다.

### 3-2. 흐름

```text
사용자 입력 (자유 서술 또는 추천 선택지)
  │
  ├─ core/memory.js  프롬프트 조립 = 고정 프리픽스 + 최근 3턴 + 현재 입력
  │
  ├─ llm/cloudflare.js  narrate() — 스트리밍 ON, JSON OFF
  │     → core/narration.js 분할기가 마커 앞까지만 통과시킴
  │     → server.js가 SSE `narration` 이벤트로 흘림
  │
  ├─ core/narration.js  parseNarration() — 서술과 선택지 3개를 가름
  ├─ llm/budget.js      Neuron 집계
  └─ core/session.js    appendTurn() — 새 세션 객체 반환
```

선택지 3개는 서술과 같은 호출에서 받는다. 나누면 턴당 Neurons가 1.5배가 되고, 선택지는
방금 쓴 장면의 문맥이 가장 진할 때 나와야 좋다.

### 3-3. Workers AI 계약

Workers 배포 없이 Node에서 REST로 직접 호출한다.

```text
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
Authorization: Bearer {API_TOKEN}
```

토큰은 `Workers AI - Read`와 `Workers AI - Edit` 두 권한이 필요하고, `CF_ACCOUNT_ID`·
`CF_API_TOKEN` 환경변수로만 받는다. **어떤 HTTP 응답에도 나가지 않는다** — 401 응답
본문에는 토큰 조각이 섞여 돌아올 수 있으므로 업스트림 메시지를 그대로 싣지 않는다.

비밀은 `.env`에 둔다. 저장소 루트의 `.env.example`을 `.env`로 복사해서 채우고,
`.env`는 `.gitignore`에 있어 커밋되지 않는다. `server.js`가 부팅 시점에
`src/server/env.js`로 `.env`를 읽어 `process.env`에 채우는데, 이미 세팅된 실제
환경변수(셸의 `$env:`, CI, 배포 환경)가 항상 파일 값보다 우선한다 — `.env`는 기본값일
뿐 권위 있는 값이 아니다.

스트리밍 응답은 `data: {"response":"…","usage":{…},"tool_calls":[]}` 프레임이 빈 줄로
구분되고 `data: [DONE]`으로 끝난다. 프레임은 청크 경계와 무관하게 도착하므로 `"\n\n"`이
나올 때까지 버퍼에 모았다가 자른다. 프레임 하나가 깨져도 스트림 전체를 버리지 않는다 —
이미 화면에 흐른 글자를 되돌릴 수 없으므로 살릴 수 있는 만큼 살리는 편이 낫다.

`error_code` 어휘: `CONNECTION_FAILED` · `TIMEOUT` · `ABORTED` · `AUTH_FAILED` ·
`QUOTA_EXHAUSTED` · `CAPACITY` · `RATE_LIMITED` · `UPSTREAM_ERROR` · `BAD_RESPONSE` ·
`NOT_CONFIGURED`. 401/403과 429를 `UPSTREAM_ERROR`에서 갈라내는 이유는 대응이
다르기 때문이다 — 인증 실패는 재시도해도 소용없고 사람이 토큰을 고쳐야 한다.

429는 한 걸음 더 나눈다. Cloudflare는 최소 두 가지 무관한 사유를 같은 HTTP 429로
묶어 보낸다 — 본문의 `errors[0].code`로만 구분할 수 있다:
`3036`(하루 무료 할당 10,000 Neurons 소진 → `QUOTA_EXHAUSTED`, 재시도 무의미,
할당은 매일 초기화)과 `3040`(데이터센터 용량 부족, 계정 할당과 무관 →
`CAPACITY`, 재시도하면 풀릴 수 있다). 그 외/코드를 알 수 없는 429는 `RATE_LIMITED`로
남고, 원인을 추측하지 않는 대신 Cloudflare가 보낸 `code`·`message`를 그대로 옮겨
싣는다(본문 전체가 아니라 이 두 필드만 화이트리스트 — 401/403처럼 토큰 노출
우려가 있는 나머지 필드는 여전히 담지 않는다).

`ABORTED`(호출자 취소)와 `TIMEOUT`(내부 타이머)을 구분하는 이유도 비슷하다 —
의도적 취소를 재시도 대상으로 표시하면 호출자가 멈추라고 한 요청을 다시 쏜다.

### 3-4. 예산

무료 할당은 **하루 10,000 Neurons**, 초과분은 1,000 Neurons당 $0.011다.
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`는 100만 토큰당 입력 26,668 / 출력 204,805
Neurons다.

| 시나리오 | 입력 | 출력 | Neurons/턴 | 무료 한도 내 턴 수 |
| --- | ---: | ---: | ---: | ---: |
| 짧은 서술 (약 400자) | 2,900 | 350 | 149 | **67** |
| 표준 (약 600자) | 3,650 | 500 | 200 | **50** |
| 긴 서술 (약 1,000자) | 4,800 | 800 | 292 | **34** |

표준 시나리오의 199.7407 Neurons는 `tests/budget.test.mjs`가 고정하고 있다.

**8B로 내려도 소용이 없다.** `llama-3.1-8b-instruct`는 입력 25,608 / 출력 75,147로 입력
단가가 70B와 거의 같다. 표준 시나리오에서 200 → 131 Neurons, 절감은 35%뿐인데 한국어
롤플레이 서술 품질 차이는 그보다 훨씬 크다. **서술 모델은 70B로 고정한다.**

출력이 비용의 48~56%이고 최근 턴 원문이 입력의 45%를 차지한다. 그래서 레버는 둘이다 —
서술 길이(`max_tokens`)와 보관 턴 수(`recent_turns`). 둘 다 세션 설정으로 노출한다.

**모르는 모델의 비용은 0이 아니라 `null`로 보고한다.** 계량기가 조용히 거짓말을 하면
예산 표시 전체가 무의미해진다. 같은 이유로 응답에 `usage`가 없으면 0으로 집계하지 않고
어림값으로 세면서 `turn.usage.estimated = true`로 표시한다.

## 4. 기억층

프롬프트는 **고정 프리픽스 + 기억 4층**이다. 이것 말고는 아무것도 들어가지 않는다.

| | 내용 | 토큰 | 상태 |
| --- | --- | ---: | --- |
| 프리픽스 | 캐릭터 카드 + 세계관 규칙·금지사항 | 700 | M1 |
| 단기 | **최근 3턴** 원문 | 1,650 | M1 |
| 중기 | 8턴마다 압축한 요약 체인 | 400 | M4 |
| 장기 | **상태 그래프** 직렬화 | 300 | M3 |
| 자료 | RAG로 뽑은 설정 조각 | 600 | M4 |

**M1은 프리픽스와 단기 기억만 만든다.** 나머지 자리를 지금 빈 블록으로 만들어 두지
않는다 — 빈 블록도 토큰을 먹고 모델이 그것을 지시로 오해한다.

최근 턴은 대화 로그가 아니라 `user`/`assistant` 쌍으로 싣는다. 한 덩어리 텍스트로 넣으면
모델이 그것을 "지금까지의 서술"이 아니라 "따라 써야 할 예시"로 다룬다.

**한 턴은 쌍으로 들어가거나 통째로 빠진다.** 모델이 빈 서술을 돌려준 실패한 턴을
사용자 발화만 남겨 실으면 답을 못 받은 지시처럼 보이고, 같은 역할 메시지가 연달아 붙어
chat 형식도 깨진다.

리뷰어가 demo 픽스처로 실제 렌더한 프리픽스는 636자(약 320~420토큰)로 700토큰 예산
안에 들어온다. 카드 1장 기준이며 M2에서 카드가 늘면 다시 재야 한다.

## 5. 서술과 선택지 가르기

모델은 장면을 쓴 뒤 `<선택지>` 태그 다음에 선택지 3개를 쓴다. 경계가 한국어 제목
(`[선택지]`)이 아니라 태그인 이유는 앞의 것이 서술 본문에도 나올 수 있기 때문이다.

**모델이 형식을 안 지키는 일은 반드시 생긴다.** 그때 턴을 실패시키지 않고 선택지 없는
턴으로 넘긴다 — 사용자는 자유 입력으로 계속할 수 있다.

스트리밍이 이 채널의 까다로운 부분이다. 마커는 청크 경계에 쪼개져 도착할 수 있어서
(`"<선"` 다음 `"택지>"`), 분할기는 **마커 길이-1(4자)만큼 꼬리를 붙들고 있다가** 마커가
아님이 확정되면 그때 내보낸다. 그러지 않으면 화면에 `<선택지>`가 잠깐 나타났다 사라진다.

그 대가로 `push()`가 돌려주는 것은 언제나 확정분의 접두사다 — 어느 순간에도 "지금까지
받은 전부"가 아니다. 대신 `finish()`가 남은 delta와 전체 텍스트를 함께 돌려주고,
선택지 파싱은 전체 텍스트로 한다.

## 6. 데이터 계약

### 6-1. 신규 객체

| 객체 | 필드 |
| --- | --- |
| `World` | `world_id`, `title`, `source_type`, `source_url`, `setting`, `tone`, `rules[]`, `forbidden[]`, `created_at` |
| `CharacterCard` | `card_id`, `world_id`, `canonical_name`, `aliases[]`, `persona{traits,values,taboos}`, `speech{first_person,endings,address_rules,examples}`, `appearance`, `relationships[]`, `knowledge_as_of`, `source{}`, `status` |
| `Session` | `session_id`, `world_id`, `card_ids[]`, `pov`, `opening`, `turns[]`, `turn_count`, `summary_chain[]`, `created_at`, `settings{recent_turns, max_tokens}` |
| `Turn` | `turn_id`, `session_id`, `index`, `user_input`, `narration`, `choices[]`, `events[]`, `state_changes[]`, `audit{violations[]}`, `usage`, `model`, `extraction_failed` |

`Turn.events[]`, `state_changes[]`, `audit{violations[]}`, `Session.summary_chain[]`은
M1에서 늘 비어 있다. M3의 추출 채널과 M4의 요약 체인이 채운다. 자리를 지금 비워 두는
이유는 나중에 `Turn`/`Session` 모양이 바뀌면 저장된 세션이 전부 깨지기 때문이다.

`created_at`은 `createSession`/`normalizeWorld`가 아니라 `createSession`을 호출하는
지점(생성 시점)에서만 만든다. `normalizeSession`/`normalizeWorld`는 값이 있으면
보존하고 없으면 빈 문자열로 둘 뿐, 여기서 새로 생성하지 않는다 — 두 정규화 함수는
요청마다 다시 도는데 여기서 생성하면 호출할 때마다 값이 바뀌어 정규화가 멱등하지
않게 된다.

`Session`에는 `budget` 필드가 없다. Cloudflare의 무료 할당은 계정 단위로 하루에 한 번
초기화되므로 장부는 세션이 아니라 프로세스(`server.js`의 `turnBudget`)가 소유한다 —
세션마다 복사해 두면 동시에 열린 세션들이 같은 할당을 중복 집계한다.

### 6-2. id 생성 규칙

두 규칙이 다르고, 그 차이에 근거가 있다.

- **`card_id`는 결정적이다** — `worldId:canonical_name`의 slug이며, 명시된 값이 있으면
  그것이 이긴다. 서버가 매 턴 요청마다 `data/worlds/*.json`을 다시 읽고
  `loadWorldFile`을 부르므로, 모듈 카운터를 쓰면 같은 카드가 요청마다 다른 id를 받고
  브라우저에 저장된 `session.pov`가 매칭에 실패한다.
- **`session_id`와 `turn_id`는 `crypto.randomUUID()`다** — 이것들은 파생값이 아니라
  정체성이라 결정적일 필요가 없다. 모듈 카운터는 프로세스가 재시작하면 0부터 다시 세고,
  세션은 브라우저 `localStorage`에 저장되므로 그때 이미 저장된 id와 충돌한다.
  `node:crypto`가 아니라 전역 `crypto`를 쓴다 — `src/core/`는 브라우저에서도 도는 공용
  코드다.

### 6-3. 재사용 객체 — 좌표만 교체

`Event`, `CharacterState`, `Relation`은 스키마를 유지하고 시간 좌표만 바꾼다.
`segment_id`와 `source_span`이 빠지고 `turn_index`(1부터인 정수, 0은 좌표 없음)가 들어온다.
M3에서 실제로 채워진다.

### 6-4. 저장

세션은 브라우저 `localStorage`에 저장된다. 서버는 세션을 보관하지 않고, 브라우저가 매
요청에 통째로 보낸다. 그래서 **서버는 받은 세션을 신뢰하지 않는다** —
`normalizeSession()`이 컨테이너와 `turns[]` 원소의 모양을 모두 고정하고, `turn_count`는
저장값이 아니라 `turns.length`에서 다시 센다. 5MB 한도와 서버 파일 이전은 M4의 일이다.

세계관과 카드는 `data/worlds/{world_id}.json`에서 읽는다. **`world_id`는
`[a-z0-9_-]+`로 제한된다** — 그대로 경로에 들어가므로 `../`를 허용하면 이 서버가 임의
파일 읽기 도구가 된다. 위키문헌 호스트 화이트리스트와 같은 이유다.

## 7. 설계에서 값나간 결정들

M1은 태스크마다 독립 리뷰를 거쳤고, 리뷰가 잡은 결함 14건은 **전부 계획서의 참조 코드에서
온 것**이었다. 그중 코드를 읽는 사람이 되짚어야 할 것들을 남긴다.

| 결정 | 근거 |
| --- | --- |
| 모르는 모델은 `null`, 0이 아님 | 계량기가 조용히 거짓말을 하면 예산 표시가 무의미해진다 |
| `usage` 없으면 어림값 + `estimated: true` | 위와 같은 이유. 0으로 집계하지 않는다 |
| `release()`를 호출자가 부른다 | 스트리밍 본문을 읽는 동안 abort 릴레이가 붙어 있어야 호출자의 취소가 fetch까지 닿는다. `send()`가 알아서 떼면 그게 끊긴다 |
| `truncated`는 두 경로에서 켜진다 | 본문 순회 중 I/O 실패, 그리고 **마지막 프레임이 잘린 채 스트림이 얌전히 끝난 경우**. 후자는 안쪽 `catch`가 파싱 실패를 삼켜 바깥 `catch`가 아예 안 돌기 때문에 별도 플래그가 필요했다 |
| `appendTurn`이 `settings`·`card_ids`도 복사 | 얕은 스프레드는 불변성의 명시된 이유(브라우저 상태와 서버 응답이 객체를 공유하면 안 된다)를 반만 지킨다 |
| `loadWorldFile`을 `try`로 감싼다 | `loadWorldFile(raw = {})`의 기본 매개변수는 `undefined`에만 걸린다. 최상위가 `null`인 세계관 파일은 `raw.world`에서 던지고, async 핸들러 밖으로 나간 rejection을 Express 4가 잡지 않아 **프로세스가 죽는다** |
| `play.html`이 `response.ok`를 먼저 본다 | 스트림 시작 전에 나가는 오류는 JSON 한 덩어리라 `\n\n`이 없다. 그대로 SSE 파서에 넣으면 통째로 삼켜져 독자가 아무것도 못 본다 |
| 파일의 `world_id`가 카드의 것을 이긴다 | 세계관 파일을 파싱하는 로더에서 카드 항목의 stray 필드가 소속을 바꾸면 안 된다 |

## 8. 화면

| 경로 | 내용 |
| --- | --- |
| `/play` | 장면 서술 스트리밍, 자유 입력, 추천 선택지, 잘림 안내, 남은 Neurons |

읽는 화면이므로 계기판을 두지 않는다. 남은 Neurons만 구석에 작게 둔다. 세계관·카드
관리(`/worlds`)와 카드 검수(`/check` 전환), 상태 그래프 뷰(`/session`)는 M2 이후다.

`truncated`는 화면에 표시한다. 잘린 장면을 독자가 모르면 작가가 문장을 끊은 것으로 읽는다.

---

# 옛 앱 (분석기) — M3에서 제거

여기서부터는 `/analyze`와 `/check`에 남아 있는 분석기의 설계다. 코드는 그대로 동작하고
테스트도 통과한다. 피보팅 설계 문서 2-2절이 제거 대상과 이유를 정한다 — 규칙 추출,
시대 주석, 시각 묘사는 폐기하고, `asof`·`audit`·`query`·`recap`·`whatif`·`export_if`는
좌표만 바꿔 새 앱이 물려받는다.

아래 절 번호는 피보팅 이전 문서의 것을 그대로 둔다. 이 부분 안의 상호 참조("2절의 의존 방향" 같은)도 그때의 번호를 가리킨다 — 아직 동작하는 코드의 설명이라
고쳐 쓰기보다 원문을 보존하는 편이 낫다고 봤다.

## 3. 분석 파이프라인

### 규칙 분석 (기본, 브라우저)

1. 공백·줄바꿈 정규화 (`src/core/text.js`, 멱등)
2. 빈 줄 기준 `Segment` 생성. 긴 문단은 문장 경계를 우선해 1,000자 이하로 분할
3. `Scene` 구성 — 챕터를 알면(EPUB) 실제 경계, 모르면 최대 12개 균등 분할
4. seed 사전으로 인물·장소 추출 → `Mention` 앵커링
5. 문장별 사건 유형과 참여 인물·장소 판정
6. 인물 상태와 관계 계산, 시간 구간 부여, 제약 감사

### 상세 분석 (선택, Ollama 4B~7B)

장면 단위 map-reduce다. 원문 길이 제한이 없고 컨텍스트 절단이 일어나지 않는다.

| 단계 | 내용 |
| --- | --- |
| 분할 | 문장 경계 우선, 목표 1,000자(`DEFAULT_TARGET_CHARS`). 청크가 60개를 넘으면 목표를 키워 호출 수를 제한한다 |
| map | 청크마다 2회 호출 — (a) 인물·장소, (b) 사건 프레임·상태 변화 |
| 롤링 cast | 앞 청크까지 확인된 인물을 다음 프롬프트에 전달. 2개 청크 이상 등장했거나 규칙 채널과 합의한 인물만 편입한다 |
| reduce | 이름 정규화 dedupe, 별칭 누적, evidence가 그 청크 원문에 실제 있는지 검증(불일치 시 confidence 강등) |
| 관계 pass | 원문 대신 병합된 cast·사건 요약으로 1회 호출. 화이트리스트 밖 관계는 버린다 |
| 병합 | 브라우저가 동적 seed를 만들어 규칙 분석을 다시 돌리고, **원문 mention과 연결되는 객체만** 병합한다 |

`temperature: 0.1`, `num_ctx: 8192`, 프롬프트는 `num_ctx`의 60% 이하로 예산을 검사한다.
구조화 출력(JSON Schema)으로 디코딩을 강제하고 파싱 실패는 1회 재시도한다. 청크 일부가
실패해도 전체가 실패하지 않고 `scenes_failed`에 기록된다. 진행 상황은 SSE `progress`로
보낸다. 결과는 `hash(text + model + prompt_version)`로 디스크 캐시된다.

프롬프트 버전은 `scene-v2`이며 캐시 키에 포함된다.

## 4. 별칭 매칭 — 단일 규칙

`analyzer.js`의 `aliasPattern()` 한 곳만 별칭을 원문에서 찾는다. mention 채널,
사건 채널, LLM 병합 채널이 모두 이 함수를 쓴다.

- 앞: 한글로 시작하는 별칭은 한글 뒤에 붙어 있으면 안 된다(단어 내부 매칭 금지).
- 뒤: 한글로 끝나는 별칭은 **조사 하나까지만** 허용하고 그 뒤는 한글이 아니어야 한다.
  `복녀도`는 인정하고 `복녀들`은 거부한다. `나가서`의 `나`+`가`도 뒤에 `서`가 있어 거부된다.

조사 허용과 뒤 경계 확인은 둘 다 필요하다. 경계만 보면 조사 결합형을 통째로 놓치고,
조사만 허용하면 활용형을 잡는다. 예전에는 세 채널이 서로 다른 규칙을 써서 같은 문장에
다른 답을 냈고, 그 불일치가 그대로 `actor` 제약 위반으로 쌓였다.

엔티티 경계 판정 기준(외부 문서용):

- 인물: `아내`, `남편`, `마나님`, `선생` 같은 명시적 사람 지칭어를 우선한다. 일반 이름
  후보는 반복 출현 + 주격·화제 조사 + 사람 행위 문맥이 함께 있어야 한다.
- 장소: 공백 없는 핵심 명사만. 처소 조사·이동 동사 문맥을 근거로 쓴다.
  `불길`, `시집`, `징역`처럼 장소 접미사와 철자가 겹치는 일반어는 제외한다.
- 오탐 금지 목록: `모양`, `조밥`, `마음`, `얼굴`, `머리`, `소리`, `활극`, `바구니`,
  `불길`, `징역`, `들어가게`. `tests/analyzer.test.mjs`가 지킨다.

## 5. 데이터 계약

```text
analysis
├─ document, segments[], scenes[], mentions[]
├─ segments[].description_spans[] # 인물·장소가 주어인 절의 원문 묘사
├─ characters[], locations[], events[], states[], relations[]
├─ annotations[]     # 시대 주석. 앵커는 원문, 내용은 외부 링크
├─ branches[]        # what-if 생성물. 없을 수 있다
├─ dynamic_lexicon
└─ diagnostics       # engine, seed_lexicon, warnings, counts, audit
```

| 객체 | 필드 |
| --- | --- |
| `Document` | `document_id`, `sample_id`, `title`, `author`, `publication_year`, `language`, `source`, `source_url`, `rights`, `created_at` |
| `Segment` | `segment_id`, `document_id`, `index`, `scene_id`, `text`, `char_start`, `char_end`, `description_spans[]` |
| `Scene` | `scene_id`, `document_id`, `index`, `title`, `start_segment_id`, `end_segment_id`, `summary`, (EPUB) `source_ref` |
| `Mention` | `mention_id`, `entity_type`, `entity_id`, `text`, `segment_id`, `char_start`, `char_end`, `status`, `confidence`, `method` |
| `DescriptionSpan` | `description_id`, `entity_type`, `entity_id`, `entity_name`, `subject_text`, `subject_kind`, `categories[]`, `matched_terms[]`, `segment_id`, `text`, `char_start`, `char_end`, `image`(`null`), `status`, `confidence`, `method` |
| `Character` | `character_id`, `canonical_name`, `aliases`, `mentions`, `first_segment_id`, `description`, `role`, `status`, `confidence`, `method`, `valid_from`, `valid_to` |
| `Location` | `location_id`, `name`, `aliases`, `mentions`, `first_segment_id`, `type`, `parent_name`, `parent_location_id`, `description`, `narrative_coords`, `status`, `confidence`, `method`, `valid_from`, `valid_to` |
| `Event` | `event_id`, `document_id`, `type`, `summary`, `segment_id`, `scene_id`, `sentence_index`, `characters`, `locations`, `source_span`, `status`, `confidence`, `method` |
| `CharacterState` | `state_id`, `character_id`, `segment_id`, `location_id`, `mental_state`, `physical_state`, `known_facts`, `source_event_ids`, `status`, `valid_from`, `valid_to`, `invalidated_by` |
| `Annotation` | `annotation_id`, `document_id`, `term`, `category`, `era`, `segment_id`, `text`, `char_start`, `char_end`, `references[{label,url,source}]`, `note`, `status`, `confidence`, `method`, `valid_from`, `valid_to` |
| `Relation` | `relation_id`, `source_type`, `source_id`, `target_type`, `target_id`, `relation_type`, `event_ids`, `segment_ids`, `weight`, `status`, `valid_from`, `valid_to`, `invalidated_by` |

상태값: `suggested`(자동 제안) · `confirmed`(확정) · `edited`(수정) · `rejected`(제외) ·
`manual`(직접 생성). `active` 필터는 저장값이 아니라 "`rejected`가 아님"을 뜻한다.

사건 유형: `appearance`, `movement`, `conversation`, `perception`, `conflict`,
`realization`, `stasis`, `symbolic`, `background`.

규칙 채널이 만드는 관계는 `participates_in`(character→event), `appears_in`
(character→location), `takes_place_at`(event→location) 셋뿐이다. 인물 간 관계
(`knows`, `family_of`, `enemy_of` 등)는 계약과 LLM 화이트리스트에는 있지만 규칙으로는
만들지 않는다 — 근거 없이 만드느니 비운다.

## 6. 서사 시간 (`src/core/asof.js`)

시간 좌표는 segment id가 아니라 **segment index(1부터인 정수)**다. 구간 비교가 가능해야
하고, 나중에 EPUB 챕터나 CFI로 재사상할 수 있어야 한다. `0`은 좌표 없음이며 어떤
시점에도 보이지 않는다. `valid_to: null`은 열린 구간이다.

술어 두 개를 구분한다. 이 구분이 모듈의 핵심이다.

| 술어 | 정의 | 쓰임 |
| --- | --- | --- |
| KNOWN(t) | `valid_from <= t` | 독자가 읽어서 **알게 된** 사실. 스포일러 범위 |
| TRUE(t) | `valid_from <= t <= valid_to` | 그 시점에 **여전히 유효한** 사실. 현재 상태 조회 |

퇴장한 인물이나 끝난 관계도 KNOWN으로 남는다. 이미 읽었기 때문이다.

같은 인물의 다음 상태 레코드가 이전 구간을 닫고, 그 레코드를 만든 사건이
`invalidated_by`가 된다. 이전 상태를 지우지 않으므로 "왜 바뀌었는가"를 사건 하나로
되짚을 수 있다. 규칙 채널은 인물·장소·관계의 `valid_to`를 채우지 않는다 — 원문에서
퇴장·단절을 근거 있게 판정할 방법이 없다. 필드는 계약으로 존재하며 검수·LLM이 채운다.

**판정은 `asOf()` 한 곳에만 있다.** `src/app/utils.js`의 `isVisibleSegmentId`도 `isKnownAt()`에
위임하고, `src/app/view/selectors.js`는 `asOf()` 결과에 표시 필터만 얹는다.
`index <= currentSegment` 비교를 다른 곳에 다시 쓰면 판정이 두 벌이 되고, 어긋난 지점이
곧 누출이다. `/check` 경로는 검수 대상 전체를 봐야 하므로 시점 제한을 끈다.

## 6-1. 조합 질의 (`src/core/query.js`)

`queryScenes()`는 `(시점 구간 × 인물 × 장소 × 사건 유형)` 하나를 받아 사건과 원문 근거를
돌려준다. 관계 지도·사건 흐름·인물 상태는 별개 조회가 아니라 **이 질의의 프리셋**이다.

| 프리셋 | 구간 | 조건 |
| --- | --- | --- |
| 관계 지도 | `from = to = 현재 단락` | 화면 공통 필터 |
| 사건 흐름 | `from = 1`, `to = at` | 화면 공통 필터 |
| 인물 상태 | `from = 1`, `to = at` | `characters: [그 인물]` |

축마다 결합 방식이 다르고 그 차이는 원문의 성질에서 온다. **인물은 AND**다 — 나열한
인물이 모두 참여한 사건만 남으므로 두 명을 주면 공동 출현 조회가 된다. **장소와 유형은
OR**다. 한 사건은 한 자리에서 일어나므로 장소 여러 개는 후보 나열이다.

판정은 여기 없다. 상한(`gate`)은 `asOf()`가 정하고 `to`는 그 값을 넘지 못하도록 잘린다.
`from`은 하한이라 더 가리기만 한다 — 두 방향 모두 허용 범위를 넓히지 않으므로 조합
필터는 누출 경로가 될 수 없다. 결과에 딸려 나오는 인물·장소도 `asOf()`가 통과시킨
집합에서만 고른다. 사건이 참조한다는 이유로 아직 알려지지 않은 객체를 돌려주지 않는다.

화면 공통 필터(사건 유형·객체)는 별도 개념이 아니라 그냥 이 질의의 조건이다. 화면마다
필터를 따로 구현하면 같은 조건에 다른 답이 나오고, 축을 섞은 질문("복녀와 왕 서방이
함께 나오는 장면")을 담을 자리가 없어진다.

빈 결과는 지금 그냥 0건으로 보인다. "그 조합은 원문에 없다"를 정보로 렌더링하는 것은
아직 계약에 없다 — 근거가 원문 offset이 아니라 검사 구간이므로 1원칙을 확장해야 한다.

## 6-2. 읽은 데까지의 요약 (`src/core/recap.js`)

`recapAt()`은 시점 하나를 받아 그 시점의 **사건 유형 집계, 인물별 현재 상태, 감사 counts**를
돌려준다. 오래 쉬었다 돌아온 독자가 잃는 것은 줄거리가 아니라 누가 지금 어떤 상태인가인데,
사건 흐름은 목록이라 훑어야 하고 인물 상태는 한 번에 한 인물이라 그 자리가 비어 있었다.

**세기만 하고 쓰지 않는다.** 원문을 재서술하거나 문장을 생성하지 않는다(7-1과 같은 이유).
`tests/recap.test.mjs`가 반환값에 원문 조각이 섞이지 않는지 검사한다.

MCP의 `arc_summary`는 이 함수의 어댑터다. 예전에는 같은 집계가 `mcp/tools.js` 안에만
있어서 화면에서 쓸 수 없었다 — 2절의 의존 방향(판정은 `core/`에) 위반이기도 했다.

## 7. 제약 감사 (`src/core/audit.js`)

`diagnostics.audit = { counts, violations[] }`, violation은
`{ code, severity, target_type, target_id, segment_index, message }`다.

| code | 판정 | 등급 |
| --- | --- | --- |
| `actor` | 사건 참여 인물의 mention이 그 단락에 없다 | error |
| `scope` | 근거 offset이 단락 범위 밖이거나 근거가 없다 | error |
| `polarity` | 부정 표현이 있는 문장에서 실제 행동 사건을 추출했다 | warn |
| `state` | 같은 시점에 모순된 상태 / 아직 등장하지 않은 장소를 현재 위치로 지목 | error |
| `temporal` | 구간이 뒤집히거나 겹치거나 인물 첫 등장보다 앞선다 | error |
| `reference` | 주석 앵커가 원문과 어긋나거나 출처 링크가 없거나 허용 밖 호스트다 | error |

감사는 **판정만 하고 고치지 않는다.** 자동 확정을 금지하는 것과 같은 이유다.
`asOf()`가 감사 결과도 시점으로 잘라내므로 아직 읽지 않은 구간의 위반은 보이지 않는다.
`warn`은 휴리스틱 의심이므로 원문을 보고 판단한다. 일괄 제외하면 안 된다.

## 7-1. 시대 주석 (`PERIOD_TERM_LEXICON`)

역사·문화 맥락은 정의상 원문에 없다. 그래서 1원칙("모든 주장은 원문 offset으로 되짚을 수
있어야 한다")을 지키려면 주석을 둘로 쪼개야 한다.

- **앵커**는 원문 span이다. 어디에 붙는지는 언제나 원문으로 되짚인다. `reference` 감사가
  앵커 문자열과 원문이 일치하는지 매번 확인한다.
- **내용**은 만들지 않는다. 외부 링크만 건다. 자동 채널은 `note`를 **언제나 빈 문자열로**
  두고, 사람이 `/check`에서 채우면 그 항목이 `edited`가 된다.

로컬 4B 모델이 쓴 역사 서술은 검증할 방법이 없고, 틀린 맥락은 없는 맥락보다 나쁘다.
그래서 이 채널만은 LLM을 쓰지 않는다 — 앱 전체에서 유일하게 "생성하지 않는 것"이 설계다.

용어 매칭은 별칭 단일 규칙(`aliasPattern()`)을 그대로 쓴다. 용어도 조사를 받으므로
(`경성역으로`) 여기서 규칙을 새로 쓰면 화면과 에이전트의 답이 갈라진다. 한 단락에서 같은
용어는 한 번만 단다.

주석도 서사 시간 위에 있다. 아직 읽지 않은 단락의 주석을 보여 주면 그 자체가 누출이다 —
「날개」의 `아달린`은 그 낱말이 나오는 순간이 곧 사건이다.

출처 링크는 `scripts/verify_references.mjs`가 실존·동음이의·리다이렉트를 확인한다.
사전에 항목을 추가하면 반드시 돌려라. 이 기능에서 깨진 링크는 유일하게 치명적인 결함이다.
네트워크가 없으면 실패가 아니라 건너뛴다.

## 7-2. 시각 묘사 (`VISUAL_DESCRIPTION_LEXICON`)

시각 묘사는 새 문장을 쓰는 채널이 아니라 **원문 절 수집기**다. `appearance`(외형),
`clothing`(복식), `space`(공간) 어휘가 있고, 인물·장소의 별칭이 그 절의 주어이거나
`복녀의 얼굴은`처럼 사전에 든 신체·공간 말의 소유격 주어일 때만 수집한다. 단순히 mention
주변을 긁지 않으므로 자주 언급되는 인물의 행동·대상 문장이 묘사로 섞이지 않는다.

별칭 표층형은 다른 채널과 똑같이 `aliasPattern()` 하나로 찾는다. 문서가 길수록 우연한
어휘 하나만으로 통과하지 않도록 근거 문턱은 segment 수에 비례하되, 한두 문단짜리 입력은
주어와 묘사 어휘 하나만 있어도 동작한다.

결과는 `segments[].description_spans[]`에 원문 절과 전역 문자 offset으로 저장한다.
리더와 MCP 분석 리소스는 `asOf()`가 돌려준 segment 안의 span만 사용하므로 아직 읽지 않은
묘사가 새지 않는다. `image`는 현재 항상 `null`이다. 이미지 생성·프롬프트 조립은 묘사
레이어 품질을 별도로 검증할 때까지 계약에 없다.

## 8. what-if 분기 (`src/core/whatif.js`, `src/server/whatif.js`)

분기 시드는 `asOf(fork)` 스냅샷뿐이고 **분기 시점 이후의 원문·사건은 프롬프트에 들어가지
않는다.** 서버는 `seed.text`나 `seed.segments`가 있으면 400으로 거부한다. 모델에게
원작을 베낄 재료를 주지 않는 것이 유일하게 확실한 방법이며, 생성 후
`detectCanonLeak()`이 분기 이후 원문·사건 요약과 12자 이상 연속 일치하는지 다시 본다.

호출은 2단계다 — 대안 행동 제안, 그다음 선택별 전개. 한 호출 = 한 작업 원칙은 추출
파이프라인과 같다. 생성이므로 `temperature`는 0.1이 아니라 0.6이다. 같은 전제로 다시
돌리면 다른 전개가 나와야 하므로 **캐시하지 않는다.**

산문이 아니라 사건 프레임과 상태 변화만 만든다. 그래야 구조화 출력으로 강제할 수 있고
검증도 계약 검사로 가능하다. 결과는 `branches[]`에만 쌓이고 원작 컬렉션을 바꾸지 않는다.

| `branches[]` 필드 | 의미 |
| --- | --- |
| `branch_id` / `parent_branch_id` | 분기 id와 부모. 원작은 `canon` |
| `fork_segment` / `fork_event_id` | 갈라진 시점과 그 사건 |
| `premise` | 분기 전제 한 문장 |
| `events[]` | `origin: "generated"`, `status: "suggested"`. `segment_id`도 `source_span`도 없다 |
| `states[]` | 인물별 심리·신체·위치 변화와 이를 일으킨 사건 |
| `diagnostics.canon_leak[]` | 분기 이후 원작을 인용한 지점 |
| `diagnostics.unknown_characters[]` | 그 시점에 없어 제거된 이름 |
| `rubric` | 사람이 매긴 3점 채점(주제 일관성·상태 정합성·구조 완결성) |

품질은 자동 채점하지 않는다. 서사 품질은 계약 검사로 판정할 수 없다. 자동으로 알 수 있는
것(원작 인용, 미등장 인물, 행위자 없는 사건)만 `branchIssues()`가 잡는다.

## 9. 입력

| 입력 | seed | Scene |
| --- | --- | --- |
| 「날개」 / 「감자」 | 작품별 정적 seed | 균등 분할 |
| TXT 업로드 | 원문에서 만든 동적 seed | 균등 분할 |
| EPUB 업로드 | 동적 seed | **실제 챕터 경계** |
| 위키문헌 | 동적 seed | 균등 분할 |

EPUB 리더(`src/core/epub.js`)는 의존성이 없다. 표준 `DecompressionStream("deflate-raw")`로
ZIP을 풀고 OPF·XHTML을 직접 읽는다. 번들러 없이 npm 패키지를 브라우저에 넣으려면 빌드
단계가 생기고, 그러면 "빌드 없음"이라는 구조적 장점이 사라진다. ZIP64·암호화·이미지는
다루지 않고 본문 텍스트만 읽는다. EPUB CFI는 만들지 않는다 — XHTML DOM 경로를 재현하지
않으면 가짜 CFI가 되므로 `source_ref`에 spine 순번과 href만 남긴다(챕터 수준 위치 지정).

챕터 offset은 정규화된 최종 텍스트 기준이며, `normalizeSourceText`가 멱등이라 분석기가
다시 정규화해도 어긋나지 않는다. 사용자가 원문을 편집하면 offset이 밀리므로 컨트롤러가
챕터를 버리고 균등 분할로 되돌린다.

위키문헌 가져오기는 `*.wikisource.org` 호스트만 허용한다 — 임의 URL을 받으면 이 서버가
열린 프록시가 된다. 권리 표기는 자동 판정하지 않고 `unverified`로 기록하며, 이 값은
MCP의 원문 배포 게이트에 그대로 작용한다.

## 10. 화면

`/`와 `/check` 두 경로 모두 같은 `index.html`을 History API로 렌더링한다.

| 영역 | 내용 |
| --- | --- |
| Reader | 원문 입력·편집, segment 목록, 독서 위치, 읽은 범위의 인물·장소 묘사 인용 |
| Reader ▸ 여기까지의 요약 | 읽은 데까지의 사건 유형 집계와 인물 현재 상태 (`core/recap.js`) |
| 관계 지도 | 현재 segment의 인물·장소·사건 연결과 Inspector |
| 사건 흐름 | 현재 범위까지의 사건 |
| 인물 상태 | 상태 이력, 관계, 공간 궤적 |
| 분기 (what-if) | 분기점 선택, 전제 입력, 생성, 인용 경고, 루브릭 채점 |
| 내보내기 | 7종 형식 생성·복사·다운로드 |
| `/check` | 근거 강조, 검수 목록, 상태 변경, 수동 사건 추가 |

검수 목록의 기본 정렬은 **읽은 차례**(첫 등장 단락 index)다. 예전 기본값이던 위반·신뢰도
순은 추출기를 정비하는 순서라서 같은 작업이 오류 사냥으로만 보인다. 읽은 차례로 놓으면
"이 단락에서 새로 알게 된 것을 확정한다"가 된다. 오류 사냥도 여전히 필요하므로 예전
순서는 `위반·신뢰도` 모드로 남아 있다.

**정렬은 무엇이 목록에 들어가는지를 바꾸지 않는다.** `/check`가 시점 제한을 끄는 것은
설계이므로(6절), 단락 index는 가리는 기준이 아니라 늘어놓는 기준으로만 쓴다. 각 행에
`P###` 표시가 붙는 이유도 그것이다 — 표시가 없으면 새 기본 정렬이 임의 순서로 보인다.

스냅샷은 `localStorage`의 `novel-if-reader:snapshot`에 저장된다. 서버·다른 기기와
동기화되지 않으며 브라우저 데이터를 지우면 사라진다.

## 11. MCP 계약

`mcp/server.js`는 Express와 별개인 stdio 서버다. 분석하지 않고 `analyzer.js`·`core/`를
재사용한다. 라이브러리는 `NOVEL_IF_LIBRARY`(기본 `texts/`)의 `*.txt`이며, 같은 이름의
`*.meta.json`이 제목·저자·`rights`·`source_url`을 덮어쓴다. `document_id`는 파일 이름이고
`analyzeNovel`의 `sample.id`로 전달되므로 내장 샘플 id와 같으면 정적 seed가 적용된다.

1. 사실 조회 도구는 `as_of` 없이는 거부한다. 기본값이 곧 스포일러이므로 기본값을 두지
   않는다. `list_works`만 예외다.
2. 모든 사실에 `evidence`(원문 인용 + segment index), `confidence`, `status`, `method`가
   붙는다. 근거를 만들 수 없는 항목은 응답에서 제거된다.
3. 쓰기 도구가 없다. 확정·수정은 `/check`에서만 한다.
4. `rights`가 `public-domain`으로 시작하지 않으면 원문 단락 제공을 거부한다. 사실 조회와
   근거 인용은 계속 동작한다.
5. `annotations_as_of`는 **링크만** 돌려준다. 역사 서술을 생성하지 않는다.

리소스는 `novel://{document_id}/analysis/{as_of}`와 `novel://{document_id}/segment/{n}`,
프롬프트는 `spoiler-safe-question`과 `character-interview`다. 둘 다 현재 독서 위치를
고정하고 근거 없는 추측을 금지한다. 분석 리소스의 각 segment에는 그 시점까지 보이는
`description_spans`가 들어가며 별도 분석 규칙은 MCP에 없다.

---

# 테스트 지도

`npm test`는 Ollama·네트워크·Cloudflare 없이 **284건**을 실행한다 — 옛 앱 161건과 새 앱
123건이다. M1은 옛 앱 코드를 한 줄도 바꾸지 않았으므로 두 묶음이 함께 초록이다.

## 새 앱

| 파일 | 건수 | 무엇을 지키는가 |
| --- | ---: | --- |
| `budget.test.mjs` | 9 | Neuron 산수(표준 시나리오 199.7407), 미상 모델이 0이 아닌 `null`, UTC 일 단위 초기화 |
| `cloudflare_client.test.mjs` | 23 | REST 계약, 오류 매핑 8종, **토큰 미유출**, abort 리스너 해제, `ABORTED`/`TIMEOUT` 구분, SSE 프레임 재조립·깨진 프레임 격리·`[DONE]` 이후 무시·`truncated` 두 경로 |
| `card.test.mjs` | 12 | 카드 정규화, **id 결정성**, 파일의 `world_id`가 카드의 것을 이김, 빈 라벨 생략, 픽스처 로드 |
| `session.test.mjs` | 24 | 1부터인 `turn_index`, **불변 갱신**(`settings`·`card_ids` 포함), 적대적 입력의 모양 고정, `turn_count` 재계산 |
| `narration.test.mjs` | 9 | 마커 파싱 관용도(4가지 번호 표기), 마커 없을 때 degrade, **분할기 홀드백**(마커가 조각으로 와도 화면에 안 샘) |
| `memory.test.mjs` | 11 | system 1개·마지막은 언제나 user, 최근 N턴 창, 오프닝은 첫 턴만, **인접 동일 역할 없음** |
| `turn.test.mjs` | 13 | 서술/선택지 가르기, **`onNarration`에 마커 미유출**, 실제/추정 usage 집계, 선택지 없어도 성공, `truncated` 전달, 원본 세션 불변 |
| `turn_api.test.mjs` | 11 | HTTP 계약, SSE 순서, **비밀 미유출**, **경로 조작 거부**, 429→502, **망가진 세계관 파일에도 프로세스 생존**, 모델 허용목록 |
| `routes.test.mjs` | 4 | `/`가 랜딩을 주고 분석기 마크업을 주지 않음(static의 디렉터리 인덱스가 `/`를 가로채는 회귀를 잡는다), `/analyze`·`/check`·`/play` 도달 |
| `env.test.mjs` | 7 | **이미 설정된 환경변수가 `.env`를 이김**, 따옴표·주석·`export` 접두·첫 `=` 분리, 깨진 줄과 없는 파일에도 안 던짐 |

`npm test`가 커버하지 않는 것: 실제 Cloudflare 호출, 실제 서술 품질, 30턴 세션에서의
캐릭터 일관성. 앞의 둘은 검증 방법이 없고 마지막은 M3의 감사 되먹임이 잡을 자리다.

## 옛 앱

| 파일 | 무엇을 지키는가 |
| --- | --- |
| `analyzer.test.mjs` | 엔티티 경계, 조사 결합형 인정, 단어 내부 매칭 금지, 두 채널 합의(actor=0) |
| `asof.test.mjs` | 구간 부여, 단조성, 누출 없음, KNOWN/TRUE 구분, 무효화 이력 |
| `query.test.mjs` | 어떤 조합으로도 상한 초과 없음, `to` 잘림, AND/OR 결합, 근거 동반, 프리셋 동치 |
| `recap.test.mjs` | 집계가 `asOf()` 통과분과 일치, 상한 잘림, 원문 재서술 없음, MCP 어댑터 동치 |
| `audit.test.mjs` | 제약 5축 탐지(정상 데이터에 위반을 주입해 검증) |
| `whatif.test.mjs` | 시드에 미래 없음, 생성물 격리, 원작 인용 검출, ink/Twee 참조 무결성 |
| `epub.test.mjs` | ZIP·OPF 파싱, 챕터 offset 유효성, 챕터 경계 Scene |
| `mcp_tools.test.mjs` / `mcp_server.test.mjs` | `as_of` 강제, 근거 동반, 권리 게이트, stdio 노출 |
| `scene_pipeline.test.mjs` / `ollama_merge.test.mjs` | 청크 분할·병합·부분 실패·evidence 검증, mention 앵커링 게이트 |
| `server_api.test.mjs` | HTTP 계약, SSE, 캐시, what-if 프롬프트에 미래 없음 |
| `wikisource.test.mjs` | 호스트 제한, 구조화 오류 |
| `module_wiring.test.mjs` | import 없이 호출하는 함수 없음 |
| `asof_qa.test.mjs` | 시점 질의 평가셋 전체 통과와 누출 0 |
| `annotations.test.mjs` / `descriptions.test.mjs` | 주석 앵커 무결성·링크 허용 호스트·시점 가림, 묘사 원문 offset·주어 절 제한 |

평가는 두 축이다. `npm run eval`은 골든셋 precision/recall, `npm run eval:qa`는 "그 시점에
답할 수 있는가 / 미래를 흘리지 않는가"를 잰다. `npm run verify:refs`는 네트워크가 있을
때만 도는 별개 검사다. 외부 벤치마크 수치를 완료 기준으로 쓰지 않는다.

# 알려진 한계

## 새 앱

- **아직 사람이 실제로 30턴을 돌려 보지 않았다.** 자동 테스트로는 "재미있는가"를 알 수
  없고, 재미없으면 M2 이후가 헛수고다. 몇 턴째부터 캐릭터가 무너지는지, 선택지가 서로
  다른 방향을 가리키는지, 실측 Neurons가 추정과 얼마나 다른지가 미확인이다.
- 3-4절 토큰 추정표는 한국어 600자 ≈ 500토큰 가정이며 **실측이 아니다.** M4의 계량기가
  실제 `usage`를 쌓으면 교체한다.
- 로컬 4B가 대화 턴에서 상태를 정확히 뽑는지 검증되지 않았다. 옛 파이프라인은 소설 원문
  분석이었고 이건 다른 과제다. 실패하면 추출을 클라우드 JSON 모드로 올려야 하고 하루
  턴 수가 30 수준으로 떨어진다.
- 하루 50턴이 실사용에 충분한지 모른다. 한 세션 30턴이면 하루 두 세션이 안 된다.
- Workers AI 카탈로그의 대형 모델(DeepSeek V4 Pro 등) Neuron 단가를 확인하지 않았다.
  70B보다 싸거나 비슷하면 서술 품질이 크게 오른다.
- 세션 저장이 브라우저 전용이라 5MB 한도에 걸릴 수 있다(턴당 약 2KB). M4에서 서버
  파일로 옮긴다.
- `world_id` 정규식이 대소문자를 허용해 Windows(대소문자 무시)와 Linux에서 동작이 갈린다.
- 스트림이 프레임 중간에 끊기면 `/play`의 문단이 pending 상태로 남고 설명이 없다.

## 옛 앱

- 대명사·생략 주어·동일 인물 병합은 해결되지 않았다. 「복녀의 남편」과 「남편」이 별개
  인물로 갈라지는 것이 대표 사례다.
- `polarity` 경고는 부정의 작용 범위를 보지 않는다. 「날개」에서 15건이 뜬다.
- Scene은 챕터를 모르는 입력에서 서사학적 판정이 아니라 탐색용 균등 분할이다.
- 상세 분석 품질과 시간은 모델·하드웨어·원문 길이에 따라 달라진다.

## 공통

- 개발·테스트는 Node v23.3에서 검증했다. EPUB 읽기가
  `DecompressionStream("deflate-raw")`에, id 생성이 전역 `crypto.randomUUID()`에
  의존하므로 구버전 Node에서는 해당 경로가 동작하지 않을 수 있다.
