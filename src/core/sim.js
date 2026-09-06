/**
 * 상태 모델 — 호감(affection)과 회복(recovery), 두 축.
 *
 * | 축 | 주체 | 무엇이 움직이나 |
 * | --- | --- | --- |
 * | affection | 히로인 | 플레이어가 하는 행동 |
 * | recovery  | 플레이어 | 히로인이 하는 행동 + 플레이어가 그것을 받아들이는지 |
 *
 * 히로인은 조언이나 진단으로 낫게 하는 사람이 아니라, 곁에 남아 있는 것으로 낫게
 * 하는 사람이다. 호감은 수단이고 회복은 목적이다. 이 모듈의 설계 전체는 한 문장으로
 * 요약된다: 어떤 행동은 호감을 올리면서 동시에 회복을 내린다. 기대는 것과 나아지는
 * 것은 다른 일이고, 규칙이 그걸 구분해야 한다.
 *
 * 그래서 두 축을 하나로 합치지 않는다. 합치면 "의존" 결말 — 호감은 높은데 회복은
 * 낮은, 경고로 읽혀야 할 결말 — 이 존재할 수 없게 된다. 네 결말의 표:
 *
 *              | 호감 높음         | 호감 낮음
 *   회복 높음  | 함께 선다         | 혼자 설 수 있게 됐다 (나쁜 결말 아님)
 *   회복 낮음  | 의존 (경고 결말)  | 그대로 겨울
 *
 * 이 모듈은 숫자만 다룬다. 프롬프트도, HTTP도, 모델도 모른다. 판정(어떤 트리거가
 * 맞았는지)은 호출부(향후 turn.js)가 만들어 넘기고, 여기서는 그 이름들을 델타로
 * 바꾸고 클램프할 뿐이다.
 */

/** 호감 → 관계 단계. 카드의 relationship_stages 키와 그대로 대응한다. */
export const STAGE_THRESHOLDS = [
  { stage: "0_stranger", min: 0, max: 19 },
  { stage: "1_acquaintance", min: 20, max: 39 },
  { stage: "2_friend", min: 40, max: 59 },
  { stage: "3_crush", min: 60, max: 79 },
  { stage: "4_love", min: 80, max: 100 }
];

/**
 * 트리거 한 건이 맞았을 때 축이 움직이는 양. 매직 넘버로 여기저기 흩어두지 않고
 * 이름을 붙여 한곳에 둔다 — 밸런스를 바꿀 때 여기만 보면 된다.
 *
 * attraction/dislike는 affection을, relief/strain은 recovery를 움직인다. 넷 다
 * 크기를 8로 맞춘 것은 "한두 번의 행동으로 단계가 바로 안 바뀌되(단계 폭이
 * 20이므로 8 두세 번이 한 단계), 열 번 넘게 반복해야 겨우 움직이는 것도 아니게"
 * 하기 위한 절충이다. dislike를 attraction보다 살짝 크게(-10) 잡은 것은, 실망은
 * 쌓기보다 무너뜨리기가 쉬워야 서사적으로 설득력이 있기 때문이다.
 */
export const AFFECTION_DELTA = {
  ATTRACTION: 8,
  DISLIKE: -10
};

export const RECOVERY_DELTA = {
  RELIEF: 8,
  STRAIN: -10
};

/** 값을 [0, 100] 안으로 접는다. */
function clamp(n) {
  return Math.max(0, Math.min(100, n));
}

export function stageFor(affection) {
  const a = clamp(Number.isFinite(affection) ? affection : 0);
  const found = STAGE_THRESHOLDS.find((s) => a >= s.min && a <= s.max);
  return found ? found.stage : STAGE_THRESHOLDS[0].stage;
}

/**
 * 단계 → 한국어 문구. 서술자 프롬프트의 [현재 상태] 블록은 "호감도 48/100" 같은
 * 숫자를 절대 보여주지 않는다 — 숫자를 본 모델은 숫자를 향해 글을 쓴다. 그래서
 * memory.js는 숫자 대신 이 문구를 싣는다. 이 모듈이 단계 경계를 소유하므로 문구도
 * 여기서 관리한다.
 */
