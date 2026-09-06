import assert from "node:assert/strict";
import test from "node:test";

const {
  createImageClient, IMAGE_MODEL, DEFAULT_STEPS, MAX_STEPS,
  DEFAULT_IMAGE_MODEL, IMAGE_MODELS, PHOENIX_DEFAULT_STEPS, PHOENIX_DEFAULT_GUIDANCE,
  DEFAULT_WIDTH, DEFAULT_HEIGHT
} = await import("../src/llm/image.js");

const PHOENIX = "@cf/leonardo/phoenix-1.0";
const LUCID = "@cf/leonardo/lucid-origin";

/** phoenix-1.0 대역 — 응답이 JSON이 아니라 이미지 바이트 그 자체다(바이너리 스트림). */
function binaryResponse(bytesBase64, status = 200) {
  const buffer = Buffer.from(bytesBase64, "base64");
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function client(fetchImpl, extra = {}) {
  return createImageClient({ accountId: "acc123", apiToken: "tok456", fetchImpl, ...extra });
}

test("generate: 올바른 URL·헤더·본문으로 호출하고 base64와 usage를 돌려준다", async () => {
  let seen = null;
  const c = client(async (url, init) => {
    seen = { url, init };
    return jsonResponse({ result: { image: "QkFTRTY0" } });
  });

  // seed를 넘겨도(과거 호출부의 잔재를 흉내낸다) 요청 본문에는 실리지 않아야 한다 —
  // 아래 전용 회귀 테스트와 별개로, 여기서도 다시 한번 확인한다.
  const result = await c.generate({ prompt: "빈 교실, 밤, 비", seed: 42, steps: 4 });

  assert.equal(
    seen.url,
    `https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/${IMAGE_MODEL}`
  );
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer tok456");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.prompt, "빈 교실, 밤, 비");
  assert.equal(body.steps, 4);
  // width/height는 스키마에 없다 — 절대 보내지 않는다
  assert.equal(body.width, undefined);
  assert.equal(body.height, undefined);
  assert.equal(body.negative_prompt, undefined);

  assert.equal(result.ok, true);
  assert.equal(result.base64, "QkFTRTY0");
  assert.deepEqual(result.usage, { steps: 4, tiles: 1 });
});

// --- 회귀 가드: seed 필드는 절대 요청 본문에 실리지 않는다 ---
//
// 실제 flux-1-schnell은 `seed` 필드가 있기만 해도(값과 무관하게) 400을 낸다
// (AiError 5006, "Additional or unevaluated properties '/seed' ... not allowed").
// Cloudflare의 모델 문서 페이지는 seed를 파라미터로 문서화하고 있지만 실제
// 배포된 모델은 그렇지 않다 — 문서를 믿고 seed를 실었던 것이 실제 400의 원인이었다.
test("generate: 요청 본문에 seed 키가 전혀 없다 (호출부가 넘겨도 마찬가지다)", async () => {
  let seenBody = null;
  const c = client(async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return jsonResponse({ result: { image: "AAAA" } });
  });

  await c.generate({ prompt: "p", seed: 999, steps: 4 });
  assert.ok(!Object.prototype.hasOwnProperty.call(seenBody, "seed"), "seed 키가 본문에 있다");

  await c.generate({ prompt: "p", steps: 4 }); // seed를 아예 안 준 경우도 확인
  assert.ok(!Object.prototype.hasOwnProperty.call(seenBody, "seed"));
});

test("generate: steps 기본값은 DEFAULT_STEPS이고 MAX_STEPS를 넘지 않는다", async () => {
  let seenBody = null;
  const c = client(async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return jsonResponse({ result: { image: "AAAA" } });
  });

  await c.generate({ prompt: "p", seed: 1 });
  assert.equal(seenBody.steps, DEFAULT_STEPS);

  await c.generate({ prompt: "p", seed: 1, steps: 999 });
  assert.equal(seenBody.steps, MAX_STEPS);
});

test("generate: 401은 AUTH_FAILED이고 재시도 대상이 아니다", async () => {
  const c = client(async () => jsonResponse({ success: false }, 401));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "AUTH_FAILED");
  assert.equal(result.retryable, false);
});

test("generate: 429 code 3036(하루 무료 할당 소진)은 QUOTA_EXHAUSTED이고 재시도 대상이 아니다", async () => {
  const c = client(async () => jsonResponse({
    success: false,
    errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }]
  }, 429));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "QUOTA_EXHAUSTED");
  assert.equal(result.retryable, false);
});

test("generate: 429 code 3040(용량 부족)은 CAPACITY이고 계정 할당과 무관하다고 명시하며 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({
    success: false,
    errors: [{ code: 3040, message: "No more data centers to forward the request to" }]
  }, 429));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "CAPACITY");
  assert.equal(result.retryable, true);
  assert.ok(result.message.includes("무관"));
});

