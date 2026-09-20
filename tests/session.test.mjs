import assert from "node:assert/strict";
import test from "node:test";

const {
  createSession, normalizeSession, normalizeTurn, nextTurnIndex, appendTurn, recentTurns, makeTurn,
  MAX_RECENT_TURNS, MAX_MAX_TOKENS
} = await import("../src/core/session.js");
const { stageFor } = await import("../src/core/sim.js");

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

test("createSession: 같은 인자로 호출해도 session_id가 다르다 (id는 파생값이 아니라 정체성)", () => {
  const session1 = createSession({ world_id: "demo" });
  const session2 = createSession({ world_id: "demo" });
  assert.notEqual(session1.session_id, session2.session_id);
  assert.ok(session1.session_id.length > 0);
  assert.ok(session2.session_id.length > 0);
});

test("appendTurn: settings와 card_ids를 깊은 복사해서 원본과 공유하지 않는다", () => {
  const session = createSession({ world_id: "demo", card_ids: ["a", "b"] });
  const next = appendTurn(session, makeTurn({ index: 1, user_input: "u", narration: "n" }));

  // next를 수정해도 원본은 안 바뀐다
  next.settings.recent_turns = 99;
  next.card_ids.push("c");

  assert.equal(session.settings.recent_turns, 3);
  assert.deepEqual(session.card_ids, ["a", "b"]);
  assert.equal(next.settings.recent_turns, 99);
  assert.deepEqual(next.card_ids, ["a", "b", "c"]);
});

test("normalizeSession: 악의적인 turn을 모양에 맞춘다", () => {
  const session = normalizeSession({
    world_id: "demo",
    turns: [{ index: "nope", user_input: { evil: 1 }, choices: "x" }]
  });
  const turn = session.turns[0];
  assert.equal(turn.index, 0);
  assert.equal(turn.user_input, "");
  assert.deepEqual(turn.choices, []);
  assert.deepEqual(turn.events, []);
  assert.deepEqual(turn.state_changes, []);
  assert.ok(turn.turn_id.length > 0);
});

test("normalizeSession: 기존 turn_id를 보존한다", () => {
  const session = normalizeSession({
    world_id: "demo",
    turns: [{ index: 1, user_input: "u", narration: "n", turn_id: "turn-existing" }]
  });
  const turn = session.turns[0];
  assert.equal(turn.turn_id, "turn-existing");
});

// --- Fix B: max_tokens / recent_turns는 비용 레버이므로 상한을 넘지 못한다 ---

test("normalizeSession: 지나치게 큰 max_tokens와 recent_turns를 상한으로 자른다", () => {
  const session = normalizeSession({
    world_id: "demo",
    settings: { max_tokens: 500000, recent_turns: 9999 }
  });
  assert.equal(session.settings.max_tokens, MAX_MAX_TOKENS);
  assert.equal(session.settings.recent_turns, MAX_RECENT_TURNS);
});

test("normalizeSession: 상한 이내의 값은 그대로 통과한다", () => {
  const session = normalizeSession({
    world_id: "demo",
    settings: { max_tokens: 1000, recent_turns: 5 }
  });
  assert.equal(session.settings.max_tokens, 1000);
  assert.equal(session.settings.recent_turns, 5);
});

test("normalizeSession: settings가 없으면 기본값이 그대로 적용된다", () => {
  const session = normalizeSession({ world_id: "demo" });
  assert.equal(session.settings.max_tokens, 700);
  assert.equal(session.settings.recent_turns, 3);
});

test("createSession: 지나치게 큰 max_tokens와 recent_turns를 상한으로 자른다", () => {
  const session = createSession({ world_id: "demo", max_tokens: 500000, recent_turns: 9999 });
  assert.equal(session.settings.max_tokens, MAX_MAX_TOKENS);
  assert.equal(session.settings.recent_turns, MAX_RECENT_TURNS);
});

test("createSession: 상한 이내의 값은 그대로 통과한다", () => {
  const session = createSession({ world_id: "demo", max_tokens: 1000, recent_turns: 5 });
  assert.equal(session.settings.max_tokens, 1000);
  assert.equal(session.settings.recent_turns, 5);
});

