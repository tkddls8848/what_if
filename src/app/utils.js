/**
 * @module app/utils
 *
 * Browser/view-layer toolkit for the app shell. These helpers read shared UI `state`,
 * touch the DOM (`els`, `document`, `window`) and format values for rendering, so this
 * module is browser-only by design.
 *
 * BOUNDARY NOTE — intentional duplication:
 * A few generic text helpers here (`unique`, `makeId`, `escapeRegExp`, `includesAny`,
 * `summarizeText`) share names with PRIVATE helpers inside `../analyzer.js`. That is
 * intentional: `analyzer.js` is the DOM-free analysis core and keeps its own self-
 * contained copies on purpose. These two modules are independent — do not merge them.
 */
import { state, els, $$, STATUS, EVENT_LABELS } from "./context.js";
import { currentRoute, isCheckRoute } from "./view/router.js";

export { currentRoute, isCheckRoute };

export function getEntity(kind, id) {
  if (!state.analysis) return null;
  if (kind === "character") return state.analysis.characters.find((item) => item.character_id === id);
  if (kind === "location") return state.analysis.locations.find((item) => item.location_id === id);
  if (kind === "event") return state.analysis.events.find((item) => item.event_id === id);
  return null;
}

export function latestStateForCharacter(characterId) {
  return state.analysis.states
    .filter((item) => item.character_id === characterId && item.status !== STATUS.REJECTED && isVisibleSegmentId(item.segment_id))
    .sort((a, b) => segmentOrder(b.segment_id) - segmentOrder(a.segment_id))[0];
}

export function nameOf(kind, id) {
  const entity = getEntity(kind, id);
  if (!entity) return id;
  return entity.canonical_name || entity.name || entity.summary || id;
}

export function kindLabel(kind) {
  return { character: "인물", location: "장소", event: "사건" }[kind] || kind;
}

export function sourceTextForSpan(span) {
  if (!state.analysis || !span) return "";
  const segment = state.analysis.segments.find((item) => span.char_start >= item.char_start && span.char_start <= item.char_end);
  if (!segment) return "";
  return segment.text.slice(span.char_start - segment.char_start, span.char_end - segment.char_start);
}

export function renderEvidenceList(items) {
  if (!items.length) return `<p class="muted">현재 범위에 표시 가능한 근거가 없습니다.</p>`;
  return `<ul class="evidence-list">${items.slice(0, 8).map((item) => {
    const segmentId = item.segment_id || item.first_segment_id;
    const text = item.source_span ? sourceTextForSpan(item.source_span) : item.text;
    return `<li><button type="button" class="link-button" data-focus-segment="${escapeAttr(segmentId || "")}">${escapeHtml(segmentId || "")}</button> ${escapeHtml(text || "")}</li>`;
  }).join("")}</ul>`;
}

export function focusSegment(segmentId) {
  const segment = state.analysis?.segments.find((item) => item.segment_id === segmentId);
  if (!segment) return;
  state.currentSegment = segment.index;
  renderAll();
}

export function renderMiniEvent(event) {
  return `
    <article class="mini-event">
      <span class="tag event">${eventTypeLabel(event.type)}</span>
      <p>${escapeHtml(event.summary)}</p>
    </article>
  `;
}

export function activateTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}Tab`));
}

export function statusMatches(status) {
  if (state.filters.status === "all") return true;
  if (state.filters.status === "active") return status !== STATUS.REJECTED;
  return status === state.filters.status;
}

export function statusClass(status) {
  return `status-${status || STATUS.SUGGESTED}`;
}

export function eventTypeLabel(type) {
  const dynamic = state.analysis?.dynamic_lexicon?.eventTypes?.find((entry) => entry.type === type);
  return dynamic?.label || EVENT_LABELS[type] || type || "사건";
}

export function matchesEntityFilter(kind, id) {
  return state.filters.entity === "all" || state.filters.entity === `${kind}:${id}`;
}

export function isVisibleSegmentId(segmentId) {
  const order = segmentOrder(segmentId);
  if (!order) return false;
  return isCheckRoute() || !state.spoilerSafe || order <= state.currentSegment;
}

export function isCurrentSegmentId(segmentId) {
  return segmentOrder(segmentId) === state.currentSegment;
}

export function segmentOrder(segmentId) {
  return state.analysis?.segments.find((segment) => segment.segment_id === segmentId)?.index || 0;
}

export function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

export function summarizeText(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function makeId(prefix, index) {
  return `${prefix}_${String(index + 1).padStart(3, "0")}`;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

export function svgEl(name, attrs) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

export function drawSvgText(text, x, y, className) {
  const node = svgEl("text", { x, y, class: className });
  node.textContent = text;
  els.spaceGraph.appendChild(node);
}

export function flashButton(button, text) {
  const previous = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

export function detectTitle(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim().split(/\n+/)[0]?.trim() || "Untitled";
}

export function titleFromFileName(fileName) {
  return String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
}
