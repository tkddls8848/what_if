import { state, STATUS } from "./context.js";
import { buildCharacterStates, buildRelations, refreshNarrativeTime, relinkEventsWithSegmentMentions } from "../analyzer.js";
import { segmentIndexOf } from "../core/asof.js";
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
  refreshNarrativeTime(state.analysis);
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
  refreshNarrativeTime(state.analysis);
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

function mergedCharacters(analysis, targetId, excludedSourceId = "") {
  return analysis.characters.filter((character) =>
    character.character_id !== excludedSourceId &&
    character.merge_record?.target_id === targetId
  );
}

function updateCharacterMentionMetadata(analysis, characterIds) {
  characterIds.forEach((characterId) => {
    const character = analysis.characters.find((item) => item.character_id === characterId);
    if (!character) return;
    const mentions = analysis.mentions
      .filter((mention) => mention.entity_type === "character" && mention.entity_id === characterId)
      .sort((a, b) =>
        segmentIndexOf(analysis, a.segment_id) - segmentIndexOf(analysis, b.segment_id) ||
        a.char_start - b.char_start
      );
    character.mentions = mentions.map((mention) => mention.mention_id);
    character.first_segment_id = mentions[0]?.segment_id || "";
  });
}

function refreshAfterCharacterEdit(analysis) {
  analysis.events = relinkEventsWithSegmentMentions(analysis.events, analysis);
  analysis.states = buildCharacterStates(analysis);
  analysis.relations = buildRelations(analysis);
  refreshNarrativeTime(analysis);
}

/**
 * 인물 병합의 데이터 변경. 원본 인물은 rejected 상태의 복구 기록으로 남기므로
 * `undoCharacterMerge()`가 mention과 사건 참조를 손실 없이 되돌릴 수 있다.
 */
export function applyCharacterMerge(analysis, sourceId, targetId) {
  if (!analysis || !sourceId || !targetId || sourceId === targetId) return null;
  const source = analysis.characters.find((item) => item.character_id === sourceId);
  const target = analysis.characters.find((item) => item.character_id === targetId);
  if (!source || !target || source.status === STATUS.REJECTED || target.status === STATUS.REJECTED) return null;
  if (source.merge_record || mergedCharacters(analysis, sourceId).length) return null;

  const existingRecords = mergedCharacters(analysis, targetId).map((character) => character.merge_record);
  const sourceMentionIds = analysis.mentions
    .filter((mention) => mention.entity_type === "character" && mention.entity_id === sourceId)
    .map((mention) => mention.mention_id);
  const sourceEventIds = [];
  const targetBaseEventIds = [];
  const stateHintIndexes = [];

  analysis.mentions.forEach((mention) => {
    if (mention.entity_type === "character" && mention.entity_id === sourceId) {
      mention.entity_id = targetId;
    }
  });

  analysis.events.forEach((event) => {
    const characters = event.characters || [];
    if (characters.includes(sourceId)) {
      sourceEventIds.push(event.event_id);
      const targetWasBaseParticipant = characters.includes(targetId) && (
        existingRecords.some((record) => record.target_base_event_ids?.includes(event.event_id)) ||
        !existingRecords.some((record) => record.source_event_ids?.includes(event.event_id))
      );
      if (targetWasBaseParticipant) targetBaseEventIds.push(event.event_id);
      event.characters = unique(characters.map((characterId) => characterId === sourceId ? targetId : characterId));
    }

    const indexes = [];
    (event.state_hints || []).forEach((hint, index) => {
      if (hint.character_id !== sourceId) return;
      hint.character_id = targetId;
      indexes.push(index);
    });
    if (indexes.length) stateHintIndexes.push({ event_id: event.event_id, indexes });
  });

  const targetAliases = target.aliases || [];
  const sourceAliases = unique([source.canonical_name, ...(source.aliases || [])]);
  const aliasesAdded = sourceAliases.filter((alias) => !targetAliases.includes(alias));
  const targetBaseStatus = existingRecords[0]?.target_base_status || target.status;
  target.aliases = unique([target.canonical_name, ...targetAliases, ...sourceAliases]);
  target.status = STATUS.EDITED;
  source.merge_record = {
    target_id: targetId,
    original_status: source.status,
    target_base_status: targetBaseStatus,
    source_mention_ids: sourceMentionIds,
    source_event_ids: sourceEventIds,
    target_base_event_ids: targetBaseEventIds,
    state_hint_indexes: stateHintIndexes,
    target_aliases_added: aliasesAdded
  };
  source.merged_into = targetId;
  source.status = STATUS.REJECTED;

  updateCharacterMentionMetadata(analysis, [sourceId, targetId]);
  refreshAfterCharacterEdit(analysis);
  return { source, target };
}