test("createSession: 인자가 없으면 기본값이 그대로 적용된다", () => {
  const session = createSession({ world_id: "demo" });
  assert.equal(session.settings.max_tokens, 700);
  assert.equal(session.settings.recent_turns, 3);
});

// --- Fix C2: 스펙 6-1절이 계약한, 아직 코드에 없던 필드들 ---

test("createSession: created_at을 ISO 8601로 생성하고, summary_chain은 빈 배열로 시작한다", () => {
  const session = createSession({ world_id: "demo" });
  assert.deepEqual(session.summary_chain, []);
  assert.equal(typeof session.created_at, "string");
  assert.ok(!Number.isNaN(Date.parse(session.created_at)), `ISO 8601이 아니다: ${session.created_at}`);
});

test("normalizeSession: created_at이 있으면 보존하고, 없으면 빈 문자열이다 (여기서 생성하지 않는다)", () => {
  const withValue = normalizeSession({ world_id: "demo", created_at: "2026-09-05T00:00:00.000Z" });
  assert.equal(withValue.created_at, "2026-09-05T00:00:00.000Z");

  const withoutValue = normalizeSession({ world_id: "demo" });
  assert.equal(withoutValue.created_at, "");
});

test("normalizeSession: created_at은 반복 정규화해도 값이 바뀌지 않는다 (멱등성)", () => {
  const once = normalizeSession({ world_id: "demo", created_at: "2026-09-05T00:00:00.000Z" });
  const twice = normalizeSession(once);
  assert.equal(once.created_at, twice.created_at);
});

test("normalizeSession: summary_chain은 M1에서 항상 빈 배열이다", () => {
  const session = normalizeSession({ world_id: "demo", summary_chain: ["나중에 채워질 요약"] });
  assert.deepEqual(session.summary_chain, []);
});

test("makeTurn / normalizeTurn: session_id를 싣고 왕복해도 보존된다", () => {
  const turn = makeTurn({ index: 1, session_id: "s-1", user_input: "u", narration: "n" });
  assert.equal(turn.session_id, "s-1");
  assert.deepEqual(turn.audit, { violations: [] });

  const round = normalizeTurn(turn);
  assert.equal(round.session_id, "s-1");
  assert.deepEqual(round.audit, { violations: [] });
});

test("normalizeTurn: audit은 M1에서 항상 { violations: [] }이다", () => {
  const turn = normalizeTurn({ index: 1, audit: { violations: ["나중에 채워질 위반"] } });
  assert.deepEqual(turn.audit, { violations: [] });
});

// --- sim 블록 (M1 sim step 2) ---

test("createSession: card_ids마다 affection 0/0_stranger로 시작하고 recovery는 0이다", () => {
  const session = createSession({ world_id: "demo", card_ids: ["haerin"] });
  assert.deepEqual(session.sim, {
    characters: { haerin: { affection: 0, stage: "0_stranger" } },
    recovery: 0,
    fired_hooks: []
  });
});

test("createSession: card_ids가 없어도 sim은 빈 characters로 죽지 않는다", () => {
  const session = createSession({ world_id: "demo" });
  assert.deepEqual(session.sim, { characters: {}, recovery: 0, fired_hooks: [] });
});

test("normalizeSession: sim이 없으면(옛 세션) card_ids로부터 기본값을 채운다", () => {
  const session = normalizeSession({ world_id: "demo", card_ids: ["haerin"] });
  assert.deepEqual(session.sim, {
    characters: { haerin: { affection: 0, stage: "0_stranger" } },
    recovery: 0,
    fired_hooks: []
  });
});

test("normalizeSession: sim이 이상해도(모양이 아님) 죽지 않고 기본값으로 채운다", () => {
  const session = normalizeSession({ world_id: "demo", card_ids: ["haerin"], sim: "이상한 값" });
  assert.deepEqual(session.sim, {
    characters: { haerin: { affection: 0, stage: "0_stranger" } },
    recovery: 0,
    fired_hooks: []
  });
});

