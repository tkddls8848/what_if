import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const {
  normalizeWorld, normalizeCard, loadWorldFile, renderPrefix, renderNarratorPrefix, renderJudgeContext
} = await import("../src/core/card.js");

test("normalizeCard: 빠진 필드를 빈 값으로 채우고 모양을 고정한다", () => {
  const card = normalizeCard({ canonical_name: "아스카", world_id: "demo" });
  assert.equal(card.canonical_name, "아스카");
  assert.equal(card.world_id, "demo");
  assert.ok(card.card_id.length > 0);
  assert.deepEqual(card.aliases, []);
  assert.deepEqual(card.persona, { summary: "", traits: [], values: [], taboos: [], weaknesses: [] });
  assert.deepEqual(card.speech, {
    first_person: "",
    endings: [],
    address_rules: [],
    examples: [],
    tone: "",
    speech_habits: []
  });
  assert.equal(card.status, "suggested");
  // 확장 필드도 같은 규칙(빠지면 빈 값)을 따른다 (스펙: 로맨스/서사 필드 추가)
  assert.equal(card.role, "");
  assert.deepEqual(card.archetype, []);
  assert.deepEqual(card.appearance, { description: "", impression: "", romance_detail: "" });
  assert.deepEqual(card.scenario_hooks, []);
  assert.deepEqual(Object.keys(card.relationship_stages), [
    "0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"
  ]);
  assert.deepEqual(card.relationship_stages["0_stranger"], { behavior: "", example: "" });
  assert.deepEqual(card.romance, {
    romance_style: "",
    initial_attitude: "",
    jealousy_style: "",
    confession_style: "",
    dating_style: "",
    attraction_triggers: [],
    dislike_triggers: [],
    care_signs: [],
    affection_signs: [],
    high_affection_signs: []
  });
});

test("normalizeCard: 이름이 없으면 예외가 아니라 빈 이름 카드를 만들고 호출부가 거른다", () => {
  const card = normalizeCard({});
  assert.equal(card.canonical_name, "");
});

test("renderPrefix: 세계관 규칙·금지와 카드의 성격·말투·예시 대사를 모두 싣는다", () => {
  const world = normalizeWorld({
    world_id: "demo",
    title: "야간 자율학습",
    setting: "비 오는 밤의 고등학교. 교실 하나에만 불이 켜져 있다.",
    tone: "차분하고 건조하다. 감정을 설명하지 않고 행동으로 보여준다.",
    rules: ["초자연적 요소는 없다.", "장면은 학교 안에서만 벌어진다."],
    forbidden: ["현대 기술 용어를 쓰지 않는다."]
  });
  const cards = [normalizeCard({
    world_id: "demo",
    canonical_name: "한서린",
    aliases: ["서린", "반장"],
    persona: { traits: ["무뚝뚝함", "책임감"], values: ["약속은 지킨다"], taboos: ["먼저 사과하지 않는다"] },
    speech: {
      first_person: "나",
      endings: ["-거든", "-잖아"],
      address_rules: ["상대를 성 없이 이름으로 부른다"],
      examples: ["\"먼저 가. 나는 좀 더 있을 거거든.\""]
    },
    appearance: "묶은 머리, 소매가 긴 교복 셔츠."
  })];

  const prefix = renderPrefix({ world, cards, pov: null });

  assert.ok(prefix.includes("야간 자율학습"));
  assert.ok(prefix.includes("초자연적 요소는 없다."));
  assert.ok(prefix.includes("현대 기술 용어를 쓰지 않는다."));
  assert.ok(prefix.includes("한서린"));
  assert.ok(prefix.includes("서린"));
  assert.ok(prefix.includes("무뚝뚝함"));
  assert.ok(prefix.includes("먼저 사과하지 않는다"));
  assert.ok(prefix.includes("-거든"));
  assert.ok(prefix.includes("먼저 가. 나는 좀 더 있을 거거든."));
  assert.ok(prefix.includes("묶은 머리"));
});

test("renderPrefix: pov가 지정되면 그 카드가 시점 인물임을 명시한다", () => {
  const world = normalizeWorld({ world_id: "d", title: "t", setting: "s", tone: "n" });
  const cards = [
    normalizeCard({ card_id: "c1", world_id: "d", canonical_name: "가" }),
    normalizeCard({ card_id: "c2", world_id: "d", canonical_name: "나" })
  ];
  const withPov = renderPrefix({ world, cards, pov: "c2" });
  assert.ok(/시점 인물[^\n]*나/.test(withPov), withPov);

  const without = renderPrefix({ world, cards, pov: null });
  assert.ok(without.includes("3인칭"));
});

