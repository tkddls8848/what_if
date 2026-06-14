"use strict";

const SAMPLE_TEXT_URL = "texts/wings.txt";
const SNAPSHOT_KEY = "novel-if-reader:snapshot:v2";

const STATUS = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  EDITED: "edited",
  REJECTED: "rejected",
  MANUAL: "manual"
};

const EVENT_LABELS = {
  appearance: "등장",
  movement: "이동",
  conversation: "대화",
  perception: "인식",
  conflict: "갈등",
  realization: "깨달음",
  stasis: "정체",
  symbolic: "상징",
  background: "배경"
};

const STATUS_LABELS = {
  suggested: "제안",
  confirmed: "확정",
  edited: "수정",
  rejected: "제외",
  manual: "수동"
};

const CHARACTER_SEEDS = [
  {
    canonical_name: "나",
    aliases: ["나는", "내가", "나를", "나에게", "나의", "내 방", "내 아내"],
    role: "화자",
    description: "소설의 1인칭 화자. 방 안에 머물며 아내와 세계를 관찰한다."
  },
  {
    canonical_name: "아내",
    aliases: ["아내", "내 아내", "아내가", "아내는", "아내의", "아내에게"],
    role: "배우자",
    description: "화자와 함께 33번지에 사는 인물. 외출과 내객을 통해 사건을 만든다."
  },
  {
    canonical_name: "내객",
    aliases: ["내객", "손님", "서너 사람", "방문객"],
    role: "방문자",
    description: "아내를 찾아오는 익명의 방문자들."
  },
  {
    canonical_name: "18가구 사람들",
    aliases: ["18 가구", "18가구", "그들", "여인네", "젊은 여인"],
    role: "주변 인물",
    description: "33번지에 함께 사는 주변 인물 집단."
  },
  {
    canonical_name: "남자",
    aliases: ["남자", "그 남자", "어떤 남자"],
    role: "남성 인물",
    description: "원문에서 남성으로 지칭되는 인물 후보."
  }
];

const LOCATION_SEEDS = [
  {
    name: "33번지",
    aliases: ["33번지", "33 번지"],
    type: "residential",
    description: "18가구가 함께 사는 중심 공간.",
    narrative_coords: { x: 490, y: 310 }
  },
  {
    name: "내 방",
    aliases: ["내 방", "윗방", "침침한 방", "방안"],
    type: "interior",
    description: "화자가 주로 머무는 방. 스포일러 차단 상태 계산의 중심 공간.",
    parent: "33번지",
    narrative_coords: { x: 315, y: 350 }
  },
  {
    name: "아내 방",
    aliases: ["아내 방", "아내의 방", "아랫방", "볕드는 방"],
    type: "interior",
    description: "아내의 화장대와 물건들이 있는 공간.",
    parent: "33번지",
    narrative_coords: { x: 500, y: 410 }
  },
  {
    name: "대문",
    aliases: ["대문", "문간", "미닫이"],
    type: "threshold",
    description: "33번지 안팎을 잇는 통로.",
    parent: "33번지",
    narrative_coords: { x: 650, y: 320 }
  },
  {
    name: "거리",
    aliases: ["거리", "한길", "길", "밖"],
    type: "exterior",
    description: "방과 33번지 바깥의 세계.",
    narrative_coords: { x: 735, y: 500 }
  },
  {
    name: "미쓰코시 옥상",
    aliases: ["미쓰코시", "미쓰코시 옥상", "옥상"],
    type: "public",
    description: "도시적 상승과 전환을 암시하는 장소.",
    narrative_coords: { x: 770, y: 150 }
  },
  {
    name: "경성역",
    aliases: ["경성역", "역"],
    type: "public",
    description: "이동과 도시 공간을 암시하는 장소.",
    narrative_coords: { x: 810, y: 390 }
  }
];

const EVENT_LEXICON = [
  { type: "movement", words: ["가다", "간다", "갔다", "돌아오", "외출", "나가", "들어오", "건너간", "올라", "내려", "찾아"] },
  { type: "conversation", words: ["말", "이야기", "묻", "대답", "소리", "불렀", "속삭", "농"] },
  { type: "perception", words: ["보다", "보는", "느낀", "생각", "알", "모르", "연상", "기억", "관찰"] },
  { type: "conflict", words: ["무서", "꾸지람", "싫", "불안", "미워", "갈등", "아프", "쓰라리", "피곤"] },
  { type: "realization", words: ["깨달", "알았다", "분명", "확실", "연구", "착수", "증거"] },
  { type: "stasis", words: ["눕", "잔다", "잠", "머물", "기다", "게으", "침침", "우울", "상태"] },
  { type: "symbolic", words: ["날개", "박제", "태양", "상징", "벙어리", "거울", "향기", "꽃", "돈"] }
];

const MENTAL_STATE_LEXICON = [
  { state: "불안", words: ["불안", "무서", "꾸지람", "잠이 잘 오지"] },
  { state: "우울", words: ["우울", "침침", "피곤", "싫증"] },
  { state: "관찰", words: ["본다", "보는", "연상", "생각", "연구"] },
  { state: "안일", words: ["편리", "안일", "좋았다", "즐거웠다", "행복"] },
  { state: "각성", words: ["날개", "깨달", "확실", "비약"] }
];

