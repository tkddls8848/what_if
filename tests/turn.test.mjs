import assert from "node:assert/strict";
import test from "node:test";

const { runTurn } = await import("../src/server/turn.js");
const { normalizeWorld, normalizeCard } = await import("../src/core/card.js");
const { createSession, appendTurn, makeTurn } = await import("../src/core/session.js");
const { createBudget } = await import("../src/llm/budget.js");
const { CHOICE_MARKER } = await import("../src/core/narration.js");

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
function fakeClient({ pieces = null, usage = { prompt_tokens: 3650, completion_tokens: 500, total_tokens: 4150 }, fail = null, capture = null, truncated = false } = {}) {
  return {
    async narrate({ messages, maxTokens, onToken }) {
      if (capture) { capture.messages = messages; capture.maxTokens = maxTokens; }
      if (fail) return fail;
      for (const piece of pieces || [FULL]) if (onToken) onToken(piece);
      return { ok: true, text: (pieces || [FULL]).join(""), usage, truncated };
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

test("runTurn: budget이 없으면 조용히 새 장부를 만들지 않고 INVALID_ARGUMENT다", async () => {
  let called = false;
  const client = { async narrate() { called = true; return { ok: true, text: FULL, usage: null }; } };
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client, model: MODEL
    // budget을 일부러 넘기지 않는다
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.equal(called, false, "장부 없이는 모델도 부르지 않는다");
});

test("runTurn: 세션의 session_id를 턴에 싣는다", async () => {
  const session = createSession({ session_id: "s-abc", world_id: "demo" });
  const result = await runTurn({
    world, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget()
  });
  assert.equal(result.turn.session_id, "s-abc");
});

test("runTurn: budget_unknown은 단가를 모르는 모델일 때만 true다", async () => {
  const known = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget()
  });
  assert.equal(known.budget_unknown, false);

  const unknown = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: "@cf/unknown/model", budget: budget()
  });
  assert.equal(unknown.budget_unknown, true);
});

test("runTurn: truncated 스트림도 턴을 기록하고 플래그를 전한다", async () => {
  const partialNarration = "밤의 학교 복도. 저 멀리서 발소리가 들린다. 막 몸을 돌려 다른 방향으로 가려던 순간, 뭔가";
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient({ pieces: [partialNarration], truncated: true }), model: MODEL, budget: budget()
  });

  assert.equal(result.ok, true, "truncation은 실패가 아니다");
  assert.equal(result.truncated, true, "truncated 플래그가 전해진다");
  assert.equal(result.session.turn_count, 1, "턴이 기록된다");
  assert.equal(result.turn.narration, partialNarration, "부분 텍스트가 저장된다");
  assert.ok(result.budget.used > 0, "토큰이 사용되었으므로 계량기는 기록한다");
  assert.deepEqual(result.turn.choices, [], "끝나지 않은 장면에는 선택지가 없다");
});

// --- 판정 배선 (M1 sim step 2) ---

const romanceWorld = normalizeWorld({
  world_id: "demo", title: "야간 자율학습", setting: "밤의 학교", tone: "건조하다",
  protagonist: { name: "너", relief_triggers: ["먼저 집에 가겠다고 말한다"], strain_triggers: ["괜찮다고 화제를 돌린다"] }
});
const romanceCards = [normalizeCard({
  card_id: "haerin", world_id: "demo", canonical_name: "한해린",
  romance: { attraction_triggers: ["곁에 있어줌"], dislike_triggers: ["거짓말을 한다"] }
})];

function fakeJudgeClient(handler) {
  return { async generateJson(args) { return handler(args); } };
}

test("runTurn: judgeClient를 안 주면 판정을 시도조차 하지 않고 sim은 그대로다", async () => {
  const session = createSession({ world_id: "demo", card_ids: ["haerin"] });
  const result = await runTurn({
    world: romanceWorld, cards: romanceCards, session, userInput: "옆에 앉는다",
    client: fakeClient(), model: MODEL, budget: budget()
    // judgeClient를 일부러 안 준다
  });
  assert.equal(result.ok, true);
  assert.equal(result.judge_unavailable, false, "시도조차 안 한 것은 실패가 아니다");
  assert.deepEqual(result.sim, session.sim, "판정을 안 돌렸으니 sim은 그대로다");
  assert.deepEqual(result.session.sim, session.sim);
  assert.equal(result.last_change, null);
});

test("runTurn: judgeClient가 성공하면 sim을 반영하고 last_change를 함께 돌려준다", async () => {
  const session = createSession({ world_id: "demo", card_ids: ["haerin"] });
  const judgeClient = fakeJudgeClient(() => ({
    ok: true, data: { attraction: ["곁에 있어줌"], dislike: [], relief: ["먼저 집에 가겠다고 말한다"], strain: [] }
  }));
  const result = await runTurn({
    world: romanceWorld, cards: romanceCards, session, userInput: "옆에 앉는다",
    client: fakeClient(), model: MODEL, budget: budget(),
    judgeClient
  });
  assert.equal(result.ok, true);
  assert.equal(result.judge_unavailable, false);
  assert.ok(result.sim.characters.haerin.affection > 0, "attraction이 반영되어 호감이 올랐다");
  assert.ok(result.sim.recovery > 0, "relief가 반영되어 회복이 올랐다");
  assert.equal(result.session.sim, result.sim, "세션에도 같은 sim이 실린다");
  assert.ok(result.last_change, "무엇이 왜 바뀌었는지 last_change로 온다");
  assert.equal(result.last_change.card_id, "haerin");
});

