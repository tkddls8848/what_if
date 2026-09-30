// Analysis: events. See doc/CODE_MAP.md for the call path.
import { makeId, unique, matchesAliases, summarizeText } from "./helpers.js";
import { buildRuntimeLexicon } from "./entities.js";
import { STATUS } from "../config.js";
import { annotateEntityIntervals, annotateRelationIntervals, annotateStateIntervals } from "../core/asof.js";
import { auditAnalysis } from "../core/audit.js";

function extractEvents(segments, characters, locations, documentId, dynamicLexicon = buildRuntimeLexicon(null)) {
  const events = [];
  segments.forEach((segment) => {
    splitSentences(segment.text).forEach((sentence, sentenceIndex) => {
      const type = inferEventType(sentence.text, dynamicLexicon);
      let characterIds = characters
        .filter((character) => character.status !== STATUS.REJECTED && matchesAliases(sentence.text, character.aliases, "character"))
        .map((character) => character.character_id);
      let locationIds = locations
        .filter((location) => location.status !== STATUS.REJECTED && matchesAliases(sentence.text, location.aliases, "location"))
        .map((location) => location.location_id);

      if (type !== "background" && !characterIds.length) {
        characterIds = characters
          .filter((character) => character.status !== STATUS.REJECTED && matchesAliases(segment.text, character.aliases, "character"))
          .map((character) => character.character_id);
      }

      if (type !== "background" && !locationIds.length) {
        locationIds = locations
          .filter((location) => location.status !== STATUS.REJECTED && matchesAliases(segment.text, location.aliases, "location"))
          .map((location) => location.location_id);
      }

      if (type === "background" && !characterIds.length && !locationIds.length) return;

      const confidence = Math.min(
        0.92,
        0.45 + (type === "background" ? 0 : 0.18) + characterIds.length * 0.07 + locationIds.length * 0.06
      );

      events.push({
        event_id: makeId("event", events.length),
        document_id: documentId,
        type: type === "background" && characterIds.length ? "appearance" : type,
        summary: summarizeText(sentence.text, 100),
        segment_id: segment.segment_id,
        scene_id: segment.scene_id,
        sentence_index: sentenceIndex,
        characters: unique(characterIds),
        locations: unique(locationIds),
        source_span: {
          char_start: segment.char_start + sentence.start,
          char_end: segment.char_start + sentence.end
        },
        status: STATUS.SUGGESTED,
        confidence,
        method: "event-lexicon"
      });
    });
  });
  return events;
}

function splitSentences(text) {
  const regex = /[^.!?。！？\n]+[.!?。！？…]*/g;
  const results = [];
  for (const match of text.matchAll(regex)) {
    const sentence = match[0].trim();
    if (!sentence) continue;
    const trimStart = match[0].indexOf(sentence);
    results.push({
      text: sentence,
      start: match.index + trimStart,
      end: match.index + trimStart + sentence.length
    });
  }
  return results.length ? results : [{ text, start: 0, end: text.length }];
}