const STAGE_LABELS = {
  "0_stranger": "낯선 사이",
  "1_acquaintance": "아는 사이",
  "2_friend": "친구",
  "3_crush": "설렘",
  "4_love": "사랑"
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || STAGE_LABELS["0_stranger"];
}

/** recovery 값 구간 → 서술어. stageLabel과 같은 이유로 숫자 대신 문구를 싣는다. */
const RECOVERY_BANDS = [
  { max: 19, label: "전혀 나아지지 않았다" },
  { max: 39, label: "조금씩 나아지고 있다" },
  { max: 59, label: "조금 나아졌다" },
  { max: 79, label: "많이 나아졌다" },
  { max: 100, label: "스스로 설 수 있게 됐다" }
];

export function recoveryLabel(recovery) {
  const r = clamp(Number.isFinite(recovery) ? recovery : 0);
  const found = RECOVERY_BANDS.find((band) => r <= band.max);
  return found ? found.label : RECOVERY_BANDS[RECOVERY_BANDS.length - 1].label;
}

/**
 * 이름 목록(카드가 authored한 트리거 이름들) 중에서 candidates에 실제로 있는
 * 이름만 남긴다. 판정기가 카드에 없는 이름을 지어내도, 목록에 없으면(=카드가
 * 그런 트리거를 authored하지 않았으면) 조용히 무시한다. 초이스 파서가 모르는
 * 선택지 텍스트를 무시하는 것과 같은 관용이다.
 */
function matchNames(names, candidates) {
  if (!Array.isArray(names) || !Array.isArray(candidates)) return [];
  const known = new Set(candidates);
  return [...new Set(names)].filter((n) => typeof n === "string" && known.has(n));
}

/**
 * 카드 목록으로부터 초기 시뮬레이션 상태를 만든다. cards는 정규화된
 * CharacterCard 배열(card.js의 normalizeCard 결과)을 기대한다. protagonist는
 * 지금 당장은 상태에 숫자를 보태지 않지만(회복은 캐릭터에 종속되지 않는 전역
 * 축이라 world.protagonist 자체에서 가져올 게 없다), 서명에 받아 두어 호출부가
 * world 전체를 그대로 넘길 수 있게 한다.
 */
export function createSimState({ cards = [], protagonist = null } = {}) {
  const characters = {};
  for (const card of cards) {
    if (!card || !card.card_id) continue;
    characters[card.card_id] = { affection: 0, stage: stageFor(0) };
  }
  return {
    characters,
    recovery: 0,
    fired_hooks: []
  };
}

/**
 * 판정 결과 하나를 상태에 적용해 새 상태를 반환한다(불변 — appendTurn과 같은
 * 스타일. 인자로 받은 state를 고치지 않고 항상 새 객체를 만들어 돌려준다).
 *
 * judgment의 attraction/dislike/relief/strain은 트리거 "이름" 목록이며, 원시
 * 숫자를 절대 받지 않는다 — 숫자(델타)는 오직 이 모듈만 안다. card와
 * protagonist는 이름을 검증할 authored 목록의 출처다: card는 normalizeCard
 * 결과(romance.attraction_triggers / dislike_triggers를 본다), protagonist는
 * world.protagonist(relief_triggers / strain_triggers를 본다). 상태 자체에는
 * authored 목록을 담지 않는다 — createSimState의 반환 모양을
 * { characters, recovery, fired_hooks }로 고정해 두기 위해서다.
 *
 * 트리거 이름이 attraction과 strain 양쪽에 다 있는 경우(예: "판단을 대신
 * 내려달라고 한다") 같은 이름을 호출부가 attraction 목록과 strain 목록에
 * 둘 다 넣어 넘기면 그대로 양쪽이 함께 반영된다 — 특별 취급 코드가 필요
 * 없다. 그것이 이 시뮬레이션의 핵심 설계다: 기대는 행동이 호감을 올리면서
 * 회복은 내릴 수 있다.
 *
 * 반환값은 새 상태이되, 그 위에 last_change를 얹어 "무엇이 왜 움직였는지"를
 * 함께 실어 보낸다. 이유 없이 움직이는 게이지는 버그와 구별할 수 없다.
 */
