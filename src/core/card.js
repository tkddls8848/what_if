/**
 * 캐릭터 카드와 세계관 — 시스템 프롬프트의 고정 앞부분.
 *
 * 카드는 매 턴 프롬프트의 맨 앞에 그대로 들어간다. 그래서 형식이 곧 비용이고,
 * 빈 필드의 제목만 남기지 않는다(약 700토큰 예산, 스펙 5절).
 *
 * 여기서는 문장을 생성하지 않는다. 카드에 든 것을 늘어놓기만 한다. 카드를 채우는 것은
 * M2의 컴파일러와 사람의 검수이고, 이 모듈은 그 결과를 읽기만 한다.
 */

export const CARD_STATUS = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  EDITED: "edited",
  REJECTED: "rejected",
  MANUAL: "manual"
};

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter(Boolean);
}

/**
 * 결정적 id. 모듈 카운터를 쓰면 같은 카드를 다시 정규화할 때마다 정체성이 바뀌고,
 * 서버가 요청마다 세계관 파일을 다시 읽으므로 그 흔들림이 그대로 화면에 나온다.
 */
function slugId(worldId, name) {
  const base = `${worldId}:${name}`
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^0-9a-z가-힣:_-]/g, "");
  return base === ":" ? "card" : base;
}

/**
 * 주인공(플레이어) 블록. 없으면 전부 빈 값 — lighthouse.json처럼 아직
 * protagonist를 쓰지 않는 세계관도 그대로 로드되어야 한다.
 *
 * difficulty는 "무엇이 힘든가"를 이름 붙인 것이고, relief/strain_triggers는
 * sim.js가 recovery 축을 움직일 때 참조할 이름표다. 여기서는 목록을 보존만
 * 하고 숫자로 바꾸지 않는다 — 그건 sim.js의 일이다.
 */
function normalizeProtagonist(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const difficulty = p.difficulty && typeof p.difficulty === "object" ? p.difficulty : {};
  return {
    name: str(p.name) || "너",
    difficulty: {
      id: str(difficulty.id),
      label: str(difficulty.label),
      description: str(difficulty.description)
    },
    relief_triggers: list(p.relief_triggers),
    strain_triggers: list(p.strain_triggers)
  };
}

/**
 * `world.stage` — 이 세계관에서 **그릴 수 있는 배경의 닫힌 집합**.
 *
 * 이름이 카드의 `relationship_stages`와 겹쳐 보이지만 아무 관계가 없다. 저쪽은
 * 관계 단계(0_stranger…4_love)이고, 이쪽은 연극의 무대(stage) — 장소·시간대·날씨의
 * 정의역이다.
 *
 * 왜 닫힌 집합인가: 배경 이미지의 캐시 키가 매 턴 생성되는 자유 문자열이면
 * "교실"과 "3학년 2반 교실"이 다른 그림이 된다(src/server/scene.js 머리주석의
 * "같은 그림이 비슷한 그림보다 강한 일관성을 준다"가 구조적으로 깨지는 자리).
 * 미술감독(src/server/director.js)이 이 목록 **안에서만** 고르게 하면 그 사고가
 * 일어날 수 없다.
 *
 * `visual`은 **사람이 미리 쓰는 영어 문장**이다. 생성물이 아니라 저작물이므로
 * 고치면 계속 반영되고, 한글이 섞일 일이 없다(resolveScene의 한글 게이트는
 * 그래도 불변식 방어로 남는다). world.visual_style과 같은 이유로 영어다 —
 * 이미지 모델이 영어 캡션으로 학습되어 있다.
 *
 * id가 없는 장소 항목은 버린다 — id가 캐시 키의 재료이자 Choice의 선택지 키라
 * 없으면 아무 일도 할 수 없다.
 */
function normalizeStageSet(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const locations = (Array.isArray(s.locations) ? s.locations : [])
    .map((item) => {
      const loc = item && typeof item === "object" ? item : {};
      return { id: str(loc.id), ko: str(loc.ko), visual: str(loc.visual) };
    })
    .filter((loc) => loc.id);
  return { locations, times: list(s.times), weathers: list(s.weathers) };
}

