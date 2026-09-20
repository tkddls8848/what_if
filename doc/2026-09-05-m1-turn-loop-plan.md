# M1 — LLM 어댑터 + 턴 루프 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하드코딩한 캐릭터 카드로 Cloudflare Workers AI 70B와 스트리밍 대화가 왕복하는 턴 루프를 만든다. `/play`에서 장면 서술이 흐르고 선택지 3개가 나오며, 소모한 Neurons가 집계된다.

> **완료된 계획서다(2026-09-05).** 구현이 끝났고, 이후 배선이 바뀐 부분이 있다 —
> 지금 도는 코드의 권위는 [`doc/README.md`](./README.md)다. 특히 이 계획서가 쓰인 뒤
> 한 턴의 호출이 셋으로 늘었고(서술 · 판정 · 장면 판정), `core/narration.js`에서
> 장면 파싱이 **삭제**됐다([장면 판정 분리 설계](./2026-09-20-scene-director-jev-design.md)).
> 이 문서는 당시 태스크 분해와 판단의 기록으로 그대로 둔다.

**Architecture:** 턴 하나는 ①서술 생성(Cloudflare, 스트리밍, 자유 텍스트)과 ②상태 추출(로컬 Ollama, 구조화)로 나뉜다. **M1은 ①만 만든다.** 프롬프트 조립은 `src/core/`(ESM, 순수 함수)가, 모델 호출은 `src/llm/`(CommonJS, fetch 주입)이, 둘을 잇는 오케스트레이션은 `src/server/turn.js`가 한다. 서술과 선택지는 한 호출에서 받고 `<선택지>` 마커로 가른다.

**Tech Stack:** Node v23.3, Express 4, `node --test`, 의존성 추가 없음. Cloudflare Workers AI REST (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).

**Spec:** [`doc/2026-09-05-interactive-fiction-pivot-design.md`](2026-09-05-interactive-fiction-pivot-design.md)

## Global Constraints

이 절의 요구사항은 모든 태스크에 암묵적으로 포함된다.

- **의존성을 추가하지 않는다.** `package.json`의 dependencies는 `express`와 `@modelcontextprotocol/sdk` 그대로다. 빌드 단계 없음이 이 저장소의 구조적 장점이다.
- **모듈 종류는 디렉터리별 `package.json`이 명시한다.** `src/`와 `mcp/`는 `"type": "module"`, `src/server/`는 `"type": "commonjs"`. **`src/llm/`은 CommonJS다** — 스펙 9절은 ESM으로 적었으나, 소비자(`server.js`, `src/server/turn.js`)가 전부 CommonJS이고 매 요청 경로에서 `await import()`를 도는 것은 얻는 것이 없다. Task 1에서 스펙 9절을 함께 고친다.
- **CommonJS가 ESM을 쓸 때는 `await import()`를 쓴다.** 기존 선례는 `src/server/wikisource.js:96`의 `await import("../core/epub.js")`다.
- **`src/core/`는 위쪽을 참조하지 않는다.** DOM·네트워크·전역 상태 없음. `src/llm/`도 `src/core/`를 참조하지 않는다 — 어댑터는 프롬프트 문자열과 스키마만 받고 도메인을 모른다.
- **서술 모델은 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`로 고정한다.** 모델 id는 설정값으로 받되 기본값이 이것이다.
- **생성 temperature는 0.6이다.** 추출(0.1)과 다르다. 같은 입력에 다른 전개가 나와야 한다.
- **단기 기억은 최근 3턴이다.** 예산 레버이며 세션 설정으로 노출한다(스펙 3-3절).
- **비밀은 환경변수로만 받는다.** `CF_ACCOUNT_ID`, `CF_API_TOKEN`. 저장소·로그·HTTP 응답 어디에도 토큰이 나가지 않는다.
- **오류는 구조화 형태 하나로 통일한다.** `{ ok: false, error_code, message, retryable }`. stack trace·로컬 경로·원문 예외를 클라이언트로 노출하지 않는다. `src/server/ollama_client.js`와 같은 규약이다.
- **테스트는 네트워크 없이 돈다.** `fetchImpl` 주입 또는 fake HTTP 서버. `npm test`는 `node --test tests/*.test.mjs`다.
- **M1에서 기존 테스트를 초록으로 유지하지 않는다**(스펙 2-3절). 새로 추가하는 테스트 파일만 통과하면 된다. 기존 파일은 건드리지 않는다.
- **커밋 메시지 끝에 두 줄을 붙인다.**

  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01L3TZAxwQFFXypcBiGBFdqZ
  ```

## File Structure

| 파일 | 책임 | 종류 |
| --- | --- | --- |
| `src/llm/package.json` | `{"type":"commonjs"}` | — |
| `src/llm/budget.js` | Neuron 단가표, 비용 계산, 하루 장부, 토큰 추정 | CJS |
| `src/llm/cloudflare.js` | Workers AI REST 클라이언트. `complete()`와 `narrate()`(SSE) | CJS |
| `src/core/card.js` | 카드·세계관 정규화와 시스템 프롬프트 프리픽스 렌더링 | ESM |
| `src/core/session.js` | 세션·턴 상태 기계. 불변 갱신 | ESM |
| `src/core/narration.js` | 서술/선택지 분리. 스트리밍용 분할기 포함 | ESM |
| `src/core/memory.js` | 프롬프트 조립(프리픽스 + 최근 N턴 + 사용자 입력) | ESM |
| `src/server/turn.js` | 턴 오케스트레이터. 조립 → 호출 → 파싱 → 계량 | CJS |
| `data/worlds/demo.json` | M1용 하드코딩 세계관·카드 | 데이터 |
| `server.js` | `POST /api/turn`(SSE), `GET /api/cf/health`, `GET /play` | CJS |
| `play.html` | 플레이 화면 | HTML |

`index.html`과 기존 `/`·`/check`는 건드리지 않는다. M1은 새 경로로 따로 서고, 기존 앱은 M2~M3에 걸쳐 죽는다. 이렇게 해야 M1이 독립적으로 검토·되돌리기 가능하다.

---

### Task 1: Neuron 계량기

**Files:**
- Create: `src/llm/package.json`
- Create: `src/llm/budget.js`
- Test: `tests/budget.test.mjs`
- Modify: `doc/2026-09-05-interactive-fiction-pivot-design.md` (9절 `src/llm/`을 CommonJS로 정정)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `NEURONS_PER_MTOK: Record<string, {input:number, output:number}>`
  - `FREE_NEURONS_PER_DAY: number` (10000)
  - `DEFAULT_NARRATION_MODEL: string` (`"@cf/meta/llama-3.3-70b-instruct-fp8-fast"`)
  - `neuronsFor({ model, inputTokens, outputTokens }) -> number | null`
  - `estimateTokens(text) -> number`
  - `createBudget({ freePerDay?, now? }) -> { record({model,inputTokens,outputTokens}), snapshot() }`
  - `record()`와 `snapshot()`이 돌려주는 모양: `{ day, used, remaining, free_per_day }`. `record()`는 여기에 `neurons`를 더한다.

- [ ] **Step 1: 모듈 종류 선언 파일을 만든다**

`src/llm/package.json`:

```json
{"type":"commonjs"}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`tests/budget.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { neuronsFor, estimateTokens, createBudget, NEURONS_PER_MTOK, FREE_NEURONS_PER_DAY } =
  await import("../src/llm/budget.js");

test("neuronsFor: 스펙 3-3절 표준 시나리오와 같은 값을 낸다", () => {
  // 입력 3,650 / 출력 500 토큰 → 199.74 Neurons (스펙 3-3절)
  const n = neuronsFor({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    inputTokens: 3650,
    outputTokens: 500
  });
  assert.ok(Math.abs(n - 199.7407) < 0.001, `expected ~199.74, got ${n}`);

  // 무료 할당 10,000 Neurons ÷ 199.74 = 50턴
  assert.equal(Math.floor(FREE_NEURONS_PER_DAY / n), 50);
});

test("neuronsFor: 단가를 모르는 모델은 0이 아니라 null을 돌려준다", () => {
  // 모르는 모델의 비용을 0으로 보고하면 계량기가 조용히 거짓말을 한다.
  assert.equal(neuronsFor({ model: "@cf/unknown/model", inputTokens: 1000, outputTokens: 100 }), null);
});

test("neuronsFor: 8B는 70B 대비 35% 싸다 (스펙 3-3절 근거)", () => {
  const big = neuronsFor({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  const small = neuronsFor({ model: "@cf/meta/llama-3.1-8b-instruct", inputTokens: 3650, outputTokens: 500 });
  const saving = (big - small) / big;
  assert.ok(saving > 0.3 && saving < 0.4, `expected ~35% saving, got ${(saving * 100).toFixed(1)}%`);
});

test("estimateTokens: 한국어를 1.2자/토큰으로 어림한다", () => {
  assert.equal(estimateTokens("가나다라마바사아자차"), 9); // 10자 / 1.2 = 8.33 → 9
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
});

test("createBudget: 사용량을 누적하고 남은 양을 돌려준다", () => {
  const budget = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const first = budget.record({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    inputTokens: 3650,
    outputTokens: 500
  });
  assert.ok(Math.abs(first.neurons - 199.7407) < 0.001);
  assert.ok(Math.abs(first.used - 199.7407) < 0.001);
  assert.ok(Math.abs(first.remaining - (10000 - 199.7407)) < 0.001);
  assert.equal(first.day, "2026-09-05");

  budget.record({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  assert.ok(Math.abs(budget.snapshot().used - 399.4814) < 0.001);
});

test("createBudget: 날짜가 바뀌면 사용량이 0으로 돌아간다", () => {
  let clock = new Date("2026-09-05T23:59:00Z");
  const budget = createBudget({ now: () => clock });
  budget.record({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  assert.ok(budget.snapshot().used > 0);

  clock = new Date("2026-09-06T00:01:00Z");
  const rolled = budget.snapshot();
  assert.equal(rolled.used, 0);
  assert.equal(rolled.day, "2026-09-06");
  assert.equal(rolled.remaining, 10000);
});

test("createBudget: 단가를 모르는 모델은 사용량을 늘리지 않고 neurons=null을 보고한다", () => {
  const budget = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const result = budget.record({ model: "@cf/unknown/model", inputTokens: 1000, outputTokens: 100 });
  assert.equal(result.neurons, null);
  assert.equal(result.used, 0);
});

test("NEURONS_PER_MTOK: 문서에서 확인한 네 모델의 단가를 담는다", () => {
  assert.deepEqual(NEURONS_PER_MTOK["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], { input: 26668, output: 204805 });
  assert.deepEqual(NEURONS_PER_MTOK["@cf/meta/llama-3.1-8b-instruct"], { input: 25608, output: 75147 });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `node --test tests/budget.test.mjs`
Expected: FAIL — `Cannot find module .../src/llm/budget.js`

- [ ] **Step 4: 구현한다**

`src/llm/budget.js`:

```js
"use strict";

/**
 * Cloudflare Workers AI 비용 계량.
 *
 * 단가는 developers.cloudflare.com/workers-ai/platform/pricing/ 에서 확인한 값이며
 * 100만 토큰당 Neurons다. 무료 할당은 하루 10,000 Neurons, 초과분은 1,000 Neurons당
 * $0.011다.
 *
 * 모르는 모델의 비용을 0으로 보고하지 않는다 — 계량기가 조용히 거짓말을 하면
 * 예산 표시 전체가 무의미해진다. 단가가 없으면 null을 돌려주고 호출부가 판단한다.
 */

const NEURONS_PER_MTOK = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26668, output: 204805 },
  "@cf/meta/llama-3.1-8b-instruct": { input: 25608, output: 75147 },
  "@cf/google/gemma-3-12b-it": { input: 31371, output: 50560 },
  "@cf/mistralai/mistral-7b-instruct-v0.1": { input: 10000, output: 17300 }
};

