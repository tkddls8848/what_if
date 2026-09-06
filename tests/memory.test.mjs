import assert from "node:assert/strict";
import test from "node:test";

const { buildMessages, OUTPUT_RULES } = await import("../src/core/memory.js");
const { normalizeWorld, normalizeCard } = await import("../src/core/card.js");
const { createSession, appendTurn, makeTurn } = await import("../src/core/session.js");
const { CHOICE_MARKER } = await import("../src/core/narration.js");
const { createSimState, applyJudgment, stageLabel, recoveryLabel } = await import("../src/core/sim.js");

const world = normalizeWorld({ world_id: "demo", title: "야간 자율학습", setting: "밤의 학교", tone: "건조하다" });
const cards = [normalizeCard({ card_id: "seorin", world_id: "demo", canonical_name: "한서린" })];

function sessionWith(turnCount, recent = 3) {
  let session = createSession({ world_id: "demo", card_ids: ["seorin"], recent_turns: recent, opening: "교실에 불이 켜져 있다." });
  for (let i = 1; i <= turnCount; i += 1) {
    session = appendTurn(session, makeTurn({ index: i, user_input: `입력${i}`, narration: `서술${i}` }));
  }
  return session;
}

test("buildMessages: system 하나로 시작하고 프리픽스와 출력 규칙을 담는다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(0), userInput: "옆에 선다" });
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("야간 자율학습"));
  assert.ok(messages[0].content.includes("한서린"));
  assert.ok(messages[0].content.includes(CHOICE_MARKER));
  assert.equal(messages.filter((m) => m.role === "system").length, 1);
});

test("buildMessages: 첫 턴이면 오프닝이 assistant로 먼저 들어간다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(0), userInput: "옆에 선다" });
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "교실에 불이 켜져 있다.");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content, "옆에 선다");
});

test("buildMessages: 최근 3턴만 user/assistant 쌍으로 싣는다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(5), userInput: "지금 입력" });
  const pairs = messages.filter((m) => m.role !== "system");
  // 3턴 × 2 + 현재 입력 1 = 7. 오프닝은 첫 턴에만 들어간다.
  assert.equal(pairs.length, 7);
  assert.equal(pairs[0].content, "입력3");
  assert.equal(pairs[1].content, "서술3");
  assert.equal(pairs[4].content, "입력5");
  assert.equal(pairs[5].content, "서술5");
  assert.equal(pairs[6].role, "user");
  assert.equal(pairs[6].content, "지금 입력");
});

test("buildMessages: recent_turns 설정을 따른다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(5, 1), userInput: "지금" });
  const pairs = messages.filter((m) => m.role !== "system");
  assert.equal(pairs.length, 3); // 1턴 × 2 + 현재 1
  assert.equal(pairs[0].content, "입력5");
});

test("buildMessages: 오프닝이 없으면 assistant 자리를 만들지 않는다", () => {
  const session = createSession({ world_id: "demo", opening: "" });
  const { messages } = buildMessages({ world, cards, session, userInput: "시작" });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "user");
});

test("buildMessages: 마지막은 언제나 user다", () => {
  for (const n of [0, 1, 3, 7]) {
    const { messages } = buildMessages({ world, cards, session: sessionWith(n), userInput: "x" });
    assert.equal(messages[messages.length - 1].role, "user", `turns=${n}`);
  }
});

test("buildMessages: 입력 토큰을 어림해 돌려준다", () => {
  const { estimatedInputTokens } = buildMessages({ world, cards, session: sessionWith(3), userInput: "x" });
  assert.ok(estimatedInputTokens > 0);
  // 실제 usage가 오면 대체되는 어림값이다(스펙 12절 5번)
  assert.equal(typeof estimatedInputTokens, "number");
});

test("OUTPUT_RULES: 선택지 3개와 마커 형식을 지시한다", () => {
  assert.ok(OUTPUT_RULES.includes(CHOICE_MARKER));
  assert.ok(OUTPUT_RULES.includes("3개"));
});

test("buildMessages: 빈 서술 턴은 통째로 빠진다 (회귀 테스트)", () => {
  // 유효한 턴과 빈 서술 턴을 섞어서 만들기
  let session = createSession({ world_id: "demo", card_ids: ["seorin"], recent_turns: 3, opening: "시작" });
  session = appendTurn(session, makeTurn({ index: 1, user_input: "입력1", narration: "서술1" }));
  session = appendTurn(session, makeTurn({ index: 2, user_input: "입력2", narration: "" })); // 빈 서술
  session = appendTurn(session, makeTurn({ index: 3, user_input: "입력3", narration: "서술3" }));

  const { messages } = buildMessages({ world, cards, session, userInput: "현재" });

  // 같은 role 메시지가 연달아 붙지 않는지 확인
  for (let i = 0; i < messages.length - 1; i += 1) {
    assert.notEqual(messages[i].role, messages[i + 1].role, `인접 메시지 ${i}, ${i + 1}이 같은 role: ${messages[i].role}`);
  }
});

test("buildMessages: 빈 서술 턴의 user_input은 나타나지 않는다", () => {
  let session = createSession({ world_id: "demo", card_ids: ["seorin"], recent_turns: 3, opening: "" });
  session = appendTurn(session, makeTurn({ index: 1, user_input: "입력1", narration: "서술1" }));
  session = appendTurn(session, makeTurn({ index: 2, user_input: "절대_보이면_안됨", narration: "" }));

  const { messages } = buildMessages({ world, cards, session, userInput: "x" });

  const contents = messages.map(m => m.content).join("\n");
  assert.ok(!contents.includes("절대_보이면_안됨"), "빈 서술 턴의 user_input이 나타남");
});

