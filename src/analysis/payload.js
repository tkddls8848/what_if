// Analysis: payload. See doc/CODE_MAP.md for the call path.
import { normalizeEventType, normalizeLocationType, cleanName, makeId, unique, aliasRegex, summarizeText, listFrom, expandAliasCandidates, stripKoreanParticle, normalizeLexiconId, clampConfidence } from "./helpers.js";
import { inferLocationTypeFromName, normalizeMentionReferences } from "./seeds.js";
import { buildCharacterStates, buildRelations, refreshNarrativeTime } from "./events.js";
import { STATUS } from "../config.js";

function applyOllamaPayload(analysis, payload, model) {
  const method = `ollama:${model}`;

  (payload.characters || []).forEach((item) => {
    const name = cleanName(item.name);
    if (!name) return;
    const aliases = unique([name, ...(item.aliases || []).map(cleanName)]);
    const mentions = findMentionsForAliases(analysis.segments, aliases, "character");
    if (!mentions.length) return;

    let character = findEntityByNames(analysis.characters, aliases, "character");
    if (!character) {
      const characterId = makeId("char", analysis.characters.length);
      mentions.forEach((mention) => {
        mention.entity_id = characterId;
        analysis.mentions.push(mention);
      });
      analysis.characters.push({
        character_id: characterId,
        canonical_name: name,
        aliases,
        mentions: [],
        first_segment_id: mentions[0].segment_id,
        description: item.description || "Ollama가 원문 근거로 제안한 인물 후보입니다.",
        role: item.role || "인물 후보",
        status: STATUS.SUGGESTED,
        confidence: 0.72,
        method
      });
      return;
    }

    character.aliases = unique([...(character.aliases || []), ...aliases]);
    character.description = character.description || item.description || "";
    character.role = character.role || item.role || "";
    character.confidence = Math.max(character.confidence || 0, 0.72);
  });

  (payload.locations || []).forEach((item) => {
    const name = cleanName(item.name);
    if (!name) return;
    const aliases = unique([name, ...(item.aliases || []).map(cleanName)]);
    const mentions = findMentionsForAliases(analysis.segments, aliases, "location");
    if (!mentions.length) return;

    let location = findEntityByNames(analysis.locations, aliases, "location");
    if (!location) {
      const locationId = makeId("loc", analysis.locations.length);
      mentions.forEach((mention) => {
        mention.entity_id = locationId;
        analysis.mentions.push(mention);
      });
      analysis.locations.push({
        location_id: locationId,
        name,
        aliases,
        mentions: [],
        first_segment_id: mentions[0].segment_id,
        type: normalizeLocationType(item.type),
        parent_name: "",
        parent_location_id: "",
        description: item.description || "Ollama가 원문 근거로 제안한 장소 후보입니다.",
        narrative_coords: null,
        status: STATUS.SUGGESTED,
        confidence: 0.72,
        method
      });
      return;
    }

    location.aliases = unique([...(location.aliases || []), ...aliases]);
    location.description = location.description || item.description || "";
    location.confidence = Math.max(location.confidence || 0, 0.72);
  });

  normalizeMentionReferences(analysis.characters, analysis.locations, analysis.mentions);

  normalizePayloadEvents(payload).forEach((item) => {
    const summary = summarizeText(item.summary || item.evidence || "", 100);
    if (!summary) return;
    const quoteMatch = findQuoteInSegments(analysis.segments, item.evidence || summary);
    let segment = quoteMatch?.segment || null;
    const span = quoteMatch
      ? { char_start: quoteMatch.char_start, char_end: quoteMatch.char_end }
      : null;
    const resolved = resolveOllamaEventLinks(analysis, item, segment, span, method);
    const relatedCharacters = resolved.characters;
    const relatedLocations = resolved.locations;
    if (!segment) segment = firstRelatedSegment(analysis, relatedCharacters, relatedLocations);
    if (!segment && (relatedCharacters.length || relatedLocations.length)) {
      const firstMention = analysis.mentions.find((mention) =>
        relatedCharacters.includes(mention.entity_id) ||
        relatedLocations.includes(mention.entity_id)
      );
      segment = analysis.segments.find((candidate) => candidate.segment_id === firstMention?.segment_id) || null;
    }
    if (!segment && !relatedCharacters.length && !relatedLocations.length) return;
    if (!segment) return;
    const eventSpan = span || { char_start: segment.char_start, char_end: Math.min(segment.char_end, segment.char_start + segment.text.length) };

    const duplicate = analysis.events.some((event) =>
      event.segment_id === segment.segment_id &&
      event.summary === summary &&
      event.method === method
    );
    if (duplicate) return;

    analysis.events.push({
      event_id: makeId("event", analysis.events.length),
      document_id: analysis.document.document_id,
      type: normalizeEventType(item.type),
      summary,
      segment_id: segment.segment_id,
      scene_id: segment.scene_id,
      sentence_index: 0,
      characters: relatedCharacters,
      locations: relatedLocations,
      state_hints: [],
      event_frame: item.event_frame || null,
      source_span: eventSpan,
      status: STATUS.SUGGESTED,
      confidence: clampConfidence(item.confidence, 0.7),
      method
    });
  });

  normalizeMentionReferences(analysis.characters, analysis.locations, analysis.mentions);
  analysis.events = relinkEventsWithSegmentMentions(analysis.events, analysis);
  applyPayloadStateChangesToEvents(analysis, payload, method);
  analysis.states = buildCharacterStates(analysis);
  analysis.relations = buildRelations(analysis);
  applyPayloadRelationships(analysis, payload, method);
  refreshNarrativeTime(analysis);
  analysis.diagnostics.ollama = { model, applied: true };
  analysis.diagnostics.counts = {
    segments: analysis.segments.length,
    scenes: analysis.scenes.length,
    mentions: analysis.mentions.length,
    characters: analysis.characters.length,
    locations: analysis.locations.length,
    events: analysis.events.length,
    relations: analysis.relations.length
  };
}