test("runTurn: judge 호출이 실패하면 judge_unavailable=true이고 sim은 손대지 않는다", async () => {
  const session = createSession({ world_id: "demo", card_ids: ["haerin"] });
  const judgeClient = fakeJudgeClient(() => ({
    ok: false, error_code: "CONNECTION_FAILED", message: "Ollama에 연결할 수 없습니다", retryable: true
  }));
  const result = await runTurn({
    world: romanceWorld, cards: romanceCards, session, userInput: "옆에 앉는다",
    client: fakeClient(), model: MODEL, budget: budget(),
    judgeClient
  });
  assert.equal(result.ok, true, "판정 실패가 턴 전체를 실패시키지 않는다");
  assert.equal(result.judge_unavailable, true);
  assert.deepEqual(result.sim, session.sim, "판정이 안 됐으니 점수를 0으로 지어내지 않고 그대로 둔다");
  assert.equal(result.last_change, null);
});

// --- 장면 판정 (미술감독) ---
//
// 서술자는 더 이상 `<장면>` 블록을 쓰지 않는다. 판정은 서술이 다 흐른 뒤 도는
// 별도 호출(src/server/director.js → Jev)이고, runTurn은 그 결과를 실어 나른다.

const stageWorld = normalizeWorld({
  world_id: "demo", title: "야간 자율학습", setting: "밤의 학교", tone: "건조하다",
  stage: {
    locations: [
      { id: "classroom_3_2", ko: "3학년 2반 교실", visual: "empty Korean classroom at night, rows of desks" },
      { id: "hallway", ko: "복도", visual: "empty Korean school corridor at night, lockers" }
    ],
    times: ["밤", "자정"],
    weathers: ["비", "흐림"]
  }
});

function choice(value, confidence) {
  return { type: "choice", choice: value, confidence, noul: null, score: null, probabilities: null };
}

/** Jev 모양의 대역(src/llm/jev.js의 ask 계약). */
function fakeDirectorClient({ answers = null, fail = null, capture = null } = {}) {
  return {
    async ask(args) {
      if (capture) Object.assign(capture, args);
      if (fail) return fail;
      return { ok: true, answers, usage: { input_tokens: 120, output_tokens: 0 }, model: "jev-1.13.0" };
    }
  };
}

const CONFIDENT_CLASSROOM = {
  place: choice("classroom_3_2", 0.94), time: choice("밤", 0.91), weather: choice("비", 0.88)
};

test("runTurn: directorClient가 없으면 장면 판정을 아예 안 한다(시도조차 안 한 것과 실패는 다르다)", async () => {
  const result = await runTurn({
    world: stageWorld, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget()
  });
  assert.equal(result.scene, null);
  assert.equal(result.scene_changed, false);
  assert.equal(result.scene_unavailable, false, "안 준 것을 실패로 적으면 안 된다");
});

test("runTurn: 세 답이 모두 확신이면 새 장면을 내고 visual은 world에서 조회된다", async () => {
  const result = await runTurn({
    world: stageWorld, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM })
  });
  assert.equal(result.scene_changed, true);
  assert.deepEqual(result.scene, {
    location_id: "classroom_3_2",
    place: "3학년 2반 교실",
    time: "밤",
    weather: "비",
    // 생성물이 아니라 세계관 파일에 authored된 문장을 조회한 값이다.
    visual: "empty Korean classroom at night, rows of desks"
  });
  assert.equal(result.scene_unavailable, false);
  assert.equal(result.scene_low_confidence, false);
});

test("runTurn: 판정된 장면이 돌려준 세션의 current_scene에 실린다", async () => {
  const session = createSession({ world_id: "demo" });
  assert.equal(session.current_scene, null, "선행 조건: 새 세션은 장면이 없다");
  const result = await runTurn({
    world: stageWorld, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM })
  });
  assert.equal(result.session.current_scene.location_id, "classroom_3_2");
  assert.equal(result.session.current_scene.place, "3학년 2반 교실");
});

test("runTurn: 직전과 같은 장면이면 changed는 false다(캐시 히트조차 필요 없다)", async () => {
  let session = createSession({ world_id: "demo" });
  session = { ...session, current_scene: { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" } };
  const result = await runTurn({
    world: stageWorld, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM })
  });
  assert.equal(result.scene_changed, false);
  assert.equal(result.scene.location_id, "classroom_3_2");
});

