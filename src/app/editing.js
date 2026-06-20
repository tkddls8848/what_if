import { state, STATUS } from "./context.js";
import { buildCharacterStates, buildRelations, relinkEventsWithSegmentMentions } from "../analyzer.js";
import { renderAll } from "./views.js";
import { getEntity, makeId, unique } from "./utils.js";

export function addManualEvent() {
  if (!state.analysis) return;
  const segment = state.analysis.segments[state.currentSegment - 1];
  if (!segment) return;
  const summary = window.prompt("추가할 사건 요약을 입력하세요.");
  if (!summary) return;
  const event = {
    event_id: makeId("event", state.analysis.events.length),
    document_id: state.analysis.document.document_id,
    type: "background",
    summary,
    segment_id: segment.segment_id,
    scene_id: segment.scene_id,
    sentence_index: 0,
    characters: [],
    locations: [],
    source_span: { char_start: segment.char_start, char_end: Math.min(segment.char_end, segment.char_start + 120) },
    status: STATUS.MANUAL,
    confidence: 1,
    method: "manual"
  };
  state.analysis.events.push(event);
  state.analysis.events = relinkEventsWithSegmentMentions(state.analysis.events, state.analysis);
  state.analysis.states = buildCharacterStates(state.analysis);
  state.analysis.relations = buildRelations(state.analysis);
  state.selected = { kind: "event", id: event.event_id };
  renderAll();
}

export function setAnnotationStatus(kind, id, status) {
  const entity = getEntity(kind, id);
  if (!entity) return;
  entity.status = status;
  if (kind === "character" || kind === "location") {
    state.analysis.mentions.forEach((mention) => {
      if (mention.entity_type === kind && mention.entity_id === id) mention.status = status;
    });
  }
  state.analysis.states = buildCharacterStates(state.analysis);
  state.analysis.relations = buildRelations(state.analysis);
  renderAll();
}

export function editEntity(kind, id, field, value) {
  const entity = getEntity(kind, id);
  if (!entity) return;
  const previousName = entity.canonical_name || entity.name;
  if (field === "aliases_csv") {
    entity.aliases = unique(value.split(",").map((alias) => alias.trim()));
    if (entity.status === STATUS.SUGGESTED) entity.status = STATUS.EDITED;
    renderAll();
    return;
  }
  entity[field] = value;
  if (kind === "character" && field === "canonical_name") {
    entity.aliases = unique([value, ...(entity.aliases || [])]);
  }
  if (kind === "location" && field === "name") {
    entity.aliases = unique([value, ...(entity.aliases || [])]);
  }
  if (previousName !== value && entity.status === STATUS.SUGGESTED) entity.status = STATUS.EDITED;
  if (field === "description" && entity.status === STATUS.SUGGESTED) entity.status = STATUS.EDITED;
  renderAll();
}

export function statusButtons(kind, id) {
  return `
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.CONFIRMED}">확정</button>
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.EDITED}">수정</button>
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.REJECTED}">제외</button>
  `;
}
