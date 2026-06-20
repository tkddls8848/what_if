import { state, els, STATUS_LABELS } from "../context.js";
import { selectVisibleEvents } from "./selectors.js";
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

export function renderTimeline() {
  const events = selectVisibleEvents();
  els.timelineList.innerHTML = "";
  if (!events.length) {
    els.timelineList.innerHTML = `<div class="empty-state">현재 조건에 맞는 사건이 없습니다.</div>`;
    return;
  }

  events.forEach((event) => {
    const segment = state.analysis.segments.find((item) => item.segment_id === event.segment_id);
    const card = document.createElement("article");
    card.className = `timeline-card ${statusClass(event.status)}`;
    card.innerHTML = `
      <div class="timeline-marker">
        <strong>${event.event_id}</strong>
        <span>P${segment?.index || "?"}</span>
      </div>
      <div class="timeline-content">
        <div class="tag-row">
          <span class="tag event">${eventTypeLabel(event.type)}</span>
          <span class="status-pill ${statusClass(event.status)}">${STATUS_LABELS[event.status]}</span>
          ${event.characters.map((id) => `<button type="button" class="chip" data-select-kind="character" data-select-id="${id}">${escapeHtml(nameOf("character", id))}</button>`).join("")}
          ${event.locations.map((id) => `<button type="button" class="chip location" data-select-kind="location" data-select-id="${id}">${escapeHtml(nameOf("location", id))}</button>`).join("")}
        </div>
        <p>${escapeHtml(event.summary)}</p>
        <blockquote>${escapeHtml(sourceTextForSpan(event.source_span))}</blockquote>
      </div>
    `;
    card.addEventListener("click", (eventClick) => {
      if (eventClick.target.closest("button")) return;
      state.currentSegment = segment?.index || state.currentSegment;
      state.selected = { kind: "event", id: event.event_id };
      activateTab("timeline");
      renderAll();
    });
    els.timelineList.appendChild(card);
  });
}