const FREE_NEURONS_PER_DAY = 10000;
const DEFAULT_NARRATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** 한국어 기준 어림값. 실제 usage가 오면 그것으로 대체된다(스펙 12절 5번). */
const CHARS_PER_TOKEN = 1.2;

function neuronsFor({ model, inputTokens = 0, outputTokens = 0 } = {}) {
  const rate = NEURONS_PER_MTOK[model];
  if (!rate) return null;
  return (Number(inputTokens) * rate.input + Number(outputTokens) * rate.output) / 1e6;
}

function estimateTokens(text) {
  const chars = String(text || "").length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 하루 단위 장부. Cloudflare의 무료 할당이 하루마다 초기화되므로 UTC 날짜가 바뀌면
 * 사용량을 0으로 되돌린다. 프로세스가 재시작되면 장부도 사라진다 — M1에서는
 * 영속화하지 않는다(M4에서 세션 저장과 함께 파일로 옮긴다).
 */
function createBudget({ freePerDay = FREE_NEURONS_PER_DAY, now = () => new Date() } = {}) {
  let day = null;
  let used = 0;

  function roll() {
    const today = now().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
  }

  function state() {
    return { day, used, remaining: freePerDay - used, free_per_day: freePerDay };
  }

  return {
    record({ model, inputTokens = 0, outputTokens = 0 } = {}) {
      roll();
      const neurons = neuronsFor({ model, inputTokens, outputTokens });
      if (neurons === null) return { neurons: null, ...state() };
      used += neurons;
      return { neurons, ...state() };
    },
    snapshot() {
      roll();
      return state();
    }
  };
}

module.exports = {
  NEURONS_PER_MTOK,
  FREE_NEURONS_PER_DAY,
  DEFAULT_NARRATION_MODEL,
  neuronsFor,
  estimateTokens,
  createBudget
};
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `node --test tests/budget.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 6: 스펙 9절의 모듈 종류 표기를 고친다**

`doc/2026-09-05-interactive-fiction-pivot-design.md`의 9절에서 이 줄을

```text
src/llm/           [신규] 모델 어댑터 (ESM)
```

이렇게 바꾼다.

```text
src/llm/           [신규] 모델 어댑터 (CommonJS — 소비자가 전부 CJS다)
```

- [ ] **Step 7: 커밋**

```bash
git add src/llm/package.json src/llm/budget.js tests/budget.test.mjs doc/2026-09-05-interactive-fiction-pivot-design.md
git commit -m "feat(llm): Neuron 계량기와 Workers AI 단가표"
```

---

### Task 2: Cloudflare 클라이언트 — 비스트리밍 호출과 오류 매핑

**Files:**
- Create: `src/llm/cloudflare.js`
- Test: `tests/cloudflare_client.test.mjs`

**Interfaces:**
- Consumes: 없음 (budget.js와 독립이다 — 어댑터는 비용을 모르고 토큰 수만 보고한다)
- Produces:
  - `createCloudflareClient({ accountId, apiToken, fetchImpl?, timeoutMs? }) -> client`
  - `client.complete({ model, messages, maxTokens?, temperature?, signal? })` → 성공 `{ ok:true, text, usage }`, 실패 `{ ok:false, error_code, message, retryable }`
  - `usage`의 모양: `{ prompt_tokens, completion_tokens, total_tokens }` 또는 `null`
  - `client.isConfigured() -> boolean`
  - `error_code` 어휘: `CONNECTION_FAILED | TIMEOUT | AUTH_FAILED | RATE_LIMITED | UPSTREAM_ERROR | BAD_RESPONSE | NOT_CONFIGURED`
  - Task 3이 같은 파일에 `client.narrate()`를 더한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/cloudflare_client.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { createCloudflareClient } = await import("../src/llm/cloudflare.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function client(fetchImpl, extra = {}) {
  return createCloudflareClient({ accountId: "acc123", apiToken: "tok456", fetchImpl, ...extra });
}

test("complete: 올바른 URL·헤더·본문으로 호출하고 text와 usage를 돌려준다", async () => {
  let seen = null;
  const c = client(async (url, init) => {
    seen = { url, init };
    return jsonResponse({
      success: true,
      result: {
        response: "복도 끝에서 발소리가 멈췄다.",
        usage: { prompt_tokens: 3650, completion_tokens: 500, total_tokens: 4150 }
      }
    });
  });

  const result = await c.complete({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    maxTokens: 700
  });

  assert.equal(
    seen.url,
    "https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  );
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer tok456");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 700);
  assert.equal(body.temperature, 0.6);
  assert.equal(body.messages.length, 2);

  assert.equal(result.ok, true);
  assert.equal(result.text, "복도 끝에서 발소리가 멈췄다.");
  assert.equal(result.usage.completion_tokens, 500);
});

test("complete: 401은 AUTH_FAILED이고 재시도 대상이 아니다", async () => {
  const c = client(async () => jsonResponse({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "AUTH_FAILED");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("Workers AI"));
});

test("complete: 429는 RATE_LIMITED이고 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({ success: false, errors: [{ message: "too many requests" }] }, 429));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
  // 무료 할당 소진이 가장 흔한 원인이므로 메시지가 그것을 짚어야 한다
  assert.ok(result.message.includes("10,000"));
});

test("complete: 5xx는 UPSTREAM_ERROR이고 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({ success: false, errors: [{ message: "boom" }] }, 503));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "UPSTREAM_ERROR");
  assert.equal(result.retryable, true);
});

test("complete: JSON이 아닌 응답은 BAD_RESPONSE다", async () => {
  const c = client(async () => ({ ok: true, status: 200, async json() { throw new Error("not json"); } }));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "BAD_RESPONSE");
});

test("complete: 연결 실패는 CONNECTION_FAILED다", async () => {
  const c = client(async () => { throw new Error("ECONNREFUSED"); });
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "CONNECTION_FAILED");
  assert.equal(result.retryable, true);
});

test("complete: 시간 초과는 TIMEOUT이다", async () => {
  const c = client(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "TIMEOUT");
  assert.equal(result.retryable, true);
});

test("오류 메시지에 API 토큰이 절대 들어가지 않는다", async () => {
  const c = client(async () => jsonResponse({ success: false, errors: [{ message: "bad token tok456" }] }, 401));
  const result = await c.complete({ model: "m", messages: [] });
  assert.ok(!JSON.stringify(result).includes("tok456"));
});

test("isConfigured: accountId나 apiToken이 비면 false, 호출은 NOT_CONFIGURED", async () => {
  const unset = createCloudflareClient({ accountId: "", apiToken: "", fetchImpl: async () => { throw new Error("호출되면 안 된다"); } });
  assert.equal(unset.isConfigured(), false);
  const result = await unset.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "NOT_CONFIGURED");
  assert.equal(result.retryable, false);

  const set = client(async () => jsonResponse({ success: true, result: { response: "ok" } }));
  assert.equal(set.isConfigured(), true);
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/cloudflare_client.test.mjs`
Expected: FAIL — `Cannot find module .../src/llm/cloudflare.js`

- [ ] **Step 3: 구현한다**

`src/llm/cloudflare.js`:

```js
"use strict";

/**
 * Cloudflare Workers AI REST 클라이언트.
 *
 * Workers 배포 없이 Node에서 직접 호출한다.
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
 *   Authorization: Bearer {API_TOKEN}
 * 토큰은 `Workers AI - Read`와 `Workers AI - Edit` 두 권한이 필요하다.
 *
 * 규약은 src/server/ollama_client.js와 같다.
 *   - fetch 주입 가능 → 네트워크 없이 단위 테스트
 *   - 모든 실패를 { ok:false, error_code, message, retryable }로 변환
 *   - stack trace, 로컬 경로, 원문 예외, **API 토큰**을 호출부로 노출하지 않는다
 *
 * 이 모듈은 도메인을 모른다. 프롬프트가 무엇을 뜻하는지, 비용이 얼마인지 알지 않는다.
 * 토큰 수만 그대로 보고하고 해석은 호출부에 맡긴다.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_MAX_TOKENS = 700;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * 상태 코드를 구조화 오류로 옮긴다.
 *
 * 401/403과 429를 UPSTREAM_ERROR에서 갈라내는 이유는 대응이 다르기 때문이다 —
 * 인증 실패는 재시도해도 소용없고 사람이 토큰을 고쳐야 하며, 429는 무료 할당
 * 소진이 가장 흔한 원인이라 기다리면 풀린다.
 *
 * 업스트림 메시지를 그대로 싣지 않는다. 인증 오류 본문에는 토큰 일부가 섞여 돌아올 수 있다.
 */
function mapStatus(status) {
  if (status === 401 || status === 403) {
    return errorResult(
      "AUTH_FAILED",
      "Cloudflare API 토큰이 거부되었습니다. Workers AI Read/Edit 권한이 있는지 확인하세요.",
      false
    );
  }
  if (status === 429) {
    return errorResult(
      "RATE_LIMITED",
      "Workers AI 요청 한도에 걸렸습니다. 무료 할당(하루 10,000 Neurons)이 소진되었을 수 있습니다.",
      true
    );
  }
  return errorResult("UPSTREAM_ERROR", `Workers AI 오류 (HTTP ${status})`, status >= 500);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const completion = Number(usage.completion_tokens) || 0;
  const prompt = Number(usage.prompt_tokens) || 0;
  if (completion === 0 && prompt === 0) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion
  };
}

function createCloudflareClient({ accountId, apiToken, fetchImpl, timeoutMs } = {}) {
  const account = String(accountId || "");
  const token = String(apiToken || "");
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  function isConfigured() {
    return account.length > 0 && token.length > 0;
  }

  /**
   * 헤더가 올 때까지만 시간 제한을 건다. 스트리밍 본문은 길게 이어지므로 같은 타이머로
   * 재면 정상 생성이 중간에 끊긴다. 본문 단계의 이탈은 호출부가 넘긴 signal(클라이언트
   * 접속 종료)이 처리한다.
   */
  async function send(model, payload, signal) {
    if (!isConfigured()) {
      return errorResult(
        "NOT_CONFIGURED",
        "CF_ACCOUNT_ID와 CF_API_TOKEN 환경변수가 필요합니다.",
        false
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const relay = () => controller.abort();
    if (signal) signal.addEventListener("abort", relay, { once: true });

    let response;
    try {
      response = await doFetch(`${API_BASE}/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return errorResult("TIMEOUT", `Workers AI 응답 시간 초과 (${timeout}ms)`, true);
      }
      return errorResult("CONNECTION_FAILED", "Workers AI에 연결할 수 없습니다.", true);
    }
    clearTimeout(timer);

    if (!response.ok) return mapStatus(response.status);
    return { ok: true, response };
  }

  async function complete({ model, messages, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE, signal } = {}) {
    const sent = await send(model, {
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature
    }, signal);
    if (!sent.ok) return sent;

    let body;
    try {
      body = await sent.response.json();
    } catch (_error) {
      return errorResult("BAD_RESPONSE", "Workers AI가 JSON이 아닌 응답을 반환했습니다.", false);
    }

    const result = body && body.result;
    if (!result || typeof result.response !== "string") {
      return errorResult("BAD_RESPONSE", "Workers AI 응답에 result.response가 없습니다.", false);
    }
    return { ok: true, text: result.response, usage: normalizeUsage(result.usage) };
  }

  return { complete, isConfigured, send, accountId: account, timeoutMs: timeout };
}