/** 잘못 확정한 병합 하나를 원본 인물 단위로 되돌린다. */
export function undoCharacterMerge(analysis, sourceId) {
  const source = analysis?.characters.find((item) => item.character_id === sourceId);
  const record = source?.merge_record;
  const target = record && analysis.characters.find((item) => item.character_id === record.target_id);
  if (!source || !record || !target) return null;

  const movedMentionIds = new Set(record.source_mention_ids || []);
  analysis.mentions.forEach((mention) => {
    if (movedMentionIds.has(mention.mention_id) && mention.entity_id === target.character_id) {
      mention.entity_id = sourceId;
    }
  });

  const remainingRecords = mergedCharacters(analysis, target.character_id, sourceId).map((character) => character.merge_record);
  const sourceEventIds = new Set(record.source_event_ids || []);
  const targetBaseEventIds = new Set(record.target_base_event_ids || []);
  analysis.events.forEach((event) => {
    if (sourceEventIds.has(event.event_id)) {
      event.characters = unique([...(event.characters || []), sourceId]);
      const targetStillParticipates = targetBaseEventIds.has(event.event_id) ||
        remainingRecords.some((other) => other.source_event_ids?.includes(event.event_id));
      if (!targetStillParticipates) {
        event.characters = event.characters.filter((characterId) => characterId !== target.character_id);
      }
    }
  });
  (record.state_hint_indexes || []).forEach(({ event_id: eventId, indexes }) => {
    const event = analysis.events.find((item) => item.event_id === eventId);
    indexes.forEach((index) => {
      if (event?.state_hints?.[index]?.character_id === target.character_id) {
        event.state_hints[index].character_id = sourceId;
      }
    });
  });

  const remainingAliasSources = mergedCharacters(analysis, target.character_id, sourceId)
    .flatMap((character) => [character.canonical_name, ...(character.aliases || [])]);
  const removableAliases = new Set(
    (record.target_aliases_added || []).filter((alias) => !remainingAliasSources.includes(alias))
  );
  target.aliases = (target.aliases || []).filter((alias) => !removableAliases.has(alias));
  source.status = record.original_status || STATUS.SUGGESTED;
  target.status = remainingRecords.length ? STATUS.EDITED : record.target_base_status || STATUS.SUGGESTED;
  delete source.merge_record;
  delete source.merged_into;

  updateCharacterMentionMetadata(analysis, [sourceId, target.character_id]);
  refreshAfterCharacterEdit(analysis);
  return { source, target };
}

export function mergeCharacter(sourceId, targetId) {
  const result = applyCharacterMerge(state.analysis, sourceId, targetId);
  if (!result) return false;
  state.selected = { kind: "character", id: targetId };
  renderAll();
  return true;
}

export function splitCharacter(sourceId) {
  const result = undoCharacterMerge(state.analysis, sourceId);
  if (!result) return false;
  state.selected = { kind: "character", id: sourceId };
  renderAll();
  return true;
}

export function statusButtons(kind, id) {
  return `
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.CONFIRMED}">확정</button>
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.EDITED}">수정</button>
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.REJECTED}">제외</button>
  `;
}