function inferEventType(sentence, dynamicLexicon = buildRuntimeLexicon(null)) {
  const lexicon = dynamicLexicon || buildRuntimeLexicon(null);
  const hit = lexicon.eventTypes
    .map((entry) => ({ type: entry.type, score: entry.words.filter((word) => sentence.includes(word)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  return hit?.type || "background";
}

function buildCharacterStates(analysis) {
  const states = [];
  analysis.characters.forEach((character) => {
    let currentLocationId = "";
    let mentalState = "미정";
    let physicalState = "";
    const knownFacts = [];

    analysis.segments.forEach((segment) => {
      const segmentEvents = analysis.events.filter((event) =>
        event.segment_id === segment.segment_id &&
        event.status !== STATUS.REJECTED &&
        event.characters.includes(character.character_id)
      );
      const hasMention = analysis.mentions.some((mention) =>
        mention.entity_type === "character" &&
        mention.entity_id === character.character_id &&
        mention.segment_id === segment.segment_id &&
        mention.status !== STATUS.REJECTED
      );

      if (!segmentEvents.length && !hasMention) return;

      const explicitLocation = segmentEvents.flatMap((event) => event.locations)[0];
      if (explicitLocation) currentLocationId = explicitLocation;
      const stateHint = stateHintForCharacter(segmentEvents, character.character_id);
      mentalState = stateHint?.mental_state || inferMentalState(segment.text, mentalState, analysis.dynamic_lexicon, segmentEvents);
      physicalState = stateHint?.physical_state || inferPhysicalState(segment.text, physicalState, analysis.dynamic_lexicon, segmentEvents);
      knownFacts.push(...segmentEvents.map((event) => event.summary));

      states.push({
        state_id: makeId("state", states.length),
        character_id: character.character_id,
        segment_id: segment.segment_id,
        location_id: currentLocationId,
        mental_state: mentalState,
        physical_state: physicalState,
        known_facts: unique(knownFacts).slice(-5),
        source_event_ids: segmentEvents.map((event) => event.event_id),
        status: STATUS.SUGGESTED
      });
    });
  });
  return annotateStateIntervals(analysis, states);
}

function stateHintForCharacter(events, characterId) {
  return events
    .flatMap((event) => event.state_hints || [])
    .filter((hint) => hint.character_id === characterId)
    .find((hint) => hint.mental_state || hint.physical_state) || null;
}

function inferMentalState(text, fallback, dynamicLexicon = buildRuntimeLexicon(null), events = []) {
  const lexicon = dynamicLexicon || buildRuntimeLexicon(null);
  const hit = bestLexiconHit(text, lexicon.mentalStates, "state");
  if (hit) return hit;
  const eventTypes = new Set(events.map((event) => event.type));
  if (eventTypes.has("conflict")) return "긴장";
  if (eventTypes.has("realization")) return "각성";
  if (eventTypes.has("perception")) return "관찰";
  if (eventTypes.has("conversation")) return "대화 참여";
  if (eventTypes.has("symbolic")) return "상징적 동요";
  return fallback && fallback !== "미정" ? fallback : "상태 단서 부족";
}

function inferPhysicalState(text, fallback, dynamicLexicon = buildRuntimeLexicon(null), events = []) {
  const lexicon = dynamicLexicon || buildRuntimeLexicon(null);
  const hit = bestLexiconHit(text, lexicon.physicalStates, "state");
  if (hit) return hit;
  const eventTypes = new Set(events.map((event) => event.type));
  if (eventTypes.has("movement")) return "이동 중";
  if (eventTypes.has("stasis")) return "정지/체류";
  if (eventTypes.has("conflict")) return "긴장 상태";
  if (events.some((event) => event.locations.length)) return "장소에 머무름";
  return fallback || "신체 단서 부족";
}

function bestLexiconHit(text, entries, valueKey) {
  return entries
    .map((entry) => ({
      value: entry[valueKey],
      score: (entry.words || []).filter((word) => word && text.includes(word)).length
    }))
    .filter((entry) => entry.value && entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.value || "";
}

function buildRelations(analysis) {
  const relations = [];
  const addRelation = (sourceType, sourceId, targetType, targetId, relationType, eventId, segmentId) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const existing = relations.find((relation) =>
      relation.source_type === sourceType &&
      relation.source_id === sourceId &&
      relation.target_type === targetType &&
      relation.target_id === targetId &&
      relation.relation_type === relationType
    );
    if (existing) {
      existing.weight += 1;
      existing.event_ids = unique([...existing.event_ids, eventId]);
      existing.segment_ids = unique([...existing.segment_ids, segmentId]);
      return;
    }
    relations.push({
      relation_id: makeId("rel", relations.length),
      source_type: sourceType,
      source_id: sourceId,
      target_type: targetType,
      target_id: targetId,
      relation_type: relationType,
      event_ids: [eventId],
      segment_ids: [segmentId],
      weight: 1,
      status: STATUS.SUGGESTED
    });
  };

  analysis.events.filter((event) => event.status !== STATUS.REJECTED).forEach((event) => {
    event.characters.forEach((characterId) => {
      addRelation("character", characterId, "event", event.event_id, "participates_in", event.event_id, event.segment_id);
      event.locations.forEach((locationId) => {
        addRelation("character", characterId, "location", locationId, "appears_in", event.event_id, event.segment_id);
      });
    });
    event.locations.forEach((locationId) => {
      addRelation("event", event.event_id, "location", locationId, "takes_place_at", event.event_id, event.segment_id);
    });
  });

  return annotateRelationIntervals(analysis, relations);
}

/**
 * 검수 편집 이후 시간 구간과 제약 감사를 다시 계산한다.
 *
 * `buildCharacterStates`/`buildRelations`는 각자 자기 구간을 부여하지만, 인물·장소
 * 구간과 감사 결과는 문서 전체를 봐야 하므로 여기서 한 번에 갱신한다. 편집 경로가
 * 이 함수를 부르지 않으면 `/check` 배지와 진단이 옛 값으로 남는다.
 */
function refreshNarrativeTime(analysis) {
  if (!analysis) return analysis;
  annotateEntityIntervals(analysis);
  annotateStateIntervals(analysis, analysis.states || []);
  annotateRelationIntervals(analysis, analysis.relations || []);
  analysis.diagnostics = analysis.diagnostics || {};
  analysis.diagnostics.audit = auditAnalysis(analysis);
  return analysis;
}

export { buildCharacterStates, buildRelations, refreshNarrativeTime, extractEvents };