function normalizePayloadEvents(payload) {
  return (payload.event_frames || []).map((frame) => {
    const summary = cleanName(frame.summary);
    return {
      type: frame.type || "background",
      summary,
      characters: listFrom(frame.who),
      locations: listFrom(frame.where),
      evidence: frame.evidence,
      confidence: frame.confidence,
      event_frame: {
        frame_id: frame.id || "",
        label: cleanName(frame.label || ""),
        who: listFrom(frame.who),
        where: listFrom(frame.where),
        what_happened: cleanName(frame.what_happened || ""),
        result: cleanName(frame.result || "")
      }
    };
  }).filter((event) => event.summary);
}

function resolveOllamaEventLinks(analysis, item, segment, span, method) {
  const characters = resolvePayloadEntityNames(analysis, listFrom(item.characters), "character", segment, method);
  const locations = resolvePayloadEntityNames(analysis, listFrom(item.locations), "location", segment, method);
  const scopedMentions = mentionsInScope(analysis, segment, span);

  return {
    characters: unique([
      ...characters,
      ...scopedMentions
        .filter((mention) => mention.entity_type === "character")
        .map((mention) => mention.entity_id)
    ]),
    locations: unique([
      ...locations,
      ...scopedMentions
        .filter((mention) => mention.entity_type === "location")
        .map((mention) => mention.entity_id)
    ])
  };
}

function resolvePayloadEntityNames(analysis, names, kind, segment, method) {
  return unique(names.map(cleanName).filter(Boolean).map((name) => {
    const existing = findEntityByNames(kind === "character" ? analysis.characters : analysis.locations, [name], kind);
    if (existing) return kind === "character" ? existing.character_id : existing.location_id;
    const aliases = expandAliasCandidates([name]);
    const mentions = findMentionsForAliases(analysis.segments, aliases, kind);
    if (!mentions.length && !segment) return "";
    return createOllamaEntityFromName(analysis, kind, name, aliases, mentions, segment, method);
  }));
}

