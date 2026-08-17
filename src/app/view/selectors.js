/**
 * @module app/view/selectors
 *
 * 뷰 레이어의 표시 데이터 계산.
 *
 * 관계 지도·사건 흐름·인물 상태는 서로 다른 조회가 아니라 `core/query.js`의 조합 질의
 * 하나를 **구간과 조건만 달리해 부르는 프리셋**이다. 화면마다 필터를 따로 구현하면
 * 같은 조건에 다른 답이 나오고, 축을 섞은 질문을 담을 자리가 없어진다.
 *
 * BOUNDARY NOTE — 스포일러 판정은 여기 없다:
 * 시점 범위(무엇이 보이는가)는 전부 `core/asof.js`가 결정한다. 이 모듈이 하는 일은
 * UI 상태를 질의 인자로 옮겨 담는 것뿐이다. 여기에 `index <= currentSegment` 같은
 * 비교를 다시 쓰면 판정이 두 벌이 되고, 그 순간부터 내보내기·MCP와 어긋난다.
 */
import { state } from "../context.js";
import { asOf } from "../../core/asof.js";
import { queryScenes } from "../../core/query.js";
import { currentSpoilerSafe } from "../utils.js";

/**
 * 화면 공통 필터를 질의 축으로 옮긴다. 사건 유형 필터와 객체 필터는 별도 개념이
 * 아니라 그냥 이 질의의 조건이다.
 */
function filterQuery() {
  const [kind, id] = state.filters.entity === "all" ? [] : state.filters.entity.split(":");
  return {
    types: state.filters.eventType === "all" ? [] : [state.filters.eventType],
    characters: kind === "character" && id ? [id] : [],
    locations: kind === "location" && id ? [id] : [],
    statuses: state.filters.status
  };
}

function readerScope() {
  return { at: state.currentSegment, spoilerSafe: currentSpoilerSafe() };
}

/** 관계 지도: **지금 이 단락**만 그린다. 구간의 양 끝을 현재 독서 위치에 붙인다. */
export function selectMapEvents() {
  if (!state.analysis) return [];
  return queryScenes(state.analysis, {
    ...readerScope(),
    from: state.currentSegment,
    to: state.currentSegment,
    ...filterQuery()
  }).events;
}

/** 사건 흐름: 시작부터 현재 시점까지 읽어서 알게 된 사건 전부. */
export function selectVisibleEvents() {
  if (!state.analysis) return [];
  return queryScenes(state.analysis, {
    ...readerScope(),
    ...filterQuery()
  }).events;
}

/**
 * 인물 상태: 한 인물이 참여한 사건.
 *
 * 화면 공통 필터를 일부러 쓰지 않는다 — 카드마다 인물 축이 이미 정해져 있고,
 * 객체 필터를 켠 상태에서도 각 카드는 자기 인물의 이력을 온전히 보여 줘야 한다.
 * 어느 카드를 그릴지는 `renderCharacters()`가 정한다.
 */
export function selectCharacterEvents(characterId) {
  if (!state.analysis || !characterId) return [];
  return queryScenes(state.analysis, {
    ...readerScope(),
    characters: [characterId]
  }).events;
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