const state = {
  analysis: null,
  currentSegment: 1,
  spoilerSafe: true,
  selected: null,
  exportFormat: "json",
  filters: {
    eventType: "all",
    status: "active",
    entity: "all"
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  sourceText: $("#sourceText"),
  loadSampleBtn: $("#loadSampleBtn"),
  analyzeBtn: $("#analyzeBtn"),
  saveSnapshotBtn: $("#saveSnapshotBtn"),
  loadSnapshotBtn: $("#loadSnapshotBtn"),
  readerStats: $("#readerStats"),
  readerPosition: $("#readerPosition"),
  readerPositionLabel: $("#readerPositionLabel"),
  spoilerToggle: $("#spoilerToggle"),
  segmentList: $("#segmentList"),
  eventTypeFilter: $("#eventTypeFilter"),
  statusFilter: $("#statusFilter"),
  entityFilter: $("#entityFilter"),
  spaceGraph: $("#spaceGraph"),
  mapStats: $("#mapStats"),
  inspectorBody: $("#inspectorBody"),
  clearSelectionBtn: $("#clearSelectionBtn"),
  timelineList: $("#timelineList"),
  characterCards: $("#characterCards"),
  reviewSourceStats: $("#reviewSourceStats"),
  reviewSource: $("#reviewSource"),
  reviewStats: $("#reviewStats"),
  reviewList: $("#reviewList"),
  rebuildBtn: $("#rebuildBtn"),
  addManualEventBtn: $("#addManualEventBtn"),
  exportOutput: $("#exportOutput"),
  copyExportBtn: $("#copyExportBtn")
};

initApp();

async function initApp() {
  bindEvents();
  const sampleText = await loadText(SAMPLE_TEXT_URL);
  els.sourceText.value = sampleText;
  runAnalysis();
}

async function loadText(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (_error) {
    return "";
  }
}

function bindEvents() {
  els.loadSampleBtn.addEventListener("click", async () => {
    els.sourceText.value = await loadText(SAMPLE_TEXT_URL);
    state.currentSegment = 1;
    runAnalysis();
  });

  els.analyzeBtn.addEventListener("click", () => {
    state.currentSegment = 1;
    runAnalysis();
  });

  els.saveSnapshotBtn.addEventListener("click", () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ analysis: state.analysis, sourceText: els.sourceText.value }));
    flashButton(els.saveSnapshotBtn, "저장됨");
  });

  els.loadSnapshotBtn.addEventListener("click", () => {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return flashButton(els.loadSnapshotBtn, "없음");
    const snapshot = JSON.parse(raw);
    els.sourceText.value = snapshot.sourceText || "";
    state.analysis = snapshot.analysis || null;
    state.currentSegment = 1;
    renderAll();
    flashButton(els.loadSnapshotBtn, "복원됨");
  });

  els.readerPosition.addEventListener("input", (event) => {
    state.currentSegment = Number(event.target.value);
    renderAll();
  });

  els.spoilerToggle.addEventListener("change", (event) => {
    state.spoilerSafe = event.target.checked;
    renderAll();
  });

  els.eventTypeFilter.addEventListener("change", (event) => {
    state.filters.eventType = event.target.value;
    renderAll();
  });

  els.statusFilter.addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    renderAll();
  });

  els.entityFilter.addEventListener("change", (event) => {
    state.filters.entity = event.target.value;
    renderAll();
  });

  els.clearSelectionBtn.addEventListener("click", () => {
    state.selected = null;
    renderAll();
  });

  els.rebuildBtn.addEventListener("click", () => {
    if (!state.analysis) return;
    state.analysis.states = buildCharacterStates(state.analysis);
    state.analysis.relations = buildRelations(state.analysis);
    renderAll();
  });

  els.addManualEventBtn.addEventListener("click", () => {
    addManualEvent();
  });

  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      activateTab(tab.dataset.tab);
      return;
    }

    const statusButton = event.target.closest("[data-status-action]");
    if (statusButton) {
      setAnnotationStatus(statusButton.dataset.kind, statusButton.dataset.id, statusButton.dataset.statusAction);
      return;
    }

    const selectButton = event.target.closest("[data-select-kind]");
    if (selectButton) {
      state.selected = { kind: selectButton.dataset.selectKind, id: selectButton.dataset.selectId };
      renderAll();
    }

    const exportButton = event.target.closest("[data-export-format]");
    if (exportButton) {
      state.exportFormat = exportButton.dataset.exportFormat;
      $("[data-export-format].active")?.classList.remove("active");
      exportButton.classList.add("active");
      renderExport();
      return;
    }

    const focusButton = event.target.closest("[data-focus-segment]");
    if (focusButton) {
      focusSegment(focusButton.dataset.focusSegment);
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const { editKind, editId, editField } = target.dataset;
    if (!editKind || !editId || !editField) return;
    editEntity(editKind, editId, editField, target.value);
  });

  els.copyExportBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.exportOutput.value);
    } catch (_error) {
      els.exportOutput.select();
      document.execCommand("copy");
    }
    flashButton(els.copyExportBtn, "복사됨");
  });
}

function runAnalysis() {
  state.analysis = analyzeNovel({
    title: detectTitle(els.sourceText.value),
    language: "ko",
    source: SAMPLE_TEXT_URL,
    text: els.sourceText.value
  });
  state.currentSegment = Math.min(state.currentSegment, state.analysis.segments.length || 1);
  renderAll();
}

function analyzeNovel(input) {
  const normalized = normalizeText(input.text);
  const document = {
    document_id: "doc_001",
    title: input.title || "Untitled",
    language: input.language || "ko",
    source: input.source || "manual",
    created_at: new Date().toISOString()
  };

  const segments = buildSegments(normalized, document.document_id);
  const scenes = buildScenes(segments, document.document_id);
  const characterPass = extractCharacters(segments);
  const locationPass = extractLocations(segments);
  const mentions = [...characterPass.mentions, ...locationPass.mentions];
  normalizeMentionReferences(characterPass.characters, locationPass.locations, mentions);
  const events = extractEvents(segments, characterPass.characters, locationPass.locations, document.document_id);
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
    diagnostics: {
      engine: "rule-based-ko-adapter",
      model_reference: "BookNLP-style schema",
      warnings: [
        "현재 엔진은 규칙 기반입니다. 공지시와 은유적 사건은 검수 화면에서 확인해야 합니다."
      ],
      counts: {}
    }
  };

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

function detectTitle(text) {
  return normalizeText(text).split(/\n+/)[0]?.trim() || "Untitled";
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

function extractCharacters(segments) {
  const characters = [];
  const mentions = [];

  CHARACTER_SEEDS.forEach((seed) => {
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
      confidence: 0.88,
      method: "seed-lexicon"
    });
  });

  const existingAliases = new Set(characters.flatMap((character) => character.aliases));
  const locationAliases = new Set(LOCATION_SEEDS.flatMap((location) => location.aliases));
  const stopNames = new Set(["나는", "내가", "아내", "방안", "대문", "거리", "사람", "생활", "생각", "여인", "원문", "가구", "그들", "이것", "그것"]);
  const candidates = new Map();
  const pattern = /([가-힣]{2,5})(?:은|는|이|가|을|를|에게|와|과|도|의)\b/g;

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

