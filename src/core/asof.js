/**
 * @module core/asof
 *
 * 서사 시간(narrative time) 기준 질의 원시연산.
 *
 * 이 모듈은 저장소에서 **스포일러 범위를 판정하는 유일한 장소**다. 뷰(`app/view/*`),
 * 내보내기, MCP 어댑터, what-if 분기 시드가 모두 여기를 경유해야 한다. 같은 판정을
 * 다른 곳에서 다시 구현하면 반드시 어긋나고, 어긋난 지점이 곧 스포일러 누출이다.
 *
 * BOUNDARY NOTE:
 * DOM·전역 UI 상태·네트워크에 의존하지 않는다. `app/context.js`의 `state`를 import
 * 하지 말 것. 시점 `t`와 옵션은 항상 인자로 받는다.
 *
 * 두 가지 시간 술어를 구분한다. 이 구분이 이 모듈의 핵심이다.
 *
 * - KNOWN(t) — `valid_from <= t`. 독자가 그 시점까지 읽어서 **이미 알게 된** 사실.
 *   스포일러 범위(scope) 계산에 쓴다. 퇴장한 인물도 계속 KNOWN이다.
 * - TRUE(t)  — `valid_from <= t <= valid_to`. 그 시점에 **여전히 유효한** 사실.
 *   "지금 상태/지금 관계" 조회에 쓴다.
 *
 * 시간 좌표는 segment id가 아니라 **segment index(1부터 시작하는 정수)**다. 정수여야
 * 구간 비교가 가능하고, 나중에 EPUB CFI나 챕터 번호로 재사상할 수 있다.
 * `0`은 "좌표 없음"을 뜻하며 어떤 시점에도 KNOWN/TRUE가 되지 않는다.
 */
import { STATUS } from "../config.js";

/** 좌표를 알 수 없는 사실에 부여하는 값. 어떤 시점에도 보이지 않는다. */
const UNKNOWN_TIME = 0;

export function lastSegmentIndex(analysis) {
  const segments = analysis?.segments;
  if (!segments?.length) return UNKNOWN_TIME;
  return segments.reduce((max, segment) => Math.max(max, segment.index || 0), UNKNOWN_TIME);
}

export function segmentIndexOf(analysis, segmentId) {
  if (!segmentId) return UNKNOWN_TIME;
  return analysis?.segments?.find((segment) => segment.segment_id === segmentId)?.index || UNKNOWN_TIME;
}

/**
 * 질의 시점을 정규화한다. `spoilerSafe: false`는 문서 전체를 뜻하므로 마지막
 * segment index로 치환된다 — 이렇게 하면 하위 연산이 분기 없이 하나의 `t`만 다룬다.
 */
export function resolveTime(analysis, t, spoilerSafe = true) {
  const last = lastSegmentIndex(analysis);
  if (!spoilerSafe) return last;
  const value = Number(t);
  if (!Number.isFinite(value)) return last;
  return Math.max(UNKNOWN_TIME, Math.min(last, Math.trunc(value)));
}

export function intervalOf(fact) {
  const from = Number(fact?.valid_from);
  const to = fact?.valid_to === null || fact?.valid_to === undefined ? null : Number(fact.valid_to);
  return {
    valid_from: Number.isFinite(from) ? from : UNKNOWN_TIME,
    valid_to: Number.isFinite(to) ? to : null
  };
}

/** 시점 t까지 읽은 독자가 알고 있는 사실인가. */
export function isKnownAt(fact, t) {
  const { valid_from } = intervalOf(fact);
  return valid_from >= 1 && valid_from <= t;
}

/** 시점 t에 여전히 유효한 사실인가. */
export function isTrueAt(fact, t) {
  const { valid_from, valid_to } = intervalOf(fact);
  if (valid_from < 1 || valid_from > t) return false;
  return valid_to === null || t <= valid_to;
}

export function statusFilter(statuses = "active") {
  if (statuses === "all") return () => true;
  if (statuses === "active") return (status) => status !== STATUS.REJECTED;
  if (Array.isArray(statuses)) {
    const allowed = new Set(statuses);
    return (status) => allowed.has(status);
  }
  return (status) => status === statuses;
}

