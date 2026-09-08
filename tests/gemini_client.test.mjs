import assert from "node:assert/strict";
import test from "node:test";

const { createGeminiClient, toGeminiBody } = await import("../src/llm/gemini.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

/** SSE 본문을 흉내 낸다. 청크 경계를 호출자가 정하도록 문자열 배열을 그대로 받는다. */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: (async function* stream() {
      for (const chunk of chunks) yield encoder.encode(chunk);
    })()
  };
}

function client(fetchImpl, extra = {}) {
  return createGeminiClient({ apiKey: "key-abc", fetchImpl, ...extra });
}

function candidate(text, extra = {}) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }] };
}

test("complete: 올바른 URL·헤더·본문으로 호출하고 text와 usage를 돌려준다", async () => {
  let seen = null;
  const c = client(async (url, init) => {
    seen = { url, init };
    return jsonResponse({
      ...candidate("복도 끝에서 발소리가 멈췄다."),
      usageMetadata: { promptTokenCount: 3650, candidatesTokenCount: 500, totalTokenCount: 4150 }
    });
  });

  const result = await c.complete({
    model: "gemini-2.5-flash",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    maxTokens: 700
  });

  assert.equal(
    seen.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
  );
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["x-goog-api-key"], "key-abc");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.systemInstruction.parts[0].text, "s");
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.generationConfig.maxOutputTokens, 700);
  assert.equal(body.generationConfig.temperature, 0.6);

  assert.equal(result.ok, true);
  assert.equal(result.text, "복도 끝에서 발소리가 멈췄다.");
  assert.equal(result.usage.prompt_tokens, 3650);
  assert.equal(result.usage.completion_tokens, 500);
});

test("키를 URL에 싣지 않는다 — 헤더로만 보낸다", async () => {
  let seen = null;
  const c = client(async (url, init) => {
    seen = { url, init };
    return jsonResponse(candidate("x"));
  });
  await c.complete({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "u" }] });
  assert.ok(!seen.url.includes("key-abc"));
});

test("키가 없으면 NOT_CONFIGURED이고 네트워크를 건드리지 않는다", async () => {
  let called = false;
  const c = createGeminiClient({ apiKey: "", fetchImpl: async () => { called = true; } });
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "NOT_CONFIGURED");
  assert.equal(c.isConfigured(), false);
  assert.equal(called, false);
});

test("모델 이름의 경로 탈출은 INVALID_ARGUMENT로 막는다", async () => {
  let called = false;
  const c = client(async () => { called = true; return jsonResponse({}); });
  const result = await c.complete({ model: "../../tokens/verify", messages: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.equal(called, false);
});

test("401은 AUTH_FAILED이고 재시도 대상이 아니다", async () => {
  const c = client(async () => jsonResponse({ error: { message: "no" } }, 401));
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.error_code, "AUTH_FAILED");
  assert.equal(result.retryable, false);
});

test("400 API_KEY_INVALID도 AUTH_FAILED다 — 본문 메시지는 싣지 않는다", async () => {
  const c = client(async () => jsonResponse({
    error: {
      code: 400,
      message: "API key not valid. 프롬프트 조각이 섞여 있을 수 있다",
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }]
    }
  }, 400));
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.error_code, "AUTH_FAILED");
  assert.ok(!result.message.includes("프롬프트 조각"));
});

test("429 PerDay 할당은 QUOTA_EXHAUSTED이고 재시도해도 소용없다", async () => {
  const c = client(async () => jsonResponse({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }]
      }]
    }
  }, 429));
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.error_code, "QUOTA_EXHAUSTED");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("GenerateRequestsPerDayPerProjectPerModel-FreeTier"));
});

test("429 분당 할당은 RATE_LIMITED이고 retryDelay를 그대로 옮긴다", async () => {
  const c = client(async () => jsonResponse({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }]
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32s" }
      ]
    }
  }, 429));
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
  assert.ok(result.message.includes("32s"));
});