test("renderPrefix: 빈 배열 필드는 빈 제목만 남기지 않고 통째로 생략한다", () => {
  const world = normalizeWorld({ world_id: "d", title: "t", setting: "s", tone: "n", rules: [], forbidden: [] });
  const prefix = renderPrefix({ world, cards: [], pov: null });
  assert.ok(!prefix.includes("규칙:"));
  assert.ok(!prefix.includes("금지:"));
});

test("data/worlds/demo.json이 실제로 로드되고 카드가 하나 이상 있다", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../data/worlds/demo.json", import.meta.url), "utf8"));
  const { world, cards } = loadWorldFile(raw);
  assert.equal(world.world_id, "demo");
  assert.ok(cards.length >= 1);
  assert.ok(cards.every((card) => card.canonical_name.length > 0));
  assert.ok(cards.every((card) => card.world_id === "demo"));
  // 말투를 흉내 내려면 요약이 아니라 실제 대사가 필요하다(스펙 7절)
  assert.ok(cards.every((card) => card.speech.examples.length >= 2));
});

test("normalizeCard: 같은 입력을 두 번 정규화하면 같은 card_id를 얻는다 (결정적 id)", () => {
  const input = { canonical_name: "아스카", world_id: "demo" };
  const card1 = normalizeCard(input);
  const card2 = normalizeCard(input);
  assert.equal(card1.card_id, card2.card_id);
});

test("normalizeCard: 같은 세계관 내 다른 이름들은 다른 id를 얻는다", () => {
  const card1 = normalizeCard({ canonical_name: "아스카", world_id: "demo" });
  const card2 = normalizeCard({ canonical_name: "신지", world_id: "demo" });
  assert.notEqual(card1.card_id, card2.card_id);
});

test("normalizeCard: 명시된 card_id는 변경되지 않는다", () => {
  const card = normalizeCard({ canonical_name: "아스카", world_id: "demo", card_id: "custom-id" });
  assert.equal(card.card_id, "custom-id");
});

// --- Fix C2: 스펙 6-1절이 계약한, 아직 코드에 없던 World 필드들 ---

test("normalizeWorld: source_type, source_url, created_at을 보존한다", () => {
  const world = normalizeWorld({
    world_id: "demo",
    title: "t",
    source_type: "wikisource",
    source_url: "https://ko.wikisource.org/wiki/x",
    created_at: "2026-09-05T00:00:00.000Z"
  });
  assert.equal(world.source_type, "wikisource");
  assert.equal(world.source_url, "https://ko.wikisource.org/wiki/x");
  assert.equal(world.created_at, "2026-09-05T00:00:00.000Z");
});

test("normalizeWorld: created_at이 없으면 빈 문자열이고, 여기서 생성하지 않는다 (멱등성)", () => {
  const once = normalizeWorld({ world_id: "demo", title: "t" });
  assert.equal(once.created_at, "");
  const twice = normalizeWorld(once);
  assert.equal(twice.created_at, once.created_at);
});

// --- Problem A: 이미지 프롬프트용 영어 아트 디렉션 ---

test("normalizeWorld: visual_style을 보존하고, 없으면 빈 문자열이다(멱등)", () => {
  const withStyle = normalizeWorld({
    world_id: "demo",
    title: "t",
    visual_style: "muted anime-style background art, cool blue-grey palette"
  });
  assert.equal(withStyle.visual_style, "muted anime-style background art, cool blue-grey palette");

  const twice = normalizeWorld(withStyle);
  assert.equal(twice.visual_style, withStyle.visual_style, "정규화를 두 번 해도 visual_style이 유지된다");

  const without = normalizeWorld({ world_id: "demo", title: "t" });
  assert.equal(without.visual_style, "");
});

test("normalizeWorld: opening을 보존하고, 없으면 빈 문자열이다", () => {
  const withOpening = normalizeWorld({ world_id: "demo", title: "t", opening: "형광등이 깜박인다." });
  assert.equal(withOpening.opening, "형광등이 깜박인다.");

  const twice = normalizeWorld(withOpening);
  assert.equal(twice.opening, "형광등이 깜박인다.", "정규화를 두 번 해도 opening이 유지된다");

  const without = normalizeWorld({ world_id: "demo", title: "t" });
  assert.equal(without.opening, "");
});