module.exports = { createCloudflareClient, API_BASE, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE };
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node --test tests/cloudflare_client.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/llm/cloudflare.js tests/cloudflare_client.test.mjs
git commit -m "feat(llm): Workers AI REST 클라이언트와 오류 매핑"
```

---

### Task 3: Cloudflare 클라이언트 — SSE 스트리밍

**Files:**
- Modify: `src/llm/cloudflare.js` (`narrate()` 추가, `module.exports` 유지)
- Modify: `tests/cloudflare_client.test.mjs` (스트리밍 테스트 추가)

**Interfaces:**
- Consumes: Task 2의 `send()`. 성공 시 `{ ok:true, response, release }`를 돌려주며,
  `release()`는 호출자가 응답을 다 쓴 뒤 반드시 한 번 불러야 한다(abort 리스너 해제).
- Produces:
  - `client.narrate({ model, messages, maxTokens?, temperature?, onToken?, signal? })`
    → 성공 `{ ok:true, text, usage, truncated }`, 실패는 `complete()`와 같은 형태
  - `onToken(piece)`는 도착한 조각마다 동기로 호출된다. 예외를 던지면 스트림이 죽으므로 호출부가 감싼다.
  - `truncated: true`는 본문을 읽는 중 스트림이 끊겼다는 뜻이다. 이때도 `ok:true`이고 `text`에 그때까지 받은 내용이 들어 있다.

Workers AI 스트리밍 응답의 실제 형태(문서 확인):

```
data: {"response": "복도 끝에서", "usage": {"prompt_tokens": 15, "completion_tokens": 18, "total_tokens": 33}, "tool_calls": []}

data: {"response": " 발소리가 멈췄다.", "usage": {...}, "tool_calls": []}

data: [DONE]
```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/cloudflare_client.test.mjs` 끝에 이어 붙인다.

```js
/** 임의로 쪼갠 바이트 조각을 내보내는 fake SSE 본문. 프레임이 청크 경계에 걸리게 만든다. */
function sseBody(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk, "utf8");
    }
  };
}

function streamResponse(chunks, status = 200) {
  return { ok: status >= 200 && status < 300, status, body: sseBody(chunks) };
}

test("narrate: 조각을 순서대로 onToken에 넘기고 전체 텍스트를 모은다", async () => {
  const c = client(async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return streamResponse([
      'data: {"response":"복도 끝에서","usage":{"prompt_tokens":15,"completion_tokens":4,"total_tokens":19},"tool_calls":[]}\n\n',
      'data: {"response":" 발소리가 멈췄다.","usage":{"prompt_tokens":15,"completion_tokens":12,"total_tokens":27},"tool_calls":[]}\n\n',
      "data: [DONE]\n\n"
    ]);
  });

  const seen = [];
  const result = await c.narrate({ model: "m", messages: [], onToken: (p) => seen.push(p) });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["복도 끝에서", " 발소리가 멈췄다."]);
  assert.equal(result.text, "복도 끝에서 발소리가 멈췄다.");
  assert.equal(result.usage.completion_tokens, 12); // 마지막으로 본 usage
  assert.equal(result.truncated, false);
});

test("narrate: 청크 경계가 프레임 한가운데를 잘라도 복원한다", async () => {
  const c = client(async () => streamResponse([
    'data: {"response":"복도 ',
    '끝에서","usage":{"completion_tokens":4},"tool_ca',
    'lls":[]}\n\ndata: {"response":"멈췄다.","usage":{"completion_tokens":8},"tool_calls":[]}\n\n',
    "data: [DONE]\n\n"
  ]));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.text, "복도 끝에서멈췄다.");
  assert.equal(result.usage.completion_tokens, 8);
});

test("narrate: 깨진 프레임 하나는 버리고 나머지를 살린다", async () => {
  const c = client(async () => streamResponse([
    'data: {"response":"살아있다"}\n\n',
    "data: {깨짐\n\n",
    'data: {"response":" 그리고 이어진다"}\n\n',
    "data: [DONE]\n\n"
  ]));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "살아있다 그리고 이어진다");
});

test("narrate: [DONE] 이후의 내용은 무시한다", async () => {
  const c = client(async () => streamResponse([
    'data: {"response":"본문"}\n\n',
    "data: [DONE]\n\n",
    'data: {"response":"뒤에 붙은 쓰레기"}\n\n'
  ]));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.text, "본문");
});

test("narrate: 스트림이 중간에 끊기면 truncated로 표시하고 받은 데까지 돌려준다", async () => {
  const c = client(async () => ({
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('data: {"response":"여기까지"}\n\n', "utf8");
        throw new Error("socket hang up");
      }
    }
  }));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "여기까지");
  assert.equal(result.truncated, true);
});

test("narrate: usage가 한 번도 오지 않으면 null이다", async () => {
  const c = client(async () => streamResponse(['data: {"response":"본문"}\n\n', "data: [DONE]\n\n"]));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.usage, null);
});

test("narrate: HTTP 오류는 complete와 같은 구조화 오류다", async () => {
  const c = client(async () => ({ ok: false, status: 429, async json() { return {}; } }));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "RATE_LIMITED");
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/cloudflare_client.test.mjs`
Expected: FAIL — `c.narrate is not a function`

- [ ] **Step 3: `narrate()`를 구현한다**

`src/llm/cloudflare.js`의 `complete()` 정의 바로 뒤, `return { complete, ... }` 앞에 넣는다.

```js
  /**
   * 스트리밍 생성.
   *
   * SSE 프레임은 청크 경계와 무관하게 도착한다. 한 프레임이 두 청크에 걸치거나 한
   * 청크에 여러 프레임이 들어 있으므로, "\n\n"이 나올 때까지 버퍼에 모았다가 자른다.
   * 프레임 하나가 깨져도 스트림 전체를 버리지 않는다 — 이미 사용자 화면에 흐른 글자를
   * 되돌릴 수 없으므로, 살릴 수 있는 만큼 살리고 계속 읽는 편이 낫다.
   *
   * usage는 마지막으로 본 값을 쓴다. Workers AI는 프레임마다 usage를 실어 보내며
   * 누적값이므로 마지막 것이 총계다.
   */
  async function narrate({ model, messages, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE, onToken, signal } = {}) {
    const sent = await send(model, {
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature
    }, signal);
    if (!sent.ok) return sent;

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage = null;
    let done = false;
    let truncated = false;

    const consume = (block) => {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { done = true; return; }
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch (_error) {
          continue; // 깨진 프레임 하나는 버린다
        }
        const piece = typeof frame.response === "string" ? frame.response : "";
        if (piece) {
          text += piece;
          if (onToken) onToken(piece);
        }
        const normalized = normalizeUsage(frame.usage);
        if (normalized) usage = normalized;
      }
    };

    try {
      for await (const chunk of sent.response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while (!done && (cut = buffer.indexOf("\n\n")) !== -1) {
          consume(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
        }
        if (done) break;
      }
      if (!done && buffer.trim()) consume(buffer);
    } catch (_error) {
      truncated = true;
    }

    // 스트림을 다 읽은 뒤에야 abort 릴레이를 뗀다 — 본문 순회 중에는 호출자의
    // 취소가 fetch까지 닿아야 한다.
    sent.release();

    return { ok: true, text, usage, truncated };
  }
```

`return` 줄을 이렇게 바꾼다.

```js
  return { complete, narrate, isConfigured, send, accountId: account, timeoutMs: timeout };
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node --test tests/cloudflare_client.test.mjs`
Expected: PASS, 16 tests

- [ ] **Step 5: 커밋**

```bash
git add src/llm/cloudflare.js tests/cloudflare_client.test.mjs
git commit -m "feat(llm): Workers AI SSE 스트리밍"
```

---

### Task 4: 캐릭터 카드와 세계관 프리픽스

**Files:**
- Create: `src/core/card.js`
- Create: `data/worlds/demo.json`
- Test: `tests/card.test.mjs`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `normalizeWorld(raw) -> World`
  - `normalizeCard(raw) -> CharacterCard`
  - `loadWorldFile(json) -> { world, cards }` (파일 내용 파싱, I/O 없음)
  - `renderPrefix({ world, cards, pov }) -> string` — 시스템 프롬프트의 고정 앞부분
  - `World`: `{ world_id, title, setting, tone, rules[], forbidden[] }`
  - `CharacterCard`: `{ card_id, world_id, canonical_name, aliases[], persona{traits[],values[],taboos[]}, speech{first_person, endings[], address_rules[], examples[]}, appearance, relationships[], knowledge_as_of, source{}, status }`

`data/worlds/demo.json`은 M1 전용 픽스처다. 실물 작품 카드는 M2의 임포터가 만든다. 픽스처를 창작물로 두는 이유는 외부 자료 없이도 테스트가 결정적으로 돌기 위해서다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/card.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const { normalizeWorld, normalizeCard, loadWorldFile, renderPrefix } = await import("../src/core/card.js");

test("normalizeCard: 빠진 필드를 빈 값으로 채우고 모양을 고정한다", () => {
  const card = normalizeCard({ canonical_name: "아스카", world_id: "demo" });
  assert.equal(card.canonical_name, "아스카");
  assert.equal(card.world_id, "demo");
  assert.ok(card.card_id.length > 0);
  assert.deepEqual(card.aliases, []);
  assert.deepEqual(card.persona, { traits: [], values: [], taboos: [] });
  assert.deepEqual(card.speech, { first_person: "", endings: [], address_rules: [], examples: [] });
  assert.equal(card.status, "suggested");
});

test("normalizeCard: 이름이 없으면 예외가 아니라 빈 이름 카드를 만들고 호출부가 거른다", () => {
  const card = normalizeCard({});
  assert.equal(card.canonical_name, "");
});

test("renderPrefix: 세계관 규칙·금지와 카드의 성격·말투·예시 대사를 모두 싣는다", () => {
  const world = normalizeWorld({
    world_id: "demo",
    title: "야간 자율학습",
    setting: "비 오는 밤의 고등학교. 교실 하나에만 불이 켜져 있다.",
    tone: "차분하고 건조하다. 감정을 설명하지 않고 행동으로 보여준다.",
    rules: ["초자연적 요소는 없다.", "장면은 학교 안에서만 벌어진다."],
    forbidden: ["현대 기술 용어를 쓰지 않는다."]
  });
  const cards = [normalizeCard({
    world_id: "demo",
    canonical_name: "한서린",
    aliases: ["서린", "반장"],
    persona: { traits: ["무뚝뚝함", "책임감"], values: ["약속은 지킨다"], taboos: ["먼저 사과하지 않는다"] },
    speech: {
      first_person: "나",
      endings: ["-거든", "-잖아"],
      address_rules: ["상대를 성 없이 이름으로 부른다"],
      examples: ["\"먼저 가. 나는 좀 더 있을 거거든.\""]
    },
    appearance: "묶은 머리, 소매가 긴 교복 셔츠."
  })];

  const prefix = renderPrefix({ world, cards, pov: null });

  assert.ok(prefix.includes("야간 자율학습"));
  assert.ok(prefix.includes("초자연적 요소는 없다."));
  assert.ok(prefix.includes("현대 기술 용어를 쓰지 않는다."));
  assert.ok(prefix.includes("한서린"));
  assert.ok(prefix.includes("서린"));
  assert.ok(prefix.includes("무뚝뚝함"));
  assert.ok(prefix.includes("먼저 사과하지 않는다"));
  assert.ok(prefix.includes("-거든"));
  assert.ok(prefix.includes("먼저 가. 나는 좀 더 있을 거거든."));
  assert.ok(prefix.includes("묶은 머리"));
});

test("renderPrefix: pov가 지정되면 그 카드가 시점 인물임을 명시한다", () => {
  const world = normalizeWorld({ world_id: "d", title: "t", setting: "s", tone: "n" });
  const cards = [
    normalizeCard({ card_id: "c1", world_id: "d", canonical_name: "가" }),
    normalizeCard({ card_id: "c2", world_id: "d", canonical_name: "나" })
  ];
  const withPov = renderPrefix({ world, cards, pov: "c2" });
  assert.ok(/시점 인물[^\n]*나/.test(withPov), withPov);

  const without = renderPrefix({ world, cards, pov: null });
  assert.ok(without.includes("3인칭"));
});