function createOllamaEntityFromName(analysis, kind, name, aliases, mentions, segment, method) {
  if (kind === "character") {
    const characterId = makeId("char", analysis.characters.length);
    mentions.forEach((mention) => {
      mention.entity_id = characterId;
      analysis.mentions.push(mention);
    });
    analysis.characters.push({
      character_id: characterId,
      canonical_name: name,
      aliases: unique(aliases),
      mentions: [],
      first_segment_id: mentions[0]?.segment_id || segment?.segment_id || analysis.segments[0]?.segment_id || "",
      description: "Ollama 사건 연결에서 생성한 인물 후보입니다.",
      role: "사건 참여 인물 후보",
      status: STATUS.SUGGESTED,
      confidence: mentions.length ? 0.68 : 0.54,
      method
    });
    return characterId;
  }

  const locationId = makeId("loc", analysis.locations.length);
  mentions.forEach((mention) => {
    mention.entity_id = locationId;
    analysis.mentions.push(mention);
  });
  analysis.locations.push({
    location_id: locationId,
    name,
    aliases: unique(aliases),
    mentions: [],
    first_segment_id: mentions[0]?.segment_id || segment?.segment_id || analysis.segments[0]?.segment_id || "",
    type: inferLocationTypeFromName(name),
    parent_name: "",
    parent_location_id: "",
    description: "Ollama 사건 연결에서 생성한 장소 후보입니다.",
    narrative_coords: null,
    status: STATUS.SUGGESTED,
    confidence: mentions.length ? 0.68 : 0.54,
    method
  });
  return locationId;
}

function mentionsInScope(analysis, segment, span) {
  if (!segment) return [];
  return analysis.mentions.filter((mention) => {
    if (mention.status === STATUS.REJECTED || mention.segment_id !== segment.segment_id) return false;
    if (!span) return true;
    return mention.char_start < span.char_end && mention.char_end > span.char_start;
  });
}

function relinkEventsWithSegmentMentions(events, analysis) {
  return events.map((event) => {
    if (event.characters.length && event.locations.length) return event;
    const segment = analysis.segments.find((item) => item.segment_id === event.segment_id);
    const scopedMentions = mentionsInScope(analysis, segment, event.source_span);
    const segmentMentions = scopedMentions.length ? scopedMentions : mentionsInScope(analysis, segment, null);
    const mentionedCharacters = segmentMentions
      .filter((mention) => mention.entity_type === "character")
      .map((mention) => mention.entity_id);
    const mentionedLocations = segmentMentions
      .filter((mention) => mention.entity_type === "location")
      .map((mention) => mention.entity_id);
    return {
      ...event,
      characters: event.characters.length ? event.characters : unique(mentionedCharacters),
      locations: event.locations.length ? event.locations : unique(mentionedLocations)
    };
  });
}

function findMentionsForAliases(segments, aliases, entityType) {
  const mentions = [];
  segments.forEach((segment) => {
    aliases.forEach((alias) => {
      if (!alias || alias.length < 2) return;
      for (const match of segment.text.matchAll(aliasRegex(alias, entityType, "gu"))) {
        mentions.push({
          mention_id: makeId("mention", mentions.length),
          entity_type: entityType,
          entity_id: "",
          text: match[0],
          segment_id: segment.segment_id,
          char_start: segment.char_start + match.index,
          char_end: segment.char_start + match.index + match[0].length,
          status: STATUS.SUGGESTED,
          confidence: 0.72,
          method: "ollama-evidence"
        });
      }
    });
  });
  return mentions.sort((a, b) => a.char_start - b.char_start).slice(0, 30);
}

function findEntityByNames(entities, names, kind) {
  const wanted = new Set(names
    .flatMap((name) => expandAliasCandidates([name]))
    .map(normalizeEntityNameKey)
    .filter(Boolean));
  return entities.find((entity) => {
    const entityNames = kind === "character"
      ? [entity.canonical_name, ...(entity.aliases || [])]
      : [entity.name, ...(entity.aliases || [])];
    return entityNames.some((name) => expandAliasCandidates([name]).some((alias) => {
      const key = normalizeEntityNameKey(alias);
      if (!key) return false;
      if (wanted.has(key)) return true;
      return Array.from(wanted).some((candidate) =>
        candidate.length >= 2 &&
        key.length >= 2 &&
        (candidate.includes(key) || key.includes(candidate))
      );
    }));
  });
}

function normalizeEntityNameKey(value) {
  return stripKoreanParticle(value).replace(/\s+/g, "").toLowerCase();
}