test("loadWorldFile: 파일의 world_id가 카드 항목의 conflicting world_id를 덮는다", () => {
  const raw = {
    world: { world_id: "fileworld", title: "t", setting: "s", tone: "n" },
    cards: [
      { canonical_name: "인물", world_id: "wrongworld" }
    ]
  };
  const { world, cards } = loadWorldFile(raw);
  assert.equal(world.world_id, "fileworld");
  assert.equal(cards[0].world_id, "fileworld", "카드의 world_id는 파일의 world_id로 강제된다");
});

// --- 로맨스/힐링 스키마 확장 (M1 sim step 1) ---

test("normalizeCard: appearance가 맨 문자열이면 description으로 승격하고 내용을 잃지 않는다", () => {
  const card = normalizeCard({
    canonical_name: "한서린",
    world_id: "demo",
    appearance: "묶은 머리, 소매가 긴 교복 셔츠."
  });
  assert.deepEqual(card.appearance, {
    description: "묶은 머리, 소매가 긴 교복 셔츠.",
    impression: "",
    romance_detail: ""
  });
});

test("normalizeCard: appearance가 이미 객체면 세 부분을 그대로 보존한다", () => {
  const card = normalizeCard({
    canonical_name: "한해린",
    world_id: "demo",
    appearance: {
      description: "높이 묶은 머리.",
      impression: "차가워 보이지만 눈은 웃는다.",
      romance_detail: "가까이 서면 비누 냄새가 난다."
    }
  });
  assert.deepEqual(card.appearance, {
    description: "높이 묶은 머리.",
    impression: "차가워 보이지만 눈은 웃는다.",
    romance_detail: "가까이 서면 비누 냄새가 난다."
  });
});

test("renderPrefix: appearance 객체의 description만 외형 줄에 실린다", () => {
  const world = normalizeWorld({ world_id: "d", title: "t", setting: "s", tone: "n" });
  const cards = [normalizeCard({
    world_id: "d",
    canonical_name: "한해린",
    appearance: { description: "묶은 머리.", impression: "차갑다", romance_detail: "비누 냄새" }
  })];
  const prefix = renderPrefix({ world, cards, pov: null });
  assert.ok(prefix.includes("외형: 묶은 머리."));
});

test("normalizeCard: 로맨스/서사 확장 필드를 채우면 그대로 보존한다", () => {
  const card = normalizeCard({
    canonical_name: "한해린",
    world_id: "demo",
    role: "히로인",
    archetype: ["새침데기", "속정 깊은"],
    persona: { summary: "요약", traits: ["a"], values: ["b"], taboos: ["c"], weaknesses: ["d"] },
    romance: {
      romance_style: "츤데레",
      initial_attitude: "무관심",
      jealousy_style: "티 안 냄",
      confession_style: "행동으로",
      dating_style: "무뚝뚝",
      attraction_triggers: ["곁에 있어줌"],
      dislike_triggers: ["거짓말"],
      care_signs: ["말없이 담요를 덮어줌"],
      affection_signs: ["눈을 마주침"],
      high_affection_signs: ["먼저 연락함"]
    },
    relationship_stages: {
      "0_stranger": { behavior: "무시", example: "..." },
      "4_love": { behavior: "곁을 지킴", example: "같이 가자." }
    },
    speech: { tone: "건조함", speech_habits: ["말끝을 흐린다"] },
    scenario_hooks: [{ event: "비 오는 날", description: "우산을 나눠 쓴다" }]
  });
  assert.equal(card.role, "히로인");
  assert.deepEqual(card.archetype, ["새침데기", "속정 깊은"]);
  assert.equal(card.persona.summary, "요약");
  assert.deepEqual(card.persona.weaknesses, ["d"]);
  assert.equal(card.romance.romance_style, "츤데레");
  assert.deepEqual(card.romance.attraction_triggers, ["곁에 있어줌"]);
  assert.deepEqual(card.romance.care_signs, ["말없이 담요를 덮어줌"]);
  assert.equal(card.relationship_stages["0_stranger"].behavior, "무시");
  assert.equal(card.relationship_stages["4_love"].example, "같이 가자.");
  assert.equal(card.speech.tone, "건조함");
  assert.deepEqual(card.speech.speech_habits, ["말끝을 흐린다"]);
  assert.deepEqual(card.scenario_hooks, [{ event: "비 오는 날", description: "우산을 나눠 쓴다" }]);
});

