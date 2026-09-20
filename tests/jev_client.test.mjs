import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJevClient, MODEL } = require("../src/llm/jev.js");

const ACCOUNT = "acct-1";
const TOKEN = "cf-token-secret";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === undefined) throw new Error("not json");
      return body;
    }
  };
}

/** fetch 대역. 마지막 호출의 url/options를 기록한다. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
    return handler(calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}

function client(fetchImpl, extra = {}) {
  return createJevClient({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl, ...extra });
}

const QUESTIONS = {
  place: { type: "choice", instructions: "어디인가", criteria: { classroom: "교실", hallway: "복도" } }
};

const OK_BODY = {
  model: "jev-1.13.0",
  answers: {
    place: { type: "choice", choice: "hallway", confidence: 0.91, probabilities: { hallway: 0.91, classroom: 0.09 } }
  },
  usage: { input_tokens: 180, output_tokens: 0 }
};

// --- 호출 경로 ---
//
// M0에서 확인한 것: Jev는 서드파티 모델이라 `ai/run/{model}`이 아니라 모델을
// 바디에 싣는 `ai/run`으로 간다. 이 저장소의 다른 클라이언트와 다른 유일한 점이라
// 회귀 가드를 둔다.

test("ask: ai/run/{model}이 아니라 ai/run으로 보내고 모델은 바디에 싣는다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`);
  assert.ok(!fetchImpl.calls[0].url.includes("typesafe"), "모델이 URL 경로에 들어갔다 — 404가 난다");
  assert.equal(fetchImpl.calls[0].body.model, MODEL);
});

test("ask: gatewayId를 주면 AI Gateway 데이터 플레인으로 보낸다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  await client(fetchImpl, { gatewayId: "novel-if" }).ask({ state: "s", questions: QUESTIONS });

  assert.equal(
    fetchImpl.calls[0].url,
    `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/novel-if/ai/run`
  );
  // 바디는 직접 경로와 완전히 같다 — 갈리는 것은 URL뿐이다.
  assert.equal(fetchImpl.calls[0].body.model, MODEL);
  assert.deepEqual(fetchImpl.calls[0].body.input.questions, QUESTIONS);
});

test("ask: 인증 게이트웨이 토큰은 cf-aig-authorization으로만 나간다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  await client(fetchImpl, { gatewayId: "novel-if", aigToken: "aig-secret" })
    .ask({ state: "s", questions: QUESTIONS });

  const headers = fetchImpl.calls[0].options.headers;
  assert.equal(headers["cf-aig-authorization"], "Bearer aig-secret");
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`, "제공자 인증은 그대로 Authorization이다");
  assert.ok(!JSON.stringify(fetchImpl.calls[0].body).includes("aig-secret"));
});

test("ask: 게이트웨이 토큰이 없으면 cf-aig-authorization을 아예 안 붙인다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  await client(fetchImpl, { gatewayId: "novel-if" }).ask({ state: "s", questions: QUESTIONS });
  assert.equal(fetchImpl.calls[0].options.headers["cf-aig-authorization"], undefined);
});

test("ask: 게이트웨이 401(2009)은 토큰 문제가 아니라 게이트웨이 문제로 안내한다", async () => {
  // 고치는 방법이 "토큰 권한"이 아니라 "게이트웨이를 만들어라"이므로 메시지를 가른다.
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 401,
    async json() {
      return { success: false, name: "AiGatewayError", error: [{ code: 2009, message: "Unauthorized" }] };
    }
  }));
  const result = await client(fetchImpl, { gatewayId: "nope" }).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.error_code, "AUTH_FAILED");
  assert.ok(result.message.includes("CF_GATEWAY_ID"), `안내가 게이트웨이를 가리키지 않는다: ${result.message}`);
});

test("ask: gatewayId가 없으면 v4 직접 경로로 간다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  const c = client(fetchImpl);
  await c.ask({ state: "s", questions: QUESTIONS });
  assert.ok(fetchImpl.calls[0].url.startsWith("https://api.cloudflare.com/client/v4/"));
  assert.equal(c.gatewayId, null);
});

test("ask: state와 questions를 input으로 감싸 보낸다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  await client(fetchImpl).ask({ state: { a: 1 }, questions: QUESTIONS });

  const body = fetchImpl.calls[0].body;
  assert.deepEqual(body.input.state, { a: 1 });
  assert.deepEqual(body.input.questions, QUESTIONS);
});

test("ask: 토큰은 Authorization 헤더로만 나가고 바디에는 없다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(fetchImpl.calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(fetchImpl.calls[0].body).includes(TOKEN));
});

// --- 응답 봉투 ---
//
// 402를 지나지 못해 성공 응답의 봉투를 실물로 확정하지 못했다(M0 기록 3절).
// 그래서 두 모양을 다 받는다 — 어느 쪽이 실제이든 클라이언트는 같은 것을 돌려준다.

test("ask: 제공자 응답이 그대로 오는 모양을 받는다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, true);
  assert.equal(result.answers.place.choice, "hallway");
  assert.equal(result.answers.place.confidence, 0.91);
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.usage, { input_tokens: 180, output_tokens: 0 });
});

test("ask: Cloudflare가 result로 한 번 감싸는 모양도 받는다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { success: true, errors: [], result: OK_BODY }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, true);
  assert.equal(result.answers.place.choice, "hallway");
  assert.equal(result.model, "jev-1.13.0");
});

test("ask: 실물 이중 봉투(result.result)를 벗긴다", async () => {
  // 2026-09-20 라이브에서 실제로 받은 모양이다 — v4의 result 안에 게이트웨이 실행
  // 레코드가 있고, 그 안의 result가 제공자 응답이다. 이게 정상 경로다.
  const live = {
    success: true,
    errors: [],
    messages: [],
    result: {
      state: "Completed",
      gatewayMetadata: { keySource: "Unified" },
      result: {
        model: "jev-1.13.0",
        answers: {
          place: {
            type: "choice",
            choice: "hallway",
            probabilities: { classroom_3_2: 0.03, hallway: 0.97, front_gate: 0 },
            confidence: 0.96
          }
        },
        usage: { input_tokens: 407, output_tokens: 47 }
      }
    }
  };
  const result = await client(fakeFetch(() => jsonResponse(200, live))).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, true);
  assert.equal(result.answers.place.choice, "hallway");
  assert.equal(result.answers.place.confidence, 0.96);
  assert.deepEqual(result.answers.place.probabilities, { classroom_3_2: 0.03, hallway: 0.97, front_gate: 0 });
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.usage, { input_tokens: 407, output_tokens: 47 });
});

test("ask: answers가 어디에도 없으면 BAD_RESPONSE다(추측해서 지어내지 않는다)", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { success: true, result: { something_else: 1 } }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "BAD_RESPONSE");
});

test("ask: JSON이 아니면 BAD_RESPONSE다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, undefined));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "BAD_RESPONSE");
});

// --- 답 정규화 ---

test("ask: 신뢰도가 없으면 0이 아니라 null이다", async () => {
  // 신뢰도 0과 "신뢰도를 모른다"는 director의 임계 판단에서 정반대로 갈린다.
  // 모르는 값을 0으로 적으면 조용히 "확신이 전혀 없다"가 되어 버린다.
  const fetchImpl = fakeFetch(() => jsonResponse(200, {
    model: "jev-1.13.0",
    answers: { place: { type: "choice", choice: "hallway" } }
  }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, true);
  assert.equal(result.answers.place.confidence, null);
  assert.equal(result.answers.place.noul, null);
});

test("ask: noul/score 질문의 필드도 그대로 옮긴다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, {
    model: "jev-1.13.0",
    answers: {
      moved: { type: "noul", noul: 0.82, confidence: 0.77 },
      tension: { type: "score", score: 2.4, confidence: 0.6 }
    }
  }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.answers.moved.noul, 0.82);
  assert.equal(result.answers.tension.score, 2.4);
});

// --- 오류 매핑 ---

test("ask: 402는 PAYMENT_REQUIRED이고 재시도 대상이 아니다", async () => {
  // M0에서 실제로 받은 응답이다. 재시도해도 소용없고 사람이 게이트웨이에
  // 크레딧을 넣어야 풀린다 — AUTH_FAILED나 RATE_LIMITED와 대응이 다르다.
  const fetchImpl = fakeFetch(() => jsonResponse(402, {
    success: false,
    errors: [{ code: 2021, message: "Insufficient balance; add money to your gateway or use BYOK" }]
  }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "PAYMENT_REQUIRED");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("2021"));
  assert.ok(result.message.includes("BYOK"));
});

test("ask: 404 Model not found는 재시도 대상이 아니다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(404, {
    success: false,
    errors: [{ code: 7003, message: "Model not found: typesafe/jev" }]
  }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "UPSTREAM_ERROR");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("7003"));
});

test("ask: 401/403은 AUTH_FAILED이고 본문을 읽지 않는다", async () => {
  let read = false;
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 403,
    async json() { read = true; return { errors: [{ code: 1, message: "cf-token-secret leaked here" }] }; }
  }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.error_code, "AUTH_FAILED");
  assert.equal(read, false, "401/403 본문을 읽으면 토큰이 오류 메시지로 샐 수 있다");
  assert.ok(!result.message.includes(TOKEN));
});

test("ask: 429 code 3036은 QUOTA_EXHAUSTED, 3040은 CAPACITY다", async () => {
  const quota = await client(fakeFetch(() => jsonResponse(429, { errors: [{ code: 3036, message: "daily limit" }] })))
    .ask({ state: "s", questions: QUESTIONS });
  assert.equal(quota.error_code, "QUOTA_EXHAUSTED");
  assert.equal(quota.retryable, false);

  const capacity = await client(fakeFetch(() => jsonResponse(429, { errors: [{ code: 3040, message: "no capacity" }] })))
    .ask({ state: "s", questions: QUESTIONS });
  assert.equal(capacity.error_code, "CAPACITY");
  assert.equal(capacity.retryable, true);
});

test("ask: 분류 못 한 429는 RATE_LIMITED이고 업스트림 code/message를 그대로 옮긴다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(429, { errors: [{ code: 9999, message: "무슨 이유인지 모른다" }] }));
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
  assert.ok(result.message.includes("9999"));
});

test("ask: 5xx는 재시도 가능, 4xx는 아니다", async () => {
  const server = await client(fakeFetch(() => jsonResponse(503, {}))).ask({ state: "s", questions: QUESTIONS });
  assert.equal(server.error_code, "UPSTREAM_ERROR");
  assert.equal(server.retryable, true);

  const bad = await client(fakeFetch(() => jsonResponse(400, {}))).ask({ state: "s", questions: QUESTIONS });
  assert.equal(bad.error_code, "UPSTREAM_ERROR");
  assert.equal(bad.retryable, false);
});

test("ask: 연결 실패는 CONNECTION_FAILED이고 원문 예외가 새지 않는다", async () => {
  const fetchImpl = fakeFetch(() => { throw new Error("ECONNREFUSED C:\\\\secret\\\\path"); });
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.error_code, "CONNECTION_FAILED");
  assert.equal(result.retryable, true);
  assert.ok(!result.message.includes("secret"));
});

test("ask: 타임아웃은 TIMEOUT이다", async () => {
  const fetchImpl = fakeFetch(async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await client(fetchImpl, { timeoutMs: 5 }).ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.error_code, "TIMEOUT");
  assert.equal(result.retryable, true);
});

test("ask: 호출자가 취소하면 ABORTED이고 재시도 대상이 아니다", async () => {
  const controller = new AbortController();
  const fetchImpl = fakeFetch(async () => {
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await client(fetchImpl).ask({ state: "s", questions: QUESTIONS, signal: controller.signal });

  assert.equal(result.error_code, "ABORTED");
  assert.equal(result.retryable, false);
});

// --- 인자 검증 ---

test("ask: 자격증명이 없으면 네트워크를 건드리지 않고 NOT_CONFIGURED다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  const bare = createJevClient({ fetchImpl });
  const result = await bare.ask({ state: "s", questions: QUESTIONS });

  assert.equal(result.error_code, "NOT_CONFIGURED");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(bare.isConfigured(), false);
});

test("ask: 질문이 없으면 INVALID_ARGUMENT이고 호출하지 않는다", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, OK_BODY));
  const result = await client(fetchImpl).ask({ state: "s", questions: {} });

  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.equal(fetchImpl.calls.length, 0);
});

test("createJevClient: 도메인을 모른다 — 장소도 날씨도 등장하지 않는다", async () => {
  // 이 모듈은 질문을 해석하지 않고 그대로 싣는다. 도메인 어휘가 여기 생기면
  // director.js와 두 곳에서 같은 결정을 하게 된다.
  const source = require("node:fs").readFileSync(
    new URL("../src/llm/jev.js", import.meta.url), "utf8"
  );
  const body = source.slice(source.indexOf("function createJevClient"));
  for (const word of ["location_id", "weather", "stage", "narration"]) {
    assert.ok(!body.includes(word), `jev.js 구현부에 도메인 어휘가 샜다: ${word}`);
  }
});