/* ------------------------------------------------------------------ */
/* 구간 부여                                                            */
/* ------------------------------------------------------------------ */

/**
 * 인물·장소에 등장 구간을 부여한다.
 *
 * `valid_to`는 규칙 채널에서 항상 `null`로 둔다. 원문에서 "퇴장"을 근거 있게 판정할
 * 방법이 없기 때문이다. 필드는 계약으로 존재하며 검수·LLM·수동 편집이 채운다.
 * 이미 값이 있으면 덮어쓰지 않는다.
 */
export function annotateEntityIntervals(analysis) {
  analysis.characters?.forEach((character) => {
    character.valid_from = segmentIndexOf(analysis, character.first_segment_id);
    if (character.valid_to === undefined) character.valid_to = null;
  });
  analysis.locations?.forEach((location) => {
    location.valid_from = segmentIndexOf(analysis, location.first_segment_id);
    if (location.valid_to === undefined) location.valid_to = null;
  });
  // 시대 주석도 서사 시간 위에 있다. 아직 읽지 않은 단락의 주석을 보여 주면 그 자체가
  // 누출이다 — 「날개」의 `아달린`은 그 낱말이 나오는 순간이 곧 사건이다.
  analysis.annotations?.forEach((annotation) => {
    annotation.valid_from = segmentIndexOf(analysis, annotation.segment_id);
    if (annotation.valid_to === undefined) annotation.valid_to = null;
  });
  return analysis;
}

/**
 * 인물 상태 레코드를 연속 구간으로 닫는다.
 *
 * 같은 인물의 다음 상태 레코드가 이전 구간을 닫고, 그 다음 레코드를 만든 사건이
 * `invalidated_by`가 된다 — Graphiti의 "모순 시 삭제가 아니라 무효화" 규칙을
 * 서사 시간 축에 적용한 것이다. 이력은 지워지지 않으므로 "왜 상태가 바뀌었는가"를
 * 사건 하나로 되짚을 수 있다.
 *
 * 입력 배열을 제자리에서 수정하고 그대로 반환한다.
 */
export function annotateStateIntervals(analysis, states) {
  const byCharacter = new Map();
  states.forEach((state) => {
    const list = byCharacter.get(state.character_id) || [];
    list.push(state);
    byCharacter.set(state.character_id, list);
  });

  byCharacter.forEach((list) => {
    list
      .map((state) => ({ state, index: segmentIndexOf(analysis, state.segment_id) }))
      .sort((a, b) => a.index - b.index)
      .forEach((entry, position, ordered) => {
        const next = ordered[position + 1];
        entry.state.valid_from = entry.index;
        entry.state.valid_to = next ? Math.max(entry.index, next.index - 1) : null;
        entry.state.invalidated_by = next ? next.state.source_event_ids?.[0] || "" : "";
      });
  });

  return states;
}

/**
 * 관계 구간을 부여한다. `valid_from`은 근거 segment 중 가장 이른 것이다.
 * `valid_to`는 규칙 채널에서 `null`이다(관계 단절을 원문에서 판정할 근거가 없다).
 */
export function annotateRelationIntervals(analysis, relations) {
  relations.forEach((relation) => {
    const indexes = (relation.segment_ids || [])
      .map((segmentId) => segmentIndexOf(analysis, segmentId))
      .filter((index) => index >= 1);
    relation.valid_from = indexes.length ? Math.min(...indexes) : UNKNOWN_TIME;
    if (relation.valid_to === undefined) relation.valid_to = null;
    if (relation.invalidated_by === undefined) relation.invalidated_by = "";
  });
  return relations;
}