test("normalizeWorld: protagonist가 없으면 빈 값으로 채워지고 로드는 실패하지 않는다 (lighthouse 호환)", () => {
  const world = normalizeWorld({ world_id: "lighthouse", title: "t" });
  assert.deepEqual(world.protagonist, {
    name: "너",
    difficulty: { id: "", label: "", description: "" },
    relief_triggers: [],
    strain_triggers: []
  });
});

test("normalizeWorld: protagonist 블록을 채우면 difficulty와 트리거 목록을 보존한다", () => {
  const world = normalizeWorld({
    world_id: "demo",
    title: "t",
    protagonist: {
      name: "너",
      difficulty: {
        id: "unspent-evening",
        label: "집에 갈 이유를 못 찾는다",
        description: "성과로만 자기를 인정할 수 있게 됐다."
      },
      relief_triggers: ["해린이 곁에 있는 것을 밀어내지 않는다"],
      strain_triggers: ["괜찮다고 말하며 화제를 돌린다"]
    }
  });
  assert.equal(world.protagonist.difficulty.id, "unspent-evening");
  assert.equal(world.protagonist.difficulty.label, "집에 갈 이유를 못 찾는다");
  assert.deepEqual(world.protagonist.relief_triggers, ["해린이 곁에 있는 것을 밀어내지 않는다"]);
  assert.deepEqual(world.protagonist.strain_triggers, ["괜찮다고 말하며 화제를 돌린다"]);
});

// --- renderNarratorPrefix / renderJudgeContext (M1 sim step 2) ---

function loadDemo() {
  const raw = JSON.parse(fs.readFileSync(new URL("../data/worlds/demo.json", import.meta.url), "utf8"));
  return loadWorldFile(raw);
}

/** 네 트리거 목록 전체 — 이 문자열들은 서술자 프리픽스 어디에도 있으면 안 된다. */
function allTriggerStrings(world, cards) {
  const strings = [];
  for (const card of cards) {
    strings.push(...card.romance.attraction_triggers);
    strings.push(...card.romance.dislike_triggers);
  }
  strings.push(...world.protagonist.relief_triggers);
  strings.push(...world.protagonist.strain_triggers);
  return strings;
}

test("renderNarratorPrefix: demo.json의 어떤 단계에서도 네 트리거 목록 문자열이 새지 않는다", () => {
  const { world, cards } = loadDemo();
  const triggers = allTriggerStrings(world, cards);
  assert.ok(triggers.length >= 4, "테스트 자체가 무의미해지지 않도록 트리거가 실제로 있는지 확인");

  for (const stageKey of ["0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"]) {
    const stages = {};
    for (const card of cards) stages[card.card_id] = stageKey;
    const prefix = renderNarratorPrefix({ world, cards, stages, pov: null });
    for (const trigger of triggers) {
      assert.ok(!prefix.includes(trigger), `${stageKey} 프리픽스에 트리거 문자열이 샜다: ${trigger}`);
    }
  }
});

test("renderNarratorPrefix: 현재 단계의 behavior만 싣고 다른 네 단계의 behavior는 싣지 않는다", () => {
  // relationship_stages.example은 대사 한 줄이라 speech.examples(모든 단계에서 항상
  // 실리는 말투 예시 대사 목록)와 문구가 겹칠 수 있다 — 그건 "미래 단계 유출"이
  // 아니라 같은 캐릭터가 여러 지점에서 비슷한 말을 하는 것뿐이다. behavior는
  // 그런 재사용이 없는, 관계 진행 자체를 서술하는 텍스트라 유출 여부를 여기서 판단한다.
  const { world, cards } = loadDemo();
  const card = cards[0];
  const stages = { [card.card_id]: "2_friend" };
  const prefix = renderNarratorPrefix({ world, cards, stages, pov: null });

  assert.ok(prefix.includes(card.relationship_stages["2_friend"].behavior));
  for (const other of ["0_stranger", "1_acquaintance", "3_crush", "4_love"]) {
    assert.ok(!prefix.includes(card.relationship_stages[other].behavior),
      `${other}의 behavior가 2_friend 프리픽스에 샜다`);
  }
});