export function applyJudgment(
  state,
  { card_id, attraction = [], dislike = [], relief = [], strain = [], card = null, protagonist = null } = {}
) {
  const prev = state || createSimState({});
  const prevCharacters = prev.characters || {};
  const prevEntry = prevCharacters[card_id] || { affection: 0, stage: stageFor(0) };

  const romance = card && card.romance ? card.romance : {};
  const matchedAttraction = matchNames(attraction, romance.attraction_triggers);
  const matchedDislike = matchNames(dislike, romance.dislike_triggers);

  const p = protagonist || {};
  const matchedRelief = matchNames(relief, p.relief_triggers);
  const matchedStrain = matchNames(strain, p.strain_triggers);

  const affectionDelta =
    matchedAttraction.length * AFFECTION_DELTA.ATTRACTION +
    matchedDislike.length * AFFECTION_DELTA.DISLIKE;
  const recoveryDelta =
    matchedRelief.length * RECOVERY_DELTA.RELIEF +
    matchedStrain.length * RECOVERY_DELTA.STRAIN;

  const nextAffection = clamp(prevEntry.affection + affectionDelta);
  const nextRecovery = clamp((prev.recovery || 0) + recoveryDelta);
  const prevStage = prevEntry.stage || stageFor(prevEntry.affection);
  const nextStage = stageFor(nextAffection);

  const nextCharacters = {
    ...prevCharacters,
    [card_id]: { affection: nextAffection, stage: nextStage }
  };

  return {
    characters: nextCharacters,
    recovery: nextRecovery,
    fired_hooks: prev.fired_hooks || [],
    last_change: {
      card_id,
      matched: {
        attraction: matchedAttraction,
        dislike: matchedDislike,
        relief: matchedRelief,
        strain: matchedStrain
      },
      affection_delta: affectionDelta,
      recovery_delta: recoveryDelta,
      affection: { before: prevEntry.affection, after: nextAffection },
      recovery: { before: prev.recovery || 0, after: nextRecovery },
      stage_changed: prevStage !== nextStage,
      stage: { before: prevStage, after: nextStage }
    }
  };
}

/** 결말 판정의 기준선. 명시하지 않으면 이 값을 쓴다(각 축 절반인 50). */
export const DEFAULT_ENDING_TARGET = 50;

/**
 * 호감·회복 두 축의 최종값으로 네 결말 중 하나를 고른다. affectionTarget과
 * recoveryTarget은 "높다"의 기준선이며, 지정하지 않으면 50이다. card_id를
 * 넘기면 그 인물의 호감을, 생략하면 상태에 등록된 캐릭터 중 최댓값을 쓴다
 * (엔딩은 결국 특정 히로인과의 관계로 갈리므로 호출부가 card_id를 넘기는 것을
 * 기본으로 삼되, 캐릭터가 하나뿐인 세계관에서는 생략해도 동작하게 한다).
 */
export function endingFor(
  state,
  { card_id = null, affectionTarget = DEFAULT_ENDING_TARGET, recoveryTarget = DEFAULT_ENDING_TARGET } = {}
) {
  const s = state || createSimState({});
  const characters = s.characters || {};
  let affection = 0;
  if (card_id && characters[card_id]) {
    affection = characters[card_id].affection;
  } else {
    const values = Object.values(characters).map((c) => c.affection);
    affection = values.length ? Math.max(...values) : 0;
  }
  const recovery = s.recovery || 0;

  const highAffection = affection >= affectionTarget;
  const highRecovery = recovery >= recoveryTarget;

  let ending;
  if (highAffection && highRecovery) ending = "together";
  else if (!highAffection && highRecovery) ending = "standing_alone";
  else if (highAffection && !highRecovery) ending = "dependence";
  else ending = "winter";

  const reasonByEnding = {
    together: "호감과 회복이 함께 높다 — 기대지 않고도 곁에 있다.",
    standing_alone: "회복은 높지만 호감은 낮다 — 그녀 없이도 혼자 설 수 있게 됐다. 나쁜 결말이 아니다.",
    dependence: "호감은 높지만 회복은 낮다 — 그녀에게 기댄 만큼 스스로는 나아지지 못했다. 경고 결말.",
    winter: "호감도 회복도 낮다 — 아무것도 바뀌지 않은 채 겨울이 그대로 지나간다."
  };

  return {
    ending,
    reason: reasonByEnding[ending],
    affection,
    recovery,
    affectionTarget,
    recoveryTarget
  };
}