test("renderPrefix: 빈 배열 필드는 빈 제목만 남기지 않고 통째로 생략한다", () => {
  const world = normalizeWorld({ world_id: "d", title: "t", setting: "s", tone: "n", rules: [], forbidden: [] });
  const prefix = renderPrefix({ world, cards: [], pov: null });
  assert.ok(!prefix.includes("규칙:"));
  assert.ok(!prefix.includes("금지:"));
});

test("data/worlds/demo.json이 실제로 로드되고 카드가 하나 이상 있다", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../data/worlds/demo.json", import.meta.url), "utf8"));
  const { world, cards } = loadWorldFile(raw);
  assert.equal(world.world_id, "demo");
  assert.ok(cards.length >= 1);
  assert.ok(cards.every((card) => card.canonical_name.length > 0));
  assert.ok(cards.every((card) => card.world_id === "demo"));
  // 말투를 흉내 내려면 요약이 아니라 실제 대사가 필요하다(스펙 7절)
  assert.ok(cards.every((card) => card.speech.examples.length >= 2));
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/card.test.mjs`
Expected: FAIL — `Cannot find module .../src/core/card.js`

- [ ] **Step 3: `src/core/card.js`를 구현한다**

```js
/**
 * 캐릭터 카드와 세계관 — 시스템 프롬프트의 고정 앞부분.
 *
 * 카드는 매 턴 프롬프트의 맨 앞에 그대로 들어간다. 그래서 형식이 곧 비용이고,
 * 빈 필드의 제목만 남기지 않는다(약 700토큰 예산, 스펙 5절).
 *
 * 여기서는 문장을 생성하지 않는다. 카드에 든 것을 늘어놓기만 한다. 카드를 채우는 것은
 * M2의 컴파일러와 사람의 검수이고, 이 모듈은 그 결과를 읽기만 한다.
 */

export const CARD_STATUS = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  EDITED: "edited",
  REJECTED: "rejected",
  MANUAL: "manual"
};

let autoId = 0;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter(Boolean);
}

export function normalizeWorld(raw = {}) {
  return {
    world_id: str(raw.world_id) || "world",
    title: str(raw.title),
    setting: str(raw.setting),
    tone: str(raw.tone),
    rules: list(raw.rules),
    forbidden: list(raw.forbidden)
  };
}

export function normalizeCard(raw = {}) {
  const persona = raw.persona || {};
  const speech = raw.speech || {};
  return {
    card_id: str(raw.card_id) || `card-${++autoId}`,
    world_id: str(raw.world_id) || "world",
    canonical_name: str(raw.canonical_name),
    aliases: list(raw.aliases),
    persona: {
      traits: list(persona.traits),
      values: list(persona.values),
      taboos: list(persona.taboos)
    },
    speech: {
      first_person: str(speech.first_person),
      endings: list(speech.endings),
      address_rules: list(speech.address_rules),
      examples: list(speech.examples)
    },
    appearance: str(raw.appearance),
    relationships: Array.isArray(raw.relationships) ? raw.relationships : [],
    knowledge_as_of: str(raw.knowledge_as_of),
    source: raw.source && typeof raw.source === "object" ? raw.source : { type: "manual" },
    status: str(raw.status) || CARD_STATUS.SUGGESTED
  };
}

export function loadWorldFile(raw = {}) {
  const world = normalizeWorld(raw.world);
  const cards = (Array.isArray(raw.cards) ? raw.cards : [])
    .map((card) => normalizeCard({ world_id: world.world_id, ...card }));
  return { world, cards };
}

/** 값이 있을 때만 "제목: 내용" 한 줄을 만든다. 빈 제목은 토큰 낭비다. */
function line(label, value) {
  const text = Array.isArray(value) ? value.join(", ") : str(value);
  return text ? `${label}: ${text}\n` : "";
}

