import { state, els, STATUS, STATUS_LABELS } from "../context.js";
import { statusButtons } from "../editing.js";
import {
  csvCell,
  drawSvgText,
  escapeAttr,
  escapeHtml,
  eventTypeLabel,
  getEntity,
  isCurrentSegmentId,
  isVisibleSegmentId,
  kindLabel,
  latestStateForCharacter,
  matchesEntityFilter,
  nameOf,
  segmentOrder,
  sourceTextForSpan,
  statusClass,
  statusMatches,
  svgEl,
  unique
} from "../utils.js";

export function renderReview() {
  const analysis = state.analysis;
  if (!analysis) return;

  const segment = analysis.segments[state.currentSegment - 1];
  els.reviewSourceStats.textContent = segment ? `${segment.segment_id} · ${segment.scene_id}` : "현재 문단";
  els.reviewSource.innerHTML = segment ? renderHighlightedSegment(segment) : "";

  const items = [
    ...analysis.characters.map((item) => ({ kind: "character", id: item.character_id, item })),
    ...analysis.locations.map((item) => ({ kind: "location", id: item.location_id, item })),
    ...analysis.events.map((item) => ({ kind: "event", id: item.event_id, item }))
  ]
    .filter(({ item }) => statusMatches(item.status))
    .filter(({ item, kind }) => {
      const segmentId = kind === "event" ? item.segment_id : item.first_segment_id;
      return isVisibleSegmentId(segmentId);
    })
    .sort((a, b) => (a.item.confidence || 0) - (b.item.confidence || 0));

  els.reviewStats.textContent = `${items.length}개`;
  els.reviewList.innerHTML = items.length ? "" : `<div class="empty-state">검수할 항목이 없습니다.</div>`;

  items.forEach(({ kind, id, item }) => {
    const row = document.createElement("article");
    row.className = `review-item ${statusClass(item.status)} ${state.selected?.kind === kind && state.selected?.id === id ? "selected" : ""}`;
    const title = item.canonical_name || item.name || item.summary;
    row.innerHTML = `
      <header>
        <button type="button" class="link-button" data-select-kind="${kind}" data-select-id="${id}">
          ${kindLabel(kind)} · ${escapeHtml(title)}
        </button>
        <span class="status-pill ${statusClass(item.status)}">${STATUS_LABELS[item.status]}</span>
      </header>
      <label class="field compact">
        ${kind === "event" ? "요약" : "이름"}
        <input data-edit-kind="${kind}" data-edit-id="${id}" data-edit-field="${kind === "event" ? "summary" : kind === "location" ? "name" : "canonical_name"}" value="${escapeAttr(title)}">
      </label>
      <div class="review-meta">
        <span>${Math.round((item.confidence || 0) * 100)}%</span>
        <span>${item.method || "manual"}</span>
      </div>
      <div class="button-row">${statusButtons(kind, id)}</div>
    `;
    els.reviewList.appendChild(row);
  });
}

function segmentIdForEntity(kind, id) {
  const entity = getEntity(kind, id);
  if (!entity) return "";
  return kind === "event" ? entity.segment_id : entity.first_segment_id;
}

export function focusSelectionSegment(kind, id) {
  const segmentId = segmentIdForEntity(kind, id);
  const order = segmentOrder(segmentId);
  if (order) state.currentSegment = order;
}

export function renderCheckSummary() {
  if (!els.checkSummary) return;
  const analysis = state.analysis;
  if (!analysis) {
    els.checkSummary.innerHTML = "";
    return;
  }
  const reviewables = [
    ...analysis.characters,
    ...analysis.locations,
    ...analysis.events
  ];
  const counts = {
    total: reviewables.length,
    suggested: reviewables.filter((item) => item.status === STATUS.SUGGESTED).length,
    confirmed: reviewables.filter((item) => item.status === STATUS.CONFIRMED).length,
    edited: reviewables.filter((item) => item.status === STATUS.EDITED).length,
    rejected: reviewables.filter((item) => item.status === STATUS.REJECTED).length
  };
  els.checkSummary.innerHTML = `
    <div><strong>${counts.total}</strong><span>전체</span></div>
    <div><strong>${counts.suggested}</strong><span>제안</span></div>
    <div><strong>${counts.confirmed}</strong><span>확정</span></div>
    <div><strong>${counts.edited}</strong><span>수정</span></div>
    <div><strong>${counts.rejected}</strong><span>제외</span></div>
  `;
}

function renderHighlightedSegment(segment) {
  const analysis = state.analysis;
  const localMarks = [];

  analysis.mentions
    .filter((mention) => mention.segment_id === segment.segment_id && mention.status !== STATUS.REJECTED)
    .forEach((mention) => {
      localMarks.push({
        start: mention.char_start - segment.char_start,
        end: mention.char_end - segment.char_start,
        className: mention.entity_type,
        label: nameOf(mention.entity_type, mention.entity_id)
      });
    });

  analysis.events
    .filter((event) => event.segment_id === segment.segment_id && event.status !== STATUS.REJECTED)
    .forEach((event) => {
      localMarks.push({
        start: event.source_span.char_start - segment.char_start,
        end: event.source_span.char_end - segment.char_start,
        className: "event",
        label: eventTypeLabel(event.type)
      });
    });

  localMarks.sort((a, b) => a.start - b.start || b.end - a.end);
  const safeMarks = [];
  localMarks.forEach((mark) => {
    if (safeMarks.some((existing) => mark.start < existing.end && mark.end > existing.start)) return;
    safeMarks.push(mark);
  });

  let cursor = 0;
  let html = "";
  safeMarks.forEach((mark) => {
    html += escapeHtml(segment.text.slice(cursor, mark.start));
    html += `<mark class="${mark.className}" title="${escapeAttr(mark.label)}">${escapeHtml(segment.text.slice(mark.start, mark.end))}</mark>`;
    cursor = mark.end;
  });
  html += escapeHtml(segment.text.slice(cursor));
  return `<p>${html}</p>`;
}