function extractLocations(segments) {
  const locations = [];
  const mentions = [];

  LOCATION_SEEDS.forEach((seed) => {
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
      confidence: 0.86,
      method: "seed-lexicon"
    });
  });

  locations.forEach((location) => {
    if (!location.parent_name) return;
    const parent = locations.find((candidate) => candidate.name === location.parent_name);
    location.parent_location_id = parent?.location_id || "";
  });

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

function findSeedMentions(segments, aliases, entityType, entityId) {
  const mentions = [];
  segments.forEach((segment) => {
    aliases.forEach((alias) => {
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

function extractEvents(segments, characters, locations, documentId) {
  const events = [];
  segments.forEach((segment) => {
    splitSentences(segment.text).forEach((sentence, sentenceIndex) => {
      const type = inferEventType(sentence.text);
      const characterIds = characters
        .filter((character) => character.status !== STATUS.REJECTED && includesAny(sentence.text, character.aliases))
        .map((character) => character.character_id);
      const locationIds = locations
        .filter((location) => location.status !== STATUS.REJECTED && includesAny(sentence.text, location.aliases))
        .map((location) => location.location_id);

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

function inferEventType(sentence) {
  const hit = EVENT_LEXICON
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
      mentalState = inferMentalState(segment.text, mentalState);
      physicalState = inferPhysicalState(segment.text, physicalState);
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

function inferMentalState(text, fallback) {
  const hit = MENTAL_STATE_LEXICON.find((entry) => entry.words.some((word) => text.includes(word)));
  return hit?.state || fallback || "미정";
}

function inferPhysicalState(text, fallback) {
  if (includesAny(text, ["잠", "눕", "이불", "낮잠"])) return "누워 있거나 잠든 상태";
  if (includesAny(text, ["외출", "나가", "돌아오"])) return "이동 중";
  if (includesAny(text, ["피곤", "아프", "쓰라리"])) return "피로";
  return fallback || "";
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

  return relations;
}

function renderAll() {
  renderReader();
  renderFilterOptions();
  renderGraph();
  renderInspector();
  renderTimeline();
  renderCharacters();
  renderReview();
  renderExport();
}

function renderReader() {
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

function renderFilterOptions() {
  const analysis = state.analysis;
  if (!analysis) return;
  const previous = state.filters.entity;
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
  if (Array.from(els.entityFilter.options).some((option) => option.value === previous)) {
    els.entityFilter.value = previous;
  } else {
    state.filters.entity = "all";
  }
}

function renderGraph() {
  const analysis = state.analysis;
  els.spaceGraph.innerHTML = "";
  if (!analysis) return;

  const mapEvents = selectMapEvents();
  const mapEdges = buildMapEdges(mapEvents);
  const nodes = buildVisibleGraphNodes(mapEdges);

  els.mapStats.textContent = `${nodes.length} nodes · ${mapEdges.length} edges`;

  if (!mapEdges.length || !nodes.length) {
    drawSvgText("현재 문단에 연결된 관계가 없습니다.", 490, 300, "graph-empty");
    return;
  }

  const positions = layoutGraphNodes(nodes);

  mapEdges.forEach((edge) => {
    const source = positions.get(`${edge.source_type}:${edge.source_id}`);
    const target = positions.get(`${edge.target_type}:${edge.target_id}`);
    if (!source || !target) return;
    const line = svgEl("line", {
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      class: `graph-edge ${edge.relation_type}`,
      "stroke-width": String(Math.min(5, 1.4 + edge.weight * 0.35))
    });
    const title = svgEl("title", {});
    title.textContent = edge.summaries.join("\n");
    line.appendChild(title);
    els.spaceGraph.appendChild(line);
  });

  nodes.forEach((node) => {
    const position = positions.get(node.id);
    const isSelected = state.selected?.kind === node.kind && state.selected?.id === node.rawId;
    const group = svgEl("g", {
      class: `graph-node-group ${node.kind} ${isSelected ? "selected" : ""}`,
      tabindex: "0"
    });
    const shapeAttrs = {
      cx: position.x,
      cy: position.y,
      r: node.kind === "event" ? 21 : 28,
      class: `graph-node ${node.kind} ${statusClass(node.status)}`
    };
    group.appendChild(svgEl("circle", shapeAttrs));
    const label = svgEl("text", { x: position.x, y: position.y + 46, class: "graph-label" });
    label.textContent = node.label;
    const caption = svgEl("text", { x: position.x, y: position.y + 62, class: "graph-caption" });
    caption.textContent = node.caption;
    group.append(label, caption);
    group.addEventListener("click", () => {
      state.selected = { kind: node.kind, id: node.rawId };
      renderAll();
    });
    els.spaceGraph.appendChild(group);
  });
}

function buildVisibleGraphNodes(edges) {
  const nodes = new Map();
  const add = (kind, rawId) => {
    const id = `${kind}:${rawId}`;
    if (nodes.has(id)) return;
    const entity = getEntity(kind, rawId);
    if (!entity || entity.status === STATUS.REJECTED) return;
    const label = entity.canonical_name || entity.name || EVENT_LABELS[entity.type] || entity.summary || rawId;
    const caption = kind === "event"
      ? entity.event_id
      : kind === "character"
        ? entity.role || "인물"
        : entity.type || "장소";
    const coords = kind === "location" ? entity.narrative_coords : null;
    nodes.set(id, { id, kind, rawId, label, caption, status: entity.status, coords });
  };

  edges.forEach((edge) => {
    add(edge.source_type, edge.source_id);
    add(edge.target_type, edge.target_id);
  });

  return Array.from(nodes.values());
}

function buildMapEdges(events) {
  const edgeMap = new Map();
  const addEdge = (sourceType, sourceId, targetType, targetId, relationType, event) => {
    if (!sourceId || !targetId) return;
    const sourceKey = `${sourceType}:${sourceId}`;
    const targetKey = `${targetType}:${targetId}`;
    if (sourceKey === targetKey) return;
    const ordered = [sourceKey, targetKey].sort();
    const key = `${ordered[0]}|${ordered[1]}|${relationType}`;
    const [orderedSource, orderedTarget] = ordered;
    const [finalSourceType, finalSourceId] = orderedSource.split(":");
    const [finalTargetType, finalTargetId] = orderedTarget.split(":");

    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        edge_id: `map_edge_${edgeMap.size + 1}`,
        source_type: finalSourceType,
        source_id: finalSourceId,
        target_type: finalTargetType,
        target_id: finalTargetId,
        relation_type: relationType,
        event_ids: [],
        summaries: [],
        weight: 0
      });
    }

    const edge = edgeMap.get(key);
    edge.event_ids.push(event.event_id);
    edge.summaries.push(event.summary);
    edge.weight += 1;
  };

  events.forEach((event) => {
    const characterIds = event.characters.filter((id) => {
      const character = getEntity("character", id);
      return character && character.status !== STATUS.REJECTED;
    });
    const locationIds = event.locations.filter((id) => {
      const location = getEntity("location", id);
      return location && location.status !== STATUS.REJECTED;
    });

    for (let i = 0; i < characterIds.length; i += 1) {
      for (let j = i + 1; j < characterIds.length; j += 1) {
        addEdge("character", characterIds[i], "character", characterIds[j], "event_between", event);
      }
    }

    characterIds.forEach((characterId) => {
      locationIds.forEach((locationId) => {
        addEdge("character", characterId, "location", locationId, "event_at", event);
      });
    });
  });

  return Array.from(edgeMap.values());
}

function layoutGraphNodes(nodes) {
  const positions = new Map();
  const center = { x: 490, y: 300 };
  const groups = {
    character: nodes.filter((node) => node.kind === "character"),
    event: nodes.filter((node) => node.kind === "event"),
    location: nodes.filter((node) => node.kind === "location")
  };

  groups.location.forEach((node, index) => {
    if (node.coords) {
      positions.set(node.id, { ...node.coords });
      return;
    }
    const angle = (Math.PI * 2 * index) / Math.max(1, groups.location.length) + Math.PI / 8;
    positions.set(node.id, { x: center.x + Math.cos(angle) * 285, y: center.y + Math.sin(angle) * 185 });
  });

  groups.character.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, groups.character.length) - Math.PI / 2;
    positions.set(node.id, { x: center.x + Math.cos(angle) * 190, y: center.y + Math.sin(angle) * 130 });
  });

  groups.event.forEach((node, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    positions.set(node.id, { x: 235 + column * 125, y: 85 + row * 74 });
  });

  if (nodes.length === 1) positions.set(nodes[0].id, center);
  return positions;
}

function renderInspector() {
  const analysis = state.analysis;
  if (!analysis || !state.selected) {
    els.inspectorBody.innerHTML = `
      <p class="muted">그래프 노드나 검수 항목을 선택하면 원문 근거와 연결 정보를 볼 수 있습니다.</p>
      ${renderMapEventPanel()}
    `;
    return;
  }

  const entity = getEntity(state.selected.kind, state.selected.id);
  if (!entity) {
    els.inspectorBody.innerHTML = `<p class="muted">선택한 항목을 찾을 수 없습니다.</p>`;
    return;
  }

  const title = entity.canonical_name || entity.name || entity.summary;
  const status = entity.status || STATUS.SUGGESTED;
  const mentions = state.selected.kind === "event"
    ? []
    : analysis.mentions.filter((mention) =>
        mention.entity_type === state.selected.kind &&
        mention.entity_id === state.selected.id &&
        mention.status !== STATUS.REJECTED &&
        isVisibleSegmentId(mention.segment_id)
      );
  const relatedEvents = analysis.events.filter((event) =>
    event.status !== STATUS.REJECTED &&
    isVisibleSegmentId(event.segment_id) &&
    (
      event.event_id === state.selected.id ||
      event.characters.includes(state.selected.id) ||
      event.locations.includes(state.selected.id)
    )
  ).slice(-8);

  els.inspectorBody.innerHTML = `
    <div class="status-row">
      <span class="status-pill ${statusClass(status)}">${STATUS_LABELS[status] || status}</span>
      <span>${Math.round((entity.confidence || 0) * 100)}%</span>
    </div>
    <label class="field">
      이름/요약
      <input data-edit-kind="${state.selected.kind}" data-edit-id="${state.selected.id}" data-edit-field="${state.selected.kind === "event" ? "summary" : state.selected.kind === "location" ? "name" : "canonical_name"}" value="${escapeAttr(title)}">
    </label>
    <label class="field">
      설명
      <textarea data-edit-kind="${state.selected.kind}" data-edit-id="${state.selected.id}" data-edit-field="description">${escapeHtml(entity.description || "")}</textarea>
    </label>
    <div class="button-row">
      ${statusButtons(state.selected.kind, state.selected.id)}
    </div>
    <h3>근거</h3>
    ${renderEvidenceList(state.selected.kind === "event" ? [entity] : mentions)}
    <h3>관련 사건</h3>
    ${relatedEvents.length ? relatedEvents.map((event) => renderMiniEvent(event)).join("") : `<p class="muted">관련 사건 없음</p>`}
    ${renderMapEventPanel(state.selected)}
  `;
}

function renderMapEventPanel(selection = null) {
  const events = selectMapEvents().filter((event) => {
    if (!selection) return event.characters.length || event.locations.length;
    if (selection.kind === "character") return event.characters.includes(selection.id);
    if (selection.kind === "location") return event.locations.includes(selection.id);
    if (selection.kind === "event") return event.event_id === selection.id;
    return true;
  });

  const title = selection ? "선택 항목의 현재 사건" : "현재 시점 사건";
  if (!events.length) {
    return `
      <section class="inspector-events">
        <h3>${title}</h3>
        <p class="muted">현재 문단에 연결된 사건이 없습니다.</p>
      </section>
    `;
  }

  return `
    <section class="inspector-events">
      <h3>${title}</h3>
      ${events.map((event) => `
        <article class="inspector-event">
          <div class="tag-row">
            <span class="tag event">${EVENT_LABELS[event.type] || event.type}</span>
            ${event.characters.map((id) => `<span class="tag">${escapeHtml(nameOf("character", id))}</span>`).join("")}
            ${event.locations.map((id) => `<span class="tag">${escapeHtml(nameOf("location", id))}</span>`).join("")}
          </div>
          <p>${escapeHtml(event.summary)}</p>
          <blockquote>${escapeHtml(sourceTextForSpan(event.source_span))}</blockquote>
        </article>
      `).join("")}
    </section>
  `;
}

function renderTimeline() {
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
          <span class="tag event">${EVENT_LABELS[event.type] || event.type}</span>
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

function renderCharacters() {
  const analysis = state.analysis;
  els.characterCards.innerHTML = "";
  if (!analysis) return;

  const characters = analysis.characters
    .filter((character) => statusMatches(character.status))
    .filter((character) => isVisibleSegmentId(character.first_segment_id))
    .filter((character) => matchesEntityFilter("character", character.character_id));

  if (!characters.length) {
    els.characterCards.innerHTML = `<div class="empty-state">현재 범위에 표시할 인물이 없습니다.</div>`;
    return;
  }

  characters.forEach((character) => {
    const characterState = latestStateForCharacter(character.character_id);
    const locationName = characterState?.location_id ? nameOf("location", characterState.location_id) : "미정";
    const history = characterStateHistory(character.character_id);
    const relations = characterRelationSummary(character.character_id);
    const path = characterSpatialPath(character.character_id);
    const density = characterAppearanceDensity(character.character_id);
    const events = characterEvents(character.character_id).slice(-6);
    const card = document.createElement("article");
    card.className = `character-card ${statusClass(character.status)}`;
    card.innerHTML = `
      <header>
        <h3>${escapeHtml(character.canonical_name)}</h3>
        <button type="button" data-select-kind="character" data-select-id="${character.character_id}">현재 위치에서 강조</button>
      </header>
      <div class="tag-row">
        <span class="tag">${escapeHtml(character.role || "인물")}</span>
        <span class="status-pill ${statusClass(character.status)}">${STATUS_LABELS[character.status]}</span>
        <span class="tag confidence">${Math.round(character.confidence * 100)}%</span>
      </div>
      <p>${escapeHtml(character.description || "")}</p>
      <dl class="state-list">
        <div><dt>현재 장소</dt><dd>${escapeHtml(locationName)}</dd></div>
        <div><dt>심리 상태</dt><dd>${escapeHtml(characterState?.mental_state || "미정")}</dd></div>
        <div><dt>신체 상태</dt><dd>${escapeHtml(characterState?.physical_state || "미정")}</dd></div>
      </dl>
      <section class="density-section">
        <h4>등장 밀도</h4>
        ${renderDensityBars(density)}
      </section>
      <h4>알려진 사실</h4>
      <ul class="fact-list">
        ${(characterState?.known_facts || []).map((fact) => `<li>${escapeHtml(fact)}</li>`).join("") || `<li class="muted">현재 위치까지 확인된 사실 없음</li>`}
      </ul>
      <details class="character-details">
        <summary>확장 보기</summary>

        <section>
          <h4>상태 변화 타임라인</h4>
          ${renderCharacterStateTimeline(history)}
        </section>

        <section>
          <h4>관계 변화</h4>
          ${renderCharacterRelations(relations)}
        </section>

        <section>
          <h4>공간 궤적</h4>
          ${renderSpatialPath(path)}
        </section>

        <section>
          <h4>Alias / 검수</h4>
          <label class="field compact">
            별칭
            <input data-edit-kind="character" data-edit-id="${character.character_id}" data-edit-field="aliases_csv" value="${escapeAttr((character.aliases || []).join(", "))}">
          </label>
          <div class="alias-list">
            ${(character.aliases || []).map((alias) => `<span class="tag">${escapeHtml(alias)}</span>`).join("")}
          </div>
          <div class="button-row">${statusButtons("character", character.character_id)}</div>
        </section>

        <section>
          <h4>최근 사건</h4>
          ${events.length ? events.map((event) => renderCharacterEventItem(event)).join("") : `<p class="muted">현재 위치까지 연결된 사건 없음</p>`}
        </section>
      </details>
    `;
    els.characterCards.appendChild(card);
  });
}

function characterEvents(characterId) {
  return state.analysis.events
    .filter((event) => event.status !== STATUS.REJECTED)
    .filter((event) => isVisibleSegmentId(event.segment_id))
    .filter((event) => event.characters.includes(characterId))
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id) || a.sentence_index - b.sentence_index);
}

function characterStateHistory(characterId) {
  const history = state.analysis.states
    .filter((item) => item.character_id === characterId && item.status !== STATUS.REJECTED)
    .filter((item) => isVisibleSegmentId(item.segment_id))
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id));

  const compact = [];
  history.forEach((item) => {
    const previous = compact[compact.length - 1];
    if (
      previous &&
      previous.mental_state === item.mental_state &&
      previous.physical_state === item.physical_state &&
      previous.location_id === item.location_id
    ) {
      return;
    }
    compact.push(item);
  });
  return compact;
}

function characterRelationSummary(characterId) {
  const relationMap = new Map();
  characterEvents(characterId).forEach((event) => {
    event.characters
      .filter((id) => id !== characterId)
      .forEach((otherId) => {
        if (!relationMap.has(otherId)) {
          relationMap.set(otherId, {
            character_id: otherId,
            labels: new Map(),
            latest_segment_id: event.segment_id,
            latest_summary: event.summary,
            count: 0
          });
        }
        const relation = relationMap.get(otherId);
        const label = relationLabelForEvent(event.type);
        relation.labels.set(label, (relation.labels.get(label) || 0) + 1);
        relation.latest_segment_id = event.segment_id;
        relation.latest_summary = event.summary;
        relation.count += 1;
      });
  });
  return Array.from(relationMap.values()).sort((a, b) => b.count - a.count);
}

function relationLabelForEvent(type) {
  if (type === "conflict") return "갈등";
  if (type === "conversation") return "대화";
  if (type === "movement") return "동행/이동";
  if (type === "perception") return "관찰";
  if (type === "realization") return "인식 변화";
  return EVENT_LABELS[type] || "연결";
}

function characterSpatialPath(characterId) {
  const path = [];
  characterStateHistory(characterId).forEach((item) => {
    if (!item.location_id) return;
    const previous = path[path.length - 1];
    if (previous?.location_id === item.location_id) return;
    path.push({
      location_id: item.location_id,
      segment_id: item.segment_id,
      label: nameOf("location", item.location_id)
    });
  });
  return path;
}

function characterAppearanceDensity(characterId) {
  const buckets = state.analysis.scenes.map((scene) => ({
    scene_id: scene.scene_id,
    label: scene.title,
    count: 0
  }));
  const sceneIndexBySegment = new Map(state.analysis.segments.map((segment) => [segment.segment_id, segment.scene_id]));

  state.analysis.mentions
    .filter((mention) => mention.entity_type === "character")
    .filter((mention) => mention.entity_id === characterId)
    .filter((mention) => mention.status !== STATUS.REJECTED)
    .filter((mention) => isVisibleSegmentId(mention.segment_id))
    .forEach((mention) => {
      const sceneId = sceneIndexBySegment.get(mention.segment_id);
      const bucket = buckets.find((item) => item.scene_id === sceneId);
      if (bucket) bucket.count += 1;
    });

  characterEvents(characterId).forEach((event) => {
    const sceneId = sceneIndexBySegment.get(event.segment_id);
    const bucket = buckets.find((item) => item.scene_id === sceneId);
    if (bucket) bucket.count += 1;
  });

  return buckets;
}

function renderDensityBars(buckets) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return `
    <div class="density-bars" aria-label="등장 밀도">
      ${buckets.map((bucket) => `
        <span
          class="density-bar ${bucket.count ? "active" : ""}"
          style="height:${Math.max(8, Math.round((bucket.count / max) * 34))}px"
          title="${escapeAttr(bucket.label)}: ${bucket.count}"
        ></span>
      `).join("")}
    </div>
  `;
}

function renderCharacterStateTimeline(history) {
  if (!history.length) return `<p class="muted">현재 위치까지 상태 변화 없음</p>`;
  return `
    <ol class="character-timeline">
      ${history.slice(-8).map((item) => `
        <li>
          <button type="button" class="link-button" data-focus-segment="${escapeAttr(item.segment_id)}">${escapeHtml(segmentLabel(item.segment_id))}</button>
          <span>${escapeHtml(item.mental_state || "미정")}</span>
          ${item.location_id ? `<small>${escapeHtml(nameOf("location", item.location_id))}</small>` : ""}
        </li>
      `).join("")}
    </ol>
  `;
}

function renderCharacterRelations(relations) {
  if (!relations.length) return `<p class="muted">현재 위치까지 다른 인물과의 관계 변화 없음</p>`;
  return `
    <div class="relation-list">
      ${relations.map((relation) => {
        const labels = Array.from(relation.labels.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => `${label}${count > 1 ? ` ${count}` : ""}`)
          .join(" · ");
        return `
          <article class="relation-item">
            <strong>${escapeHtml(nameOf("character", relation.character_id))}</strong>
            <span>${escapeHtml(labels)}</span>
            <button type="button" class="link-button" data-focus-segment="${escapeAttr(relation.latest_segment_id)}">${escapeHtml(segmentLabel(relation.latest_segment_id))}</button>
            <p>${escapeHtml(relation.latest_summary)}</p>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderSpatialPath(path) {
  if (!path.length) return `<p class="muted">현재 위치까지 장소 궤적 없음</p>`;
  return `
    <div class="spatial-path">
      ${path.map((item) => `
        <button type="button" class="path-node" data-focus-segment="${escapeAttr(item.segment_id)}">
          ${escapeHtml(item.label)}
        </button>
      `).join(`<span class="path-arrow">→</span>`)}
    </div>
  `;
}

function renderCharacterEventItem(event) {
  return `
    <article class="character-event-item">
      <div class="tag-row">
        <span class="tag event">${EVENT_LABELS[event.type] || event.type}</span>
        <button type="button" class="link-button" data-focus-segment="${escapeAttr(event.segment_id)}">${escapeHtml(segmentLabel(event.segment_id))}</button>
      </div>
      <p>${escapeHtml(event.summary)}</p>
    </article>
  `;
}

function segmentLabel(segmentId) {
  const order = segmentOrder(segmentId);
  return order ? `P${String(order).padStart(3, "0")}` : segmentId;
}

function renderReview() {
  const analysis = state.analysis;
  if (!analysis) return;

  const segment = analysis.segments[state.currentSegment - 1];
  els.reviewSourceStats.textContent = segment ? `${segment.segment_id} · ${segment.scene_id}` : "현재 문단";
  els.reviewSource.innerHTML = segment ? renderHighlightedSegment(segment) : "";

  const items = [
    ...analysis.characters.map((item) => ({ kind: "character", id: item.character_id, item })),
    ...analysis.locations.map((item) => ({ kind: "location", id: item.location_id, item })),
    ...analysis.events.map((item) => ({ kind: "event", id: item.event_id, item }))
  ]
    .filter(({ item }) => statusMatches(item.status))
    .filter(({ item, kind }) => {
      const segmentId = kind === "event" ? item.segment_id : item.first_segment_id;
      return isVisibleSegmentId(segmentId);
    })
    .sort((a, b) => (a.item.confidence || 0) - (b.item.confidence || 0));

  els.reviewStats.textContent = `${items.length}개`;
  els.reviewList.innerHTML = items.length ? "" : `<div class="empty-state">검수할 항목이 없습니다.</div>`;

  items.forEach(({ kind, id, item }) => {
    const row = document.createElement("article");
    row.className = `review-item ${statusClass(item.status)} ${state.selected?.kind === kind && state.selected?.id === id ? "selected" : ""}`;
    const title = item.canonical_name || item.name || item.summary;
    row.innerHTML = `
      <header>
        <button type="button" class="link-button" data-select-kind="${kind}" data-select-id="${id}">
          ${kindLabel(kind)} · ${escapeHtml(title)}
        </button>
        <span class="status-pill ${statusClass(item.status)}">${STATUS_LABELS[item.status]}</span>
      </header>
      <label class="field compact">
        ${kind === "event" ? "요약" : "이름"}
        <input data-edit-kind="${kind}" data-edit-id="${id}" data-edit-field="${kind === "event" ? "summary" : kind === "location" ? "name" : "canonical_name"}" value="${escapeAttr(title)}">
      </label>
      <div class="review-meta">
        <span>${Math.round((item.confidence || 0) * 100)}%</span>
        <span>${item.method || "manual"}</span>
      </div>
      <div class="button-row">${statusButtons(kind, id)}</div>
    `;
    els.reviewList.appendChild(row);
  });
}

function renderHighlightedSegment(segment) {
  const analysis = state.analysis;
  const localMarks = [];

  analysis.mentions
    .filter((mention) => mention.segment_id === segment.segment_id && mention.status !== STATUS.REJECTED)
    .forEach((mention) => {
      localMarks.push({
        start: mention.char_start - segment.char_start,
        end: mention.char_end - segment.char_start,
        className: mention.entity_type,
        label: nameOf(mention.entity_type, mention.entity_id)
      });
    });

  analysis.events
    .filter((event) => event.segment_id === segment.segment_id && event.status !== STATUS.REJECTED)
    .forEach((event) => {
      localMarks.push({
        start: event.source_span.char_start - segment.char_start,
        end: event.source_span.char_end - segment.char_start,
        className: "event",
        label: EVENT_LABELS[event.type] || event.type
      });
    });

  localMarks.sort((a, b) => a.start - b.start || b.end - a.end);
  const safeMarks = [];
  localMarks.forEach((mark) => {
    if (safeMarks.some((existing) => mark.start < existing.end && mark.end > existing.start)) return;
    safeMarks.push(mark);
  });

  let cursor = 0;
  let html = "";
  safeMarks.forEach((mark) => {
    html += escapeHtml(segment.text.slice(cursor, mark.start));
    html += `<mark class="${mark.className}" title="${escapeAttr(mark.label)}">${escapeHtml(segment.text.slice(mark.start, mark.end))}</mark>`;
    cursor = mark.end;
  });
  html += escapeHtml(segment.text.slice(cursor));
  return `<p>${html}</p>`;
}

function renderExport() {
  if (!state.analysis) {
    els.exportOutput.value = "";
    return;
  }
  if (state.exportFormat === "csv") {
    els.exportOutput.value = toCsv(selectScopedAnalysis());
  } else if (state.exportFormat === "markdown") {
    els.exportOutput.value = toMarkdown(selectScopedAnalysis());
  } else if (state.exportFormat === "timelinejs") {
    els.exportOutput.value = JSON.stringify(toTimelineJs(selectScopedAnalysis()), null, 2);
  } else if (state.exportFormat === "graph") {
    els.exportOutput.value = JSON.stringify(toGraphJson(selectScopedAnalysis()), null, 2);
  } else {
    els.exportOutput.value = JSON.stringify(selectScopedAnalysis(), null, 2);
  }
}

function selectMapEvents() {
  if (!state.analysis) return [];
  return state.analysis.events
    .filter((event) => statusMatches(event.status))
    .filter((event) => isCurrentSegmentId(event.segment_id))
    .filter((event) => state.filters.eventType === "all" || event.type === state.filters.eventType)
    .filter((event) => {
      if (state.filters.entity === "all") return true;
      const [kind, id] = state.filters.entity.split(":");
      if (kind === "character") return event.characters.includes(id);
      if (kind === "location") return event.locations.includes(id);
      return true;
    });
}

function selectVisibleEvents() {
  if (!state.analysis) return [];
  return state.analysis.events
    .filter((event) => statusMatches(event.status))
    .filter((event) => isVisibleSegmentId(event.segment_id))
    .filter((event) => state.filters.eventType === "all" || event.type === state.filters.eventType)
    .filter((event) => {
      if (state.filters.entity === "all") return true;
      const [kind, id] = state.filters.entity.split(":");
      if (kind === "character") return event.characters.includes(id);
      if (kind === "location") return event.locations.includes(id);
      return true;
    })
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id) || a.sentence_index - b.sentence_index);
}

function selectScopedAnalysis() {
  const analysis = state.analysis;
  const segmentIds = new Set(analysis.segments.filter((segment) => isVisibleSegmentId(segment.segment_id)).map((segment) => segment.segment_id));
  return {
    document: analysis.document,
    scope: state.spoilerSafe ? { mode: "reader_position", current_segment: state.currentSegment } : { mode: "full_document" },
    segments: analysis.segments.filter((segment) => segmentIds.has(segment.segment_id)),
    scenes: analysis.scenes.filter((scene) => segmentIds.has(scene.start_segment_id) || segmentIds.has(scene.end_segment_id)),
    mentions: analysis.mentions.filter((mention) => segmentIds.has(mention.segment_id) && statusMatches(mention.status)),
    characters: analysis.characters.filter((character) => statusMatches(character.status) && isVisibleSegmentId(character.first_segment_id)),
    locations: analysis.locations.filter((location) => statusMatches(location.status) && isVisibleSegmentId(location.first_segment_id)),
    events: analysis.events.filter((event) => segmentIds.has(event.segment_id) && statusMatches(event.status)),
    states: analysis.states.filter((item) => segmentIds.has(item.segment_id) && statusMatches(item.status)),
    relations: analysis.relations.filter((relation) => relation.segment_ids.some((segmentId) => segmentIds.has(segmentId)) && statusMatches(relation.status)),
    diagnostics: analysis.diagnostics
  };
}

function toCsv(payload) {
  const rows = [["event_id", "segment_id", "type", "status", "confidence", "characters", "locations", "summary", "source"]];
  payload.events.forEach((event) => {
    rows.push([
      event.event_id,
      event.segment_id,
      event.type,
      event.status,
      event.confidence,
      event.characters.map((id) => nameOf("character", id)).join("|"),
      event.locations.map((id) => nameOf("location", id)).join("|"),
      event.summary,
      sourceTextForSpan(event.source_span)
    ]);
  });
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function toMarkdown(payload) {
  const lines = [`# ${payload.document.title}`, "", `Scope: ${payload.scope.mode}`, "", "## Characters", ""];
  payload.characters.forEach((character) => {
    lines.push(`- **${character.canonical_name}** (${STATUS_LABELS[character.status]}): ${character.description || ""}`);
  });
  lines.push("", "## Locations", "");
  payload.locations.forEach((location) => {
    lines.push(`- **${location.name}** (${location.type}): ${location.description || ""}`);
  });
  lines.push("", "## Events", "");
  payload.events.forEach((event) => {
    lines.push(`- **${event.event_id}** [${EVENT_LABELS[event.type]}] ${event.summary}`);
  });
  return lines.join("\n");
}

function toTimelineJs(payload) {
  return {
    title: {
      text: {
        headline: payload.document.title,
        text: "Novel IF Reader export"
      }
    },
    events: payload.events.map((event) => {
      const segment = state.analysis.segments.find((item) => item.segment_id === event.segment_id);
      return {
        start_date: { year: "1", month: "1", day: String(segment?.index || 1) },
        text: {
          headline: `${event.event_id} · ${EVENT_LABELS[event.type] || event.type}`,
          text: `${escapeHtml(event.summary)}<br><small>${escapeHtml(sourceTextForSpan(event.source_span))}</small>`
        },
        group: EVENT_LABELS[event.type] || event.type
      };
    })
  };
}

function toGraphJson(payload) {
  const nodes = [
    ...payload.characters.map((character) => ({ id: `character:${character.character_id}`, type: "character", label: character.canonical_name, status: character.status })),
    ...payload.locations.map((location) => ({ id: `location:${location.location_id}`, type: "location", label: location.name, status: location.status })),
    ...payload.events.map((event) => ({ id: `event:${event.event_id}`, type: "event", label: event.summary, status: event.status }))
  ];
  const edges = payload.relations.map((relation) => ({
    id: relation.relation_id,
    source: `${relation.source_type}:${relation.source_id}`,
    target: `${relation.target_type}:${relation.target_id}`,
    type: relation.relation_type,
    weight: relation.weight
  }));
  return { nodes, edges };
}

function addManualEvent() {
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
  state.analysis.relations = buildRelations(state.analysis);
  state.selected = { kind: "event", id: event.event_id };
  renderAll();
}

function setAnnotationStatus(kind, id, status) {
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

function editEntity(kind, id, field, value) {
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

function statusButtons(kind, id) {
  return `
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.CONFIRMED}">확정</button>
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.EDITED}">수정</button>
    <button type="button" data-kind="${kind}" data-id="${id}" data-status-action="${STATUS.REJECTED}">제외</button>
  `;
}

function getEntity(kind, id) {
  if (!state.analysis) return null;
  if (kind === "character") return state.analysis.characters.find((item) => item.character_id === id);
  if (kind === "location") return state.analysis.locations.find((item) => item.location_id === id);
  if (kind === "event") return state.analysis.events.find((item) => item.event_id === id);
  return null;
}

function latestStateForCharacter(characterId) {
  return state.analysis.states
    .filter((item) => item.character_id === characterId && item.status !== STATUS.REJECTED && isVisibleSegmentId(item.segment_id))
    .sort((a, b) => segmentOrder(b.segment_id) - segmentOrder(a.segment_id))[0];
}

function nameOf(kind, id) {
  const entity = getEntity(kind, id);
  if (!entity) return id;
  return entity.canonical_name || entity.name || entity.summary || id;
}

function kindLabel(kind) {
  return { character: "인물", location: "장소", event: "사건" }[kind] || kind;
}

function sourceTextForSpan(span) {
  if (!state.analysis || !span) return "";
  const segment = state.analysis.segments.find((item) => span.char_start >= item.char_start && span.char_start <= item.char_end);
  if (!segment) return "";
  return segment.text.slice(span.char_start - segment.char_start, span.char_end - segment.char_start);
}

function renderEvidenceList(items) {
  if (!items.length) return `<p class="muted">현재 범위에 표시 가능한 근거가 없습니다.</p>`;
  return `<ul class="evidence-list">${items.slice(0, 8).map((item) => {
    const segmentId = item.segment_id || item.first_segment_id;
    const text = item.source_span ? sourceTextForSpan(item.source_span) : item.text;
    return `<li><button type="button" class="link-button" data-focus-segment="${escapeAttr(segmentId || "")}">${escapeHtml(segmentId || "")}</button> ${escapeHtml(text || "")}</li>`;
  }).join("")}</ul>`;
}

function focusSegment(segmentId) {
  const segment = state.analysis?.segments.find((item) => item.segment_id === segmentId);
  if (!segment) return;
  state.currentSegment = segment.index;
  renderAll();
}

function renderMiniEvent(event) {
  return `
    <article class="mini-event">
      <span class="tag event">${EVENT_LABELS[event.type] || event.type}</span>
      <p>${escapeHtml(event.summary)}</p>
    </article>
  `;
}

function activateTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${name}Tab`));
}

function statusMatches(status) {
  if (state.filters.status === "all") return true;
  if (state.filters.status === "active") return status !== STATUS.REJECTED;
  return status === state.filters.status;
}

function statusClass(status) {
  return `status-${status || STATUS.SUGGESTED}`;
}

function matchesEntityFilter(kind, id) {
  return state.filters.entity === "all" || state.filters.entity === `${kind}:${id}`;
}

function isVisibleSegmentId(segmentId) {
  const order = segmentOrder(segmentId);
  if (!order) return false;
  return !state.spoilerSafe || order <= state.currentSegment;
}

function isCurrentSegmentId(segmentId) {
  return segmentOrder(segmentId) === state.currentSegment;
}

function segmentOrder(segmentId) {
  return state.analysis?.segments.find((segment) => segment.segment_id === segmentId)?.index || 0;
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function summarizeText(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function makeId(prefix, index) {
  return `${prefix}_${String(index + 1).padStart(3, "0")}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function svgEl(name, attrs) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function drawSvgText(text, x, y, className) {
  const node = svgEl("text", { x, y, class: className });
  node.textContent = text;
  els.spaceGraph.appendChild(node);
}

function flashButton(button, text) {
  const previous = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}
