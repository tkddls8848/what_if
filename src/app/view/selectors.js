/**
 * @module app/view/selectors
 *
 * 뷰 레이어의 표시 데이터 계산.
 *
 * BOUNDARY NOTE — 스포일러 판정은 여기 없다:
 * 시점 범위(무엇이 보이는가)는 전부 `core/asof.js`가 결정한다. 이 모듈은 그 결과에
 * 사건 유형·엔티티 같은 **표시 필터만** 얹는다. 여기에 `index <= currentSegment`
 * 같은 비교를 다시 쓰면 판정이 두 벌이 되고, 그 순간부터 내보내기·MCP와 어긋난다.
 */
import { state } from "../context.js";
import { asOf } from "../../core/asof.js";
import { currentSpoilerSafe, isCurrentSegmentId, isVisibleSegmentId, segmentOrder, statusMatches } from "../utils.js";

function matchesDisplayFilters(event) {
  if (state.filters.eventType !== "all" && event.type !== state.filters.eventType) return false;
  if (state.filters.entity === "all") return true;
  const [kind, id] = state.filters.entity.split(":");
  if (kind === "character") return event.characters.includes(id);
  if (kind === "location") return event.locations.includes(id);
  return true;
}

export function selectMapEvents() {
  if (!state.analysis) return [];
  return state.analysis.events
    .filter((event) => statusMatches(event.status))
    .filter((event) => isCurrentSegmentId(event.segment_id))
    .filter(matchesDisplayFilters);
}

export function selectVisibleEvents() {
  if (!state.analysis) return [];
  return state.analysis.events
    .filter((event) => statusMatches(event.status))
    .filter((event) => isVisibleSegmentId(event.segment_id))
    .filter(matchesDisplayFilters)
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id) || a.sentence_index - b.sentence_index);
}

/**
 * 현재 독서 시점 기준으로 잘라낸 분석 결과. 내보내기 5종이 이 결과를 공유한다.
 * 판정은 `asOf()`가 하고 여기서는 UI 상태를 인자로 옮겨 담기만 한다.
 *
 * `/check` 경로는 검수 대상 전체를 봐야 하므로 시점 제한을 끈다 —
 * `app/utils.js`의 `isVisibleSegmentId`가 갖는 예외와 같은 규칙이다.
 */
export function selectScopedAnalysis() {
  return asOf(state.analysis, state.currentSegment, {
    spoilerSafe: currentSpoilerSafe(),
    statuses: state.filters.status
  });
}
