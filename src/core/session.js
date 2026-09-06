/**
 * 세션과 턴.
 *
 * 시간 좌표는 `turn_index`(1부터인 정수)다. 기존 저장소가 segment index를 쓰던 자리를
 * 그대로 물려받는다(스펙 6-2절) — 구간 비교가 가능해야 `asOf()`를 재사용할 수 있다.
 *
 * 갱신은 불변이다. 브라우저 상태와 서버 응답이 같은 객체를 공유하면 스트리밍 중간에
 * 부분 갱신된 세션이 보이게 된다.
 *
 * `events[]`와 `state_changes[]`는 M1에서 늘 비어 있다. M3의 추출 채널이 채운다.
 * 지금 자리를 비워 두는 이유는, 나중에 Turn 모양이 바뀌면 저장된 세션이 전부 깨지기 때문이다.
 */

import { createSimState, stageFor } from "./sim.js";

export const DEFAULT_RECENT_TURNS = 3;
export const DEFAULT_MAX_TOKENS = 700;

/**
 * max_tokens와 recent_turns는 취향이 아니라 미터기 API의 비용 레버다. 출력은 턴당
 * 비용의 대략 절반이고(스펙 3-3절 199.74 Neurons 중 출력 몫이 큰 비중), 최근 턴은
 * 매 턴 다시 실리는 입력의 대략 절반을 차지한다 — 둘 다 상한이 없으면 브라우저가
 * `max_tokens: 500000`이나 `recent_turns: 9999`를 보내는 것만으로 하루 무료 할당을
 * 몇 턴 만에 써버린다. normalizeSession과 createSession 양쪽에서 이 상한을 강제한다.
 */
export const MAX_RECENT_TURNS = 12;
export const MAX_MAX_TOKENS = 2000;

/**
 * id는 호출 이력에 기대지 않는다. 모듈 카운터는 프로세스가 재시작하면 0부터 다시 세고,
 * 세션은 브라우저에 저장되므로 그때 이미 저장된 id와 충돌한다.
 */
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** positive()에 상한을 더한다. 브라우저가 보낸 값이 크면 잘라내지, 기본값으로 되돌리지 않는다. */
function clampPositive(value, fallback, max) {
  return Math.min(positive(value, fallback), max);
}

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
}

/**
 * current_scene의 모양을 맞춘다. 브라우저가 보낸 세션은 신뢰하지 않는다 — 모양이
 * 아니거나(문자열, 배열, null 등) 아예 없으면 null로 되돌린다. null은 오류가
 * 아니라 "아직 장면이 정해지지 않았다"는 유효한 상태다(memory.js의 상태 블록이
 * 바로 이 신호로 첫 장면 여부를 판단한다).
 */
function normalizeCurrentScene(raw) {
  if (!raw || typeof raw !== "object") return null;
  return { place: str(raw.place), time: str(raw.time), weather: str(raw.weather) };
}

/**
 * 세션의 sim 블록을 만든다. 브라우저가 보낸 세션은 신뢰하지 않는다 —
 * affection/recovery는 [0,100]으로 접고, stage는 저장된 문자열을 믿지 않고
 * affection에서 다시 계산하며(사용자가 "4_love"라고 우겨도 소용없다), card_ids에
 * 없는 카드 id는 버리고 있어야 할 카드는 기본값(0, 0_stranger)으로 채운다.
 * `rawSim`이 없거나(새 세션, 옛 세션) 모양이 이상해도 죽지 않는다.
 */
function normalizeSim(rawSim, cardIds) {
  const ids = list(cardIds);
  const base = createSimState({ cards: ids.map((id) => ({ card_id: id })) });
  const src = rawSim && typeof rawSim === "object" ? rawSim : {};
  const srcCharacters = src.characters && typeof src.characters === "object" ? src.characters : {};

  const characters = {};
  for (const id of ids) {
    const entry = srcCharacters[id];
    const affection = entry ? clampNumber(entry.affection, base.characters[id].affection) : base.characters[id].affection;
    characters[id] = { affection, stage: stageFor(affection) };
  }

  return {
    characters,
    recovery: clampNumber(src.recovery, base.recovery),
    fired_hooks: Array.isArray(src.fired_hooks) ? src.fired_hooks.filter((h) => typeof h === "string") : base.fired_hooks
  };
}

export function makeTurn({
  index,
  session_id = "",
  user_input = "",
  narration = "",
  choices = [],
  usage = null,
  model = ""
} = {}) {
  return {
    turn_id: newId("turn"),
    session_id: str(session_id),
    index: positive(index, 1),
    user_input: str(user_input),
    narration: str(narration),
    choices: list(choices).map(str).filter(Boolean),
    events: [],
    state_changes: [],
    // M1은 위반을 판정하지 않는다. M3가 채울 자리를 지금 비워 두는 이유는 events/
    // state_changes와 같다 — 나중에 모양이 바뀌면 저장된 세션이 전부 깨진다.
    audit: { violations: [] },
    usage,
    model: str(model),
    extraction_failed: false
  };
}