function bullets(label, items) {
  if (!items.length) return "";
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function renderCard(card) {
  const name = card.aliases.length
    ? `${card.canonical_name} (${card.aliases.join(", ")})`
    : card.canonical_name;
  let out = `\n[등장인물] ${name}\n`;
  out += line("성격", card.persona.traits);
  out += line("가치관", card.persona.values);
  out += line("금기", card.persona.taboos);
  const speech = [];
  if (card.speech.first_person) speech.push(`1인칭 "${card.speech.first_person}"`);
  if (card.speech.endings.length) speech.push(`어미 ${card.speech.endings.join(", ")}`);
  out += line("말투", speech);
  out += line("호칭", card.speech.address_rules);
  out += bullets("예시 대사", card.speech.examples);
  out += line("외형", card.appearance);
  return out;
}

export function renderPrefix({ world, cards = [], pov = null } = {}) {
  const w = normalizeWorld(world);
  let out = `[세계관] ${w.title}\n`;
  out += line("배경", w.setting);
  out += line("분위기", w.tone);
  out += bullets("규칙", w.rules);
  out += bullets("금지", w.forbidden);

  for (const card of cards) out += renderCard(card);

  const povCard = pov ? cards.find((card) => card.card_id === pov) : null;
  out += povCard
    ? `\n[시점] 시점 인물은 ${povCard.canonical_name}이다. 이 인물이 보고 들은 것만 서술한다.\n`
    : "\n[시점] 3인칭으로 서술한다. 독자는 '너'로 부른다.\n";
  return out;
}
```

- [ ] **Step 4: `data/worlds/demo.json`을 만든다**

```json
{
  "world": {
    "world_id": "demo",
    "title": "야간 자율학습",
    "setting": "비 오는 밤의 고등학교. 복도의 불은 꺼졌고 3학년 2반 교실 하나에만 형광등이 켜져 있다. 마지막 버스는 열한 시에 끊긴다.",
    "tone": "차분하고 건조하다. 감정을 설명하지 않고 행동과 사물로 보여준다. 문장은 짧다.",
    "rules": [
      "초자연적 요소는 없다.",
      "장면은 학교 건물 안과 정문 앞에서만 벌어진다.",
      "시간은 밤 아홉 시에서 자정 사이다."
    ],
    "forbidden": [
      "인물의 속마음을 직접 서술하지 않는다.",
      "장면 밖의 배경 설명을 늘어놓지 않는다."
    ]
  },
  "cards": [
    {
      "card_id": "seorin",
      "canonical_name": "한서린",
      "aliases": ["서린", "반장"],
      "persona": {
        "traits": ["무뚝뚝하다", "먼저 자리를 뜨지 않는다", "남의 일에 참견하면서 참견이 아닌 척한다"],
        "values": ["한 번 뱉은 약속은 지킨다", "혼자 두는 것보다 옆에 있는 편이 낫다"],
        "taboos": ["먼저 사과하지 않는다", "우는 모습을 보이지 않는다"]
      },
      "speech": {
        "first_person": "나",
        "endings": ["-거든", "-잖아", "-지"],
        "address_rules": ["상대를 성 없이 이름으로 부른다", "존댓말을 쓰지 않는다"],
        "examples": [
          "\"먼저 가. 나는 좀 더 있을 거거든.\"",
          "\"그거 아까부터 세 번째야. 집중 안 되면 그냥 자.\"",
          "\"우산 없잖아. ……같이 쓰든가.\""
        ]
      },
      "appearance": "높이 묶은 머리, 소매를 손등까지 내린 교복 셔츠. 왼손 검지에 굳은살.",
      "knowledge_as_of": "2학기 중간고사 직후",
      "source": { "type": "manual" },
      "status": "confirmed"
    }
  ]
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `node --test tests/card.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 6: 커밋**

```bash
git add src/core/card.js data/worlds/demo.json tests/card.test.mjs
git commit -m "feat(core): 캐릭터 카드 스키마와 시스템 프롬프트 프리픽스"
```

---

### Task 5: 세션·턴 상태 기계

**Files:**
- Create: `src/core/session.js`
- Test: `tests/session.test.mjs`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `createSession({ session_id?, world_id, card_ids?, pov?, opening?, recent_turns?, max_tokens? }) -> Session`
  - `normalizeSession(raw) -> Session` — 브라우저가 보낸 것을 신뢰하지 않고 모양을 고정한다
  - `nextTurnIndex(session) -> number` (1부터)
  - `appendTurn(session, turn) -> Session` — **불변**. 원본을 바꾸지 않는다
  - `recentTurns(session, count) -> Turn[]` — 오래된 것부터
  - `makeTurn({ index, user_input, narration, choices, usage, model }) -> Turn`
  - `Session`: `{ session_id, world_id, card_ids[], pov, opening, turns[], turn_count, settings{recent_turns, max_tokens} }`
  - `Turn`: `{ turn_id, index, user_input, narration, choices[], events[], state_changes[], usage, model, extraction_failed }`

`events[]`·`state_changes[]`는 M1에서 항상 빈 배열이다. M3의 추출 채널이 채운다. 지금 자리를 비워 두는 이유는 M3에서 `Turn` 모양이 바뀌면 저장된 세션이 전부 깨지기 때문이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/session.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { createSession, normalizeSession, nextTurnIndex, appendTurn, recentTurns, makeTurn } =
  await import("../src/core/session.js");

test("createSession: 기본값은 스펙의 예산 설정을 따른다", () => {
  const session = createSession({ world_id: "demo" });
  assert.equal(session.world_id, "demo");
  assert.deepEqual(session.turns, []);
  assert.equal(session.turn_count, 0);
  assert.equal(session.pov, null);
  // 단기 기억 3턴 (스펙 3-3, 5절)
  assert.equal(session.settings.recent_turns, 3);
  assert.equal(session.settings.max_tokens, 700);
});

test("nextTurnIndex: 1부터 센다", () => {
  const session = createSession({ world_id: "demo" });
  assert.equal(nextTurnIndex(session), 1);
  const after = appendTurn(session, makeTurn({ index: 1, user_input: "u", narration: "n" }));
  assert.equal(nextTurnIndex(after), 2);
});

test("appendTurn: 원본을 바꾸지 않는다", () => {
  const session = createSession({ world_id: "demo" });
  const next = appendTurn(session, makeTurn({ index: 1, user_input: "u", narration: "n" }));
  assert.equal(session.turns.length, 0);
  assert.equal(session.turn_count, 0);
  assert.equal(next.turns.length, 1);
  assert.equal(next.turn_count, 1);
  assert.notEqual(session, next);
});

test("recentTurns: 마지막 N개를 오래된 것부터 돌려준다", () => {
  let session = createSession({ world_id: "demo" });
  for (let i = 1; i <= 5; i += 1) {
    session = appendTurn(session, makeTurn({ index: i, user_input: `u${i}`, narration: `n${i}` }));
  }
  const recent = recentTurns(session, 3);
  assert.deepEqual(recent.map((turn) => turn.index), [3, 4, 5]);
});

test("recentTurns: 턴이 요청 수보다 적으면 있는 만큼만 준다", () => {
  const session = appendTurn(createSession({ world_id: "demo" }), makeTurn({ index: 1, user_input: "u", narration: "n" }));
  assert.equal(recentTurns(session, 3).length, 1);
  assert.equal(recentTurns(createSession({ world_id: "demo" }), 3).length, 0);
});

test("makeTurn: M3가 채울 자리를 지금부터 빈 배열로 둔다", () => {
  const turn = makeTurn({ index: 1, user_input: "u", narration: "n", choices: ["a", "b", "c"] });
  assert.deepEqual(turn.events, []);
  assert.deepEqual(turn.state_changes, []);
  assert.equal(turn.extraction_failed, false);
  assert.deepEqual(turn.choices, ["a", "b", "c"]);
  assert.ok(turn.turn_id.length > 0);
});

test("normalizeSession: 브라우저가 보낸 이상한 값을 모양에 맞춘다", () => {
  const session = normalizeSession({
    world_id: "demo",
    turns: "배열이 아님",
    card_ids: null,
    settings: { recent_turns: "3", max_tokens: -1 }
  });
  assert.deepEqual(session.turns, []);
  assert.deepEqual(session.card_ids, []);
  assert.equal(session.settings.recent_turns, 3);
  // 음수 max_tokens는 기본값으로 되돌린다
  assert.equal(session.settings.max_tokens, 700);
});

test("normalizeSession: turn_count는 저장값이 아니라 turns 길이에서 다시 센다", () => {
  const session = normalizeSession({ world_id: "d", turn_count: 99, turns: [{ index: 1 }] });
  assert.equal(session.turn_count, 1);
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/session.test.mjs`
Expected: FAIL — `Cannot find module .../src/core/session.js`

- [ ] **Step 3: 구현한다**

`src/core/session.js`:

```js
/**
 * 세션과 턴.
 *
 * 시간 좌표는 `turn_index`(1부터인 정수)다. 기존 저장소가 segment index를 쓰던 자리를
 * 그대로 물려받는다(스펙 6-2절) — 구간 비교가 가능해야 `asOf()`를 재사용할 수 있다.
 *
 * 갱신은 불변이다. 브라우저 상태와 서버 응답이 같은 객체를 공유하면 스트리밍 중간에
 * 부분 갱신된 세션이 보이게 된다.
 *
 * `events[]`와 `state_changes[]`는 M1에서 늘 비어 있다. M3의 추출 채널이 채운다.
 * 지금 자리를 비워 두는 이유는, 나중에 Turn 모양이 바뀌면 저장된 세션이 전부 깨지기 때문이다.
 */

export const DEFAULT_RECENT_TURNS = 3;
export const DEFAULT_MAX_TOKENS = 700;

let autoId = 0;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function makeTurn({ index, user_input = "", narration = "", choices = [], usage = null, model = "" } = {}) {
  return {
    turn_id: `turn-${++autoId}`,
    index: positive(index, 1),
    user_input: str(user_input),
    narration: str(narration),
    choices: list(choices).map(str).filter(Boolean),
    events: [],
    state_changes: [],
    usage,
    model: str(model),
    extraction_failed: false
  };
}

export function createSession({
  session_id,
  world_id,
  card_ids = [],
  pov = null,
  opening = "",
  recent_turns = DEFAULT_RECENT_TURNS,
  max_tokens = DEFAULT_MAX_TOKENS
} = {}) {
  return {
    session_id: str(session_id) || `session-${++autoId}`,
    world_id: str(world_id),
    card_ids: list(card_ids).map(str).filter(Boolean),
    pov: str(pov) || null,
    opening: str(opening),
    turns: [],
    turn_count: 0,
    settings: {
      recent_turns: positive(recent_turns, DEFAULT_RECENT_TURNS),
      max_tokens: positive(max_tokens, DEFAULT_MAX_TOKENS)
    }
  };
}

/** 브라우저가 보낸 세션을 신뢰하지 않는다. turn_count는 저장값을 믿지 않고 다시 센다. */
export function normalizeSession(raw = {}) {
  const settings = raw.settings || {};
  const turns = list(raw.turns);
  return {
    session_id: str(raw.session_id) || `session-${++autoId}`,
    world_id: str(raw.world_id),
    card_ids: list(raw.card_ids).map(str).filter(Boolean),
    pov: str(raw.pov) || null,
    opening: str(raw.opening),
    turns,
    turn_count: turns.length,
    settings: {
      recent_turns: positive(settings.recent_turns, DEFAULT_RECENT_TURNS),
      max_tokens: positive(settings.max_tokens, DEFAULT_MAX_TOKENS)
    }
  };
}

export function nextTurnIndex(session) {
  return list(session?.turns).length + 1;
}

export function appendTurn(session, turn) {
  const turns = [...list(session?.turns), turn];
  return { ...session, turns, turn_count: turns.length };
}

export function recentTurns(session, count = DEFAULT_RECENT_TURNS) {
  const turns = list(session?.turns);
  const n = positive(count, DEFAULT_RECENT_TURNS);
  return turns.slice(Math.max(0, turns.length - n));
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node --test tests/session.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: 커밋**

```bash
git add src/core/session.js tests/session.test.mjs
git commit -m "feat(core): 세션·턴 상태 기계"
```

---

### Task 6: 서술/선택지 분리와 스트리밍 분할기

**Files:**
- Create: `src/core/narration.js`
- Test: `tests/narration.test.mjs`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `CHOICE_MARKER: string` (`"<선택지>"`)
  - `parseNarration(text) -> { narration, choices: string[] }`
  - `createNarrationSplitter() -> { push(piece) -> string, finish() -> { delta, full } }`

`push()`는 **화면에 내보내도 안전한 만큼만** 돌려준다. 마커의 앞부분일 수 있는 꼬리(`<선택`)는 붙들고 있다가, 마커가 아님이 확정되면 그때 내보낸다. 이렇게 하지 않으면 사용자 화면에 `<선택지>`가 잠깐 나타났다 사라진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/narration.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { parseNarration, createNarrationSplitter, CHOICE_MARKER } = await import("../src/core/narration.js");

test("parseNarration: 마커 앞은 서술, 뒤의 번호 목록은 선택지다", () => {
  const raw = [
    "복도 끝에서 발소리가 멈췄다.",
    "",
    "<선택지>",
    "1. 아무 말 없이 옆에 선다",
    "2. \"혼자 두면 또 무리할 거잖아\"",
    "3. 돌아서서 그대로 나간다",
    "</선택지>"
  ].join("\n");

  const { narration, choices } = parseNarration(raw);
  assert.equal(narration, "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(choices, [
    "아무 말 없이 옆에 선다",
    "\"혼자 두면 또 무리할 거잖아\"",
    "돌아서서 그대로 나간다"
  ]);
});

test("parseNarration: 닫는 태그가 없어도 동작한다", () => {
  const { narration, choices } = parseNarration("서술.\n<선택지>\n1. 가\n2. 나\n3. 다");
  assert.equal(narration, "서술.");
  assert.deepEqual(choices, ["가", "나", "다"]);
});

test("parseNarration: 마커가 아예 없으면 전부 서술이고 선택지는 빈 배열이다", () => {
  // 모델이 형식을 안 지키는 일은 반드시 생긴다. 그때 턴을 실패시키지 않는다.
  const { narration, choices } = parseNarration("그냥 서술만 있다.");
  assert.equal(narration, "그냥 서술만 있다.");
  assert.deepEqual(choices, []);
});

test("parseNarration: 번호 표기가 흔들려도 받는다", () => {
  const { choices } = parseNarration("s\n<선택지>\n1) 가\n2. 나\n- 다\n3 라");
  assert.deepEqual(choices, ["가", "나", "다", "라"]);
});

test("parseNarration: 빈 입력은 빈 결과다", () => {
  assert.deepEqual(parseNarration(""), { narration: "", choices: [] });
  assert.deepEqual(parseNarration(null), { narration: "", choices: [] });
});

test("splitter: 마커 앞까지만 내보내고 마커부터는 삼킨다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("복도 끝에서 ");
  out += splitter.push("발소리가 멈췄다.\n\n");
  out += splitter.push("<선택지>\n1. 가\n");
  out += splitter.push("2. 나\n3. 다\n");
  const { delta, full } = splitter.finish();
  out += delta;

  assert.equal(out, "복도 끝에서 발소리가 멈췄다.\n\n");
  assert.ok(full.includes(CHOICE_MARKER));
  assert.deepEqual(parseNarration(full).choices, ["가", "나", "다"]);
});

test("splitter: 마커가 조각으로 쪼개져 와도 화면에 새지 않는다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술.");
  out += splitter.push("<선");   // 마커의 앞부분일 수 있으므로 붙들어야 한다
  // 이 시점에 "서술.<선"의 꼬리는 아직 붙들려 있다. 확정된 것은 마커의 일부일 수
  // 없는 앞부분뿐이며, 중요한 것은 "<"가 화면으로 새지 않았다는 것이다.
  assert.ok(!out.includes("<"), "마커 조각이 샜다: " + JSON.stringify(out));
  assert.ok("서술.".startsWith(out), "내보낸 것이 서술의 접두사가 아니다: " + JSON.stringify(out));
  out += splitter.push("택지>\n1. 가\n2. 나\n3. 다");
  out += splitter.finish().delta;
  assert.equal(out, "서술.");
});

test("splitter: 마커를 닮았지만 아닌 꼬리는 결국 내보낸다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술 <선택");
  out += splitter.push("의 여지가 없다.");
  out += splitter.finish().delta;
  assert.equal(out, "서술 <선택의 여지가 없다.");
});

test("splitter: 마커가 끝내 오지 않으면 finish가 남은 것을 전부 내보낸다", () => {
  const splitter = createNarrationSplitter();
  let out = splitter.push("서술만 있다.");
  const { delta, full } = splitter.finish();
  out += delta;
  assert.equal(out, "서술만 있다.");
  assert.equal(full, "서술만 있다.");
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/narration.test.mjs`
Expected: FAIL — `Cannot find module .../src/core/narration.js`

- [ ] **Step 3: 구현한다**

`src/core/narration.js`:

```js
/**
 * 서술과 선택지 가르기.
 *
 * 서술과 선택지를 한 호출에서 받는다. 나누면 턴당 Neurons가 1.5배가 되고, 선택지는
 * 방금 쓴 장면의 문맥이 가장 진할 때 나와야 좋다(스펙 4절).
 *
 * 경계는 한국어 제목이 아니라 태그다. `[선택지]` 같은 표기는 서술 본문에도 나올 수
 * 있지만 `<선택지>`는 나오지 않는다.
 *
 * 모델이 형식을 안 지키는 일은 반드시 생긴다. 그때 턴을 실패시키지 않고 선택지 없는
 * 턴으로 넘긴다 — 사용자는 자유 입력으로 계속할 수 있다.
 */

export const CHOICE_MARKER = "<선택지>";
const CHOICE_CLOSE = "</선택지>";

/** `1. `, `1) `, `1 `, `- ` 를 모두 받는다. 모델의 번호 표기는 흔들린다. */
const CHOICE_LINE = /^\s*(?:\d+\s*[.)]?|[-*])\s+(.*)$/;

export function parseNarration(text) {
  const raw = typeof text === "string" ? text : "";
  const at = raw.indexOf(CHOICE_MARKER);
  if (at === -1) return { narration: raw.trim(), choices: [] };

  const narration = raw.slice(0, at).trim();
  let tail = raw.slice(at + CHOICE_MARKER.length);
  const close = tail.indexOf(CHOICE_CLOSE);
  if (close !== -1) tail = tail.slice(0, close);

  const choices = tail
    .split("\n")
    .map((line) => {
      const match = CHOICE_LINE.exec(line);
      return match ? match[1].trim() : "";
    })
    .filter(Boolean);

  return { narration, choices };
}

/**
 * 스트리밍용 분할기.
 *
 * `push()`는 화면에 내보내도 안전한 만큼만 돌려준다. 마커의 앞부분일 수 있는 꼬리는
 * 붙들고 있다가 마커가 아님이 확정되면 내보낸다. 그러지 않으면 사용자 화면에
 * `<선택지>`가 잠깐 나타났다 사라진다.
 */
export function createNarrationSplitter() {
  let full = "";
  let emitted = 0;
  let cut = -1;

  function limit() {
    if (cut !== -1) return cut;
    // 마커의 진부분집합만큼은 붙들어 둔다
    return Math.max(0, full.length - (CHOICE_MARKER.length - 1));
  }

  function drain() {
    const stop = limit();
    if (stop <= emitted) return "";
    const delta = full.slice(emitted, stop);
    emitted = stop;
    return delta;
  }

  return {
    push(piece) {
      full += typeof piece === "string" ? piece : "";
      if (cut === -1) {
        const at = full.indexOf(CHOICE_MARKER);
        if (at !== -1) cut = at;
      }
      return drain();
    },
    finish() {
      const stop = cut === -1 ? full.length : cut;
      const delta = stop > emitted ? full.slice(emitted, stop) : "";
      emitted = stop;
      return { delta, full };
    }
  };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node --test tests/narration.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/core/narration.js tests/narration.test.mjs
git commit -m "feat(core): 서술/선택지 분리와 스트리밍 분할기"
```

---

### Task 7: 프롬프트 조립

**Files:**
- Create: `src/core/memory.js`
- Test: `tests/memory.test.mjs`

**Interfaces:**
- Consumes: `src/core/card.js`의 `renderPrefix`, `src/core/session.js`의 `recentTurns`, `src/core/narration.js`의 `CHOICE_MARKER`
- Produces:
  - `OUTPUT_RULES: string` — 출력 형식 지시문
  - `buildMessages({ world, cards, session, userInput }) -> { messages, estimatedInputTokens }`
  - `messages`: `[{ role: "system"|"user"|"assistant", content: string }]`

M1의 기억층은 **프리픽스 + 최근 3턴**뿐이다. 상태 블록은 M3, 요약 체인과 RAG는 M4다. 자리를 만들어 두되 채우지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/memory.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { buildMessages, OUTPUT_RULES } = await import("../src/core/memory.js");
const { normalizeWorld, normalizeCard } = await import("../src/core/card.js");
const { createSession, appendTurn, makeTurn } = await import("../src/core/session.js");
const { CHOICE_MARKER } = await import("../src/core/narration.js");

const world = normalizeWorld({ world_id: "demo", title: "야간 자율학습", setting: "밤의 학교", tone: "건조하다" });
const cards = [normalizeCard({ card_id: "seorin", world_id: "demo", canonical_name: "한서린" })];

function sessionWith(turnCount, recent = 3) {
  let session = createSession({ world_id: "demo", card_ids: ["seorin"], recent_turns: recent, opening: "교실에 불이 켜져 있다." });
  for (let i = 1; i <= turnCount; i += 1) {
    session = appendTurn(session, makeTurn({ index: i, user_input: `입력${i}`, narration: `서술${i}` }));
  }
  return session;
}

test("buildMessages: system 하나로 시작하고 프리픽스와 출력 규칙을 담는다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(0), userInput: "옆에 선다" });
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("야간 자율학습"));
  assert.ok(messages[0].content.includes("한서린"));
  assert.ok(messages[0].content.includes(CHOICE_MARKER));
  assert.equal(messages.filter((m) => m.role === "system").length, 1);
});

