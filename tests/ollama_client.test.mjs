import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaClient, isAllowedSmallModel } from "../src/server/ollama_client.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function brokenJsonResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new Error("invalid json"); }
  };
}

test("generate: 정상 응답에서 본문·토큰 계측을 반환한다", async () => {
  const client = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith("/api/generate"));
      const body = JSON.parse(init.body);
      assert.equal(body.stream, false);
      return jsonResponse({ response: "{\"a\":1}", prompt_eval_count: 1200, eval_count: 88 });
    }
  });
  const result = await client.generate({ model: "qwen3.5:4b", prompt: "p" });
  assert.equal(result.ok, true);
  assert.equal(result.response, "{\"a\":1}");
  assert.equal(result.prompt_eval_count, 1200);
  assert.equal(result.eval_count, 88);
});

test("generateJson: JSON 파싱 성공과 PARSE_FAILED 구분", async () => {
  const okClient = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async () => jsonResponse({ response: "{\"characters\":[]}" })
  });
  const parsed = await okClient.generateJson({ model: "m4b", prompt: "p" });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { characters: [] });

  const badClient = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async () => jsonResponse({ response: "{broken" })
  });
  const failed = await badClient.generateJson({ model: "m4b", prompt: "p" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error_code, "PARSE_FAILED");
  assert.equal(failed.retryable, true);
});

test("연결 실패는 CONNECTION_FAILED로 변환된다", async () => {
  const client = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async () => { throw new TypeError("fetch failed"); }
  });
  const result = await client.generate({ model: "m4b", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "CONNECTION_FAILED");
  assert.equal(result.retryable, true);
  assert.ok(result.message.includes("http://fake"));
});

test("timeout은 TIMEOUT으로 변환된다", async () => {
  const client = createOllamaClient({
    baseUrl: "http://fake",
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });
  const result = await client.generate({ model: "m4b", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "TIMEOUT");
  assert.equal(result.retryable, true);
});

test("HTTP 오류 상태는 UPSTREAM_ERROR로 변환된다", async () => {
  const client = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async () => jsonResponse({ error: "model not found" }, 404)
  });
  const result = await client.generate({ model: "m4b", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "UPSTREAM_ERROR");
  assert.ok(result.message.includes("model not found"));
  assert.equal(result.retryable, false);
});

test("비JSON 본문은 BAD_RESPONSE로 변환된다", async () => {
  const client = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async () => brokenJsonResponse(200)
  });
  const result = await client.listModels();
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "BAD_RESPONSE");
});

test("listModels: 허용 크기 판정을 포함한다", async () => {
  const client = createOllamaClient({
    baseUrl: "http://fake",
    fetchImpl: async () => jsonResponse({
      models: [
        { name: "qwen3.5:4b", capabilities: ["completion"], details: { parameter_size: "4B" } },
        { name: "llama3:70b", capabilities: ["completion"], details: { parameter_size: "70B" } }
      ]
    })
  });
  const result = await client.listModels();
  assert.equal(result.ok, true);
  const allowed = result.models.filter((model) => model.allowed).map((model) => model.name);
  assert.deepEqual(allowed, ["qwen3.5:4b"]);
});

test("isAllowedSmallModel: 태그·파라미터 크기 판별", () => {
  assert.equal(isAllowedSmallModel("qwen3.5:4b"), true);
  assert.equal(isAllowedSmallModel("gemma4:e4b"), true);
  assert.equal(isAllowedSmallModel("llama3:70b"), false);
  assert.equal(isAllowedSmallModel("mymodel", "7B"), true);
  assert.equal(isAllowedSmallModel("mymodel", "70B"), false);
});
