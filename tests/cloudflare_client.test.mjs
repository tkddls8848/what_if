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

test("complete: 429 code 3036(하루 무료 할당 소진)은 QUOTA_EXHAUSTED이고 재시도 대상이 아니다", async () => {
  const c = client(async () => jsonResponse({
    success: false,
    errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }]
  }, 429));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "QUOTA_EXHAUSTED");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("10,000") || result.message.includes("할당"));
});

test("complete: 429 code 3040(용량 부족)은 CAPACITY이고 계정 할당과 무관하다고 명시하며 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({
    success: false,
    errors: [{ code: 3040, message: "No more data centers to forward the request to" }]
  }, 429));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "CAPACITY");
  assert.equal(result.retryable, true);
  assert.ok(result.message.includes("무관"));
});

test("complete: 코드를 알 수 없는 429는 RATE_LIMITED이고 Cloudflare의 code·message를 그대로 옮긴다", async () => {
  const c = client(async () => jsonResponse({ success: false, errors: [{ message: "too many requests" }] }, 429));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
  // 원인을 확인하지 못했으므로 할당 소진을 단정하지 않는다 — Cloudflare가 준 메시지만 옮긴다.
  assert.ok(!result.message.includes("10,000"));
  assert.ok(result.message.includes("too many requests"));
});

test("complete: 본문을 파싱할 수 없는 429는 죽지 않고 RATE_LIMITED로 떨어진다", async () => {
  const c = client(async () => ({ ok: false, status: 429, async json() { throw new Error("not json"); } }));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
});

test("429 본문에 토큰 비슷한 문자열이 있어도(code/message 바깥 필드) 결과에 새지 않는다", async () => {
  const c = client(async () => jsonResponse({
    success: false,
    errors: [{ code: 9999, message: "rate limited" }],
    result: { debug: "Authorization: Bearer tok456" }
  }, 429));
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.ok(!JSON.stringify(result).includes("tok456"));
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

test("complete: AbortError인데 타임아웃도 취소도 아니면 방어적으로 TIMEOUT이다", async () => {
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

test("complete: 호출이 취소되면 ABORTED이고 재시도 대상이 아니다", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const c = client(async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  });
  const result = await c.complete({ model: "m", messages: [], signal: ctl.signal });
  assert.equal(result.error_code, "ABORTED");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("취소"));
});

test("complete: 내부 타임아웃은 timedOut 분기를 지나 TIMEOUT을 낸다", { timeout: 5000 }, async () => {
  const c = client(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        // 클라이언트의 내부 타이머가 abort할 때까지 매달려 있는다. 즉시 거부하면
        // 마이크로태스크에서 끝나 타이머가 뜨지 못하고 방어용 분기로 빠진다.
        init.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      }),
    { timeoutMs: 5 }
  );
  const result = await c.complete({ model: "m", messages: [] });
  assert.equal(result.error_code, "TIMEOUT");
  assert.equal(result.retryable, true);
});

test("complete: 성공 경로에서 abort 리스너를 제거한다", async () => {
  const ctl = new AbortController();
  let removeEventListenerCalled = false;
  const originalRemove = ctl.signal.removeEventListener;
  ctl.signal.removeEventListener = function(name, fn) {
    if (name === "abort") removeEventListenerCalled = true;
    originalRemove.call(this, name, fn);
  };

  const c = client(async () => jsonResponse({ success: true, result: { response: "ok" } }));
  const result = await c.complete({ model: "m", messages: [], signal: ctl.signal });

  assert.equal(result.ok, true);
  assert.equal(removeEventListenerCalled, true);
});

test("complete: BAD_RESPONSE 경로에서도 abort 리스너를 제거한다", async () => {
  const ctl = new AbortController();
  let removeEventListenerCalled = false;
  const originalRemove = ctl.signal.removeEventListener;
  ctl.signal.removeEventListener = function(name, fn) {
    if (name === "abort") removeEventListenerCalled = true;
    originalRemove.call(this, name, fn);
  };

  const c = client(async () => ({ ok: true, status: 200, async json() { throw new Error("not json"); } }));
  const result = await c.complete({ model: "m", messages: [], signal: ctl.signal });

  assert.equal(result.error_code, "BAD_RESPONSE");
  assert.equal(removeEventListenerCalled, true);
});

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
  assert.equal(result.truncated, false); // 도중의 깨진 프레임은 truncated를 켜지 않는다
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

test("narrate: 스트림이 마지막 프레임 한가운데서 끝나면 truncated는 true다", async () => {
  // 완전한 프레임 하나, 그리고 \n\n 없이 끝나는 불완전한 프레임. 클라이언트는 반복을 정상 종료한다.
  const c = client(async () => ({
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('data: {"response":"첫 번째"}\n\n', "utf8");
        yield Buffer.from('data: {"response":"두', "utf8"); // 프레임이 끝나지 않음
        // 여기서 반복이 정상 종료 — 예외를 던지지 않음
      }
    }
  }));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "첫 번째"); // 불완전한 프레임은 버림
  assert.equal(result.truncated, true); // 마지막 프레임이 끝나기 전에 끝남
});

test("narrate: 청크 경계가 한국어 문자의 UTF-8 바이트 한가운데를 잘라도 올바르게 디코딩한다", async () => {
  // decoder.decode(chunk, { stream: true })가 청크 사이에 걸친 미완성 바이트를 내부에
  // 들고 있다가 다음 청크와 이어붙인다. { stream: true }를 빼먹는 회귀가 생기면 이
  // 테스트 없이는 드러나지 않는다 — 한글은 UTF-8에서 3바이트라 청크 경계가 문자
  // 한가운데를 가르는 일이 실제로 가장 흔하다.
  const full = 'data: {"response":"복도 끝에서 발소리가 멈췄다."}\n\ndata: [DONE]\n\n';
  const buf = Buffer.from(full, "utf8");

  const prefixBeforeChar = 'data: {"response":"'; // 이 뒤에 바로 "복"(3바이트)이 온다
  const k = Buffer.byteLength(prefixBeforeChar, "utf8") + 1; // "복"의 3바이트 중 1바이트만 첫 청크에 남긴다

  const c = client(async () => ({
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield buf.subarray(0, k);
        yield buf.subarray(k);
      }
    }
  }));

  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "복도 끝에서 발소리가 멈췄다.");
  assert.equal(result.truncated, false);
});

test("narrate: 스트림이 빈 줄만 남기고 끝나면 truncated는 false다", async () => {
  // [DONE] 다음에 빈 줄만 있는 경우, payload가 없으므로 unterminated를 켜지 않는다
  const c = client(async () => streamResponse([
    'data: {"response":"본문"}\n\n',
    "data: [DONE]\n\n",
    "\n" // 빈 줄
  ]));
  const result = await c.narrate({ model: "m", messages: [] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "본문");
  assert.equal(result.truncated, false);
});
