/**
 * @module core/query
 *
 * 조합형 장면 질의 — `(시점 구간 × 인물 × 장소 × 사건 유형)` → 사건과 원문 근거.
 *
 * 관계 지도·사건 흐름·인물 상태는 서로 다른 화면이 아니라 **같은 질문의 세 프리셋**이다.
 * 화면마다 필터를 따로 들고 있으면 두 가지가 생긴다. 첫째, "복녀와 왕 서방이 함께
 * 나오는 장면"처럼 축을 섞은 질문을 담을 자리가 없다. 둘째, 같은 조건인데 화면마다
 * 답이 조금씩 달라진다. 질문을 담는 자리를 하나로 만들어 둘 다 막는다.
 *
 * BOUNDARY NOTE — 스포일러 판정은 여기 없다:
 * 시점 상한은 전부 `asOf()`가 정한다. 이 모듈은 그 결과 위에 조합 필터만 얹는다.
 * `window.to`는 `asOf()`가 정한 상한(`gate`)을 **넘지 못하도록 잘리고**, `window.from`은
 * 하한이라 더 가리기만 한다 — 두 방향 모두 허용 범위를 넓히지 않는다. 이 성질이
 * 유지되는 한 조합 필터는 누출 경로가 될 수 없다. 여기에 `index <= t` 같은 비교를
 * 다시 쓰면 판정이 두 벌이 되고, 어긋난 지점이 곧 누출이다.
 *
 * DOM·전역 상태·네트워크에 의존하지 않는다. 시점과 조건은 항상 인자로 받는다.
 */
import { asOf, resolveTime, segmentIndexOf } from "./asof.js";
import { evidenceOf } from "./evidence.js";

const DEFAULT_MAX_CHARS = 240;

function toIntOr(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function idSet(values) {
  if (!values) return new Set();
  return new Set((Array.isArray(values) ? values : [values]).filter(Boolean));
}

/**
 * 조합 질의.
 *
 * 축마다 결합 방식이 다르고, 그 차이는 원문의 성질에서 온다.
 *
 * - `characters`는 **AND**다. 나열한 인물이 *모두* 참여한 사건만 남는다. 하나면
 *   "그 인물이 나오는 장면", 둘이면 공동 출현 조회가 된다.
 * - `locations`는 **OR**다. 한 사건은 한 자리에서 일어나므로 여러 개는 후보 나열이다.
 * - `types`도 **OR**다.
 *
 * 비어 있는 축은 조건 없음이다.
 *
 * @param {object} analysis 분석 결과
 * @param {object} [options]
 * @param {number} [options.at] 시점 상한(segment index). `asOf()`가 정규화한다
 * @param {number} [options.from=1] 구간 하한. `to`와 같으면 그 단락만 본다
 * @param {number} [options.to] 구간 상한. 생략하면 `at`. 언제나 `at` 이하로 잘린다
 * @param {string[]} [options.characters] 모두 참여해야 하는 인물 id
 * @param {string[]} [options.locations] 그중 하나에서 일어나야 하는 장소 id
 * @param {string[]} [options.types] 사건 유형
 * @param {boolean} [options.spoilerSafe=true] false면 문서 전체가 상한이 된다
 * @param {string|string[]} [options.statuses="active"]
 * @param {number} [options.maxChars=240] 근거 인용 길이 상한
 */
export function queryScenes(analysis, options = {}) {
  const {
    at,
    from = 1,
    to = null,
    characters = [],
    locations = [],
    types = [],
    spoilerSafe = true,
    statuses = "active",
    maxChars = DEFAULT_MAX_CHARS
  } = options;

  const gate = resolveTime(analysis, at, spoilerSafe);
  const lower = Math.max(1, toIntOr(from, 1));
  const upper = to === null || to === undefined ? gate : Math.min(gate, toIntOr(to, gate));
  const range = { from: lower, to: upper, gate };

  const wantedCharacters = idSet(characters);
  const wantedLocations = idSet(locations);
  const wantedTypes = idSet(types);
  const query = {
    characters: [...wantedCharacters],
    locations: [...wantedLocations],
    types: [...wantedTypes]
  };

  const empty = { window: range, query, events: [], characters: [], locations: [], evidence: [] };
  if (!analysis || upper < lower) return empty;

  const scoped = asOf(analysis, at, { spoilerSafe, statuses });
  const requiredCharacters = [...wantedCharacters];

  const events = (scoped.events || [])
    .map((event) => ({ event, index: segmentIndexOf(analysis, event.segment_id) }))
    .filter(({ index }) => index >= lower && index <= upper)
    .filter(({ event }) => !wantedTypes.size || wantedTypes.has(event.type))
    .filter(({ event }) => requiredCharacters.every((id) => (event.characters || []).includes(id)))
    .filter(({ event }) => !wantedLocations.size || (event.locations || []).some((id) => wantedLocations.has(id)))
    .sort((a, b) => a.index - b.index || (a.event.sentence_index || 0) - (b.event.sentence_index || 0))
    .map(({ event }) => event);

  const characterIds = new Set();
  const locationIds = new Set();
  events.forEach((event) => {
    (event.characters || []).forEach((id) => characterIds.add(id));
    (event.locations || []).forEach((id) => locationIds.add(id));
  });

  const evidence = events
    .map((event) => {
      const found = evidenceOf(analysis, event, "event", { maxChars });
      return found ? { event_id: event.event_id, ...found } : null;
    })
    .filter(Boolean);

  return {
    window: range,
    query,
    events,
    // 결과에 딸려 나오는 인물·장소도 `asOf()`가 통과시킨 집합에서만 고른다. 사건이
    // 참조한다는 이유만으로 그 시점에 아직 알려지지 않은 객체를 돌려주지 않는다.
    characters: (scoped.characters || []).filter((item) => characterIds.has(item.character_id)),
    locations: (scoped.locations || []).filter((item) => locationIds.has(item.location_id)),
    evidence
  };
}
