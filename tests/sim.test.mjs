import assert from "node:assert/strict";
import test from "node:test";

const {
  STAGE_THRESHOLDS,
  AFFECTION_DELTA,
  RECOVERY_DELTA,
  stageFor,
  createSimState,
  applyJudgment,
  endingFor
} = await import("../src/core/sim.js");

const CARD = {
  card_id: "haerin",
  romance: {
    attraction_triggers: ["곁에 있어줌", "판단을 대신 내려달라고 한다"],
    dislike_triggers: ["거짓말을 한다"]
  }
};

const PROTAGONIST = {
  relief_triggers: ["먼저 집에 가겠다고 말한다"],
  strain_triggers: ["판단을 대신 내려달라고 한다", "괜찮다고 말하며 화제를 돌린다"]
};

test("stageFor: 경계값 19/20, 79/80에서 정확히 갈린다", () => {
  assert.equal(stageFor(19), "0_stranger");
  assert.equal(stageFor(20), "1_acquaintance");
  assert.equal(stageFor(39), "1_acquaintance");
  assert.equal(stageFor(40), "2_friend");
  assert.equal(stageFor(59), "2_friend");
  assert.equal(stageFor(60), "3_crush");
  assert.equal(stageFor(79), "3_crush");
  assert.equal(stageFor(80), "4_love");
});

test("STAGE_THRESHOLDS: 다섯 단계가 0-100을 빈틈/겹침 없이 덮는다", () => {
  assert.equal(STAGE_THRESHOLDS.length, 5);
  const sorted = [...STAGE_THRESHOLDS].sort((a, b) => a.min - b.min);
  assert.equal(sorted[0].min, 0);
  assert.equal(sorted[sorted.length - 1].max, 100);
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(sorted[i].min, sorted[i - 1].max + 1, "단계 사이에 빈틈이나 겹침이 없어야 한다");
  }
});

test("createSimState: 카드마다 affection 0, stage 0_stranger로 시작하고 recovery는 0이다", () => {
  const state = createSimState({ cards: [CARD], protagonist: PROTAGONIST });
  assert.deepEqual(state, {
    characters: { haerin: { affection: 0, stage: "0_stranger" } },
    recovery: 0,
    fired_hooks: []
  });
});

test("createSimState: cards가 없어도 죽지 않는다", () => {
  const state = createSimState({});
  assert.deepEqual(state, { characters: {}, recovery: 0, fired_hooks: [] });
});

test("applyJudgment: 원래 state를 고치지 않고 새 state를 반환한다 (불변)", () => {
  const before = createSimState({ cards: [CARD] });
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  const after = applyJudgment(before, {
    card_id: "haerin",
    attraction: ["곁에 있어줌"],
    card: CARD,
    protagonist: PROTAGONIST
  });
  assert.deepEqual(before, beforeSnapshot, "인자로 준 state는 그대로다");
  assert.notEqual(after, before);
  assert.equal(after.characters.haerin.affection, AFFECTION_DELTA.ATTRACTION);
});

test("applyJudgment: 카드의 authored 목록에 없는 트리거 이름은 조용히 무시된다", () => {
  const state = createSimState({ cards: [CARD] });
  const after = applyJudgment(state, {
    card_id: "haerin",
    attraction: ["존재하지 않는 트리거"],
    card: CARD,
    protagonist: PROTAGONIST
  });
  assert.equal(after.characters.haerin.affection, 0);
  assert.deepEqual(after.last_change.matched.attraction, []);
});

test("applyJudgment: 한 행동이 호감은 올리고 회복은 내릴 수 있다 (같은 이름이 양쪽 목록에 있을 때)", () => {
  // recovery를 50에서 시작시켜 클램프가 부호를 가리지 않게 한다.
  const state = { ...createSimState({ cards: [CARD] }), recovery: 50 };
  const after = applyJudgment(state, {
    card_id: "haerin",
    attraction: ["판단을 대신 내려달라고 한다"],
    strain: ["판단을 대신 내려달라고 한다"],
    card: CARD,
    protagonist: PROTAGONIST
  });
  assert.equal(after.characters.haerin.affection, AFFECTION_DELTA.ATTRACTION);
  assert.equal(after.recovery, 50 + RECOVERY_DELTA.STRAIN);
  assert.ok(after.characters.haerin.affection > 0, "호감은 올랐고");
  assert.ok(after.recovery < 50, "회복은 같은 턴에 내려갔다");
  assert.equal(after.last_change.affection_delta, AFFECTION_DELTA.ATTRACTION);
  assert.equal(after.last_change.recovery_delta, RECOVERY_DELTA.STRAIN);
});