test("generate: 코드를 알 수 없는 429는 RATE_LIMITED이고 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({ success: false }, 429));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
});

test("generate: 본문을 파싱할 수 없는 429는 죽지 않고 RATE_LIMITED로 떨어진다", async () => {
  const c = client(async () => ({ ok: false, status: 429, async json() { throw new Error("not json"); } }));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
});

test("generate: 429 본문에 토큰 비슷한 문자열이 있어도(code/message 바깥 필드) 결과에 새지 않는다", async () => {
  const c = client(async () => jsonResponse({
    success: false,
    errors: [{ code: 9999, message: "rate limited" }],
    result: { debug: "Authorization: Bearer tok456" }
  }, 429));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "RATE_LIMITED");
  assert.ok(!JSON.stringify(result).includes("tok456"));
});

test("generate: 5xx는 UPSTREAM_ERROR이고 재시도 대상이다", async () => {
  const c = client(async () => jsonResponse({ success: false }, 503));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "UPSTREAM_ERROR");
  assert.equal(result.retryable, true);
});

test("generate: result.image가 없는 응답은 BAD_RESPONSE다", async () => {
  const c = client(async () => jsonResponse({ result: {} }));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "BAD_RESPONSE");
});

test("generate: JSON이 아닌 응답은 BAD_RESPONSE다", async () => {
  const c = client(async () => ({ ok: true, status: 200, async json() { throw new Error("not json"); } }));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "BAD_RESPONSE");
});

test("generate: 연결 실패는 CONNECTION_FAILED다", async () => {
  const c = client(async () => { throw new Error("ECONNREFUSED"); });
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "CONNECTION_FAILED");
  assert.equal(result.retryable, true);
});

test("generate: 타임아웃이면 TIMEOUT이다", { timeout: 5000 }, async () => {
  const c = client(
    (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    { timeoutMs: 5 }
  );
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "TIMEOUT");
  assert.equal(result.retryable, true);
});

test("isConfigured: accountId나 apiToken이 비면 false, 호출은 NOT_CONFIGURED", async () => {
  const unset = createImageClient({ accountId: "", apiToken: "", fetchImpl: async () => { throw new Error("호출되면 안 된다"); } });
  assert.equal(unset.isConfigured(), false);
  const result = await unset.generate({ prompt: "p", seed: 1 });
  assert.equal(result.error_code, "NOT_CONFIGURED");
  assert.equal(result.retryable, false);
});

test("오류 메시지 어디에도 API 토큰이 들어가지 않는다", async () => {
  const c = client(async () => jsonResponse({ error: "bad token tok456" }, 401));
  const result = await c.generate({ prompt: "p", seed: 1 });
  assert.ok(!JSON.stringify(result).includes("tok456"));

  const c2 = client(async () => { throw new Error("connect ECONNREFUSED tok456@host"); });
  const result2 = await c2.generate({ prompt: "p", seed: 1 });
  assert.ok(!JSON.stringify(result2).includes("tok456"));
});

// --- 모델 레지스트리: phoenix-1.0, lucid-origin, 알 수 없는 model id ---
//
// 세 모델은 요청 바디도, 응답 모양도 다르다(파일 상단 주석 참고). 여기서는
// 그 차이를 실제로 만드는지, 그리고 알 수 없는 model이 조용히 기본값으로
// 넘어가지 않고 구조화 오류를 내는지 확인한다.

test("레지스트리: phoenix-1.0은 negative_prompt·width·height·num_steps·guidance를 보낸다(steps가 아니다)", async () => {
  let seenBody = null;
  const c = client(
    async (url, init) => {
      seenBody = JSON.parse(init.body);
      assert.ok(url.endsWith(`/ai/run/${PHOENIX}`), `URL에 phoenix 모델이 없다: ${url}`);
      return binaryResponse("/9j/4AAQSkZJRg==");
    },
    { model: PHOENIX }
  );

  const result = await c.generate({ prompt: "an empty rainy classroom at night", negativePrompt: "people, text" });

  assert.equal(seenBody.prompt, "an empty rainy classroom at night");
  assert.equal(seenBody.negative_prompt, "people, text");
  assert.equal(seenBody.width, DEFAULT_WIDTH);
  assert.equal(seenBody.height, DEFAULT_HEIGHT);
  assert.equal(seenBody.num_steps, PHOENIX_DEFAULT_STEPS);
  assert.equal(seenBody.guidance, PHOENIX_DEFAULT_GUIDANCE);
  // flux 전용 키가 섞이면 안 된다.
  assert.equal(seenBody.steps, undefined);

  assert.equal(result.ok, true);
  assert.equal(result.base64, "/9j/4AAQSkZJRg==");
  assert.deepEqual(result.usage, { steps: PHOENIX_DEFAULT_STEPS, tiles: 1 });
});