/** 무효화 이력: 어떤 사실이 언제, 무엇 때문에 대체되었는가. */
export function invalidations(analysis) {
  const rows = [];
  const collect = (items, type, idKey) => {
    (items || []).forEach((item) => {
      const { valid_to } = intervalOf(item);
      if (valid_to === null || !item.invalidated_by) return;
      rows.push({
        fact_type: type,
        fact_id: item[idKey],
        at: valid_to + 1,
        invalidated_by: item.invalidated_by
      });
    });
  };
  collect(analysis.states, "state", "state_id");
  collect(analysis.relations, "relation", "relation_id");
  collect(analysis.characters, "character", "character_id");
  collect(analysis.locations, "location", "location_id");
  return rows.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------ */
/* 질의                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 시점 t에 **유효한**(TRUE) 사실만 반환한다. "지금 상태는?"에 답할 때 쓴다.
 * scope 계산(KNOWN)과 혼동하지 말 것.
 */
export function factsAt(analysis, t, { statuses = "active" } = {}) {
  const matches = statusFilter(statuses);
  return {
    at: t,
    characters: (analysis.characters || []).filter((item) => matches(item.status) && isTrueAt(item, t)),
    locations: (analysis.locations || []).filter((item) => matches(item.status) && isTrueAt(item, t)),
    states: (analysis.states || []).filter((item) => matches(item.status) && isTrueAt(item, t)),
    relations: (analysis.relations || []).filter((item) => matches(item.status) && isTrueAt(item, t)),
    annotations: (analysis.annotations || []).filter((item) => matches(item.status) && isKnownAt(item, t))
  };
}

/** 시점 t에 유효한 특정 인물의 상태 레코드. 없으면 null. */
export function currentStateOf(analysis, characterId, t, { statuses = "active" } = {}) {
  const matches = statusFilter(statuses);
  return (analysis.states || [])
    .filter((state) => state.character_id === characterId && matches(state.status) && isTrueAt(state, t))
    .sort((a, b) => intervalOf(b).valid_from - intervalOf(a).valid_from)[0] || null;
}

/**
 * 시점 t까지 독자가 알고 있는(KNOWN) 범위로 분석 결과를 잘라낸다.
 *
 * 반환 형태는 기존 `selectScopedAnalysis()`와 동일한 계약이다 — 내보내기 5종이
 * 그대로 동작해야 하므로 필드 구성을 바꾸지 않는다. `audit`만 추가된다.
 */
export function asOf(analysis, t, { spoilerSafe = true, statuses = "active" } = {}) {
  const at = resolveTime(analysis, t, spoilerSafe);
  const matches = statusFilter(statuses);
  const visible = (segmentId) => {
    const index = segmentIndexOf(analysis, segmentId);
    return index >= 1 && index <= at;
  };

  return {
    document: analysis.document,
    scope: spoilerSafe
      ? { mode: "reader_position", current_segment: at }
      : { mode: "full_document" },
    segments: (analysis.segments || []).filter((segment) => segment.index >= 1 && segment.index <= at),
    scenes: (analysis.scenes || []).filter((scene) => visible(scene.start_segment_id) || visible(scene.end_segment_id)),
    mentions: (analysis.mentions || []).filter((mention) => visible(mention.segment_id) && matches(mention.status)),
    characters: (analysis.characters || []).filter((item) => matches(item.status) && isKnownAt(item, at)),
    locations: (analysis.locations || []).filter((item) => matches(item.status) && isKnownAt(item, at)),
    events: (analysis.events || []).filter((event) => visible(event.segment_id) && matches(event.status)),
    states: (analysis.states || []).filter((item) => visible(item.segment_id) && matches(item.status)),
    relations: (analysis.relations || []).filter((item) => matches(item.status) && isKnownAt(item, at)),
    annotations: (analysis.annotations || []).filter((item) => visible(item.segment_id) && matches(item.status)),
    audit: scopeAudit(analysis.diagnostics?.audit, at),
    diagnostics: analysis.diagnostics
  };
}

function scopeAudit(audit, at) {
  if (!audit?.violations) return { counts: audit?.counts || {}, violations: [] };
  const violations = audit.violations.filter((violation) => {
    const index = Number(violation.segment_index);
    return Number.isFinite(index) && index >= 1 && index <= at;
  });
  return { counts: audit.counts || {}, violations };
}