test("applyJudgment: affection은 100을 넘지 않고 0 밑으로 내려가지 않는다 (양끝 클램프)", () => {
  let state = createSimState({ cards: [CARD] });
  for (let i = 0; i < 30; i++) {
    state = applyJudgment(state, {
      card_id: "haerin",
      attraction: ["곁에 있어줌"],
      card: CARD,
      protagonist: PROTAGONIST
    });
  }
  assert.equal(state.characters.haerin.affection, 100);

  for (let i = 0; i < 30; i++) {
    state = applyJudgment(state, {
      card_id: "haerin",
      dislike: ["거짓말을 한다"],
      card: CARD,
      protagonist: PROTAGONIST
    });
  }
  assert.equal(state.characters.haerin.affection, 0);
});

test("applyJudgment: recovery도 0-100 양끝에서 클램프된다", () => {
  let state = createSimState({ cards: [CARD] });
  for (let i = 0; i < 30; i++) {
    state = applyJudgment(state, {
      card_id: "haerin",
      relief: ["먼저 집에 가겠다고 말한다"],
      card: CARD,
      protagonist: PROTAGONIST
    });
  }
  assert.equal(state.recovery, 100);

  for (let i = 0; i < 30; i++) {
    state = applyJudgment(state, {
      card_id: "haerin",
      strain: ["괜찮다고 말하며 화제를 돌린다"],
      card: CARD,
      protagonist: PROTAGONIST
    });
  }
  assert.equal(state.recovery, 0);
});

test("applyJudgment: 호감 단계가 바뀌면 stage_changed가 true이고 전후 단계를 담는다", () => {
  let state = createSimState({ cards: [CARD] });
  // 8점씩 3번 = 24점 -> 0_stranger에서 1_acquaintance로 넘어간다
  state = applyJudgment(state, { card_id: "haerin", attraction: ["곁에 있어줌"], card: CARD });
  state = applyJudgment(state, { card_id: "haerin", attraction: ["곁에 있어줌"], card: CARD });
  const third = applyJudgment(state, { card_id: "haerin", attraction: ["곁에 있어줌"], card: CARD });
  assert.equal(third.characters.haerin.stage, "1_acquaintance");
  assert.equal(third.last_change.stage_changed, true);
  assert.equal(third.last_change.stage.before, "0_stranger");
  assert.equal(third.last_change.stage.after, "1_acquaintance");
});

function stateWith(affection, recovery) {
  return { characters: { haerin: { affection, stage: stageFor(affection) } }, recovery, fired_hooks: [] };
}

test("endingFor: 호감 높음 + 회복 높음 = together (함께 선다)", () => {
  const result = endingFor(stateWith(80, 80), { card_id: "haerin" });
  assert.equal(result.ending, "together");
});

test("endingFor: 호감 낮음 + 회복 높음 = standing_alone (혼자 설 수 있게 됐다)", () => {
  const result = endingFor(stateWith(20, 80), { card_id: "haerin" });
  assert.equal(result.ending, "standing_alone");
});

test("endingFor: 호감 높음 + 회복 낮음 = dependence (의존, 경고 결말)", () => {
  const result = endingFor(stateWith(80, 20), { card_id: "haerin" });
  assert.equal(result.ending, "dependence");
});

test("endingFor: 호감 낮음 + 회복 낮음 = winter (그대로 겨울)", () => {
  const result = endingFor(stateWith(20, 20), { card_id: "haerin" });
  assert.equal(result.ending, "winter");
});

test("endingFor: card_id를 생략하면 등록된 캐릭터 중 최댓값 호감을 쓴다", () => {
  const state = {
    characters: {
      a: { affection: 30, stage: stageFor(30) },
      b: { affection: 90, stage: stageFor(90) }
    },
    recovery: 90,
    fired_hooks: []
  };
  const result = endingFor(state);
  assert.equal(result.affection, 90);
  assert.equal(result.ending, "together");
});

test("endingFor: 각 결말마다 이유 문자열을 함께 준다", () => {
  const result = endingFor(stateWith(80, 20), { card_id: "haerin" });
  assert.ok(result.reason.length > 0);
});
