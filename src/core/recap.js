/**
 * @module core/recap
 *
 * 읽은 데까지의 집계 — "여기까지 무슨 일이 있었나".
 *
 * 오래 쉬었다 돌아온 독자가 잃는 것은 줄거리가 아니라 **누가 지금 어떤 상태인가**다.
 * 사건 흐름 탭은 목록이라 훑어야 하고, 인물 상태 탭은 한 번에 한 인물이다. 시점
 * 하나를 받아 그 시점의 전체 집계를 한 번에 돌려주는 자리가 없었다.
 *
 * BOUNDARY NOTE — 서술을 만들지 않는다:
 * 이 모듈은 `asOf()`가 통과시킨 사실을 **세기만 한다.** 원문을 재서술하거나 문장을
 * 생성하지 않는다(`doc/README.md` 7-1). 요약처럼 읽히는 문자열이 필요하면 원문
 * 근거를 그대로 인용해야 하고 그건 `core/evidence.js`의 일이다.
 *
 * 시점 판정도 여기 없다. `asOf()` 결과 위의 집계다. `index <= t` 비교를 여기에
 * 다시 쓰면 판정이 두 벌이 되고, 어긋난 지점이 곧 누출이다.
 */
import { asOf, currentStateOf, isKnownAt, lastSegmentIndex, resolveTime } from "./asof.js";

const NOTE = "이 요약은 추출된 사실의 집계다. 원문을 재서술하거나 생성하지 않는다.";

/**
 * 시점 t까지의 집계.
 *
 * @param {object} analysis 분석 결과
 * @param {number} at 시점(segment index). `resolveTime()`이 정규화한다
 * @param {object} [options]
 * @param {boolean} [options.spoilerSafe=true] false면 문서 전체가 상한이 된다
 * @param {string|string[]} [options.statuses="active"]
 */
export function recapAt(analysis, at, { spoilerSafe = true, statuses = "active" } = {}) {
  const time = resolveTime(analysis, at, spoilerSafe);
  const scoped = asOf(analysis, time, { spoilerSafe, statuses });

  const eventTypeCounts = {};
  scoped.events.forEach((event) => {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] || 0) + 1;
  });

  const characters = scoped.characters.map((character) => {
    const current = currentStateOf(analysis, character.character_id, time, { statuses });
    const stateRecords = (analysis.states || [])
      .filter((item) => item.character_id === character.character_id && isKnownAt(item, time))
      .length;
    return {
      character_id: character.character_id,
      name: character.canonical_name,
      first_seen_segment: character.valid_from,
      state_records: stateRecords,
      current_mental_state: current?.mental_state || "",
      current_physical_state: current?.physical_state || ""
    };
  });

  return {
    as_of: time,
    progress: { segment: time, of: lastSegmentIndex(analysis) },
    event_type_counts: eventTypeCounts,
    characters,
    audit: scoped.audit.counts,
    note: NOTE
  };
}
