import { state, els, STATUS } from "../context.js";
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

export function renderReader() {
  const analysis = state.analysis;
  if (!analysis) {
    els.readerStats.textContent = "문서 없음";
    els.segmentList.innerHTML = "";
    return;
  }

  const max = Math.max(1, analysis.segments.length);
  els.readerPosition.max = String(max);
  els.readerPosition.value = String(Math.min(state.currentSegment, max));
  els.readerPositionLabel.textContent = `${state.currentSegment} / ${max}`;
  els.readerStats.textContent = `${analysis.document.title} · ${analysis.segments.length}문단 · ${analysis.events.length}사건`;

  els.segmentList.innerHTML = "";
  const segment = analysis.segments[state.currentSegment - 1];
  if (!segment) return;

  const segmentEvents = analysis.events
    .filter((event) => event.segment_id === segment.segment_id && event.status !== STATUS.REJECTED);
  const characterNames = unique(segmentEvents.flatMap((event) => event.characters).map((id) => nameOf("character", id)));
  const locationNames = unique(segmentEvents.flatMap((event) => event.locations).map((id) => nameOf("location", id)));

  const card = document.createElement("article");
  card.className = "active-segment-card";
  card.innerHTML = `
    <header>
      <div>
        <span class="segment-index">${escapeHtml(segment.segment_id)} · ${escapeHtml(segment.scene_id)}</span>
        <h3>현재 활성 문단</h3>
      </div>
      <div class="active-segment-actions">
        <button type="button" data-reader-step="-1" ${state.currentSegment <= 1 ? "disabled" : ""}>이전</button>
        <button type="button" data-reader-step="1" ${state.currentSegment >= max ? "disabled" : ""}>다음</button>
      </div>
    </header>
    <p class="active-segment-text">${escapeHtml(segment.text)}</p>
    <div class="active-segment-meta">
      <span class="tag">${segmentEvents.length} 사건</span>
      ${characterNames.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("")}
      ${locationNames.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("")}
    </div>
  `;
  card.querySelectorAll("[data-reader-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = state.currentSegment + Number(button.dataset.readerStep);
      state.currentSegment = Math.max(1, Math.min(max, next));
      renderAll();
    });
  });
  els.segmentList.appendChild(card);
  highlightSourceSegment(segment);
}

function highlightSourceSegment(segment) {
  if (!segment || !els.sourceText.value) return;
  const start = Math.max(0, segment.char_start);
  const end = Math.min(els.sourceText.value.length, segment.char_end);

  const ratio = start / Math.max(1, els.sourceText.value.length);
  const maxScroll = Math.max(0, els.sourceText.scrollHeight - els.sourceText.clientHeight);
  els.sourceText.scrollTop = Math.max(0, Math.round(maxScroll * ratio) - 40);
  els.sourceText.focus({ preventScroll: true });
  els.sourceText.setSelectionRange(start, end);
}

export function renderFilterOptions() {
  const analysis = state.analysis;
  if (!analysis) return;
  const previousEntity = state.filters.entity;
  const previousEventType = state.filters.eventType;
  const eventTypes = unique([
    ...(analysis.dynamic_lexicon?.eventTypes || []).map((entry) => entry.type),
    ...analysis.events.map((event) => event.type)
  ]);

  els.eventTypeFilter.innerHTML = [
    `<option value="all">전체</option>`,
    ...eventTypes.map((type) => `<option value="${escapeAttr(type)}">${escapeHtml(eventTypeLabel(type))}</option>`)
  ].join("");

  if (Array.from(els.eventTypeFilter.options).some((option) => option.value === previousEventType)) {
    els.eventTypeFilter.value = previousEventType;
  } else {
    state.filters.eventType = "all";
  }

  const visibleOptions = [
    `<option value="all">전체</option>`,
    ...analysis.characters
      .filter((character) => character.status !== STATUS.REJECTED)
      .map((character) => `<option value="character:${character.character_id}">인물 · ${escapeHtml(character.canonical_name)}</option>`),
    ...analysis.locations
      .filter((location) => location.status !== STATUS.REJECTED)
      .map((location) => `<option value="location:${location.location_id}">장소 · ${escapeHtml(location.name)}</option>`)
  ];
  els.entityFilter.innerHTML = visibleOptions.join("");
  if (Array.from(els.entityFilter.options).some((option) => option.value === previousEntity)) {
    els.entityFilter.value = previousEntity;
  } else {
    state.filters.entity = "all";
  }
}
