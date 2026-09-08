import assert from "node:assert/strict";
import test from "node:test";

const { createFallbackClient } = await import("../src/llm/fallback.js");

/**
 * 가짜 제공처. plan은 호출 순서대로 꺼내 쓰는 결과 목록이다.
 * 결과에 tokens가 있으면 onToken으로 흘린 뒤 그 결과를 돌려준다.
 */
function provider(name, plan, { configured = true } = {}) {
  const calls = [];
  const queue = [...plan];

  async function run(opts) {
    calls.push(opts);
    const next = queue.shift() || { ok: false, error_code: "UPSTREAM_ERROR", message: "소진", retryable: false };
    if (next.tokens && opts.onToken) {
      for (const piece of next.tokens) opts.onToken(piece);
    }
    return next;
  }

  return {
    calls,
    entry: {
      name,
      model: `${name}-model`,
      client: {
        isConfigured: () => configured,
        complete: run,
        narrate: run
      }
    }
  };
}

const QUOTA = { ok: false, error_code: "QUOTA_EXHAUSTED", message: "할당 소진", retryable: false };
const OK = (text) => ({ ok: true, text, usage: null, truncated: false, tokens: [text] });

test("주 제공처가 성공하면 폴백은 아예 안 불린다", async () => {
  const primary = provider("cloudflare", [OK("주 서술")]);
  const backup = provider("gemini", [OK("폴백 서술")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ model: "@cf/meta/llama", messages: [] });

  assert.equal(result.ok, true);
  assert.equal(result.text, "주 서술");
  assert.equal(result.provider, "cloudflare");
  assert.equal(backup.calls.length, 0);
});

test("QUOTA_EXHAUSTED면 다음 제공처로 넘어가고 누가 답했는지 알린다", async () => {
  const primary = provider("cloudflare", [QUOTA]);
  const backup = provider("gemini", [OK("폴백이 이어 쓴 서술")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const pieces = [];
  const result = await c.narrate({
    model: "@cf/meta/llama",
    messages: [],
    onToken: (piece) => pieces.push(piece)
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "폴백이 이어 쓴 서술");
  assert.equal(result.provider, "gemini");
  assert.deepEqual(pieces, ["폴백이 이어 쓴 서술"]);
  assert.deepEqual(result.attempts.map((item) => item.error_code), ["QUOTA_EXHAUSTED"]);
});

test("호출부의 model은 첫 제공처에만 간다 — 폴백은 자기 모델을 쓴다", async () => {
  const primary = provider("cloudflare", [QUOTA]);
  const backup = provider("gemini", [OK("x")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", messages: [] });

  assert.equal(primary.calls[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(backup.calls[0].model, "gemini-model");
  assert.equal(result.model, "gemini-model");
});

test("글자가 이미 나갔으면 폴백하지 않는다 — 서술을 겹쳐 쓰지 않는다", async () => {
  // 규약을 어기는 클라이언트(토큰을 흘린 뒤 실패)를 일부러 세운다.
  const primary = provider("cloudflare", [{ ...QUOTA, tokens: ["이미 화면에 나간 글자"] }]);
  const backup = provider("gemini", [OK("두 번째 서술")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const pieces = [];
  const result = await c.narrate({ messages: [], onToken: (piece) => pieces.push(piece) });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "QUOTA_EXHAUSTED");
  assert.equal(backup.calls.length, 0);
  assert.deepEqual(pieces, ["이미 화면에 나간 글자"]);
});

test("ABORTED에서는 폴백하지 않는다 — 아무도 안 기다리는 글이다", async () => {
  const primary = provider("cloudflare", [{ ok: false, error_code: "ABORTED", message: "취소", retryable: false }]);
  const backup = provider("gemini", [OK("x")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ messages: [] });

  assert.equal(result.error_code, "ABORTED");
  assert.equal(backup.calls.length, 0);
});

test("CONTENT_FILTERED에서는 폴백하지 않는다 — 내용에 대한 판단이다", async () => {
  const primary = provider("gemini", [{ ok: false, error_code: "CONTENT_FILTERED", message: "거부", retryable: false }]);
  const backup = provider("cloudflare", [OK("x")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ messages: [] });

  assert.equal(result.error_code, "CONTENT_FILTERED");
  assert.equal(backup.calls.length, 0);
});

test("설정 안 된 제공처는 시도조차 하지 않는다", async () => {
  const primary = provider("cloudflare", [OK("주")], { configured: false });
  const backup = provider("gemini", [OK("폴백")]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ model: "@cf/meta/llama", messages: [] });

  assert.equal(primary.calls.length, 0);
  assert.equal(result.provider, "gemini");
  // 첫 제공처가 빠졌으므로 gemini가 선두다 — 호출부의 model이 gemini로 가면
  // 404가 난다. 자기 모델을 써야 한다.
  assert.equal(backup.calls[0].model, "gemini-model");
  assert.deepEqual(result.attempts, []);
});

test("전부 실패하면 주 제공처의 오류를 돌려주고 나머지를 메시지에 남긴다", async () => {
  const primary = provider("cloudflare", [QUOTA]);
  const backup = provider("gemini", [{ ok: false, error_code: "AUTH_FAILED", message: "키 거부", retryable: false }]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ messages: [] });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "QUOTA_EXHAUSTED");
  assert.ok(result.message.includes("할당 소진"));
  assert.ok(result.message.includes("gemini=AUTH_FAILED"));
  assert.deepEqual(result.attempts.map((item) => item.provider), ["cloudflare", "gemini"]);
});

test("아무 제공처도 설정 안 됐으면 NOT_CONFIGURED다", async () => {
  const primary = provider("cloudflare", [], { configured: false });
  const backup = provider("gemini", [], { configured: false });
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.narrate({ messages: [] });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "NOT_CONFIGURED");
  assert.equal(c.isConfigured(), false);
});

test("describe(): 순서와 설정 여부를 그대로 보여 준다", () => {
  const primary = provider("cloudflare", []);
  const backup = provider("gemini", [], { configured: false });
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  assert.deepEqual(c.describe(), [
    { provider: "cloudflare", model: "cloudflare-model", configured: true },
    { provider: "gemini", model: "gemini-model", configured: false }
  ]);
});

test("complete도 같은 체인을 탄다", async () => {
  const primary = provider("cloudflare", [QUOTA]);
  const backup = provider("gemini", [{ ok: true, text: "폴백 응답", usage: null }]);
  const c = createFallbackClient({ providers: [primary.entry, backup.entry] });

  const result = await c.complete({ messages: [] });

  assert.equal(result.ok, true);
  assert.equal(result.text, "폴백 응답");
  assert.equal(result.provider, "gemini");
});
