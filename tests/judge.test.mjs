import assert from "node:assert/strict";
import test from "node:test";

const { judgeTurn, DEFAULT_JUDGE_MODEL, JUDGE_SCHEMA } = await import("../src/server/judge.js");

const CARD = {
  card_id: "haerin",
  romance: {
    attraction_triggers: ["곁에 있어줌", "판단을 대신 내려달라고 한다"],
    dislike_triggers: ["거짓말을 한다"]
  }
};

const PROTAGONIST = {
  relief_triggers: ["먼저 집에 가겠다고 말한다"],
  strain_triggers: ["괜찮다고 말하며 화제를 돌린다"]
};

/** tests/scene_pipeline.test.mjs와 같은 패턴: 스크립트로 응답을 내는 대역 클라이언트. */
function fakeClient(handler) {
  const calls = [];
  return {
    async generateJson(args) {
      calls.push(args);
      return handler(args);
    },
    calls
  };
}

test("judgeTurn: 정확한 이름이 일치하면 그대로 통과한다", async () => {
  const client = fakeClient(() => ({
    ok: true,
    data: { attraction: ["곁에 있어줌"], dislike: [], relief: ["먼저 집에 가겠다고 말한다"], strain: [] }
  }));
  const result = await judgeTurn({
    card: CARD, protagonist: PROTAGONIST, userInput: "옆에 앉는다", narration: "...",
    client
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attraction, ["곁에 있어줌"]);
  assert.deepEqual(result.dislike, []);
  assert.deepEqual(result.relief, ["먼저 집에 가겠다고 말한다"]);
  assert.deepEqual(result.strain, []);
});

test("judgeTurn: 목록에 없는 이름(모델이 지어낸 것)은 버린다", async () => {
  const client = fakeClient(() => ({
    ok: true,
    data: {
      attraction: ["곁에 있어줌", "완전히 지어낸 트리거"],
      dislike: ["존재하지 않는 트리거"],
      relief: [],
      strain: []
    }
  }));
  const result = await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attraction, ["곁에 있어줌"]);
  assert.deepEqual(result.dislike, []);
});

test("judgeTurn: 빈 배열은 그대로 통과한다 (해당하는 게 없어도 실패가 아니다)", async () => {
  const client = fakeClient(() => ({
    ok: true,
    data: { attraction: [], dislike: [], relief: [], strain: [] }
  }));
  const result = await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attraction, []);
  assert.deepEqual(result.dislike, []);
  assert.deepEqual(result.relief, []);
  assert.deepEqual(result.strain, []);
});

test("judgeTurn: JSON 파싱 실패(PARSE_FAILED)를 그대로 구조화 오류로 올린다", async () => {
  const client = fakeClient(() => ({
    ok: false, error_code: "PARSE_FAILED", message: "파싱 실패", retryable: true
  }));
  const result = await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "PARSE_FAILED");
  assert.equal(result.retryable, true);
});

test("judgeTurn: Ollama가 죽어 있으면(CONNECTION_FAILED) 구조화 오류로 올리고 던지지 않는다", async () => {
  const client = fakeClient(() => ({
    ok: false, error_code: "CONNECTION_FAILED", message: "Ollama에 연결할 수 없습니다", retryable: true
  }));
  const result = await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "CONNECTION_FAILED");
  assert.equal(result.retryable, true);
});

test("judgeTurn: 클라이언트 자체가 없어도 던지지 않고 구조화 오류를 낸다", async () => {
  const result = await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "CONNECTION_FAILED");
});

test("judgeTurn: 구조화 출력에 JSON Schema(네 배열)를 그대로 전달한다", async () => {
  const client = fakeClient(() => ({ ok: true, data: { attraction: [], dislike: [], relief: [], strain: [] } }));
  await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].format, JUDGE_SCHEMA);
  assert.equal(client.calls[0].temperature, 0.1);
  assert.equal(client.calls[0].model, DEFAULT_JUDGE_MODEL);
});

test("judgeTurn: 프롬프트에 authored 트리거 문자열이 그대로 실린다 (모델이 정확히 골라야 하므로)", async () => {
  const client = fakeClient(() => ({ ok: true, data: { attraction: [], dislike: [], relief: [], strain: [] } }));
  await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  const prompt = client.calls[0].prompt;
  assert.ok(prompt.includes("곁에 있어줌"));
  assert.ok(prompt.includes("거짓말을 한다"));
  assert.ok(prompt.includes("먼저 집에 가겠다고 말한다"));
  assert.ok(prompt.includes("괜찮다고 말하며 화제를 돌린다"));
});

test("judgeTurn: card/protagonist가 없어도(lighthouse류) 죽지 않는다", async () => {
  const client = fakeClient(() => ({ ok: true, data: { attraction: [], dislike: [], relief: [], strain: [] } }));
  const result = await judgeTurn({ card: null, protagonist: null, userInput: "u", narration: "n", client });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attraction, []);
});

test("judgeTurn: data 필드가 배열이 아니어도(모델의 이상 응답) 죽지 않는다", async () => {
  const client = fakeClient(() => ({
    ok: true, data: { attraction: "문자열아님", dislike: null, relief: 5, strain: undefined }
  }));
  const result = await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attraction, []);
  assert.deepEqual(result.dislike, []);
  assert.deepEqual(result.relief, []);
  assert.deepEqual(result.strain, []);
});

test("judgeTurn: model을 지정하면 그대로 전달한다", async () => {
  const client = fakeClient(() => ({ ok: true, data: { attraction: [], dislike: [], relief: [], strain: [] } }));
  await judgeTurn({ card: CARD, protagonist: PROTAGONIST, userInput: "u", narration: "n", client, model: "gemma4:e4b" });
  assert.equal(client.calls[0].model, "gemma4:e4b");
});