function findQuoteInSegments(segments, quote) {
  const cleaned = String(quote || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 4) return null;
  for (const segment of segments) {
    const index = segment.text.indexOf(cleaned);
    if (index >= 0) {
      return {
        segment,
        char_start: segment.char_start + index,
        char_end: segment.char_start + index + cleaned.length
      };
    }
  }
  return null;
}

function firstRelatedSegment(analysis, characterIds, locationIds) {
  const mention = analysis.mentions.find((item) =>
    (item.entity_type === "character" && characterIds.includes(item.entity_id)) ||
    (item.entity_type === "location" && locationIds.includes(item.entity_id))
  );
  return mention ? analysis.segments.find((segment) => segment.segment_id === mention.segment_id) : null;
}

function applyPayloadStateChangesToEvents(analysis, payload, method) {
  const changes = payload.state_changes || [];
  changes.forEach((change) => {
    const characterName = cleanName(change.character);
    const character = characterName ? findEntityByNames(analysis.characters, [characterName], "character") : null;
    if (!character) return;

    const event = findEventByPayloadReference(analysis, change.trigger_event || change.evidence);
    if (!event) return;

    const after = typeof change.after === "object" && change.after ? change.after : {};
    const hint = {
      character_id: character.character_id,
      mental_state: cleanName(after.mental_state),
      physical_state: cleanName(after.physical_state),
      evidence: cleanName(change.evidence || ""),
      method
    };
    if (hint.mental_state || hint.physical_state) {
      event.state_hints = [...(event.state_hints || []), hint];
    }

    const locationName = cleanName(after.location);
    if (locationName) {
      const locationIds = resolvePayloadEntityNames(analysis, [locationName], "location", analysis.segments.find((segment) => segment.segment_id === event.segment_id), method);
      event.locations = unique([...(event.locations || []), ...locationIds]);
    }

    event.state_changes = [...(event.state_changes || []), {
      character_id: character.character_id,
      before: change.before || {},
      after,
      evidence: cleanName(change.evidence || ""),
      confidence: change.confidence || "explicit"
    }];
  });
}

function applyPayloadRelationships(analysis, payload, method) {
  const relationships = payload.relationships || [];
  relationships.forEach((relationship) => {
    const sourceType = normalizeNodeType(relationship.source_type);
    const targetType = normalizeNodeType(relationship.target_type);
    const relationType = normalizeSchemaRelationType(sourceType, targetType, relationship.type);
    if (!sourceType || !targetType || !relationType) return;

    const source = resolvePayloadNode(analysis, sourceType, relationship.source, relationship.evidence, method);
    const target = resolvePayloadNode(analysis, targetType, relationship.target, relationship.evidence, method);
    if (!source || !target) return;

    const event = findEventByPayloadReference(analysis, relationship.event || relationship.evidence || relationship.target || relationship.source);
    upsertRelation(analysis.relations, {
      source_type: sourceType,
      source_id: source.id,
      target_type: targetType,
      target_id: target.id,
      relation_type: relationType,
      event_id: event?.event_id || "",
      segment_id: event?.segment_id || source.segment_id || target.segment_id || "",
      evidence: cleanName(relationship.evidence || ""),
      label: cleanName(relationship.label || ""),
      confidence: relationConfidence(relationship.confidence),
      method
    });
  });
}

function resolvePayloadNode(analysis, type, name, evidence, method) {
  const cleaned = cleanName(name);
  if (!cleaned) return null;
  if (type === "character") {
    const existing = findEntityByNames(analysis.characters, [cleaned], "character");
    if (existing) return { id: existing.character_id, segment_id: existing.first_segment_id || "" };
    const quoteMatch = findQuoteInSegments(analysis.segments, evidence || cleaned);
    const id = createOllamaEntityFromName(analysis, "character", cleaned, expandAliasCandidates([cleaned]), [], quoteMatch?.segment, method);
    return id ? { id, segment_id: quoteMatch?.segment?.segment_id || "" } : null;
  }
  if (type === "location") {
    const existing = findEntityByNames(analysis.locations, [cleaned], "location");
    if (existing) return { id: existing.location_id, segment_id: existing.first_segment_id || "" };
    const quoteMatch = findQuoteInSegments(analysis.segments, evidence || cleaned);
    const id = createOllamaEntityFromName(analysis, "location", cleaned, expandAliasCandidates([cleaned]), [], quoteMatch?.segment, method);
    return id ? { id, segment_id: quoteMatch?.segment?.segment_id || "" } : null;
  }
  if (type === "event") {
    const event = findEventByPayloadReference(analysis, cleaned) || findEventByPayloadReference(analysis, evidence);
    return event ? { id: event.event_id, segment_id: event.segment_id } : null;
  }
  return null;
}