test("normalizeSession: affection/recovery 숫자를 [0,100]으로 클램프한다", () => {
  const session = normalizeSession({
    world_id: "demo",
    card_ids: ["haerin"],
    sim: { characters: { haerin: { affection: 9999, stage: "4_love" } }, recovery: -50 }
  });
  assert.equal(session.sim.characters.haerin.affection, 100);
  assert.equal(session.sim.recovery, 0);
});

test("normalizeSession: stage는 저장값을 믿지 않고 affection에서 다시 계산한다", () => {
  // 브라우저가 affection=5인데 stage="4_love"라고 우겨도 소용없다.
  const session = normalizeSession({
    world_id: "demo",
    card_ids: ["haerin"],
    sim: { characters: { haerin: { affection: 5, stage: "4_love" } }, recovery: 0 }
  });
  assert.equal(session.sim.characters.haerin.stage, stageFor(5));
  assert.equal(session.sim.characters.haerin.stage, "0_stranger");
});

test("normalizeSession: card_ids에 없는 카드의 sim 항목은 버린다", () => {
  const session = normalizeSession({
    world_id: "demo",
    card_ids: ["haerin"],
    sim: {
      characters: {
        haerin: { affection: 30, stage: "1_acquaintance" },
        "유령-카드": { affection: 90, stage: "4_love" }
      },
      recovery: 10
    }
  });
  assert.deepEqual(Object.keys(session.sim.characters), ["haerin"]);
  assert.equal(session.sim.characters.haerin.affection, 30);
});

test("normalizeSession: card_ids에 있지만 sim에 없는 카드는 기본값(0)으로 채운다", () => {
  const session = normalizeSession({
    world_id: "demo",
    card_ids: ["haerin", "새카드"],
    sim: { characters: { haerin: { affection: 40, stage: "2_friend" } }, recovery: 0 }
  });
  assert.equal(session.sim.characters.haerin.affection, 40);
  assert.deepEqual(session.sim.characters["새카드"], { affection: 0, stage: "0_stranger" });
});

// --- current_scene (장면 기억 — memory.js의 상태 블록이 이 값으로 baseline을 삼는다) ---

test("createSession: current_scene은 null로 시작한다", () => {
  const session = createSession({ world_id: "demo" });
  assert.equal(session.current_scene, null);
});

test("normalizeSession: current_scene이 없으면(옛 세션) null이다", () => {
  const session = normalizeSession({ world_id: "demo" });
  assert.equal(session.current_scene, null);
});

test("normalizeSession: 저장된 current_scene을 모양을 맞춰 보존한다", () => {
  const session = normalizeSession({
    world_id: "demo",
    current_scene: { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" }
  });
  assert.deepEqual(session.current_scene, {
    location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비"
  });
});

// visual(이미지 프롬프트)은 세션에 담지 않는다 — 세계관 파일에 authored되어 있고
// 매 턴 location_id로 다시 조회된다. 브라우저가 실어 보내도 버려야, 저작물이
// 사용자 입력으로 되돌아와 이미지 프롬프트에 들어가는 경로가 생기지 않는다.
test("normalizeSession: current_scene의 visual은 보존하지 않는다", () => {
  const session = normalizeSession({
    world_id: "demo",
    current_scene: { location_id: "classroom_3_2", place: "교실", time: "밤", weather: "비", visual: "injected prompt" }
  });
  assert.equal(session.current_scene.visual, undefined);
});

test("normalizeSession: current_scene이 이상한 모양이면(문자열 등) null로 되돌린다", () => {
  const session = normalizeSession({ world_id: "demo", current_scene: "이상한 값" });
  assert.equal(session.current_scene, null);
});

test("normalizeSession: current_scene 필드가 문자열이 아니면 빈 문자열로 채운다", () => {
  const session = normalizeSession({
    world_id: "demo",
    current_scene: { location_id: [], place: 123, time: null, weather: undefined }
  });
  assert.deepEqual(session.current_scene, { location_id: "", place: "", time: "", weather: "" });
});

test("normalizeSession: fired_hooks가 배열이 아니면 빈 배열로 되돌린다", () => {
  const session = normalizeSession({
    world_id: "demo",
    card_ids: ["haerin"],
    sim: { characters: {}, recovery: 0, fired_hooks: "이상한 값" }
  });
  assert.deepEqual(session.sim.fired_hooks, []);
});