test("buildMessages: 첫 턴이면 오프닝이 assistant로 먼저 들어간다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(0), userInput: "옆에 선다" });
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "교실에 불이 켜져 있다.");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content, "옆에 선다");
});

test("buildMessages: 최근 3턴만 user/assistant 쌍으로 싣는다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(5), userInput: "지금 입력" });
  const pairs = messages.filter((m) => m.role !== "system");
  // 3턴 × 2 + 현재 입력 1 = 7. 오프닝은 첫 턴에만 들어간다.
  assert.equal(pairs.length, 7);
  assert.equal(pairs[0].content, "입력3");
  assert.equal(pairs[1].content, "서술3");
  assert.equal(pairs[4].content, "입력5");
  assert.equal(pairs[5].content, "서술5");
  assert.equal(pairs[6].role, "user");
  assert.equal(pairs[6].content, "지금 입력");
});

test("buildMessages: recent_turns 설정을 따른다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(5, 1), userInput: "지금" });
  const pairs = messages.filter((m) => m.role !== "system");
  assert.equal(pairs.length, 3); // 1턴 × 2 + 현재 1
  assert.equal(pairs[0].content, "입력5");
});

test("buildMessages: 오프닝이 없으면 assistant 자리를 만들지 않는다", () => {
  const session = createSession({ world_id: "demo", opening: "" });
  const { messages } = buildMessages({ world, cards, session, userInput: "시작" });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "user");
});

test("buildMessages: 마지막은 언제나 user다", () => {
  for (const n of [0, 1, 3, 7]) {
    const { messages } = buildMessages({ world, cards, session: sessionWith(n), userInput: "x" });
    assert.equal(messages[messages.length - 1].role, "user", `turns=${n}`);
  }
});

test("buildMessages: 입력 토큰을 어림해 돌려준다", () => {
  const { estimatedInputTokens } = buildMessages({ world, cards, session: sessionWith(3), userInput: "x" });
  assert.ok(estimatedInputTokens > 0);
  // 실제 usage가 오면 대체되는 어림값이다(스펙 12절 5번)
  assert.equal(typeof estimatedInputTokens, "number");
});

test("OUTPUT_RULES: 선택지 3개와 마커 형식을 지시한다", () => {
  assert.ok(OUTPUT_RULES.includes(CHOICE_MARKER));
  assert.ok(OUTPUT_RULES.includes("3개"));
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/memory.test.mjs`
Expected: FAIL — `Cannot find module .../src/core/memory.js`

- [ ] **Step 3: 구현한다**

`src/core/memory.js`:

```js
/**
 * 프롬프트 조립.
 *
 * 프롬프트는 고정 프리픽스 + 기억 4층이다(스펙 5절). **M1은 프리픽스와 단기 기억만
 * 만든다.** 상태 블록은 M3, 요약 체인과 RAG는 M4다. 자리를 지금 만들어 두지 않는
 * 이유는, 빈 블록도 토큰을 먹고 모델이 그것을 지시로 오해하기 때문이다.
 *
 * 최근 턴은 대화 로그가 아니라 user/assistant 쌍으로 싣는다. 한 덩어리 텍스트로 넣으면
 * 모델이 그것을 "지금까지의 서술"이 아니라 "따라 써야 할 예시"로 다루는 경향이 있다.
 */

import { renderPrefix } from "./card.js";
import { recentTurns, DEFAULT_RECENT_TURNS } from "./session.js";
import { CHOICE_MARKER } from "./narration.js";

/** 한국어 기준 어림값. src/llm/budget.js와 같은 상수지만 core는 llm을 참조하지 않는다. */
const CHARS_PER_TOKEN = 1.2;

export const OUTPUT_RULES = `
[출력 형식]
1. 먼저 장면을 서술한다. 서술은 300자에서 700자 사이로 쓴다.
2. 서술이 끝나면 마지막 줄에 반드시 아래 형식으로 선택지 3개를 쓴다.

${CHOICE_MARKER}
1. (행동 또는 대사)
2. (행동 또는 대사)
3. (행동 또는 대사)

3. 서술 본문에는 ${CHOICE_MARKER} 를 쓰지 않는다.
4. 선택지는 서로 방향이 달라야 한다. 같은 행동의 말만 바꾼 것을 세 개 늘어놓지 않는다.
5. 사용자를 대신해 사용자의 행동을 서술하지 않는다. 사용자가 방금 한 행동의 결과만 쓴다.
`.trim();

export function buildMessages({ world, cards = [], session, userInput = "" } = {}) {
  const prefix = renderPrefix({ world, cards, pov: session?.pov ?? null });
  const messages = [{ role: "system", content: `${prefix}\n${OUTPUT_RULES}` }];

  const turns = recentTurns(session, session?.settings?.recent_turns ?? DEFAULT_RECENT_TURNS);

  // 오프닝은 첫 턴에만 넣는다. 이후에는 최근 턴이 그 자리를 대신한다.
  if (turns.length === 0 && session?.opening) {
    messages.push({ role: "assistant", content: session.opening });
  }

  for (const turn of turns) {
    if (turn.user_input) messages.push({ role: "user", content: turn.user_input });
    if (turn.narration) messages.push({ role: "assistant", content: turn.narration });
  }

  messages.push({ role: "user", content: String(userInput || "") });

  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return { messages, estimatedInputTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node --test tests/memory.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: 커밋**

```bash
git add src/core/memory.js tests/memory.test.mjs
git commit -m "feat(core): 프롬프트 조립 (프리픽스 + 최근 3턴)"
```

---

### Task 8: 턴 오케스트레이터

**Files:**
- Create: `src/server/turn.js`
- Test: `tests/turn.test.mjs`

**Interfaces:**
- Consumes: `src/core/memory.js`, `src/core/narration.js`, `src/core/session.js`, `src/llm/budget.js`, Task 3의 `client.narrate()`
- Produces:
  - `runTurn({ world, cards, session, userInput, client, model?, budget, onNarration?, signal? })`
    → 성공 `{ ok:true, turn, session, budget: {...}, truncated }`
    → 실패 `{ ok:false, error_code, message, retryable }`
  - `onNarration(delta)`는 화면에 내보내도 안전한 조각만 받는다(마커 이후는 오지 않는다).
  - 반환 `session`은 새 턴이 붙은 **새 객체**다.

`src/server/`는 CommonJS이고 `src/core/`는 ESM이므로 `await import()`로 접근한다 — 선례는 `src/server/wikisource.js:96`이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/turn.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { runTurn } = await import("../src/server/turn.js");
const { normalizeWorld, normalizeCard } = await import("../src/core/card.js");
const { createSession, appendTurn, makeTurn } = await import("../src/core/session.js");
const { createBudget } = await import("../src/llm/budget.js");

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const world = normalizeWorld({ world_id: "demo", title: "야간 자율학습", setting: "밤의 학교", tone: "건조하다" });
const cards = [normalizeCard({ card_id: "seorin", world_id: "demo", canonical_name: "한서린" })];

const FULL = [
  "복도 끝에서 발소리가 멈췄다.",
  "",
  "<선택지>",
  "1. 아무 말 없이 옆에 선다",
  "2. \"혼자 두면 또 무리할 거잖아\"",
  "3. 돌아서서 그대로 나간다"
].join("\n");

/** FULL을 조각내어 흘려보내는 fake 클라이언트. */
function fakeClient({ pieces = null, usage = { prompt_tokens: 3650, completion_tokens: 500, total_tokens: 4150 }, fail = null, capture = null } = {}) {
  return {
    async narrate({ messages, maxTokens, onToken }) {
      if (capture) { capture.messages = messages; capture.maxTokens = maxTokens; }
      if (fail) return fail;
      for (const piece of pieces || [FULL]) if (onToken) onToken(piece);
      return { ok: true, text: (pieces || [FULL]).join(""), usage, truncated: false };
    }
  };
}

function budget() {
  return createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
}

test("runTurn: 서술과 선택지를 갈라 턴을 만들고 세션에 붙인다", async () => {
  const session = createSession({ world_id: "demo", card_ids: ["seorin"] });
  const result = await runTurn({
    world, cards, session, userInput: "옆에 선다",
    client: fakeClient(), model: MODEL, budget: budget()
  });

  assert.equal(result.ok, true);
  assert.equal(result.turn.narration, "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(result.turn.choices, [
    "아무 말 없이 옆에 선다",
    "\"혼자 두면 또 무리할 거잖아\"",
    "돌아서서 그대로 나간다"
  ]);
  assert.equal(result.turn.index, 1);
  assert.equal(result.turn.user_input, "옆에 선다");
  assert.equal(result.turn.model, MODEL);
  assert.equal(result.session.turn_count, 1);
  assert.equal(session.turn_count, 0, "원본 세션을 바꾸면 안 된다");
});

test("runTurn: onNarration에는 마커 이후가 절대 오지 않는다", async () => {
  const pieces = ["복도 끝에서 ", "발소리가 멈췄다.\n\n", "<선", "택지>\n1. 가\n2. 나\n3. 다"];
  const seen = [];
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient({ pieces }), model: MODEL, budget: budget(),
    onNarration: (delta) => seen.push(delta)
  });

  const streamed = seen.join("");
  assert.ok(!streamed.includes("<선택지>"), `마커가 샜다: ${JSON.stringify(streamed)}`);
  assert.ok(!streamed.includes("1. 가"));
  assert.equal(streamed.trim(), "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(result.turn.choices, ["가", "나", "다"]);
});

test("runTurn: 실제 usage로 Neurons를 집계한다", async () => {
  const b = budget();
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: b
  });
  // 3,650 입력 / 500 출력 → 199.74 (스펙 3-3절)
  assert.ok(Math.abs(result.budget.used - 199.7407) < 0.001);
  assert.equal(result.turn.usage.completion_tokens, 500);
  assert.ok(Math.abs(b.snapshot().used - 199.7407) < 0.001);
});