function findEventByPayloadReference(analysis, reference) {
  const cleaned = cleanName(reference);
  if (!cleaned) return null;
  const quoteMatch = findQuoteInSegments(analysis.segments, cleaned);
  if (quoteMatch) {
    const segmentEvent = analysis.events.find((event) =>
      event.segment_id === quoteMatch.segment.segment_id &&
      event.source_span?.char_start <= quoteMatch.char_end &&
      event.source_span?.char_end >= quoteMatch.char_start
    );
    if (segmentEvent) return segmentEvent;
    return analysis.events.find((event) => event.segment_id === quoteMatch.segment.segment_id) || null;
  }
  const key = normalizeEntityNameKey(cleaned);
  return analysis.events.find((event) => {
    const fields = [
      event.summary,
      event.event_frame?.frame_id,
      event.event_frame?.what_happened,
      event.event_frame?.result
    ].map(normalizeEntityNameKey).filter(Boolean);
    return fields.some((field) => field.includes(key) || key.includes(field));
  }) || null;
}

function normalizeNodeType(type) {
  const normalized = String(type || "").trim();
  return ["character", "event", "location"].includes(normalized) ? normalized : "";
}

function normalizeSchemaRelationType(sourceType, targetType, relationType) {
  const type = normalizeLexiconId(relationType);
  const schema = {
    "character:character": ["knows", "family_of", "ally_of", "enemy_of", "protects", "threatens", "depends_on", "suspects", "loves", "hides_from", "changes_attitude_to", "speaks_to"],
    "character:event": ["participates_in", "caused", "witnessed", "affected_by", "investigated", "escaped_from"],
    "event:event": ["caused_by", "leads_to", "happens_before", "happens_after", "reveals", "contradicts"],
    "character:location": ["appears_in", "located_at", "came_from", "went_to", "trapped_at", "owns"],
    "event:location": ["takes_place_at"]
  };
  return schema[`${sourceType}:${targetType}`]?.includes(type) ? type : "";
}

function relationConfidence(value) {
  if (typeof value === "number") return clampConfidence(value, 0.7);
  const normalized = String(value || "").toLowerCase();
  if (normalized === "weak") return 0.45;
  if (normalized === "inferred") return 0.6;
  return 0.78;
}

function upsertRelation(relations, input) {
  if (!input.source_id || !input.target_id || input.source_id === input.target_id) return;
  const existing = relations.find((relation) =>
    relation.source_type === input.source_type &&
    relation.source_id === input.source_id &&
    relation.target_type === input.target_type &&
    relation.target_id === input.target_id &&
    relation.relation_type === input.relation_type
  );
  if (existing) {
    existing.weight += 1;
    existing.event_ids = unique([...existing.event_ids, input.event_id].filter(Boolean));
    existing.segment_ids = unique([...existing.segment_ids, input.segment_id].filter(Boolean));
    existing.evidence = existing.evidence || input.evidence || "";
    existing.label = existing.label || input.label || "";
    existing.confidence = Math.max(existing.confidence || 0, input.confidence || 0);
    return;
  }
  relations.push({
    relation_id: makeId("rel", relations.length),
    source_type: input.source_type,
    source_id: input.source_id,
    target_type: input.target_type,
    target_id: input.target_id,
    relation_type: input.relation_type,
    event_ids: input.event_id ? [input.event_id] : [],
    segment_ids: input.segment_id ? [input.segment_id] : [],
    weight: 1,
    status: STATUS.SUGGESTED,
    evidence: input.evidence || "",
    label: input.label || "",
    confidence: input.confidence || 0.7,
    method: input.method || "relation-extraction"
  });
}

export { relinkEventsWithSegmentMentions, applyOllamaPayload };