export function normalizeWorld(raw = {}) {
  return {
    world_id: str(raw.world_id) || "world",
    title: str(raw.title),
    source_type: str(raw.source_type),
    source_url: str(raw.source_url),
    setting: str(raw.setting),
    tone: str(raw.tone),
    // visual_style: 배경 이미지 생성용 아트 디렉션(화풍·팔레트·톤). **영어로 쓴다** —
    // 다른 모든 필드는 한국어인데 이 필드만 영어인 게 실수가 아니다. 배경 이미지
    // 모델(flux-1-schnell)은 영어 캡션으로 학습되어 있어 한국어를 노이즈로 취급한다
    // (src/server/scene.js의 buildPrompt가 이 필드와 scene.visual만 프롬프트 재료로
    // 쓴다 — world.setting/tone은 쓰지 않는다). "고쳐서" 한국어로 되돌리지 말 것.
    visual_style: str(raw.visual_style),
    // 오프닝은 저자가 쓴 세계관 소유물이다. 세션에도 opening 필드가 있지만 그건 이
    // 값을 "시드로 받아 저장"할 뿐이다 — 세계관 파일이 원본이다.
    opening: str(raw.opening),
    rules: list(raw.rules),
    forbidden: list(raw.forbidden),
    // 배경의 닫힌 집합(normalizeStageSet 참고). 없으면 빈 집합이고, 그 세계관은
    // 배경 그림을 못 그린다 — director.js가 INVALID_ARGUMENT로 그 사실을 드러낸다.
    stage: normalizeStageSet(raw.stage),
    // created_at은 여기서 생성하지 않는다. loadWorldFile은 요청마다 파일을 다시 읽고
    // normalizeWorld를 거치는데, 여기서 new Date()를 부르면 저장된 세계관 파일에 이미
    // 있는 값도 매번 지금 시각으로 덮어써 정규화가 멱등하지 않게 된다.
    created_at: str(raw.created_at),
    protagonist: normalizeProtagonist(raw.protagonist)
  };
}

/**
 * appearance는 두 모양을 다 받는다: 기존 세계관들은 맨 문자열이고, 새로 쓰는
 * 카드는 { description, impression, romance_detail } 객체다. 여기서 문자열을
 * 객체 형태로 승격해 이후 코드(렌더링, 미래의 UI)가 한 모양만 알면 되게 한다.
 * 문자열로 들어온 값은 고스란히 description으로 옮겨 내용 손실이 없다.
 */
function normalizeAppearance(raw) {
  if (typeof raw === "string") {
    return { description: str(raw), impression: "", romance_detail: "" };
  }
  const a = raw && typeof raw === "object" ? raw : {};
  return {
    description: str(a.description),
    impression: str(a.impression),
    romance_detail: str(a.romance_detail)
  };
}

const STAGE_KEYS = ["0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"];

/** 한 단계의 { behavior, example }. 둘 다 없어도 키 자체는 항상 다섯 개 다 만든다. */
function normalizeStage(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return { behavior: str(s.behavior), example: str(s.example) };
}

function normalizeRelationshipStages(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of STAGE_KEYS) out[key] = normalizeStage(src[key]);
  return out;
}

function normalizeScenarioHooks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((h) => ({ event: str(h && h.event), description: str(h && h.description) }))
    .filter((h) => h.event || h.description);
}