test("runTurn: 장소가 바뀌면 changed가 true다", async () => {
  let session = createSession({ world_id: "demo" });
  session = { ...session, current_scene: { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" } };
  const result = await runTurn({
    world: stageWorld, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({
      answers: { place: choice("hallway", 0.93), time: choice("밤", 0.9), weather: choice("비", 0.85) }
    })
  });
  assert.equal(result.scene_changed, true);
  assert.equal(result.scene.location_id, "hallway");
  assert.equal(result.scene.visual, "empty Korean school corridor at night, lockers");
});

test("runTurn: 하나라도 신뢰도가 임계 미만이면 장면을 유지한다(모르면 바꾸지 않는다)", async () => {
  let session = createSession({ world_id: "demo" });
  const prior = { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" };
  session = { ...session, current_scene: prior };
  const result = await runTurn({
    world: stageWorld, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({
      // 서술이 authored되지 않은 옥상으로 넘어갔다 — 장소 신뢰도가 무너진다.
      answers: { place: choice("hallway", 0.31), time: choice("밤", 0.9), weather: choice("비", 0.9) }
    })
  });
  assert.equal(result.scene_changed, false, "확신 없이 그림을 바꾸면 틀린 그림이 걸린다");
  assert.deepEqual(result.scene, prior);
  assert.equal(result.scene_low_confidence, true);
  // 로그로 "빠진 장소"를 모을 수 있도록 답 자체는 실어 보낸다.
  assert.equal(result.scene_answers.place.choice, "hallway");
});

test("runTurn: 판정 호출이 실패해도 턴은 성공하고 장면은 유지된다", async () => {
  let session = createSession({ world_id: "demo" });
  const prior = { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" };
  session = { ...session, current_scene: prior };
  const result = await runTurn({
    world: stageWorld, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({
      fail: { ok: false, error_code: "PAYMENT_REQUIRED", message: "게이트웨이 잔액이 없습니다.", retryable: false }
    })
  });
  assert.equal(result.ok, true, "배경 그림 하나 때문에 턴을 잃지 않는다");
  assert.equal(result.scene_changed, false);
  assert.deepEqual(result.scene, prior);
  assert.equal(result.scene_unavailable, true, "모르는 값을 없음으로 적지 않는다");
});

test("runTurn: 서술에 장면 표시가 전혀 없어도 매 턴 조건 없이 판정한다", async () => {
  // 예전 고장 1번(블록을 안 써서 그림이 그대로)은 묻는 것 자체가 조건부라
  // 생겼다. 이제 서술이 무엇이든 매 턴 묻는다.
  const capture = {};
  await runTurn({
    world: stageWorld, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM, capture })
  });
  assert.ok(capture.questions, "판정을 아예 안 걸었다");
  assert.deepEqual(Object.keys(capture.questions).sort(), ["place", "time", "weather"]);
  // 서술자에게는 목록을 안 보여주지만, 미술감독에게는 닫힌 목록을 준다.
  assert.deepEqual(Object.keys(capture.questions.place.criteria), ["classroom_3_2", "hallway"]);
});

test("runTurn: 미술감독에게 넘기는 서술은 선택지를 뺀 본문이다", async () => {
  const capture = {};
  await runTurn({
    world: stageWorld, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM, capture })
  });
  assert.equal(capture.state.narration, "복도 끝에서 발소리가 멈췄다.");
  assert.ok(!capture.state.narration.includes(CHOICE_MARKER));
});

test("runTurn: 직전 장면을 state에 실어 준다(날씨처럼 서술에 안 나오는 축 때문)", async () => {
  const capture = {};
  let session = createSession({ world_id: "demo" });
  session = { ...session, current_scene: { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" } };
  await runTurn({
    world: stageWorld, cards, session, userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM, capture })
  });
  assert.deepEqual(capture.state.previous_scene, { place: "3학년 2반 교실", time: "밤", weather: "비" });
});

test("runTurn: world에 stage가 없으면 장면을 못 그린다는 사실이 드러난다", async () => {
  // 모델의 불확실성이 아니라 세계관 파일의 공백이다 — 조용히 유지로 넘기지 않고
  // scene_unavailable로 드러나야 사람이 world를 고친다.
  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "u",
    client: fakeClient(), model: MODEL, budget: budget(),
    directorClient: fakeDirectorClient({ answers: CONFIDENT_CLASSROOM })
  });
  assert.equal(result.ok, true);
  assert.equal(result.scene_unavailable, true);
  assert.equal(result.scene_changed, false);
});

test("runTurn: judgeClient가 지어낸 트리거 이름은 sim에 반영되지 않는다", async () => {
  const session = createSession({ world_id: "demo", card_ids: ["haerin"] });
  const judgeClient = fakeJudgeClient(() => ({
    ok: true, data: { attraction: ["완전히 지어낸 트리거"], dislike: [], relief: [], strain: [] }
  }));
  const result = await runTurn({
    world: romanceWorld, cards: romanceCards, session, userInput: "옆에 앉는다",
    client: fakeClient(), model: MODEL, budget: budget(),
    judgeClient
  });
  assert.equal(result.sim.characters.haerin.affection, 0);
});