test("503은 CAPACITY이고 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({}, 503));
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.error_code, "CAPACITY");
  assert.equal(result.retryable, true);
});

test("안전 필터로 텍스트가 하나도 없으면 CONTENT_FILTERED다", async () => {
  const c = client(async () => jsonResponse({
    candidates: [{ finishReason: "SAFETY", content: { parts: [] } }]
  }));
  const result = await c.complete({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.error_code, "CONTENT_FILTERED");
  assert.equal(result.retryable, false);
});

test("narrate: SSE 프레임을 이어 붙이고 마지막 usage를 총계로 쓴다", async () => {
  const frames = [
    `data: ${JSON.stringify(candidate("복도 끝에서 "))}\n\n`,
    `data: ${JSON.stringify({
      ...candidate("발소리가 멈췄다."),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
    })}\n\n`
  ];
  let seen = null;
  const c = client(async (url) => { seen = url; return sseResponse(frames); });

  const pieces = [];
  const result = await c.narrate({
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "u" }],
    onToken: (piece) => pieces.push(piece)
  });

  assert.ok(seen.endsWith(":streamGenerateContent?alt=sse"));
  assert.equal(result.ok, true);
  assert.equal(result.text, "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(pieces, ["복도 끝에서 ", "발소리가 멈췄다."]);
  assert.equal(result.usage.completion_tokens, 20);
  assert.equal(result.truncated, false);
});

test("narrate: 프레임이 청크 경계에 걸쳐 도착해도 조립한다", async () => {
  const whole = `data: ${JSON.stringify(candidate("한 문장이다."))}\n\n`;
  const c = client(async () => sseResponse([whole.slice(0, 12), whole.slice(12, 30), whole.slice(30)]));
  const result = await c.narrate({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "한 문장이다.");
});

test("narrate: 실패하면 onToken은 한 번도 불리지 않는다 (fallback.js가 기대는 불변식)", async () => {
  let calls = 0;
  const c = client(async () => jsonResponse({
    error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [] }
  }, 429));
  const result = await c.narrate({
    model: "gemini-2.5-flash",
    messages: [],
    onToken: () => { calls += 1; }
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("narrate: 글자가 나간 뒤 안전 필터에 막히면 없던 일로 만들지 않고 truncated를 켠다", async () => {
  const frames = [
    `data: ${JSON.stringify(candidate("첫 문장은 나갔다."))}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] })}\n\n`
  ];
  const c = client(async () => sseResponse(frames));
  const result = await c.narrate({ model: "gemini-2.5-flash", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "첫 문장은 나갔다.");
  assert.equal(result.truncated, true);
});

test("toGeminiBody: system은 systemInstruction으로, assistant는 model로 옮긴다", () => {
  const body = toGeminiBody([
    { role: "system", content: "너는 서술자다." },
    { role: "user", content: "문을 연다" },
    { role: "assistant", content: "문이 열렸다." },
    { role: "user", content: "들어간다" }
  ]);
  assert.equal(body.systemInstruction.parts[0].text, "너는 서술자다.");
  assert.deepEqual(body.contents.map((item) => item.role), ["user", "model", "user"]);
});

test("toGeminiBody: 선두의 assistant(오프닝)는 버리지 않고 systemInstruction으로 옮긴다", () => {
  const body = toGeminiBody([
    { role: "system", content: "규칙" },
    { role: "assistant", content: "등대는 조용했다." },
    { role: "user", content: "문을 연다" }
  ]);
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].role, "user");
  const instruction = body.systemInstruction.parts[0].text;
  assert.ok(instruction.includes("규칙"));
  assert.ok(instruction.includes("등대는 조용했다."));
});

test("toGeminiBody: 같은 역할이 연달아 오면 한 턴으로 합친다", () => {
  const body = toGeminiBody([
    { role: "user", content: "a" },
    { role: "user", content: "b" }
  ]);
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].parts.length, 2);
});