export function normalizeCard(raw = {}) {
  const persona = raw.persona || {};
  const speech = raw.speech || {};
  const romance = raw.romance || {};
  const worldId = str(raw.world_id) || "world";
  const name = str(raw.canonical_name);
  return {
    card_id: str(raw.card_id) || slugId(worldId, name),
    world_id: worldId,
    canonical_name: name,
    aliases: list(raw.aliases),
    role: str(raw.role),
    archetype: list(raw.archetype),
    persona: {
      summary: str(persona.summary),
      traits: list(persona.traits),
      values: list(persona.values),
      taboos: list(persona.taboos),
      weaknesses: list(persona.weaknesses)
    },
    romance: {
      romance_style: str(romance.romance_style),
      initial_attitude: str(romance.initial_attitude),
      jealousy_style: str(romance.jealousy_style),
      confession_style: str(romance.confession_style),
      dating_style: str(romance.dating_style),
      attraction_triggers: list(romance.attraction_triggers),
      dislike_triggers: list(romance.dislike_triggers),
      // care_signs: 이 인물이 "돌보기로 정한 사람"에게 말없이 하는 행동들 — 무엇이
      // 호감을 올리는가(attraction_triggers)가 아니라 그 애가 어떻게 행동하는가다.
      // affection_signs와도 다르다: affection_signs는 로맨틱 신호라 2_friend
      // 이상에서만 서술자에게 보이지만(card.js의 renderCardForNarrator), care_signs는
      // 로맨스가 아니라 성격이라 모든 단계에서 항상 보인다(renderNarratorPrefix
      // 참고, B2). 트리거 넷(attraction/dislike/relief/strain)과 달리 서술자에게
      // 숨기지 않는다 — "무엇이 점수를 올리는가"가 아니라 "이 사람은 어떻게
      // 행동하는 사람인가"이기 때문이다.
      care_signs: list(romance.care_signs),
      affection_signs: list(romance.affection_signs),
      high_affection_signs: list(romance.high_affection_signs)
    },
    relationship_stages: normalizeRelationshipStages(raw.relationship_stages),
    speech: {
      first_person: str(speech.first_person),
      endings: list(speech.endings),
      address_rules: list(speech.address_rules),
      examples: list(speech.examples),
      tone: str(speech.tone),
      speech_habits: list(speech.speech_habits)
    },
    appearance: normalizeAppearance(raw.appearance),
    scenario_hooks: normalizeScenarioHooks(raw.scenario_hooks),
    relationships: Array.isArray(raw.relationships) ? raw.relationships : [],
    knowledge_as_of: str(raw.knowledge_as_of),
    source: raw.source && typeof raw.source === "object" ? raw.source : { type: "manual" },
    status: str(raw.status) || CARD_STATUS.SUGGESTED
  };
}

export function loadWorldFile(raw = {}) {
  const world = normalizeWorld(raw.world);
  // 파일의 세계관 id가 카드 항목의 stray world_id를 덮는다.
  const cards = (Array.isArray(raw.cards) ? raw.cards : [])
    .map((card) => normalizeCard({ ...card, world_id: world.world_id }));
  return { world, cards };
}

/** 값이 있을 때만 "제목: 내용" 한 줄을 만든다. 빈 제목은 토큰 낭비다. */
function line(label, value) {
  const text = Array.isArray(value) ? value.join(", ") : str(value);
  return text ? `${label}: ${text}\n` : "";
}