test("runTurn: usage가 없으면 어림값으로 집계하고 그 사실을 표시한다", async () => {
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient({ usage: null }), model: MODEL, budget: budget()
  });
  assert.ok(result.budget.used > 0, "usage가 없다고 0으로 집계하면 계량기가 거짓말을 한다");
  assert.equal(result.turn.usage.estimated, true);
});

test("runTurn: 선택지가 없어도 턴은 성공이다", async () => {
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient({ pieces: ["형식을 안 지킨 서술만 있다."] }), model: MODEL, budget: budget()
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.choices, []);
  assert.equal(result.turn.narration, "형식을 안 지킨 서술만 있다.");
});

test("runTurn: 클라이언트 오류를 그대로 올린다", async () => {
  const fail = { ok: false, error_code: "RATE_LIMITED", message: "한도", retryable: true };
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient({ fail }), model: MODEL, budget: budget()
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
});

test("runTurn: 빈 입력은 INVALID_ARGUMENT이고 모델을 부르지 않는다", async () => {
  let called = false;
  const client = { async narrate() { called = true; return { ok: true, text: "", usage: null }; } };
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "   ",
    client, model: MODEL, budget: budget()
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.equal(called, false);
});

test("runTurn: 세션 설정의 max_tokens를 클라이언트에 넘긴다", async () => {
  const capture = {};
  await runTurn({
    world, cards,
    session: createSession({ world_id: "demo", max_tokens: 420 }),
    userInput: "u", client: fakeClient({ capture }), model: MODEL, budget: budget()
  });
  assert.equal(capture.maxTokens, 420);
  assert.equal(capture.messages[0].role, "system");
});

test("runTurn: 두 번째 턴의 프롬프트에 첫 턴이 실린다", async () => {
  const capture = {};
  let session = createSession({ world_id: "demo" });
  session = appendTurn(session, makeTurn({ index: 1, user_input: "첫 입력", narration: "첫 서술" }));
  await runTurn({
    world, cards, session, userInput: "둘째 입력",
    client: fakeClient({ capture }), model: MODEL, budget: budget()
  });
  const contents = capture.messages.map((m) => m.content);
  assert.ok(contents.includes("첫 입력"));
  assert.ok(contents.includes("첫 서술"));
  assert.equal(contents[contents.length - 1], "둘째 입력");
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/turn.test.mjs`
Expected: FAIL — `Cannot find module .../src/server/turn.js`

- [ ] **Step 3: 구현한다**

`src/server/turn.js`:

```js
"use strict";

/**
 * 턴 오케스트레이터.
 *
 * 한 턴은 두 호출이다 — ①서술 생성(Cloudflare, 스트리밍)과 ②상태 추출(로컬, 구조화).
 * **M1은 ①만 한다.** ②는 M3에서 이 함수 끝에 비동기로 붙는다.
 *
 * 흐름: 조립(core/memory) → 호출(llm/cloudflare) → 가르기(core/narration) → 계량(llm/budget).
 * 판정은 아무것도 하지 않는다. 이 파일은 순서만 안다.
 *
 * src/server/는 CommonJS, src/core/는 ESM이라 await import()로 접근한다
 * (선례: src/server/wikisource.js).
 */

const { createBudget, estimateTokens, DEFAULT_NARRATION_MODEL } = require("../llm/budget");

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

async function runTurn({
  world,
  cards = [],
  session,
  userInput,
  client,
  model = DEFAULT_NARRATION_MODEL,
  budget,
  onNarration,
  signal
} = {}) {
  const input = String(userInput || "").trim();
  if (!input) return errorResult("INVALID_ARGUMENT", "행동을 입력하세요.", false);

  const memory = await import("../core/memory.js");
  const narration = await import("../core/narration.js");
  const sessionApi = await import("../core/session.js");

  const { messages, estimatedInputTokens } = memory.buildMessages({ world, cards, session, userInput: input });
  const splitter = narration.createNarrationSplitter();
  const ledger = budget || createBudget();

  const generated = await client.narrate({
    model,
    messages,
    maxTokens: session?.settings?.max_tokens,
    onToken(piece) {
      const delta = splitter.push(piece);
      // onNarration이 던지면 스트림 전체가 죽는다. 화면 하나 때문에 턴을 잃지 않는다.
      if (delta && onNarration) {
        try { onNarration(delta); } catch (_error) { /* 무시 */ }
      }
    },
    signal
  });

  if (!generated.ok) return generated;

  const { delta } = splitter.finish();
  if (delta && onNarration) {
    try { onNarration(delta); } catch (_error) { /* 무시 */ }
  }

  const parsed = narration.parseNarration(generated.text);

  // usage가 없다고 0으로 집계하면 계량기가 조용히 거짓말을 한다. 어림값이라고 표시하고 센다.
  const estimated = !generated.usage;
  const inputTokens = generated.usage ? generated.usage.prompt_tokens : estimatedInputTokens;
  const outputTokens = generated.usage ? generated.usage.completion_tokens : estimateTokens(generated.text);
  const recorded = ledger.record({ model, inputTokens, outputTokens });

  const turn = sessionApi.makeTurn({
    index: sessionApi.nextTurnIndex(session),
    user_input: input,
    narration: parsed.narration,
    choices: parsed.choices,
    model,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      neurons: recorded.neurons,
      estimated
    }
  });

  return {
    ok: true,
    turn,
    session: sessionApi.appendTurn(session, turn),
    budget: recorded,
    truncated: Boolean(generated.truncated)
  };
}

module.exports = { runTurn };
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node --test tests/turn.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/server/turn.js tests/turn.test.mjs
git commit -m "feat(server): 턴 오케스트레이터"
```

---

### Task 9: HTTP 엔드포인트와 플레이 화면

**Files:**
- Modify: `server.js` (`POST /api/turn`, `GET /api/cf/health`, `GET /play` 추가)
- Create: `play.html`
- Test: `tests/turn_api.test.mjs`

**Interfaces:**
- Consumes: `src/server/turn.js`의 `runTurn`, `src/llm/cloudflare.js`, `src/llm/budget.js`, `src/core/card.js`의 `loadWorldFile`
- Produces:
  - `GET /api/cf/health` → `{ ok, configured, model, budget }`. **토큰과 account id를 절대 싣지 않는다.**
  - `POST /api/turn` — body `{ session, user_input, model? }`
    - `Accept: text/event-stream`이면 SSE: `narration`(`{delta}`) 여러 번 → `done`(`{turn, session, budget, truncated}`) 또는 `error`
    - 아니면 JSON 한 번에
  - `GET /play` → `play.html`

세계관·카드는 `session.world_id`로 `data/worlds/{world_id}.json`에서 읽는다. M1은 `demo` 하나뿐이며, 경로 조작을 막기 위해 `world_id`를 `[a-z0-9_-]+`로 제한한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/turn_api.test.mjs`:

```js
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.NOVEL_IF_CACHE = "0";
process.env.CF_ACCOUNT_ID = "acc-test";
process.env.CF_API_TOKEN = "tok-secret";

const serverModule = await import("../server.js");
const { app } = serverModule.default || serverModule;

const SSE_BODY = [
  'data: {"response":"복도 끝에서 발소리가 멈췄다.\\n\\n"}\n\n',
  'data: {"response":"<선택지>\\n1. 가\\n2. 나\\n3. 다"}\n\n',
  'data: {"response":"","usage":{"prompt_tokens":3650,"completion_tokens":500,"total_tokens":4150}}\n\n',
  "data: [DONE]\n\n"
].join("");

/** Workers AI 대역. CF_API_BASE로 주입한다. */
function startFakeCloudflare(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function post(port, body, accept) {
  return fetch(`http://127.0.0.1:${port}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(accept ? { Accept: accept } : {}) },
    body: JSON.stringify(body)
  });
}

test("GET /api/cf/health: 설정 여부만 알리고 비밀을 싣지 않는다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/cf/health`);
    const body = await response.json();
    assert.equal(body.configured, true);
    assert.equal(body.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    assert.equal(body.budget.free_per_day, 10000);
    const text = JSON.stringify(body);
    assert.ok(!text.includes("tok-secret"), "API 토큰이 응답에 샜다");
    assert.ok(!text.includes("acc-test"), "account id가 응답에 샜다");
  } finally {
    server.close();
  }
});

test("POST /api/turn: JSON 모드로 턴을 돌려준다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.turn.narration, "복도 끝에서 발소리가 멈췄다.");
    assert.deepEqual(body.turn.choices, ["가", "나", "다"]);
    assert.equal(body.session.turn_count, 1);
    assert.ok(Math.abs(body.budget.used - 199.7407) < 0.001);
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: SSE 모드로 narration 조각을 먼저 흘리고 done으로 끝낸다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    }, "text/event-stream");
    const text = await response.text();

    assert.ok(text.includes("event: narration"));
    assert.ok(text.includes("event: done"));
    assert.ok(text.indexOf("event: narration") < text.indexOf("event: done"));
    assert.ok(!text.includes("<선택지>"), "마커가 SSE로 샜다");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 빈 입력은 400이다", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "demo" }, user_input: "  " });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("POST /api/turn: 없는 world_id는 404다", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "nope" }, user_input: "가" });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error_code, "NOT_FOUND");
  } finally {
    server.close();
  }
});

test("POST /api/turn: world_id 경로 조작을 거부한다", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "../../package" }, user_input: "가" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("POST /api/turn: 업스트림 429는 502와 RATE_LIMITED로 나간다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.statusCode = 429;
    res.end("{}");
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "demo" }, user_input: "가" });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error_code, "RATE_LIMITED");
    assert.equal(body.retryable, true);
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `node --test tests/turn_api.test.mjs`
Expected: FAIL — `/api/cf/health`가 404

- [ ] **Step 3: `src/llm/cloudflare.js`가 API base를 주입받게 한다**

테스트가 fake Workers AI를 세우려면 base URL이 고정 상수여선 안 된다. `createCloudflareClient`의 인자와 URL 조립을 고친다.

```js
function createCloudflareClient({ accountId, apiToken, fetchImpl, timeoutMs, apiBase } = {}) {
  const account = String(accountId || "");
  const token = String(apiToken || "");
  const base = String(apiBase || API_BASE).replace(/\/+$/, "");
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
```

`send()` 안의 fetch URL을 바꾼다.

```js
      response = await doFetch(`${base}/accounts/${account}/ai/run/${model}`, {
```

Task 2의 URL 테스트는 기본값을 쓰므로 그대로 통과한다.

- [ ] **Step 4: `server.js`에 엔드포인트를 더한다**

파일 위쪽 `require` 묶음에 이어서 넣는다.

