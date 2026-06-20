/**
 * @module analyzer
 *
 * Pure novel-analysis core. Runtime-agnostic and DOM-free: it only consumes plain
 * text/payload objects and returns plain analysis objects. It must never touch the
 * browser (`window`, `document`, DOM `els`) or the view layer under `./app/`.
 *
 * BOUNDARY NOTE — intentional duplication:
 * The small text helpers below (`cleanName`, `unique`, `makeId`, `escapeRegExp`,
 * `includesAny`, `summarizeText`, `stripKoreanParticle`, ...) are deliberately kept
 * PRIVATE to this module and are NOT imported from `./app/utils.js`. `app/utils.js`
 * is the browser/view-layer toolkit and pulls in DOM state; importing it here would
 * couple the analysis core to the UI. The two sets share names by coincidence of
 * purpose, not by design — do not "deduplicate" them into a shared import.
 * If they ever need to be shared, extract a separate DOM-free `shared/text.js`.
 */
import {
  CHARACTER_SEEDS,
  LOCATION_SEEDS,
  EVENT_LEXICON,
  MENTAL_STATE_LEXICON,
  PHYSICAL_STATE_LEXICON,
  EVENT_LABELS,
  STATUS,
  CUSTOM_SAMPLE_ID
} from "./config.js";