export function createSession({
  session_id,
  world_id,
  card_ids = [],
  pov = null,
  opening = "",
  recent_turns = DEFAULT_RECENT_TURNS,
  max_tokens = DEFAULT_MAX_TOKENS,
  created_at
} = {}) {
  const normalizedCardIds = list(card_ids).map(str).filter(Boolean);
  return {
    session_id: str(session_id) || newId("session"),
    world_id: str(world_id),
    card_ids: normalizedCardIds,
    pov: str(pov) || null,
    opening: str(opening),
    turns: [],
    turn_count: 0,
    // 호감(카드별)·회복(전역) 두 축의 초기 상태. sim.js가 상태 모델을 소유하고
    // 여기서는 card_ids로부터 카드마다 0/0_stranger를 채운 초기값만 만든다.
    sim: createSimState({ cards: normalizedCardIds.map((id) => ({ card_id: id })) }),
    // 새 세션에는 아직 정해진 장면이 없다. turn.js가 <장면> 블록을 파싱할 때마다
    // 갱신한다 — memory.js의 상태 블록이 이 값으로 "장면이 바뀌었는가"의 기준을 삼는다.
    current_scene: null,
    // M4의 요약 체인이 채울 자리. 지금은 events[]/state_changes[]와 같은 이유로 비워 둔다.
    summary_chain: [],
    // 정체성이 아니라 생성 시각이므로 여기서만 생성한다. normalizeSession은 매 요청마다
    // 도는 함수라 거기서 생성하면 호출할 때마다 값이 바뀌어 정규화가 멱등하지 않게 된다.
    created_at: str(created_at) || new Date().toISOString(),
    settings: {
      recent_turns: clampPositive(recent_turns, DEFAULT_RECENT_TURNS, MAX_RECENT_TURNS),
      max_tokens: clampPositive(max_tokens, DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS)
    }
  };
}

export function normalizeTurn(raw = {}) {
  return {
    turn_id: str(raw.turn_id) || newId("turn"),
    session_id: str(raw.session_id),
    index: positive(raw.index, 0),
    user_input: str(raw.user_input),
    narration: str(raw.narration),
    choices: list(raw.choices).map(str).filter(Boolean),
    events: [],
    state_changes: [],
    audit: { violations: [] },
    usage: raw.usage && typeof raw.usage === "object" ? raw.usage : null,
    model: str(raw.model),
    extraction_failed: Boolean(raw.extraction_failed)
  };
}

/** 브라우저가 보낸 세션을 신뢰하지 않는다. turn_count는 저장값을 믿지 않고 다시 센다. */
export function normalizeSession(raw = {}) {
  const settings = raw.settings || {};
  const turns = list(raw.turns).map(normalizeTurn);
  const cardIds = list(raw.card_ids).map(str).filter(Boolean);
  return {
    session_id: str(raw.session_id) || newId("session"),
    world_id: str(raw.world_id),
    card_ids: cardIds,
    pov: str(raw.pov) || null,
    opening: str(raw.opening),
    turns,
    turn_count: turns.length,
    // 브라우저가 보낸 값은 신뢰하지 않는다: 숫자는 클램프, stage는 저장값이 아니라
    // affection에서 다시 계산, card_ids에 없는 카드는 버린다(normalizeSim 참고).
    sim: normalizeSim(raw.sim, cardIds),
    // 브라우저가 보낸 값은 모양만 맞추고 믿지 않는다(normalizeCurrentScene 참고).
    // 없거나 이상하면 null — "장면이 아직 없다"로 처리된다.
    current_scene: normalizeCurrentScene(raw.current_scene),
    summary_chain: [],
    // 여기서 생성하지 않는다 — normalizeSession은 요청마다 다시 도는데, 여기서
    // new Date()를 부르면 저장된 값이 있어도 매번 지금 시각으로 덮어써 정규화가
    // 멱등하지 않게 된다. 있으면 보존하고, 없으면 빈 문자열로 둔다.
    created_at: str(raw.created_at),
    settings: {
      recent_turns: clampPositive(settings.recent_turns, DEFAULT_RECENT_TURNS, MAX_RECENT_TURNS),
      max_tokens: clampPositive(settings.max_tokens, DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS)
    }
  };
}

export function nextTurnIndex(session) {
  return list(session?.turns).length + 1;
}

export function appendTurn(session, turn) {
  const turns = [...list(session?.turns), turn];
  return {
    ...session,
    card_ids: [...list(session?.card_ids)],
    settings: { ...(session?.settings || {}) },
    turns,
    turn_count: turns.length
  };
}

export function recentTurns(session, count = DEFAULT_RECENT_TURNS) {
  const turns = list(session?.turns);
  const n = positive(count, DEFAULT_RECENT_TURNS);
  return turns.slice(Math.max(0, turns.length - n));
}