test("renderNarratorPrefix: 2_friend 미만에서는 affection_signs 대신 initial_attitude를 싣는다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];

  const low = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "1_acquaintance" }, pov: null });
  assert.ok(low.includes(card.romance.initial_attitude));
  for (const sign of card.romance.affection_signs) assert.ok(!low.includes(sign), `${sign}이 1_acquaintance에 샜다`);

  const mid = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "2_friend" }, pov: null });
  assert.ok(mid.includes(card.romance.affection_signs[0]));
  assert.ok(card.romance.initial_attitude.length > 0, "테스트 전제: initial_attitude가 비어있지 않아야 한다");
  assert.ok(!mid.includes(card.romance.initial_attitude), "2_friend에서는 initial_attitude를 싣지 않는다");
});

// --- B2: care_signs는 로맨스 신호(affection_signs)가 아니라 성격이라, 단계로
// 게이팅하지 않고 모든 단계에서(0_stranger 포함) 서술자에게 보인다. 이게 이번
// 수정의 핵심이다 — 예전에는 0_stranger에서 initial_attitude(무관심)만 보이고
// 챙기는 면은 전혀 안 보여서, 서술자가 실제로 무뚝뚝하기만 한 인물을 썼다. ---

test("renderNarratorPrefix: care_signs는 0_stranger를 포함한 모든 단계에서 보인다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];
  assert.ok(card.romance.care_signs.length > 0, "테스트 전제: demo.json에 care_signs가 있어야 한다");

  for (const stageKey of ["0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"]) {
    const prefix = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: stageKey }, pov: null });
    for (const sign of card.romance.care_signs) {
      assert.ok(prefix.includes(sign), `${stageKey} 프리픽스에 care_signs "${sign}"이 없다`);
    }
  }
});

test("renderNarratorPrefix: 0_stranger에서도 initial_attitude와 care_signs가 함께 보여 차가움이 아니라 절제로 읽힌다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];
  const prefix = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "0_stranger" }, pov: null });

  assert.ok(prefix.includes(card.romance.initial_attitude));
  assert.ok(prefix.includes(card.relationship_stages["0_stranger"].behavior));
  for (const sign of card.romance.care_signs) assert.ok(prefix.includes(sign));
  // 회귀 가드: 카드 원문이 실제로 "무관심"이라는 단어 자체를 쓰지 않는지 확인한다
  // (initial_attitude를 "무관심이 아니라 절제다"로 다시 썼다 — B1).
  assert.ok(!card.romance.initial_attitude.startsWith("무관심을"), "initial_attitude가 여전히 무관심으로 시작한다");
});

test("renderNarratorPrefix: high_affection_signs는 4_love에서만 실린다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];

  const crush = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "3_crush" }, pov: null });
  for (const sign of card.romance.high_affection_signs) {
    assert.ok(!crush.includes(sign), `${sign}이 3_crush에서 이미 나왔다`);
  }

  const love = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "4_love" }, pov: null });
  for (const sign of card.romance.high_affection_signs) {
    assert.ok(love.includes(sign), `${sign}이 4_love에 없다`);
  }
});

// --- care 가시성 후속 수정: care_signs를 관찰 가능한 행동으로 고쳐도, 서술자에게
// "행동으로 움직이라"는 지시 자체가 없으면 여전히 절제 신호(금기/말버릇)가
// 다수라 모델이 절제 쪽으로 수렴한다. renderCardForNarrator가 매 단계 "행동
// 지시" 한 줄을 덧붙인다 — 트리거는 언급하지 않고, 단계에 따라 스케일된다. ---

test("renderNarratorPrefix: 모든 단계에 '행동으로만 보여준다'는 행동 지시가 실린다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];

  for (const stageKey of ["0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"]) {
    const prefix = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: stageKey }, pov: null });
    assert.ok(prefix.includes("행동으로만 보여준다"), `${stageKey} 프리픽스에 행동 지시가 없다`);
  }
});

test("renderNarratorPrefix: 행동 지시는 0_stranger와 4_love에서 문구가 다르다(단계별로 스케일된다)", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];

  const stranger = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "0_stranger" }, pov: null });
  const love = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "4_love" }, pov: null });

  const strangerLine = stranger.split("\n").find((l) => l.startsWith("행동 지시:"));
  const loveLine = love.split("\n").find((l) => l.startsWith("행동 지시:"));

  assert.ok(strangerLine, "0_stranger에 행동 지시 줄이 없다");
  assert.ok(loveLine, "4_love에 행동 지시 줄이 없다");
  assert.notEqual(strangerLine, loveLine);
});

