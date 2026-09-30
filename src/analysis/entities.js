// Analysis: entities. See doc/CODE_MAP.md for the call path.
import { makeId, unique, aliasRegex } from "./helpers.js";
import { CHARACTER_SEEDS, LOCATION_SEEDS, EVENT_LEXICON, MENTAL_STATE_LEXICON, PHYSICAL_STATE_LEXICON, EVENT_LABELS, PERIOD_TERM_LEXICON, STATUS, CUSTOM_SAMPLE_ID } from "../config.js";

function extractCharacters(segments, sampleId, seedLexicon = null) {
  const characters = [];
  const mentions = [];
  const seedSource = seedLexicon
    ? seedLexicon.characters
    : CHARACTER_SEEDS.filter((seed) => seedApplies(seed, sampleId));

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

/**
 * 시대 용어 주석.
 *
 * 장면에 역사·문화 맥락을 붙이되 **서술은 만들지 않는다.** 만드는 것은 앵커(원문 span)와
 * 출처(외부 링크)뿐이고, `note`는 사람이 검수에서 채울 때까지 빈 채로 둔다. 자동 생성한
 * 역사 서술은 검증할 방법이 없고 틀린 맥락은 없는 맥락보다 나쁘다.
 *
 * 매칭은 별칭 단일 규칙(`aliasRegex`)을 그대로 쓴다. 용어도 조사가 붙으므로
 * (`경성역으로`) 여기서 규칙을 새로 쓰면 화면과 에이전트의 답이 갈라진다.
 * 조사 폭이 넓은 `location` 규칙을 쓴다 — 용어는 장소처럼 처격을 자주 받는다.
 *
 * 한 단락에서 같은 용어는 한 번만 단다. 주석은 읽기를 돕는 장치이므로 같은 낱말에
 * 표시가 여섯 개 붙으면 오히려 방해가 된다.
 */
function extractAnnotations(segments, documentId) {
  const annotations = [];
  segments.forEach((segment) => {
    PERIOD_TERM_LEXICON.forEach((entry) => {
      const hit = (entry.aliases || [])
        .map((alias) => segment.text.match(aliasRegex(alias, "location", "u")))
        .filter(Boolean)
        .sort((a, b) => a.index - b.index)[0];
      if (!hit) return;
      annotations.push({
        annotation_id: makeId("note", annotations.length),
        document_id: documentId,
        term: entry.term,
        category: entry.category,
        era: entry.era || "",
        segment_id: segment.segment_id,
        text: hit[0],
        char_start: segment.char_start + hit.index,
        char_end: segment.char_start + hit.index + hit[0].length,
        references: (entry.references || []).map((reference) => ({ ...reference })),
        note: "",
        status: STATUS.SUGGESTED,
        confidence: 0.8,
        method: "period-term-lexicon",
        valid_from: 0,
        valid_to: null
      });
    });
  });
  return annotations.sort((a, b) => a.char_start - b.char_start);
}

function findSeedMentions(segments, aliases, entityType, entityId) {
  const mentions = [];
  segments.forEach((segment) => {
    const segmentMentions = [];
    unique(aliases)
      .sort((a, b) => b.length - a.length)
      .forEach((alias) => {
      if (!alias || alias.length < 2) return;
      for (const match of segment.text.matchAll(aliasRegex(alias, entityType, "gu"))) {
        segmentMentions.push({
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
    segmentMentions
      .sort((a, b) => a.char_start - b.char_start || (b.char_end - b.char_start) - (a.char_end - a.char_start))
      .forEach((mention) => {
        const overlaps = mentions.some((existing) => existing.segment_id === mention.segment_id && existing.char_start < mention.char_end && mention.char_start < existing.char_end);
        if (!overlaps) mentions.push(mention);
      });
  });
  return mentions.sort((a, b) => a.char_start - b.char_start);
}

export { seedApplies, findSeedMentions, buildRuntimeLexicon, extractCharacters, extractLocations, extractAnnotations };