```js
const fs = require("fs");

const { createCloudflareClient } = require("./src/llm/cloudflare");
const { createBudget, DEFAULT_NARRATION_MODEL } = require("./src/llm/budget");
const turn = require("./src/server/turn");

/** 프로세스 수명 동안 유지되는 하루 장부. M4에서 파일로 옮긴다. */
const turnBudget = createBudget();

function getCloudflareClient() {
  return createCloudflareClient({
    accountId: process.env.CF_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN,
    apiBase: process.env.CF_API_BASE,
    timeoutMs: Number(process.env.CF_TIMEOUT_MS) || 120000
  });
}

/**
 * 세계관 파일 읽기.
 *
 * world_id가 그대로 경로에 들어가므로 문자 집합을 제한한다. `../`를 허용하면 이 서버가
 * 임의 파일 읽기 도구가 된다 — 위키문헌 호스트 화이트리스트와 같은 이유다.
 */
const WORLD_ID = /^[a-z0-9_-]+$/i;

async function loadWorld(worldId) {
  if (!WORLD_ID.test(String(worldId || ""))) {
    return { ok: false, status: 400, error_code: "INVALID_ARGUMENT", message: "world_id 형식이 올바르지 않습니다." };
  }
  const file = path.join(ROOT, "data", "worlds", `${worldId}.json`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return { ok: false, status: 404, error_code: "NOT_FOUND", message: `세계관 '${worldId}'을 찾을 수 없습니다.` };
  }
  const { loadWorldFile } = await import("./src/core/card.js");
  return { ok: true, ...loadWorldFile(raw) };
}

app.get("/play", (_req, res) => {
  res.sendFile(path.join(ROOT, "play.html"));
});

/** 설정 여부와 예산만 알린다. account id와 토큰은 어떤 경우에도 응답에 넣지 않는다. */
app.get("/api/cf/health", (_req, res) => {
  res.json({
    ok: true,
    configured: getCloudflareClient().isConfigured(),
    model: DEFAULT_NARRATION_MODEL,
    budget: turnBudget.snapshot()
  });
});

app.post("/api/turn", async (req, res) => {
  const userInput = String(req.body?.user_input || "").trim();
  const model = String(req.body?.model || DEFAULT_NARRATION_MODEL).trim();
  const wantsStream = String(req.headers.accept || "").includes("text/event-stream");

  if (!userInput) {
    res.status(400).json(errorBody("INVALID_ARGUMENT", "행동을 입력하세요."));
    return;
  }

  const { normalizeSession } = await import("./src/core/session.js");
  const session = normalizeSession(req.body?.session);

  const loaded = await loadWorld(session.world_id);
  if (!loaded.ok) {
    res.status(loaded.status).json(errorBody(loaded.error_code, loaded.message));
    return;
  }

  const sse = wantsStream ? startSse(res) : null;
  const abort = watchDisconnect(res);

  let result;
  try {
    result = await turn.runTurn({
      world: loaded.world,
      cards: loaded.cards,
      session,
      userInput,
      client: getCloudflareClient(),
      model,
      budget: turnBudget,
      onNarration: (delta) => { if (sse) sse.send("narration", { delta }); },
      signal: abort.signal
    });
  } catch (error) {
    console.error("[turn] error:", error);
    result = errorBody("INTERNAL", "턴 생성 내부 오류");
  }

  if (abort.signal.aborted) return;

  if (!result.ok) {
    const body = errorBody(result.error_code, result.message, result.retryable);
    if (sse) {
      sse.send("error", body);
      sse.end();
    } else {
      res.status(result.error_code === "INVALID_ARGUMENT" ? 400 : 502).json(body);
    }
    return;
  }

  const body = {
    turn: result.turn,
    session: result.session,
    budget: result.budget,
    truncated: result.truncated
  };
  if (sse) {
    sse.send("done", body);
    sse.end();
  } else {
    res.json(body);
  }
});
```

- [ ] **Step 5: `play.html`을 만든다**

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>인터랙티브 소설</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.9 system-ui, "Malgun Gothic", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
  .scene { white-space: pre-wrap; margin: 0 0 2rem; }
  .scene.pending { opacity: 0.75; }
  .you { opacity: 0.6; font-style: italic; margin: 0 0 1rem; }
  .choices { display: grid; gap: 0.5rem; margin: 0 0 1.5rem; }
  .choices button { text-align: left; padding: 0.6rem 0.85rem; font: inherit; cursor: pointer;
    border: 1px solid currentColor; border-radius: 0.375rem; background: transparent; color: inherit; }
  form { display: flex; gap: 0.5rem; }
  input { flex: 1; padding: 0.6rem; font: inherit; }
  button[type=submit] { padding: 0.6rem 1rem; font: inherit; cursor: pointer; }
  .meter { position: fixed; top: 0.5rem; right: 0.75rem; font-size: 0.75rem; opacity: 0.55; }
  .cut { opacity: 0.6; font-size: 0.85em; margin: -1rem 0 1.5rem; }
  .error { color: #c0392b; }
</style>
</head>
<body>
<div class="meter" id="meter"></div>
<main>
  <div id="log"></div>
  <div class="choices" id="choices"></div>
  <form id="form">
    <input id="input" placeholder="무엇을 하시겠습니까?" autocomplete="off" required>
    <button type="submit">보내기</button>
  </form>
</main>
<script type="module">
const KEY = "novel-if-play:session";
const log = document.getElementById("log");
const choicesBox = document.getElementById("choices");
const form = document.getElementById("form");
const input = document.getElementById("input");
const meter = document.getElementById("meter");

let session = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && saved.world_id) return saved;
  } catch (_error) { /* 저장이 깨졌으면 새로 시작한다 */ }
  return { session_id: `s-${Date.now()}`, world_id: "demo", opening: "" , turns: [] };
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (_error) { /* 무시 */ }
}

function render() {
  log.replaceChildren();
  for (const turn of session.turns || []) {
    const you = document.createElement("p");
    you.className = "you";
    you.textContent = `> ${turn.user_input}`;
    log.append(you);
    const scene = document.createElement("p");
    scene.className = "scene";
    scene.textContent = turn.narration;
    log.append(scene);
  }
  const last = (session.turns || [])[session.turns.length - 1];
  renderChoices(last ? last.choices : []);
}

function renderChoices(choices) {
  choicesBox.replaceChildren();
  for (const choice of choices || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.addEventListener("click", () => send(choice));
    choicesBox.append(button);
  }
}

async function refreshMeter() {
  try {
    const health = await fetch("/api/cf/health").then((r) => r.json());
    meter.textContent = health.configured
      ? `남은 Neurons ${Math.round(health.budget.remaining).toLocaleString()} / ${health.budget.free_per_day.toLocaleString()}`
      : "CF_ACCOUNT_ID / CF_API_TOKEN 미설정";
  } catch (_error) {
    meter.textContent = "";
  }
}

async function send(userInput) {
  form.querySelector("button").disabled = true;
  renderChoices([]);

  const you = document.createElement("p");
  you.className = "you";
  you.textContent = `> ${userInput}`;
  log.append(you);

  const scene = document.createElement("p");
  scene.className = "scene pending";
  log.append(scene);
  scene.scrollIntoView({ block: "end" });

  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ session, user_input: userInput })
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "narration") {
          scene.textContent += payload.delta;
          scene.scrollIntoView({ block: "end" });
        } else if (event === "done") {
          scene.className = "scene";
          scene.textContent = payload.turn.narration;
          session = payload.session;
          save();
          renderChoices(payload.turn.choices);
          if (payload.truncated) {
            // 스트림이 도중에 끊긴 장면이다. 독자가 모르면 작가가 문장을 끊은 것으로 읽는다.
            const cut = document.createElement("p");
            cut.className = "cut";
            cut.textContent = "장면이 도중에 끊겼습니다. 이어서 입력하면 계속됩니다.";
            log.append(cut);
          }
          meter.textContent = `남은 Neurons ${Math.round(payload.budget.remaining).toLocaleString()}`;
        } else if (event === "error") {
          scene.className = "scene error";
          scene.textContent = payload.message;
        }
      }
    }
  } catch (error) {
    scene.className = "scene error";
    scene.textContent = "요청이 실패했습니다.";
  } finally {
    form.querySelector("button").disabled = false;
    input.value = "";
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (value) send(value);
});

render();
refreshMeter();
</script>
</body>
</html>
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `node --test tests/turn_api.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 7: M1 전체 테스트를 돌린다**

Run: `node --test tests/budget.test.mjs tests/cloudflare_client.test.mjs tests/card.test.mjs tests/session.test.mjs tests/narration.test.mjs tests/memory.test.mjs tests/turn.test.mjs tests/turn_api.test.mjs`
Expected: PASS, 71 tests

기존 테스트(`npm test` 전체)는 이 시점에 초록이 아니어도 된다(스펙 2-3절). M3에서 정리한다.

- [ ] **Step 8: 커밋**

```bash
git add server.js play.html src/llm/cloudflare.js tests/turn_api.test.mjs
git commit -m "feat(server): /api/turn SSE 엔드포인트와 플레이 화면"
```

---

## M1 완료 확인 (사람이 직접)

자동 테스트로는 "재미있는가"를 알 수 없다. 스펙 11절이 M1을 가장 중요하다고 적은 이유가 이것이므로, 아래를 사람이 직접 한다.

- [ ] `CF_ACCOUNT_ID`와 `CF_API_TOKEN`을 설정하고 `npm start` 후 <http://localhost:3000/play> 를 연다

  ```powershell
  $env:CF_ACCOUNT_ID = "<account id>"
  $env:CF_API_TOKEN = "<Workers AI Read+Edit 토큰>"
  npm start
  ```

- [ ] 첫 글자가 화면에 나타나기까지 몇 초 걸리는지 잰다
- [ ] **30턴을 실제로 돌린다.** 다음을 기록한다.
  - 캐릭터가 몇 턴째부터 말투·설정에서 벗어나는가
  - 선택지가 서로 다른 방향을 가리키는가, 아니면 같은 행동의 말만 바꾼 것인가
  - 모델이 사용자를 대신해 사용자의 행동을 서술하는 일이 몇 번 있는가
  - 실제 소모 Neurons가 스펙 3-3절의 턴당 200과 얼마나 다른가
- [ ] 위 결과를 `doc/`에 M1 실측 메모로 남기고, 스펙 3-3절의 토큰 추정표와 12절 5번을 실측으로 교체한다

이 결과가 나쁘면 M2 이후는 헛수고다. **재미없으면 멈추고 프롬프트와 모델을 먼저 다시 본다.**

---

## Self-Review

**스펙 커버리지 (M1 범위)**

| 스펙 요구 | 태스크 |
| --- | --- |
| 3-1 두 호출 분리 — ①만 구현 | Task 3, 8 |
| 3-2 REST 계약·토큰 권한·env | Task 2, 9 |
| 3-3 예산·70B 고정·max_tokens 노출 | Task 1, 5, 8 |
| 4 턴 사이클 — 선택지를 같은 호출에서 | Task 6, 7, 8 |
| 5 프리픽스 + 단기 3턴 | Task 4, 5, 7 |
| 6-1 `Session`·`Turn` 계약 | Task 5 |
| 6-1 `CharacterCard`·`World` 계약 | Task 4 |
| 6-3 localStorage 저장 | Task 9 (`play.html`) |
| 9 모듈 경계·의존 방향 | 전 태스크. `src/llm/`은 `src/core/`를 참조하지 않는다 |
| 10 `/play` 화면·계기판 최소화 | Task 9 |
| 11 M1 완료 조건 | Task 9 Step 7 + 사람 확인 절 |

M1 범위 밖이라 태스크가 없는 것: 상태 블록(M3), 요약 체인·RAG(M4), 카드 컴파일러(M2), audit 되먹임(M3), 분기·내보내기(M5). 스펙 2-2의 모듈 폐기도 M1에서 하지 않는다 — 기존 코드를 건드리지 않는 것이 M1을 되돌리기 쉽게 만든다.

**타입 일관성**

- `error_code` 어휘가 `src/llm/cloudflare.js`(Task 2·3), `src/server/turn.js`(Task 8), `server.js`(Task 9)에서 같다.
- `usage` 모양이 `{prompt_tokens, completion_tokens, total_tokens}`로 Task 2·3·8에서 같다. Task 8이 `neurons`와 `estimated`를 더한 것은 `Turn.usage`이며 어댑터가 돌려주는 `usage`와 구분된다.
- `budget.record()`/`snapshot()`이 돌려주는 `{day, used, remaining, free_per_day}`가 Task 1·8·9에서 같다.
- `createNarrationSplitter().push()`/`finish()` 서명이 Task 6과 8에서 같다.
- Task 9 Step 3이 Task 2의 `createCloudflareClient`에 `apiBase`를 더한다. Task 2의 URL 테스트는 기본값 경로라 그대로 통과한다.