function bullets(label, items) {
  if (!items.length) return "";
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

/**
 * 하위 호환 얇은 래퍼. 실제 프롬프트 조립(core/memory.js)은 이제
 * renderNarratorPrefix를 직접 부른다 — 이 함수는 tests/card.test.mjs가 여전히
 * 직접 호출하는 공개 API로 남겨 둔다(죽은 export가 아니라, 카드를 하나의
 * 고정 대역(0_stranger)으로만 보고 싶을 때 쓰는 얇은 진입점).
 */
export function renderPrefix({ world, cards = [], pov = null } = {}) {
  const stages = {};
  for (const card of cards) stages[card.card_id] = "0_stranger";
  return renderNarratorPrefix({ world, cards, stages, pov });
}

const STAGE_ORDER = ["0_stranger", "1_acquaintance", "2_friend", "3_crush", "4_love"];

/**
 * B2 후속 수정: care_signs를 관찰 가능한 행동으로 고쳐도, 서술자에게 "매 장면
 * 행동으로 움직이라"는 지시 자체가 없으면 모델은 여전히 절제 신호 쪽으로
 * 수렴한다(카드에 남은 금기/말버릇이 여전히 여러 개이므로). 이 함수가 그 누락된
 * 지렛대다 — 인물이 이 장면에서 최소 한 번은 작고 구체적인 행동으로 움직이게
 * 지시한다.
 *
 * 트리거(무엇이 호감을 올리는가)는 절대 언급하지 않는다 — "이렇게 하면 호감이
 * 오른다"가 아니라 "이 인물은 이렇게 행동하는 사람이다"만 말한다. 그 구분이
 * renderJudgeContext와 이 함수를 분리해 둔 이유와 같다(파일 상단 주석 참고).
 *
 * 단계로 스케일한다: 0_stranger에서는 낯선 사람에게도 할 법한 실용적 손짓이면
 * 충분하고, 4_love로 갈수록 이 상대만을 향한 것임이 분명해진다. 그래야 다섯
 * 단계가 실제로 다른 것을 의미한다(스펙의 진행 설계).
 */
function renderCareActionInstruction(stage) {
  const stageKey = STAGE_ORDER.includes(stage) ? stage : STAGE_ORDER[0];
  const byStage = {
    "0_stranger":
      "낯선 사람에게라도 흔히 할 법한, 대단할 것 없는 실용적인 손짓이면 충분하다(예: 떨어뜨린 물건을 대신 주워 놓는다, 지나가며 문을 잡아 준다).",
    "1_acquaintance":
      "같은 반 정도의 거리에서 자연스러운 실용적인 손짓이면 된다(예: 자리를 슬쩍 옆으로 내준다, 필요한 걸 말없이 건넨다).",
    "2_friend":
      "이제는 상대를 특정해서 하는 행동이어야 한다(예: 상대 몫까지 챙겨 온다, 상대 옆자리를 비워 둔다).",
    "3_crush":
      "이제는 이 상대를 향한 것임이 분명한, 개인적인 손짓이어야 한다(예: 자기 것을 양보한다, 평소라면 안 할 만큼 오래 곁에 머문다).",
    "4_love":
      "망설임 없이, 이 상대만을 위한 것임이 분명한 개인적인 손짓이어야 한다(예: 평소라면 지키던 선을 스스로 허문다, 자기 자리를 상대 곁으로 완전히 옮긴다)."
  };
  return (
    `이 장면에서 ${byStage[stageKey]} ` +
    "설명하지 말고 행동으로만 보여준다. 대사나 속마음 서술이 아니라 몸짓·자리·사물로 나타난다."
  );
}

/**
 * 한 인물을 서술자 시점으로 렌더링한다. **여기서 절대 건드리면 안 되는 것**:
 * card.romance.attraction_triggers, card.romance.dislike_triggers. 판정 기준을
 * 서술자가 보면, 장면을 "실제로 일어난 것"이 아니라 "점수를 노린 것"으로 쓰게
 * 된다(판정이 별도 호출로 분리된 이유, judge.js 참고).
 *
 * care_signs는 그 넷과 다르다 — "무엇이 점수를 올리는가"가 아니라 "이 인물이
 * 어떻게 행동하는가"이므로 숨길 이유가 없고, 오히려 숨기면 안 된다(B2). 모든
 * 단계에서 싣는다.
 *
 * 관계 단계는 현재 stage 하나만 보여준다(다섯 단계 전부가 아니라) — 미래의
 * behavior/example을 보면 모델이 그걸 미리 앞당겨 연기하려 든다.
 */
function renderCardForNarrator(card, stage) {
  const name = card.aliases.length
    ? `${card.canonical_name} (${card.aliases.join(", ")})`
    : card.canonical_name;
  let out = `\n[등장인물] ${name}\n`;
  out += line("역할", card.role);
  out += line("정체성", card.archetype);
  out += line("요약", card.persona.summary);
  out += line("성격", card.persona.traits);
  out += line("가치관", card.persona.values);
  out += line("금기", card.persona.taboos);
  out += line("약점", card.persona.weaknesses);

  const speech = [];
  if (card.speech.first_person) speech.push(`1인칭 "${card.speech.first_person}"`);
  if (card.speech.endings.length) speech.push(`어미 ${card.speech.endings.join(", ")}`);
  if (card.speech.tone) speech.push(card.speech.tone);
  out += line("말투", speech);
  out += line("호칭", card.speech.address_rules);
  out += line("말버릇", card.speech.speech_habits);
  out += bullets("예시 대사", card.speech.examples);

  out += line("외형", card.appearance.description);
  out += line("인상", card.appearance.impression);

  // 현재 단계만. 다른 네 단계는 절대 싣지 않는다 — 미래를 미리 알면 서술이 그걸
  // 향해 앞당겨진다.
  const stageKey = STAGE_ORDER.includes(stage) ? stage : STAGE_ORDER[0];
  const stageInfo = (card.relationship_stages && card.relationship_stages[stageKey]) || { behavior: "", example: "" };
  out += line("관계 행동", stageInfo.behavior);
  out += line("행동 예시", stageInfo.example);

  const romance = card.romance || {};

  // care_signs는 모든 단계에서 싣는다(B2) — affection_signs/initial_attitude와
  // 달리 단계로 게이팅하지 않는다. 로맨스가 무르익었는가와 무관하게 "이 인물이
  // 어떻게 챙기는 사람인가"는 처음부터 참이어야, 0_stranger의 narrator가 실제로
  // 그렇게 쓸 수 있다 — 예전에는 initial_attitude만 받고 이 정보가 아예 없어서
  // 서술자가 무뚝뚝함만 알고 챙기는 면은 몰랐다(플레이어 리포트의 원인).
  out += bullets("챙기는 방식", romance.care_signs);
  out += line("행동 지시", renderCareActionInstruction(stageKey));

  const idx = STAGE_ORDER.indexOf(stageKey);
  if (idx >= STAGE_ORDER.indexOf("2_friend")) {
    // 현재 대역의 신호만. affection_signs/high_affection_signs는 "무엇이 호감을
    // 올리는가"가 아니라 "호감이 오르면 어떻게 티가 나는가"이므로 트리거가 아니다.
    out += bullets("호감 신호", romance.affection_signs);
    if (stageKey === "4_love") out += bullets("깊은 호감 신호", romance.high_affection_signs);
  } else {
    out += line("초기 태도", romance.initial_attitude);
  }

  if (idx >= STAGE_ORDER.indexOf("3_crush")) {
    out += line("로맨스 디테일", card.appearance.romance_detail);
  }

  return out;
}

/**
 * 서술자(스트리밍 narration 호출)에게 줄 프리픽스. `stages`는
 * `{ [card_id]: "2_friend" }` 모양이며, 카드마다 지금 어느 관계 단계인지를 준다
 * (없으면 0_stranger로 본다).
 *
 * **여기서 절대 내보내지 않는 것**: attraction_triggers, dislike_triggers,
 * protagonist의 relief_triggers/strain_triggers. 이 넷은 judge.js가 부르는
 * renderJudgeContext에서만 나간다 — 채점 기준을 서술자가 알면 판정이 "실제로
 * 쓴 장면"이 아니라 "점수를 노린 장면"에 대한 것이 되기 때문이다(구현자가 자기
 * 코드를 직접 리뷰하지 않는 것과 같은 이유).
 */
export function renderNarratorPrefix({ world, cards = [], stages = {}, pov = null } = {}) {
  const w = normalizeWorld(world);
  let out = `[세계관] ${w.title}\n`;
  out += line("배경", w.setting);
  out += line("분위기", w.tone);
  out += bullets("규칙", w.rules);
  out += bullets("금지", w.forbidden);

  // 주인공: 이름과 "무엇이 힘든가"만. relief/strain_triggers는 절대 여기 오지 않는다.
  const p = w.protagonist;
  if (p && (p.difficulty.label || p.difficulty.description)) {
    out += `\n[주인공] ${p.name || "너"}\n`;
    out += line("어려움", p.difficulty.label);
    out += line("사연", p.difficulty.description);
  }

  for (const card of cards) {
    out += renderCardForNarrator(card, stages[card.card_id]);
  }

  const povCard = pov ? cards.find((card) => card.card_id === pov) : null;
  out += povCard
    ? `\n[시점] 시점 인물은 ${povCard.canonical_name}이다. 이 인물이 보고 들은 것만 서술한다.\n`
    : "\n[시점] 3인칭으로 서술한다. 독자는 '너'로 부른다.\n";
  return out;
}

/**
 * 판정자(로컬 Ollama, 구조화 출력)에게 줄 컨텍스트. 서술자 프리픽스와 정반대다 —
 * 여기서는 오직 네 트리거 목록만 나간다. 다른 페르소나/말투/외형 정보는 판정에
 * 필요 없고, 실어봐야 판정자가 그걸로 서사를 지어낼 여지만 준다.
 *
 * 이름은 모델이 정확히 그대로 답해야 하므로 번호를 붙여 나열한다 — "1. 문구"
 * 형태가 "정확한 이름을 골라라"는 지시와 잘 맞는다.
 */
export function renderJudgeContext({ card, protagonist } = {}) {
  const romance = (card && card.romance) || {};
  const p = protagonist || {};

  function numbered(label, items) {
    if (!items || !items.length) return "";
    const body = items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    return `[${label}]\n${body}\n\n`;
  }

  let out = "";
  out += numbered("호감 상승 트리거", romance.attraction_triggers);
  out += numbered("호감 하락 트리거", romance.dislike_triggers);
  out += numbered("회복 상승 트리거", p.relief_triggers);
  out += numbered("회복 하락 트리거", p.strain_triggers);
  return out.trim();
}