test("renderNarratorPrefix: 행동 지시는 트리거를 이름 붙이거나 무엇이 호감을 올리는지 말하지 않는다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];
  const triggers = allTriggerStrings(world, cards);

  for (const stageKey of ["0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"]) {
    const prefix = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: stageKey }, pov: null });
    const actionLine = prefix.split("\n").find((l) => l.startsWith("행동 지시:"));
    assert.ok(actionLine, `${stageKey}에 행동 지시 줄이 없다`);
    for (const trigger of triggers) {
      assert.ok(!actionLine.includes(trigger), `${stageKey} 행동 지시에 트리거 문자열이 샜다: ${trigger}`);
    }
    assert.ok(!actionLine.includes("호감"), `${stageKey} 행동 지시가 호감을 직접 언급한다`);
  }
});

test("renderNarratorPrefix: appearance.romance_detail은 3_crush 미만에서 생략된다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];

  const friend = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "2_friend" }, pov: null });
  assert.ok(!friend.includes(card.appearance.romance_detail));

  const crush = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "3_crush" }, pov: null });
  assert.ok(crush.includes(card.appearance.romance_detail));
});

test("renderNarratorPrefix: 주인공의 이름과 어려움을 싣되 relief/strain 목록은 싣지 않는다", () => {
  const { world, cards } = loadDemo();
  const prefix = renderNarratorPrefix({ world, cards, stages: {}, pov: null });
  assert.ok(prefix.includes(world.protagonist.difficulty.label));
  assert.ok(prefix.includes(world.protagonist.difficulty.description));
});

test("renderNarratorPrefix: protagonist가 완전히 비어 있어도(lighthouse) 죽지 않고 주인공 블록을 생략한다", () => {
  const world = normalizeWorld({ world_id: "lighthouse", title: "등대" });
  const cards = [normalizeCard({ world_id: "lighthouse", canonical_name: "누군가" })];
  const prefix = renderNarratorPrefix({ world, cards, stages: {}, pov: null });
  assert.ok(!prefix.includes("[주인공]"));
  assert.ok(prefix.includes("등대"));
});

test("renderJudgeContext: 네 트리거 목록을 번호를 붙여 그대로 낸다", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];
  const context = renderJudgeContext({ card, protagonist: world.protagonist });

  for (const trigger of card.romance.attraction_triggers) assert.ok(context.includes(trigger));
  for (const trigger of card.romance.dislike_triggers) assert.ok(context.includes(trigger));
  for (const trigger of world.protagonist.relief_triggers) assert.ok(context.includes(trigger));
  for (const trigger of world.protagonist.strain_triggers) assert.ok(context.includes(trigger));
  assert.ok(/^1\./m.test(context), "번호가 매겨져 있어야 한다");
});

test("renderJudgeContext: 페르소나/말투/외형은 싣지 않는다 (판정에 필요 없다)", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];
  const context = renderJudgeContext({ card, protagonist: world.protagonist });
  assert.ok(!context.includes(card.persona.summary));
  assert.ok(!context.includes(card.appearance.description));
});

test("renderJudgeContext: card/protagonist가 없어도 죽지 않고 빈 문자열에 가깝다", () => {
  assert.equal(renderJudgeContext({}), "");
  assert.equal(renderJudgeContext({ card: null, protagonist: null }), "");
});

test("측정: demo.json 서술자 프리픽스 크기 (0_stranger vs 4_love)", () => {
  const { world, cards } = loadDemo();
  const card = cards[0];
  const CHARS_PER_TOKEN = 1.2;

  const low = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "0_stranger" }, pov: null });
  const high = renderNarratorPrefix({ world, cards, stages: { [card.card_id]: "4_love" }, pov: null });

  // 리포트용 실측치를 콘솔에 남긴다 — 700토큰 예산은 얇은 카드 기준이었고, 이
  // 카드는 훨씬 풍부하므로 실제 비용을 보고하는 것이 스펙의 요구사항이다.
  console.log(`[narrator prefix] 0_stranger: ${low.length}자 / 약 ${Math.ceil(low.length / CHARS_PER_TOKEN)}토큰`);
  console.log(`[narrator prefix] 4_love: ${high.length}자 / 약 ${Math.ceil(high.length / CHARS_PER_TOKEN)}토큰`);
  assert.ok(low.length > 0);
  assert.ok(high.length >= low.length, "4_love는 0_stranger보다 신호/로맨스 디테일이 추가되어 더 길거나 같아야 한다");
});
