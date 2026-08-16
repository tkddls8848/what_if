/**
 * @module core/evidence
 *
 * 사실 → 원문 근거 되짚기.
 *
 * 이 앱이 요약 도구와 다른 지점은 "모든 주장에 원문 인용과 좌표가 붙는다"는 것이다.
 * 그 되짚기를 한 곳에 모아 뷰·내보내기·MCP가 같은 인용을 내놓게 한다.
 *
 * BOUNDARY NOTE: DOM 의존 없음. `app/utils.js`의 `sourceTextForSpan`은 전역 UI
 * `state`를 읽는 브라우저 전용 판이므로 여기서 재사용하지 않는다.
 */
import { segmentIndexOf } from "./asof.js";

const ID_PREFIX_TO_COLLECTION = {
  char: ["characters", "character_id", "character"],
  loc: ["locations", "location_id", "location"],
  event: ["events", "event_id", "event"],
  state: ["states", "state_id", "state"],
  rel: ["relations", "relation_id", "relation"],
  mention: ["mentions", "mention_id", "mention"],
  note: ["annotations", "annotation_id", "annotation"],
  scene: ["scenes", "scene_id", "scene"]
};

function segmentOf(analysis, segmentId) {
  return (analysis?.segments || []).find((segment) => segment.segment_id === segmentId) || null;
}

/** 문자 offset 구간을 원문 인용으로 바꾼다. 구간이 단락 밖이면 빈 문자열. */
function spanQuote(analysis, segmentId, span, { maxChars = 240 } = {}) {
  const segment = segmentOf(analysis, segmentId);
  if (!segment || !span) return "";
  const start = Math.max(0, Math.trunc(span.char_start - segment.char_start));
  const end = Math.min(segment.text.length, Math.trunc(span.char_end - segment.char_start));
  if (end <= start) return "";
  return clip(segment.text.slice(start, end), maxChars);
}

function segmentQuote(analysis, segmentId, { maxChars = 240 } = {}) {
  const segment = segmentOf(analysis, segmentId);
  return segment ? clip(segment.text, maxChars) : "";
}

/** id 문자열로 임의의 사실 객체를 찾는다. `evidence_for` 계열 조회의 진입점. */
export function findFact(analysis, factId) {
  const prefix = String(factId || "").split("_")[0];
  const entry = ID_PREFIX_TO_COLLECTION[prefix];
  if (!entry) return null;
  const [collection, idKey, factType] = entry;
  const fact = (analysis?.[collection] || []).find((item) => item[idKey] === factId);
  return fact ? { fact_type: factType, fact } : null;
}

/**
 * 사실 하나의 원문 근거. 근거를 만들 수 없으면 `null`을 돌려준다 —
 * 호출부는 근거 없는 항목을 응답에서 빼야 한다(추측을 사실처럼 내보내지 않는다).
 */
export function evidenceOf(analysis, fact, factType, { maxChars = 240 } = {}) {
  if (!fact) return null;
  const build = (segmentId, quote) => {
    if (!segmentId || !quote) return null;
    return { segment_id: segmentId, segment_index: segmentIndexOf(analysis, segmentId), quote };
  };

  if (factType === "event") {
    return build(fact.segment_id, spanQuote(analysis, fact.segment_id, fact.source_span, { maxChars })
      || segmentQuote(analysis, fact.segment_id, { maxChars }));
  }
  if (factType === "mention" || factType === "annotation") {
    // 주석의 근거는 용어가 실제로 놓인 자리다. 링크 내용이 아니라 **앵커**가 근거다 —
    // 외부 서술의 진위는 이 저장소가 보증하지 않는다.
    return build(fact.segment_id, spanQuote(analysis, fact.segment_id, fact, { maxChars }));
  }
  if (factType === "state") {
    const sourceEvent = (analysis.events || []).find((event) => (fact.source_event_ids || []).includes(event.event_id));
    if (sourceEvent) return evidenceOf(analysis, sourceEvent, "event", { maxChars });
    return build(fact.segment_id, segmentQuote(analysis, fact.segment_id, { maxChars }));
  }
  if (factType === "character" || factType === "location") {
    const mention = (analysis.mentions || []).find((item) => (fact.mentions || []).includes(item.mention_id))
      || (analysis.mentions || []).find((item) =>
        item.entity_type === factType && item.entity_id === (fact.character_id || fact.location_id));
    if (mention) return evidenceOf(analysis, mention, "mention", { maxChars });
    return build(fact.first_segment_id, segmentQuote(analysis, fact.first_segment_id, { maxChars }));
  }
  if (factType === "relation") {
    const event = (analysis.events || []).find((item) => (fact.event_ids || []).includes(item.event_id));
    if (event) return evidenceOf(analysis, event, "event", { maxChars });
    return build(fact.segment_ids?.[0], segmentQuote(analysis, fact.segment_ids?.[0], { maxChars }));
  }
  if (factType === "segment") {
    return build(fact.segment_id, clip(fact.text, maxChars));
  }
  return null;
}

function clip(value, maxChars) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