test("레지스트리: phoenix-1.0은 negativePrompt를 안 주면 negative_prompt 키를 아예 만들지 않는다", async () => {
  let seenBody = null;
  const c = client(async (_url, init) => { seenBody = JSON.parse(init.body); return binaryResponse("/9j/4AAQSkZJRg=="); }, { model: PHOENIX });
  await c.generate({ prompt: "p" });
  assert.ok(!Object.prototype.hasOwnProperty.call(seenBody, "negative_prompt"));
});

test("레지스트리: phoenix-1.0 응답은 바이너리 스트림이다(JSON이 아니다) — arrayBuffer로 읽어 base64로 바꾼다", async () => {
  const raw = Buffer.from("fake-jpeg-bytes");
  const c = client(async () => binaryResponse(raw.toString("base64")), { model: PHOENIX });
  const result = await c.generate({ prompt: "p" });
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(result.base64, "base64").toString(), "fake-jpeg-bytes");
});

test("레지스트리: phoenix-1.0은 width/height를 넘기면 그대로 쓰고 타일 수를 다시 계산한다", async () => {
  let seenBody = null;
  const c = client(async (_url, init) => { seenBody = JSON.parse(init.body); return binaryResponse("AAAA"); }, { model: PHOENIX });
  const result = await c.generate({ prompt: "p", width: 1024, height: 1024 });
  assert.equal(seenBody.width, 1024);
  assert.equal(seenBody.height, 1024);
  assert.equal(result.usage.tiles, 4, "1024x1024은 512 타일 4장이어야 한다");
});

test("레지스트리: lucid-origin은 width·height·num_steps·guidance·seed를 보내고 negative_prompt는 절대 없다", async () => {
  let seenBody = null;
  const c = client(
    async (url, init) => {
      seenBody = JSON.parse(init.body);
      assert.ok(url.endsWith(`/ai/run/${LUCID}`));
      return jsonResponse({ image: "TFVDSUQ=" }); // lucid는 result로 감싸지 않는다
    },
    { model: LUCID }
  );

  const result = await c.generate({ prompt: "p", negativePrompt: "should be dropped", seed: 42 });

  assert.equal(seenBody.prompt, "p");
  assert.ok(Number.isFinite(seenBody.width));
  assert.ok(Number.isFinite(seenBody.height));
  assert.ok(Number.isFinite(seenBody.num_steps));
  assert.ok(Number.isFinite(seenBody.guidance));
  assert.equal(seenBody.seed, 42);
  assert.equal(seenBody.negative_prompt, undefined, "lucid-origin 스키마에는 negative_prompt가 없다");

  assert.equal(result.ok, true);
  assert.equal(result.base64, "TFVDSUQ=");
});

test("레지스트리: 알 수 없는 IMAGE_MODEL은 INVALID_ARGUMENT이고 fetch를 부르지 않는다", async () => {
  let called = false;
  const c = client(async () => { called = true; return jsonResponse({}); }, { model: "@cf/does-not/exist" });
  const result = await c.generate({ prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.equal(called, false, "알 수 없는 모델인데 실제로 fetch를 호출했다");
});

test("레지스트리: DEFAULT_IMAGE_MODEL(phoenix-1.0)은 IMAGE_MODELS에 등록돼 있고 negative_prompt를 받는다", () => {
  assert.equal(DEFAULT_IMAGE_MODEL, PHOENIX);
  assert.ok(IMAGE_MODELS[DEFAULT_IMAGE_MODEL].acceptsNegativePrompt);
  assert.ok(!IMAGE_MODELS[IMAGE_MODEL].acceptsNegativePrompt, "flux-1-schnell은 negative_prompt를 받지 않는다");
  assert.ok(!IMAGE_MODELS[LUCID].acceptsNegativePrompt, "lucid-origin은 negative_prompt를 받지 않는다");
});

test("레지스트리: 401/429/5xx 오류 처리는 phoenix·lucid에서도 flux와 같다(모델과 무관한 공통 경로)", async () => {
  const auth = client(async () => binaryResponse("", 401), { model: PHOENIX });
  const authResult = await auth.generate({ prompt: "p" });
  assert.equal(authResult.error_code, "AUTH_FAILED");

  const rate = client(async () => jsonResponse({}, 429), { model: LUCID });
  const rateResult = await rate.generate({ prompt: "p" });
  assert.equal(rateResult.error_code, "RATE_LIMITED");
});

test("레지스트리: 오류 메시지 어디에도 API 토큰이 들어가지 않는다(phoenix·lucid)", async () => {
  const c = client(async () => jsonResponse({ error: "bad token tok456" }, 401), { model: PHOENIX });
  const result = await c.generate({ prompt: "p" });
  assert.ok(!JSON.stringify(result).includes("tok456"));
});
