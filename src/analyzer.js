// Public analysis entry point; implementation is in src/analysis/.
import { hasStaticSampleSeeds, buildDocumentSeedLexicon, mergeSeedLexicons, normalizeMentionReferences } from "./analysis/seeds.js";
import { buildSegments, buildScenes } from "./analysis/segments.js";
import { extractCharacters, extractLocations, buildRuntimeLexicon, extractAnnotations } from "./analysis/entities.js";
import { extractDescriptionSpans } from "./analysis/descriptions.js";
import { extractEvents, buildCharacterStates, buildRelations, refreshNarrativeTime } from "./analysis/events.js";
import { relinkEventsWithSegmentMentions } from "./analysis/payload.js";
import { normalizeSourceText } from "./core/text.js";

function analyzeNovel(input) {
  const normalized = normalizeSourceText(input.text);
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
  // chapters가 있으면(EPUB) 실제 챕터 경계를 Scene으로 쓴다. 없으면 기존 균등 분할.
  const scenes = buildScenes(segments, document.document_id, input.chapters || null);
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
  extractDescriptionSpans(segments, characterPass.characters, locationPass.locations);
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
    annotations: [],
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
  analysis.annotations = extractAnnotations(segments, document.document_id);
  refreshNarrativeTime(analysis);
  analysis.diagnostics.counts = {
    segments: segments.length,
    scenes: scenes.length,
    mentions: mentions.length,
    characters: analysis.characters.length,
    locations: analysis.locations.length,
    events: analysis.events.length,
    relations: analysis.relations.length,
    annotations: analysis.annotations.length,
    descriptions: segments.reduce((count, segment) => count + segment.description_spans.length, 0)
  };

  return analysis;
}

export { analyzeNovel };
export { buildDynamicSeedLexicon } from "./analysis/seeds.js";
export { applyOllamaPayload } from "./analysis/payload.js";
export { relinkEventsWithSegmentMentions } from "./analysis/payload.js";
export { buildCharacterStates } from "./analysis/events.js";
export { buildRelations } from "./analysis/events.js";
export { refreshNarrativeTime } from "./analysis/events.js";