test("buildMessages: 최근 턴이 빈 서술 하나뿐이어도 오프닝이 살아남은 쌍 기준으로 들어간다 (회귀 테스트)", () => {
  // 이 테스트가 잡는 버그: 오프닝 삽입 여부를 "원본 recentTurns() 슬라이스가
  // 비었는가"로 판단하면, 아래처럼 최근 턴이 빈 서술 턴 하나뿐일 때
  // turns.length(=1)가 0이 아니라 오프닝을 건너뛰고, 그 턴은 곧 필터링돼
  // 사라져 프롬프트에 오프닝도 이력도 남지 않는다. "쌍이 하나라도 살아남았는가"로
  // 판단해야 이 경우에도 오프닝이 들어간다.
  let session = createSession({ world_id: "demo", card_ids: ["seorin"], recent_turns: 3, opening: "교실에 불이 켜져 있다." });
  session = appendTurn(session, makeTurn({ index: 1, user_input: "입력1", narration: "" })); // 빈 서술만 있음

  const { messages } = buildMessages({ world, cards, session, userInput: "지금 입력" });

  assert.equal(messages[1].role, "assistant", "오프닝이 들어가지 않았다");
  assert.equal(messages[1].content, "교실에 불이 켜져 있다.");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content, "지금 입력");
  assert.equal(messages.length, 3, "빈 서술 턴의 잔재가 남아 있으면 안 된다");
});

// --- [현재 상태] 블록 (M1 sim step 2) ---

test("buildMessages: simState가 없으면 카드마다 0_stranger/회복 0의 상태 블록을 싣는다", () => {
  const { messages } = buildMessages({ world, cards, session: sessionWith(0), userInput: "x" });
  const system = messages[0].content;
  assert.ok(system.includes("[현재 상태]"));
  assert.ok(system.includes(`한서린: ${stageLabel("0_stranger")}`));
  assert.ok(system.includes(`너: ${recoveryLabel(0)}`));
});

test("buildMessages: simState를 넘기면 그 단계/회복 문구를 싣는다 (숫자는 절대 나타나지 않는다)", () => {
  let sim = createSimState({ cards, protagonist: { relief_triggers: ["곁에 있는다"], strain_triggers: [] } });
  sim = applyJudgment(sim, { card_id: "seorin", attraction: ["a"], card: { romance: { attraction_triggers: ["a"] } } });
  sim = applyJudgment(sim, { card_id: "seorin", relief: ["곁에 있는다"], protagonist: { relief_triggers: ["곁에 있는다"] } });

  const { messages } = buildMessages({ world, cards, session: sessionWith(0), userInput: "x", simState: sim });
  const system = messages[0].content;

  assert.ok(system.includes(`한서린: ${stageLabel(sim.characters.seorin.stage)}`));
  assert.ok(system.includes(`너: ${recoveryLabel(sim.recovery)}`));
  // 숫자가 어디에도 그대로 나타나면 안 된다 (예: "8", "48" 같은 게이지 값)
  assert.ok(!/\d/.test(system.split("[현재 상태]")[1].split("[출력 형식]")[0]),
    "상태 블록에 숫자가 그대로 노출됐다");
});

// --- 장면 줄 (현재 장면을 기억해야 rule 2가 답할 수 있다) ---

test("buildMessages: current_scene이 없으면 상태 블록이 '아직 정해지지 않음'이라고 명시한다", () => {
  const session = sessionWith(0); // createSession()이 만든 세션의 current_scene은 null이다
  const { messages } = buildMessages({ world, cards, session, userInput: "x" });
  const system = messages[0].content;
  assert.ok(system.includes("장면: 아직 정해지지 않음"), "장면이 없다는 사실이 상태 블록에 없다");
});

test("buildMessages: current_scene이 있으면 상태 블록이 그 장소·시간·날씨를 이름 붙여 알려준다", () => {
  let session = sessionWith(0);
  session = { ...session, current_scene: { place: "3학년 2반 교실", time: "밤", weather: "비" } };
  const { messages } = buildMessages({ world, cards, session, userInput: "x" });
  const system = messages[0].content;
  assert.ok(system.includes("3학년 2반 교실"), "장소가 상태 블록에 없다");
  assert.ok(system.includes("밤"), "시간이 상태 블록에 없다");
  assert.ok(system.includes("비"), "날씨가 상태 블록에 없다");
  // "아직 정해지지 않음"은 OUTPUT_RULES 설명문에도 등장하므로(rule 2), 상태
  // 블록 구간만 잘라서 확인한다 — 상태 블록 자체에는 미정 문구가 없어야 한다.
  const stateSection = system.split("[현재 상태]")[1].split("[출력 형식]")[0];
  assert.ok(!stateSection.includes("아직 정해지지 않음"), "장면이 있는데도 상태 블록에 미정 문구가 남아 있다");
});

test("buildMessages: 빈 서술 턴이 있어도 invariant 유지 (system 하나, 마지막 user)", () => {
  let session = createSession({ world_id: "demo", card_ids: ["seorin"], recent_turns: 3, opening: "" });
  session = appendTurn(session, makeTurn({ index: 1, user_input: "입력1", narration: "서술1" }));
  session = appendTurn(session, makeTurn({ index: 2, user_input: "입력2", narration: "" }));

  const { messages } = buildMessages({ world, cards, session, userInput: "x" });

  assert.equal(messages.filter((m) => m.role === "system").length, 1, "system 메시지가 정확히 1개여야 함");
  assert.equal(messages[messages.length - 1].role, "user", "마지막 메시지가 user여야 함");
});