export function buildDynamicSeedLexicon(payload, model) {
  const eventCharacterSeeds = collectPayloadEventNames(payload, "characters").map((name) => ({
    name,
    aliases: [name],
    role: "사건 참여 인물 후보",
    description: "Ollama 사건 후보에서 역추출한 인물 seed입니다."
  }));
  const eventLocationSeeds = collectPayloadEventNames(payload, "locations").map((name) => ({
    name,
    aliases: [name],
    type: "inferred",
    description: "Ollama 사건 후보에서 역추출한 장소 seed입니다."
  }));

  return {
    model,
    method: `ollama-dynamic-seed:${model}`,
    // The LLM already returns a curated entity list with evidence. Mark it authoritative
    // so downstream extraction trusts it and skips the rule-based particle/suffix
    // augmentation that would otherwise re-introduce common-noun noise.
    authoritative: true,
    characters: [...(payload.characters || []), ...eventCharacterSeeds].map((item) => {
      const name = cleanName(item.name);
      return {
        canonical_name: name,
        aliases: expandAliasCandidates([name, ...listFrom(item.aliases).map(cleanName)]),
        role: item.role || "인물 후보",
        description: item.description || "Ollama가 원문에서 추출한 동적 seed입니다.",
        confidence: clampConfidence(item.confidence, 0.72),
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((seed) => seed.canonical_name && seed.aliases.length),
    locations: [...(payload.locations || []), ...eventLocationSeeds].map((item) => {
      const name = cleanName(item.name);
      return {
        name,
        aliases: expandAliasCandidates([name, ...listFrom(item.aliases).map(cleanName)]),
        type: normalizeLocationType(item.type),
        description: item.description || "Ollama가 원문에서 추출한 동적 seed입니다.",
        confidence: clampConfidence(item.confidence, 0.72),
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((seed) => seed.name && seed.aliases.length),
    eventTypes: (payload.event_types || payload.eventTypes || []).map((item) => {
      const type = normalizeLexiconId(item.type || item.id || item.label);
      const label = cleanName(item.label || item.name || item.type);
      return {
        type,
        label: label || type,
        words: unique(listFrom(item.words).map(cleanName)),
        description: item.description || "",
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((entry) => entry.type && entry.words.length),
    mentalStates: (payload.mental_states || payload.mentalStates || payload.emotions || []).map((item) => {
      const stateName = cleanName(item.state || item.label || item.name);
      return {
        state: stateName,
        words: unique(listFrom(item.words).map(cleanName)),
        description: item.description || "",
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((entry) => entry.state && entry.words.length),
    physicalStates: (payload.physical_states || payload.physicalStates || []).map((item) => {
      const stateName = cleanName(item.state || item.label || item.name);
      return {
        state: stateName,
        words: unique(listFrom(item.words).map(cleanName)),
        description: item.description || "",
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((entry) => entry.state && entry.words.length)
  };
}

function collectPayloadEventNames(payload, field) {
  return unique([
    ...(payload.events || []).flatMap((event) => listFrom(event[field]).map(cleanName)),
    ...(payload.event_frames || payload.eventFrames || []).flatMap((frame) => {
      if (field === "characters") return listFrom(frame.who || frame.characters).map(cleanName);
      if (field === "locations") return listFrom(frame.where || frame.locations).map(cleanName);
      return [];
    }),
    ...(payload.relationships || []).flatMap((relationship) => {
      const names = [];
      if (field === "characters" && relationship.source_type === "character") names.push(relationship.source);
      if (field === "characters" && relationship.target_type === "character") names.push(relationship.target);
      if (field === "locations" && relationship.source_type === "location") names.push(relationship.source);
      if (field === "locations" && relationship.target_type === "location") names.push(relationship.target);
      return names.map(cleanName);
    }),
    ...(payload.state_changes || payload.stateChanges || []).map((change) => field === "characters" ? cleanName(change.character) : "")
  ]
    .filter(Boolean));
}

export function applyOllamaPayload(analysis, payload, model) {
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
      state_hints: normalizeOllamaStateHints(item, analysis, relatedCharacters),
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
  const legacyEvents = (payload.events || []).map((event) => ({
    ...event,
    characters: listFrom(event.characters),
    locations: listFrom(event.locations)
  }));
  const frameEvents = (payload.event_frames || payload.eventFrames || []).map((frame) => {
    const summary = cleanName(frame.summary || frame.what_happened || frame.result || frame.evidence);
    return {
      type: frame.type || "background",
      summary,
      characters: listFrom(frame.who || frame.characters),
      locations: listFrom(frame.where || frame.locations),
      character_states: [],
      evidence: frame.evidence || summary,
      confidence: frame.confidence,
      event_frame: {
        frame_id: frame.id || "",
        label: cleanName(frame.label || ""),
        who: listFrom(frame.who || frame.characters),
        where: listFrom(frame.where || frame.locations),
        when: cleanName(frame.when || ""),
        what_happened: cleanName(frame.what_happened || ""),
        why_relevant: cleanName(frame.why_relevant || frame.why || ""),
        result: cleanName(frame.result || "")
      }
    };
  });
  return [...legacyEvents, ...frameEvents].filter((event) => cleanName(event.summary || event.evidence));
}

function normalizeOllamaStateHints(item, analysis, relatedCharacters) {
  const rawHints = [
    ...listFrom(item.character_states || item.characterStates || item.states),
    ...(item.mental_state || item.emotion || item.physical_state
      ? [{
        character: listFrom(item.characters)[0] || "",
        mental_state: item.mental_state || item.emotion || "",
        physical_state: item.physical_state || ""
      }]
      : [])
  ];

  return rawHints.map((hint) => {
    if (typeof hint === "string") {
      return {
        character_id: relatedCharacters[0] || "",
        mental_state: cleanName(hint),
        physical_state: "",
        evidence: ""
      };
    }
    const characterName = cleanName(hint.character || hint.name || hint.character_name);
    const character = characterName
      ? findEntityByNames(analysis.characters, [characterName], "character")
      : null;
    return {
      character_id: character?.character_id || relatedCharacters[0] || "",
      mental_state: cleanName(hint.mental_state || hint.emotion || hint.feeling || hint.state),
      physical_state: cleanName(hint.physical_state || hint.body_state || ""),
      evidence: cleanName(hint.evidence || "")
    };
  }).filter((hint) => hint.character_id && (hint.mental_state || hint.physical_state));
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

export function relinkEventsWithSegmentMentions(events, analysis) {
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
      const regex = new RegExp(escapeRegExp(alias), "g");
      for (const match of segment.text.matchAll(regex)) {
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
  const changes = payload.state_changes || payload.stateChanges || [];
  changes.forEach((change) => {
    const characterName = cleanName(change.character || change.name);
    const character = characterName ? findEntityByNames(analysis.characters, [characterName], "character") : null;
    if (!character) return;

    const event = findEventByPayloadReference(analysis, change.trigger_event || change.event || change.evidence);
    if (!event) return;

    const after = typeof change.after === "object" && change.after ? change.after : {};
    const hint = {
      character_id: character.character_id,
      mental_state: cleanName(after.mental_state || after.emotional_state || after.emotion || change.mental_state || change.emotion),
      physical_state: cleanName(after.physical_state || after.body_state || change.physical_state),
      evidence: cleanName(change.evidence || ""),
      method
    };
    if (hint.mental_state || hint.physical_state) {
      event.state_hints = [...(event.state_hints || []), hint];
    }

    const locationName = cleanName(after.location || change.location);
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
  const relationships = payload.relationships || payload.relations || [];
  relationships.forEach((relationship) => {
    const sourceType = normalizeNodeType(relationship.source_type || relationship.sourceType);
    const targetType = normalizeNodeType(relationship.target_type || relationship.targetType);
    const relationType = normalizeSchemaRelationType(sourceType, targetType, relationship.type || relationship.relation_type);
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
  const normalized = String(type || "").toLowerCase().trim();
  if (["character", "person", "인물"].includes(normalized)) return "character";
  if (["event", "사건"].includes(normalized)) return "event";
  if (["location", "place", "장소"].includes(normalized)) return "location";
  return "";
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

function normalizeEventType(type) {
  return EVENT_LABELS[type] ? type : normalizeLexiconId(type || "background");
}

function normalizeLocationType(type) {
  const allowed = new Set(["residential", "interior", "threshold", "exterior", "public", "symbolic", "inferred"]);
  return allowed.has(type) ? type : "inferred";
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function makeId(prefix, index) {
  return `${prefix}_${String(index + 1).padStart(3, "0")}`;
}

function unique(values) {
  return Array.from(new Set((values || []).filter((value) => value !== undefined && value !== null && value !== "")));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesAny(text, values) {
  const source = String(text || "");
  return (values || []).some((value) => value && source.includes(value));
}

function summarizeText(text, limit = 100) {
  const cleaned = cleanName(text);
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[,;|]/g).map((item) => item.trim()).filter(Boolean);
  return [];
}

function expandAliasCandidates(values) {
  const aliases = [];
  values.map(cleanName).filter(Boolean).forEach((value) => {
    aliases.push(value);
    aliases.push(stripKoreanParticle(value));
    aliases.push(value.replace(/\s+/g, ""));
  });
  return unique(aliases.filter((alias) => alias.length >= 2));
}

function stripKoreanParticle(value) {
  return cleanName(value).replace(/(은|는|이|가|을|를|에게|와|과|도|의|으로|로|에서|에게서|께서|부터|까지|만)$/u, "");
}

function normalizeLexiconId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const ascii = raw.replace(/[^a-z0-9_ -]/g, "").replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
  if (ascii) return ascii;
  return `dynamic_${hashString(raw).slice(0, 8)}`;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function clampConfidence(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

export function analyzeNovel(input) {
  const normalized = normalizeText(input.text);
  const document = {
    document_id: "doc_001",
    sample_id: input.sample?.id || "",
    title: input.title || "Untitled",
    author: input.sample?.author || "",
    publication_year: input.sample?.year || "",
    language: input.language || "ko",
    source: input.source || "manual",
    source_url: input.sample?.source_url || "",
    rights: input.sample?.rights || "",
    created_at: new Date().toISOString()
  };

  const segments = buildSegments(normalized, document.document_id);
  const scenes = buildScenes(segments, document.document_id);
  const hasStaticSeeds = hasStaticSampleSeeds(document.sample_id);
  const browserSeedLexicon = buildDocumentSeedLexicon(segments, input.seedLexicon?.model || "browser");
  const seedLexicon = input.seedLexicon
    ? mergeSeedLexicons(input.seedLexicon, browserSeedLexicon)
    : hasStaticSeeds
      ? null
      : browserSeedLexicon;
  const characterPass = extractCharacters(segments, document.sample_id, seedLexicon);
  const locationPass = extractLocations(segments, document.sample_id, seedLexicon);
  const mentions = [...characterPass.mentions, ...locationPass.mentions];
  normalizeMentionReferences(characterPass.characters, locationPass.locations, mentions);
  const dynamicLexicon = buildRuntimeLexicon(seedLexicon);
  const events = extractEvents(segments, characterPass.characters, locationPass.locations, document.document_id, dynamicLexicon);
  const analysis = {
    document,
    segments,
    scenes,
    mentions,
    characters: characterPass.characters,
    locations: locationPass.locations,
    events,
    states: [],
    relations: [],
    dynamic_lexicon: dynamicLexicon,
    diagnostics: {
      engine: input.engine || "rule-based-ko-adapter",
      model_reference: "BookNLP-style schema",
      seed_lexicon: seedLexicon ? {
        method: seedLexicon.method,
        model: seedLexicon.model,
        characters: seedLexicon.characters.length,
        locations: seedLexicon.locations.length,
        event_types: seedLexicon.eventTypes?.length || 0,
        mental_states: seedLexicon.mentalStates?.length || 0,
        physical_states: seedLexicon.physicalStates?.length || 0
      } : {
        method: "static-sample-seed-or-pattern",
        model: "",
        characters: 0,
        locations: 0
      },
      warnings: [
        seedLexicon
          ? `${seedLexicon.method} 기반으로 문서별 seed lexicon을 생성했습니다. 모든 항목은 suggested 상태이며 검수 화면에서 확인해야 합니다.`
          : "현재 엔진은 규칙 기반입니다. 공지시와 은유적 사건은 검수 화면에서 확인해야 합니다."
      ],
      counts: {}
    }
  };

  analysis.events = relinkEventsWithSegmentMentions(analysis.events, analysis);
  analysis.states = buildCharacterStates(analysis);
  analysis.relations = buildRelations(analysis);
  analysis.diagnostics.counts = {
    segments: segments.length,
    scenes: scenes.length,
    mentions: mentions.length,
    characters: analysis.characters.length,
    locations: analysis.locations.length,
    events: analysis.events.length,
    relations: analysis.relations.length
  };

  return analysis;
}

function hasStaticSampleSeeds(sampleId) {
  return CHARACTER_SEEDS.some((seed) => seedApplies(seed, sampleId)) ||
    LOCATION_SEEDS.some((seed) => seedApplies(seed, sampleId));
}

function buildDocumentSeedLexicon(segments, model = "browser") {
  const fullText = segments.map((segment) => segment.text).join("\n");
  const method = model === "browser" ? "browser-dynamic-seed" : `browser-fallback-seed:${model}`;
  const characters = buildDocumentCharacterSeeds(segments, fullText, method);
  const locations = buildDocumentLocationSeeds(segments, method);
  return {
    model,
    method,
    characters,
    locations,
    eventTypes: buildDocumentLexiconSubset(EVENT_LEXICON.map((entry) => ({
      ...entry,
      label: EVENT_LABELS[entry.type] || entry.type
    })), fullText, "type"),
    mentalStates: buildDocumentLexiconSubset(MENTAL_STATE_LEXICON, fullText, "state"),
    physicalStates: buildDocumentLexiconSubset(PHYSICAL_STATE_LEXICON, fullText, "state")
  };
}

function buildDocumentCharacterSeeds(segments, fullText, method) {
  const stopNames = new Set([
    "나는", "내가", "나를", "우리", "그들", "그것", "이것", "저것", "사람", "생활", "생각", "원문",
    "장소", "사건", "마음", "시간", "오늘", "어제", "내일", "모두", "무엇", "어디", "누구"
  ]);
  const counts = new Map();

  const addName = (name, count = 1) => {
    const cleaned = stripKoreanParticle(name);
    if (cleaned.length < 2 || cleaned.length > 8 || stopNames.has(cleaned)) return;
    counts.set(cleaned, (counts.get(cleaned) || 0) + count);
  };

  if (/(^|[^가-힣])(나|내가|나는|나를|나의)([^가-힣]|$)/.test(fullText)) {
    addName("나", 3);
  }

  // Korean-aware boundary: the particle must NOT be followed by another Hangul syllable
  // (which would mean it is mid-word, e.g. the 의 in "의자"). `\b` does not work here
  // because Korean particle chars are not \w, so `\b` never holds after them.
  const particlePattern = /([가-힣]{2,8})(?:은|는|이|가|을|를|에게|와|과|도|의|께서|에게서)(?![가-힣])/g;
  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(particlePattern)) addName(match[1]);
  });

  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([name, count]) => ({
      canonical_name: name,
      aliases: expandAliasCandidates([name, ...koreanCaseAliases(name)]),
      role: name === "나" ? "화자 후보" : "인물 후보",
      description: `문서 반복 출현 패턴으로 생성한 인물 seed입니다. 감지 ${count}회.`,
      confidence: name === "나" ? 0.68 : 0.5,
      method
    }));
}

function buildDocumentLocationSeeds(segments, method) {
  const counts = new Map();
  const pattern = /([가-힣A-Za-z0-9 ]{1,14}(?:방|집|거리|길|문|역|옥상|시장|골목|마당|학교|병원|정거장|백화점|도시|마을|강|산|바다|숲|들|밭|부엌|창고|가게|주막|다방|호텔|여관|궁|성))/g;
  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(pattern)) {
      const name = cleanName(match[1]);
      if (name.length < 2 || name.length > 14) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  });

  return Array.from(counts.entries())
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([name, count]) => ({
      name,
      aliases: expandAliasCandidates([name]),
      type: inferLocationTypeFromName(name),
      description: `장소 접미사 패턴으로 생성한 장소 seed입니다. 감지 ${count}회.`,
      confidence: count > 1 ? 0.56 : 0.44,
      method
    }));
}

function buildDocumentLexiconSubset(entries, text, key) {
  return entries
    .map((entry) => ({
      ...entry,
      words: unique((entry.words || []).filter((word) => word && text.includes(word)))
    }))
    .filter((entry) => entry.words.length)
    .map((entry) => ({
      ...entry,
      method: `browser-dynamic-${key}-lexicon`
    }));
}

function mergeSeedLexicons(primary, fallback) {
  // When the primary (LLM) seed is authoritative, trust its entity list and do NOT fold
  // in the browser particle/suffix heuristics for characters/locations — that is what was
  // polluting the LLM result with common nouns like "소리"/"얼굴". Classification lexicons
  // (event/mental/physical) are still merged because more trigger words only help tagging.
  const authoritative = Boolean(primary.authoritative);
  const characterFallback = authoritative ? [] : (fallback.characters || []);
  const locationFallback = authoritative ? [] : (fallback.locations || []);
  return {
    model: primary.model || fallback.model,
    method: `${primary.method}+${fallback.method}`,
    authoritative,
    characters: mergeSeedEntities(primary.characters || [], characterFallback, "character"),
    locations: mergeSeedEntities(primary.locations || [], locationFallback, "location"),
    eventTypes: mergeLexiconEntries(primary.eventTypes || [], fallback.eventTypes || [], EVENT_LEXICON.map((entry) => ({
      ...entry,
      label: EVENT_LABELS[entry.type] || entry.type,
      method: "static-event-lexicon"
    })), "type"),
    mentalStates: mergeLexiconEntries(primary.mentalStates || [], fallback.mentalStates || [], MENTAL_STATE_LEXICON.map((entry) => ({
      ...entry,
      method: "static-mental-state-lexicon"
    })), "state"),
    physicalStates: mergeLexiconEntries(primary.physicalStates || [], fallback.physicalStates || [], PHYSICAL_STATE_LEXICON.map((entry) => ({
      ...entry,
      method: "static-physical-state-lexicon"
    })), "state")
  };
}

function mergeSeedEntities(primary, fallback, kind) {
  const merged = new Map();
  [...fallback, ...primary].forEach((seed) => {
    const name = kind === "character" ? seed.canonical_name : seed.name;
    if (!name) return;
    const key = stripKoreanParticle(name).replace(/\s+/g, "");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...seed, aliases: unique(seed.aliases || []) });
      return;
    }
    existing.aliases = unique([...(existing.aliases || []), ...(seed.aliases || [])]);
    existing.description = seed.description || existing.description;
    existing.confidence = Math.max(existing.confidence || 0, seed.confidence || 0);
    existing.method = seed.method || existing.method;
  });
  return Array.from(merged.values());
}

function mergeLexiconEntries(...args) {
  const key = args.pop();
  const sources = args;
  const merged = new Map();
  sources.flat().forEach((entry) => {
    const id = entry[key];
    if (!id) return;
    if (!merged.has(id)) {
      merged.set(id, { ...entry, words: unique(entry.words || []) });
      return;
    }
    const existing = merged.get(id);
    existing.words = unique([...(existing.words || []), ...(entry.words || [])]);
    existing.label = existing.label || entry.label;
    existing.description = existing.description || entry.description;
  });
  return Array.from(merged.values()).filter((entry) => entry.words?.length);
}

function koreanCaseAliases(name) {
  return ["은", "는", "이", "가", "을", "를", "에게", "의", "와", "과"].map((particle) => `${name}${particle}`);
}

function inferLocationTypeFromName(name) {
  if (/(방|집|부엌|창고|호텔|여관|다방|가게|주막)$/u.test(name)) return "interior";
  if (/(문|골목)$/u.test(name)) return "threshold";
  if (/(거리|길|마당|강|산|바다|숲|들|밭)$/u.test(name)) return "exterior";
  if (/(역|시장|학교|병원|정거장|백화점|도시|마을|궁|성)$/u.test(name)) return "public";
  return "inferred";
}

function normalizeMentionReferences(characters, locations, mentions) {
  characters.forEach((character) => {
    character.mentions = [];
  });
  locations.forEach((location) => {
    location.mentions = [];
  });
  mentions.forEach((mention, index) => {
    mention.mention_id = makeId("mention", index);
    if (mention.entity_type === "character") {
      const character = characters.find((item) => item.character_id === mention.entity_id);
      character?.mentions.push(mention.mention_id);
    }
    if (mention.entity_type === "location") {
      const location = locations.find((item) => item.location_id === mention.entity_id);
      location?.mentions.push(mention.mention_id);
    }
  });
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+/g, " ")
    .trim();
}

function buildSegments(text, documentId) {
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean);
  let cursor = 0;
  return paragraphs.map((paragraph, index) => {
    const charStart = text.indexOf(paragraph, cursor);
    const charEnd = charStart + paragraph.length;
    cursor = charEnd;
    return {
      segment_id: makeId("seg", index),
      document_id: documentId,
      index: index + 1,
      scene_id: "",
      text: paragraph,
      char_start: charStart,
      char_end: charEnd
    };
  });
}

function buildScenes(segments, documentId) {
  const sceneSize = Math.max(1, Math.ceil(segments.length / Math.min(8, Math.max(1, segments.length))));
  const scenes = [];
  segments.forEach((segment, index) => {
    const sceneIndex = Math.floor(index / sceneSize);
    const sceneId = makeId("scene", sceneIndex);
    segment.scene_id = sceneId;
    if (!scenes[sceneIndex]) {
      scenes[sceneIndex] = {
        scene_id: sceneId,
        document_id: documentId,
        index: sceneIndex + 1,
        title: `Scene ${sceneIndex + 1}`,
        start_segment_id: segment.segment_id,
        end_segment_id: segment.segment_id,
        summary: ""
      };
    }
    scenes[sceneIndex].end_segment_id = segment.segment_id;
  });

  scenes.forEach((scene) => {
    const sceneSegments = segments.filter((segment) => segment.scene_id === scene.scene_id);
    scene.summary = summarizeText(sceneSegments.map((segment) => segment.text).join(" "), 110);
  });

  return scenes;
}

function extractCharacters(segments, sampleId, seedLexicon = null) {
  const characters = [];
  const mentions = [];
  const seedSource = seedLexicon
    ? seedLexicon.characters
    : CHARACTER_SEEDS.filter((seed) => seedApplies(seed, sampleId));
  const locationSeedSource = seedLexicon
    ? seedLexicon.locations
    : LOCATION_SEEDS.filter((location) => seedApplies(location, sampleId));

  seedSource.forEach((seed) => {
    const entityMentions = findSeedMentions(segments, seed.aliases, "character", "");
    if (!entityMentions.length) return;
    const characterId = makeId("char", characters.length);
    entityMentions.forEach((mention) => {
      mention.entity_id = characterId;
      mention.mention_id = makeId("mention", mentions.length);
      mentions.push(mention);
    });
    characters.push({
      character_id: characterId,
      canonical_name: seed.canonical_name,
      aliases: unique(seed.aliases),
      mentions: entityMentions.map((mention) => mention.mention_id),
      first_segment_id: entityMentions[0].segment_id,
      description: seed.description,
      role: seed.role,
      status: STATUS.SUGGESTED,
      confidence: seed.confidence || 0.88,
      method: seed.method || "seed-lexicon"
    });
  });

  // Authoritative LLM seed: trust its character list only, skip the noisy particle pass.
  if (seedLexicon?.authoritative) return { characters, mentions };

  const existingAliases = new Set(characters.flatMap((character) => character.aliases));
  const locationAliases = new Set(locationSeedSource.flatMap((location) => location.aliases));
  const stopNames = new Set(["나는", "내가", "아내", "방안", "대문", "거리", "사람", "생활", "생각", "여인", "원문", "가구", "그들", "이것", "그것"]);
  const candidates = new Map();
  const pattern = /([가-힣]{2,5})(?:은|는|이|가|을|를|에게|와|과|도|의)(?![가-힣])/g;

  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(pattern)) {
      const name = match[1];
      if (stopNames.has(name) || existingAliases.has(name) || locationAliases.has(name)) continue;
      if (!candidates.has(name)) candidates.set(name, []);
      candidates.get(name).push({
        text: name,
        segment_id: segment.segment_id,
        char_start: segment.char_start + match.index,
        char_end: segment.char_start + match.index + name.length
      });
    }
  });

  candidates.forEach((candidateMentions, name) => {
    if (candidateMentions.length < 2) return;
    const characterId = makeId("char", characters.length);
    candidateMentions.slice(0, 20).forEach((mention) => {
      mention.mention_id = makeId("mention", mentions.length);
      mention.entity_type = "character";
      mention.entity_id = characterId;
      mention.status = STATUS.SUGGESTED;
      mention.confidence = 0.48;
      mention.method = "korean-particle-pattern";
      mentions.push(mention);
    });
    characters.push({
      character_id: characterId,
      canonical_name: name,
      aliases: [name],
      mentions: candidateMentions.slice(0, 20).map((mention) => mention.mention_id),
      first_segment_id: candidateMentions[0].segment_id,
      description: "조사 패턴으로 발견된 인물 후보입니다.",
      role: "인물 후보",
      status: STATUS.SUGGESTED,
      confidence: 0.48,
      method: "korean-particle-pattern"
    });
  });

  return { characters, mentions };
}

function extractLocations(segments, sampleId, seedLexicon = null) {
  const locations = [];
  const mentions = [];
  const seedSource = seedLexicon
    ? seedLexicon.locations
    : LOCATION_SEEDS.filter((seed) => seedApplies(seed, sampleId));

  seedSource.forEach((seed) => {
    const entityMentions = findSeedMentions(segments, seed.aliases, "location", "");
    if (!entityMentions.length) return;
    const locationId = makeId("loc", locations.length);
    entityMentions.forEach((mention) => {
      mention.entity_id = locationId;
      mention.mention_id = makeId("mention", mentions.length);
      mentions.push(mention);
    });
    locations.push({
      location_id: locationId,
      name: seed.name,
      aliases: unique(seed.aliases),
      mentions: entityMentions.map((mention) => mention.mention_id),
      first_segment_id: entityMentions[0].segment_id,
      type: seed.type,
      parent_name: seed.parent || "",
      parent_location_id: "",
      description: seed.description,
      narrative_coords: seed.narrative_coords || null,
      status: STATUS.SUGGESTED,
      confidence: seed.confidence || 0.86,
      method: seed.method || "seed-lexicon"
    });
  });

  locations.forEach((location) => {
    if (!location.parent_name) return;
    const parent = locations.find((candidate) => candidate.name === location.parent_name);
    location.parent_location_id = parent?.location_id || "";
  });

  // Authoritative LLM seed: trust its location list only, skip the suffix-pattern pass.
  if (seedLexicon?.authoritative) return { locations, mentions };

  const existingAliases = new Set(locations.flatMap((location) => location.aliases));
  const candidates = new Map();
  const pattern = /([가-힣A-Za-z0-9 ]{1,12}(?:방|집|거리|길|문|역|옥상|시장|골목|마당|학교|병원|정거장|백화점|도시|마을))/g;

  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(pattern)) {
      const name = match[1].trim();
      if (name.length < 2 || existingAliases.has(name)) continue;
      if (!candidates.has(name)) candidates.set(name, []);
      candidates.get(name).push({
        text: name,
        segment_id: segment.segment_id,
        char_start: segment.char_start + match.index,
        char_end: segment.char_start + match.index + name.length
      });
    }
  });

  candidates.forEach((candidateMentions, name) => {
    if (candidateMentions.length < 2) return;
    const locationId = makeId("loc", locations.length);
    candidateMentions.slice(0, 20).forEach((mention) => {
      mention.mention_id = makeId("mention", mentions.length);
      mention.entity_type = "location";
      mention.entity_id = locationId;
      mention.status = STATUS.SUGGESTED;
      mention.confidence = 0.5;
      mention.method = "location-suffix-pattern";
      mentions.push(mention);
    });
    locations.push({
      location_id: locationId,
      name,
      aliases: [name],
      mentions: candidateMentions.slice(0, 20).map((mention) => mention.mention_id),
      first_segment_id: candidateMentions[0].segment_id,
      type: "inferred",
      parent_name: "",
      parent_location_id: "",
      description: "장소 접미사 패턴으로 발견된 장소 후보입니다.",
      narrative_coords: null,
      status: STATUS.SUGGESTED,
      confidence: 0.5,
      method: "location-suffix-pattern"
    });
  });

  return { locations, mentions };
}

function seedApplies(seed, sampleId) {
  if (sampleId === CUSTOM_SAMPLE_ID) return false;
  return !seed.sampleIds || seed.sampleIds.includes(sampleId);
}

function buildRuntimeLexicon(seedLexicon) {
  const eventTypes = seedLexicon?.eventTypes?.length
    ? seedLexicon.eventTypes
    : EVENT_LEXICON.map((entry) => ({
      type: entry.type,
      label: EVENT_LABELS[entry.type] || entry.type,
      words: entry.words,
      method: "static-event-lexicon"
    }));
  const mentalStates = seedLexicon?.mentalStates?.length
    ? seedLexicon.mentalStates
    : MENTAL_STATE_LEXICON.map((entry) => ({
      state: entry.state,
      words: entry.words,
      method: "static-mental-state-lexicon"
    }));
  const physicalStates = seedLexicon?.physicalStates?.length
    ? seedLexicon.physicalStates
    : PHYSICAL_STATE_LEXICON.map((entry) => ({
      state: entry.state,
      words: entry.words,
      method: "static-physical-state-lexicon"
    }));
  return { eventTypes, mentalStates, physicalStates };
}

function findSeedMentions(segments, aliases, entityType, entityId) {
  const mentions = [];
  segments.forEach((segment) => {
    aliases.forEach((alias) => {
      if (!alias || alias.length < 2) return;
      const escaped = escapeRegExp(alias);
      const regex = new RegExp(escaped, "g");
      for (const match of segment.text.matchAll(regex)) {
        mentions.push({
          mention_id: "",
          entity_type: entityType,
          entity_id: entityId,
          text: match[0],
          segment_id: segment.segment_id,
          char_start: segment.char_start + match.index,
          char_end: segment.char_start + match.index + match[0].length,
          status: STATUS.SUGGESTED,
          confidence: 0.86,
          method: "seed-lexicon"
        });
      }
    });
  });
  return mentions.sort((a, b) => a.char_start - b.char_start);
}

function extractEvents(segments, characters, locations, documentId, dynamicLexicon = buildRuntimeLexicon(null)) {
  const events = [];
  segments.forEach((segment) => {
    splitSentences(segment.text).forEach((sentence, sentenceIndex) => {
      const type = inferEventType(sentence.text, dynamicLexicon);
      let characterIds = characters
        .filter((character) => character.status !== STATUS.REJECTED && includesAny(sentence.text, character.aliases))
        .map((character) => character.character_id);
      let locationIds = locations
        .filter((location) => location.status !== STATUS.REJECTED && includesAny(sentence.text, location.aliases))
        .map((location) => location.location_id);

      if (type !== "background" && !characterIds.length) {
        characterIds = characters
          .filter((character) => character.status !== STATUS.REJECTED && includesAny(segment.text, character.aliases))
          .map((character) => character.character_id);
      }

      if (type !== "background" && !locationIds.length) {
        locationIds = locations
          .filter((location) => location.status !== STATUS.REJECTED && includesAny(segment.text, location.aliases))
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

export function buildCharacterStates(analysis) {
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
  return states;
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

export function buildRelations(analysis) {
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

  return relations;
}
