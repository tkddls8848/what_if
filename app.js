"use strict";

const SAMPLE_TEXT_URL = "texts/wings.txt";
const MAP_TIMELINE_WINDOW = 10;
const sampleText = await loadInitialSampleText();

const knownCharacters = [
  {
    canonical: "나",
    aliases: ["나", "나는", "내", "내가", "나를", "나의", "내게", "나도"],
    role: "화자",
    appearance_text: "야위고 창백한 26세 남성, 빛이 검은 골덴 양복과 하이넥 스웨터",
    appearance_traits: ["창백", "야윔", "검은 의복", "수염 자람"],
    personality_traits: ["무기력", "사색적", "자의식 강함", "의존적", "관찰자적"],
    initial_mental_state: "정체"
  },
  {
    canonical: "아내",
    aliases: ["아내", "아내가", "아내는", "아내의", "아내에게", "아내도", "그녀"],
    role: "배우자",
    real_name: "연심",
    appearance_text: "33번지에서 가장 작고 아름다운 여인, 화려한 치마저고리와 진솔 버선",
    appearance_traits: ["작고 아름다움", "화려한 옷차림", "화장대 소유"],
    personality_traits: ["통제적", "신비", "정중함", "내객 응대"],
    initial_mental_state: "거리 유지"
  },
  {
    canonical: "내객",
    aliases: ["내객", "내객들", "손님"],
    role: "방문자",
    appearance_text: "익명의 서너 사람, 자정 즈음에 돌아감",
    appearance_traits: [],
    personality_traits: ["익명", "교양 편차"],
    initial_mental_state: "방문"
  },
  {
    canonical: "낯선 남자",
    aliases: ["낯선 남자", "그 남자", "낯설은 남자"],
    role: "특정 남자",
    appearance_text: "결말부 아내와 함께 나타나는 특정 남자",
    appearance_traits: [],
    personality_traits: ["수수께끼"],
    initial_mental_state: "외부"
  },
  {
    canonical: "18가구 사람들",
    aliases: ["18가구", "18 가구", "송이송이 꽃", "젊은 여인"],
    role: "주변 인물",
    appearance_text: "33번지에 사는 송이송이 꽃과 같이 젊은 여인들",
    appearance_traits: ["젊음"],
    personality_traits: ["익명 군중"],
    initial_mental_state: "배경"
  }
];

const locationSeeds = [
  {
    canonical: "33번지",
    aliases: ["33번지", "이 33번지"],
    type: "residential",
    is_fictional: false,
    real_world_candidate: "1930년대 경성 사창가 구조 추정",
    narrative_coords: { x: 450, y: 300 },
    symbolic_meaning: "유곽 같은 구조의 18가구 거주 공간"
  },
  {
    canonical: "내 방",
    aliases: ["내 방", "윗방", "이 방", "일곱째 칸"],
    type: "interior",
    is_fictional: true,
    parent: "33번지",
    narrative_coords: { x: 280, y: 360 },
    symbolic_meaning: "해 안 드는 화자의 고립과 폐쇄"
  },
  {
    canonical: "아내 방",
    aliases: ["아내 방", "아내의 방", "아랫방"],
    type: "interior",
    is_fictional: true,
    parent: "33번지",
    narrative_coords: { x: 450, y: 360 },
    symbolic_meaning: "햇볕 드는 화려한 공간, 화장대와 향기"
  },
  {
    canonical: "변소",
    aliases: ["변소"],
    type: "interior",
    is_fictional: true,
    parent: "33번지",
    narrative_coords: { x: 580, y: 410 },
    symbolic_meaning: "벙어리(저금통)를 버린 작은 반항의 공간"
  },
  {
    canonical: "거리",
    aliases: ["거리", "한길", "길가", "이 거리", "저 거리"],
    type: "exterior",
    is_fictional: false,
    real_world_candidate: "1930년대 경성 도심 거리",
    narrative_coords: { x: 450, y: 470 },
    symbolic_meaning: "외부 세계, 자유와 피로의 공존"
  },
  {
    canonical: "경성역",
    aliases: ["경성역", "경성역 시계", "일 이등 대합실", "티이루움"],
    type: "public",
    is_fictional: false,
    real_world_candidate: "경성역 (현 서울역)",
    real_coords: { lat: 37.5550, lng: 126.9707 },
    geocode_source: "manual",
    narrative_coords: { x: 720, y: 470 },
    symbolic_meaning: "정확한 시계, 자정의 통제, 익명성"
  },
  {
    canonical: "산",
    aliases: ["산"],
    type: "symbolic",
    is_fictional: true,
    narrative_coords: { x: 180, y: 200 },
    symbolic_meaning: "아달린 발견 후 도피처, 자기 파괴와 회복"
  },
  {
    canonical: "미쓰꼬시 옥상",
    aliases: ["미쓰꼬시", "미쓰꼬시 옥상", "옥상"],
    type: "symbolic",
    is_fictional: false,
    real_world_candidate: "미쓰코시 백화점 경성지점 (현 신세계백화점 본점)",
    real_coords: { lat: 37.5605, lng: 126.9819 },
    geocode_source: "manual",
    narrative_coords: { x: 720, y: 130 },
    symbolic_meaning: "근대 소비문화의 정점에서의 비상 욕망"
  }
];

const eventLexicon = [
  { type: "movement", words: ["갔다", "나갔다", "걸었", "돌아왔", "떠났", "향했", "들어갔", "나왔", "올라갔", "내려갔", "외출", "찾아갔", "쏘다녔", "헤매었", "방황", "건너갔"] },
  { type: "conversation", words: ["말", "이야기", "목소리", "불렸", "물었", "대답", "웃는", "소곤", "속삭"] },
  { type: "perception", words: ["보았", "들었", "느꼈", "알 수", "생각", "바라보", "떠올", "내려다보", "들여다보", "바라보았", "회고"] },
  { type: "conflict", words: ["걸려", "닫혔", "불안", "갈등", "멀어지", "거슬", "이상하게", "노기", "발악", "꾸지람", "감금"] },
  { type: "realization", words: ["깨달", "알게 되었", "알 수 없었", "느껴졌", "알았다", "알게", "발견"] },
  { type: "stasis", words: ["잔다", "잠들었", "누웠", "누워", "멍하니", "천장", "뒹굴", "의식을 잃", "졸려"] },
  { type: "symbolic", words: ["날개", "날자", "날아", "박제", "은화", "백지", "자유", "벙어리", "사이렌", "겨드랑이", "금붕어", "아달린"] }
];

// 「날개」 인물 동적 변화 규칙: 키워드 매칭 시 trait 변경
// segment.text에 모든 match 키워드가 포함된 첫 segment에서 변화 발생
const traitChangeRules = [
  {
    character_canonical: "나",
    triggers: [
      { match: ["깨달았다", "내객들"], change: { trait_key: "mental_state", value: "호기심" } },
      { match: ["벙어리를 변소"], change: { trait_key: "add_trait", value: "반항" } },
      { match: ["밖으로 나왔다", "은화를 지폐"], change: { trait_key: "mental_state", value: "외부 지향" } },
      { match: ["오 원", "쥐어 준"], change: { trait_key: "mental_state", value: "쾌감 발견" } },
      { match: ["아내 방", "맨 처음"], change: { trait_key: "add_trait", value: "관계 변화" } },
      { match: ["아달린", "발견"], change: { trait_key: "mental_state", value: "충격" } },
      { match: ["산을 찾아 올라"], change: { trait_key: "add_trait", value: "도피" } },
      { match: ["미쓰꼬시 옥상"], change: { trait_key: "mental_state", value: "절망" } },
      { match: ["겨드랑이", "날개"], change: { trait_key: "mental_state", value: "비상 욕망" } },
      { match: ["날개야", "다시 돋아"], change: { trait_key: "add_trait", value: "각성" } }
    ]
  },
  {
    character_canonical: "아내",
    triggers: [
      { match: ["노기", "바르르"], change: { trait_key: "stance_to_narrator", value: "노기" } },
      { match: ["미소", "팔을 이끄"], change: { trait_key: "stance_to_narrator", value: "호의" } },
      { match: ["아달린", "한 달"], change: { trait_key: "add_trait", value: "음모" } },
      { match: ["발악", "도둑질"], change: { trait_key: "stance_to_narrator", value: "발악" } }
    ]
  }
];

const state = {
  work: null,
  segments: [],
  scenes: [],
  characters: [],
  locations: [],
  events: [],
  states: [],
  edges: [],
  currentSegment: 1,
  spoilerSafe: true,
  exportFormat: "json"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  sourceText: $("#sourceText"),
  loadSampleBtn: $("#loadSampleBtn"),
  analyzeBtn: $("#analyzeBtn"),
  exportJsonBtn: $("#exportJsonBtn"),
  exportCsvBtn: $("#exportCsvBtn"),
  exportMdBtn: $("#exportMdBtn"),
  readerStats: $("#readerStats"),
  readerPosition: $("#readerPosition"),
  readerPositionLabel: $("#readerPositionLabel"),
  spoilerToggle: $("#spoilerToggle"),
  paragraphList: $("#paragraphList"),
  spaceGraph: $("#spaceGraph"),
  mapStats: $("#mapStats"),
  evidenceList: $("#evidenceList"),
  eventTypeFilter: $("#eventTypeFilter"),
  timelineList: $("#timelineList"),
  characterStats: $("#characterStats"),
  characterCards: $("#characterCards"),
  characterEditor: $("#characterEditor"),
  locationEditor: $("#locationEditor"),
  eventEditor: $("#eventEditor"),
  rebuildBtn: $("#rebuildBtn"),
  exportOutput: $("#exportOutput"),
  copyExportBtn: $("#copyExportBtn")
};

function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+/g, " ")
    .trim();
}

function splitSentences(text) {
  const matches = text.match(/[^.!?。！？\n]+[.!?。！？]?/g);
  return (matches || [text]).map((sentence) => sentence.trim()).filter(Boolean);
}

function includesAlias(text, aliases) {
  return aliases.some((alias) => text.includes(alias));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function makeId(prefix, index) {
  return `${prefix}${String(index + 1).padStart(3, "0")}`;
}

function analyzeText(rawText) {
  const text = normalizeText(rawText);
  const paragraphs = text ? text.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean) : [];
  let cursor = 0;

  const segments = paragraphs.map((paragraph, index) => {
    const start = text.indexOf(paragraph, cursor);
    const end = start + paragraph.length;
    cursor = end;
    return {
      segment_id: makeId("P", index),
      work_id: "W001",
      order: index + 1,
      start_char: start,
      end_char: end,
      text: paragraph,
      scene_id: "",
      spoiler_level: "reader_visible"
    };
  });

  const sceneSize = Math.max(1, Math.ceil(segments.length / Math.min(8, Math.max(1, segments.length))));
  const scenes = [];
  segments.forEach((segment, index) => {
    const sceneIndex = Math.floor(index / sceneSize);
    const sceneId = makeId("S", sceneIndex);
    segment.scene_id = sceneId;
    if (!scenes[sceneIndex]) {
      scenes[sceneIndex] = {
        scene_id: sceneId,
        work_id: "W001",
        order: sceneIndex + 1,
        title: `장면 ${sceneIndex + 1}`,
        summary: "",
        start_segment_id: segment.segment_id,
        end_segment_id: segment.segment_id,
        dominant_location_id: "",
        narrator_state: "",
        confidence: 0.68
      };
    }
    scenes[sceneIndex].end_segment_id = segment.segment_id;
  });

  const characters = extractCharacters(segments);
  const locations = extractLocations(segments);
  linkLocationParents(locations);
  const events = extractEvents(segments, characters, locations);
  applyTraitChangeRules(characters, segments, events);
  const states = buildCharacterStates(segments, characters, locations, events);
  const edges = buildEdges(events, locations);

  scenes.forEach((scene) => {
    const sceneSegments = segments.filter((segment) => segment.scene_id === scene.scene_id);
    const sceneEvents = events.filter((event) => event.scene_id === scene.scene_id);
    const locationCounts = countBy(sceneEvents.flatMap((event) => event.locations));
    const dominantLocation = Object.entries(locationCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    scene.summary = summarizeScene(sceneSegments, sceneEvents);
    scene.dominant_location_id = locations.find((location) => location.canonical_name === dominantLocation)?.location_id || "";
    scene.narrator_state = inferMentalState(sceneSegments.map((segment) => segment.text).join(" "));
  });

  return {
    work: {
      work_id: "W001",
      title: "Untitled Work",
      author: "",
      publication_year: "",
      source_url: "",
      source_accessed_at: new Date().toISOString().slice(0, 10),
      copyright_note: "User supplied text",
      raw_text_hash: hashText(text)
    },
    segments,
    scenes,
    characters,
    locations,
    events,
    states,
    edges
  };
}

function extractCharacters(segments) {
  const results = [];

  knownCharacters.forEach((seed) => {
    const hits = segments.filter((segment) => includesAlias(segment.text, seed.aliases));
    if (!hits.length) return;
    results.push({
      character_id: makeId("C", results.length),
      work_id: "W001",
      canonical_name: seed.canonical,
      aliases: seed.aliases,
      description: `${seed.role}로 추정됨`,
      first_appearance_segment_id: hits[0].segment_id,
      role: seed.role,
      real_name: seed.real_name || "",
      appearance: {
        text: seed.appearance_text || "",
        traits: [...(seed.appearance_traits || [])],
        evidence_segment_ids: hits.slice(0, 2).map((s) => s.segment_id),
        last_updated_by_event: null
      },
      personality: {
        traits: [...(seed.personality_traits || [])],
        evidence_segment_ids: hits.slice(0, 2).map((s) => s.segment_id),
        last_updated_by_event: null
      },
      initial_mental_state: seed.initial_mental_state || "미정",
      dynamic_traits: [],
      confidence: confidenceFromHits(hits.length, segments.length),
      evidence_segment_ids: hits.slice(0, 3).map((segment) => segment.segment_id),
      evidence: hits.slice(0, 3).map((segment) => firstSentence(segment.text))
    });
  });

  const namePattern = /([가-힣]{2,4})(?:은|는|이|가|을|를|에게|와|과|도|의)\b/g;
  const stopNames = new Set(["나는", "내가", "아내", "방문", "거리", "사람", "문밖", "다음", "마지막", "그곳", "그들"]);
  const found = new Map();
  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(namePattern)) {
      const name = match[1];
      if (stopNames.has(name) || locationSeeds.some((seed) => seed.aliases.includes(name))) continue;
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(segment);
    }
  });

  found.forEach((hits, name) => {
    if (results.some((character) => character.canonical_name === name)) return;
    if (hits.length < 1) return;
    results.push({
      character_id: makeId("C", results.length),
      work_id: "W001",
      canonical_name: name,
      aliases: [name],
      description: "원문에서 자동 감지된 인물 후보",
      first_appearance_segment_id: hits[0].segment_id,
      role: "인물 후보",
      confidence: confidenceFromHits(hits.length, segments.length) * 0.75,
      evidence_segment_ids: hits.slice(0, 2).map((segment) => segment.segment_id),
      evidence: hits.slice(0, 2).map((segment) => firstSentence(segment.text))
    });
  });

  return results;
}

function extractLocations(segments) {
  const results = [];

  locationSeeds.forEach((seed) => {
    const hits = segments.filter((segment) => includesAlias(segment.text, seed.aliases));
    if (!hits.length) return;
    results.push({
      location_id: makeId("L", results.length),
      work_id: "W001",
      canonical_name: seed.canonical,
      aliases: seed.aliases,
      type: seed.type,
      description: seed.symbolic_meaning || `${seed.type} 공간`,
      is_fictional: seed.is_fictional ?? true,
      real_world_candidate: seed.real_world_candidate || "",
      real_coords: seed.real_coords || null,
      geocode_source: seed.geocode_source || null,
      narrative_coords: seed.narrative_coords || null,
      symbolic_meaning: seed.symbolic_meaning || "",
      parent_location_id: "",
      parent_canonical: seed.parent || "",
      first_appearance_segment_id: hits[0].segment_id,
      confidence: confidenceFromHits(hits.length, segments.length),
      evidence_segment_ids: hits.slice(0, 3).map((segment) => segment.segment_id),
      evidence: hits.slice(0, 3).map((segment) => firstSentence(segment.text))
    });
  });

  const locationPattern = /([가-힣A-Za-z0-9 ]{1,12}(?:방|집|거리|길|문|학교|역|정원|옥상|백화점|시장|골목|강|바다|산|도시|마을))/g;
  const found = new Map();
  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(locationPattern)) {
      const name = match[1].trim();
      if (name.length < 2 || results.some((location) => location.aliases.includes(name))) continue;
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(segment);
    }
  });

  found.forEach((hits, name) => {
    results.push({
      location_id: makeId("L", results.length),
      work_id: "W001",
      canonical_name: name,
      aliases: [name],
      type: "inferred",
      description: "원문에서 자동 감지된 장소 후보",
      real_world_candidate: "",
      parent_location_id: "",
      confidence: confidenceFromHits(hits.length, segments.length) * 0.72,
      evidence_segment_ids: hits.slice(0, 2).map((segment) => segment.segment_id),
      evidence: hits.slice(0, 2).map((segment) => firstSentence(segment.text))
    });
  });

  return results;
}

function extractEvents(segments, characters, locations) {
  const events = [];

  segments.forEach((segment) => {
    const sentences = splitSentences(segment.text);
    sentences.forEach((sentence) => {
      const type = inferEventType(sentence);
      const eventCharacters = characters
        .filter((character) => includesAlias(sentence, character.aliases))
        .map((character) => character.canonical_name);
      const eventLocations = locations
        .filter((location) => includesAlias(sentence, location.aliases))
        .map((location) => location.canonical_name);

      if (type === "background" && !eventCharacters.length && !eventLocations.length) return;

      events.push({
        event_id: makeId("E", events.length),
        work_id: "W001",
        scene_id: segment.scene_id,
        order: events.length + 1,
        event_type: type === "background" && eventCharacters.length ? "appearance" : type,
        summary: summarizeSentence(sentence),
        characters: unique(eventCharacters),
        locations: unique(eventLocations),
        evidence_segment_ids: [segment.segment_id],
        evidence: [sentence],
        certainty: inferCertainty(sentence),
        reader_visible_after_segment_id: segment.segment_id
      });
    });
  });

  return events;
}

function buildCharacterStates(segments, characters, locations, events) {
  const states = [];

  characters.forEach((character) => {
    let currentLocation = "";
    let mentalState = "미정";
    const knownFacts = [];

    segments.forEach((segment) => {
      const segmentEvents = events.filter((event) => event.evidence_segment_ids.includes(segment.segment_id));
      const characterEvents = segmentEvents.filter((event) => event.characters.includes(character.canonical_name));
      if (!characterEvents.length && !includesAlias(segment.text, character.aliases)) return;

      const location = locations.find((candidate) => includesAlias(segment.text, candidate.aliases));
      if (location) currentLocation = location.location_id;
      mentalState = inferMentalState(segment.text);
      knownFacts.push(...characterEvents.map((event) => event.summary));

      states.push({
        state_id: makeId("ST", states.length),
        character_id: character.character_id,
        segment_id: segment.segment_id,
        physical_location_id: currentLocation,
        mental_state: mentalState,
        relation_changes: inferRelationChange(segment.text, character.canonical_name),
        known_facts: unique(knownFacts).slice(-4),
        uncertainty_note: mentalState === "미정" ? "상태 근거가 약함" : ""
      });
    });
  });

  return states;
}

function linkLocationParents(locations) {
  locations.forEach((loc) => {
    if (loc.parent_canonical) {
      const parent = locations.find((p) => p.canonical_name === loc.parent_canonical);
      loc.parent_location_id = parent ? parent.location_id : "";
    }
  });
}

function applyTraitChangeRules(characters, segments) {
  characters.forEach((character) => {
    character.dynamic_traits = [];
    const ruleSet = traitChangeRules.find(
      (r) => r.character_canonical === character.canonical_name
    );
    if (!ruleSet) return;

    let currentMentalState = character.initial_mental_state || "미정";

    ruleSet.triggers.forEach((rule) => {
      const matchedSegment = segments.find((seg) =>
        rule.match.every((kw) => seg.text.includes(kw))
      );
      if (!matchedSegment) return;

      const trait_key = rule.change.trait_key;
      const value = rule.change.value;
      const previous_value = trait_key === "mental_state" ? currentMentalState : "";

      character.dynamic_traits.push({
        trait_key,
        value,
        previous_value,
        segment_id: matchedSegment.segment_id,
        changed_by_event_id: ""
      });

      if (trait_key === "mental_state") {
        currentMentalState = value;
      }
    });

    character.dynamic_traits.sort(
      (a, b) => segmentOrderById(a.segment_id) - segmentOrderById(b.segment_id)
    );
  });
}

function characterStateAt(character, segmentOrder) {
  const applied = (character.dynamic_traits || []).filter(
    (dt) => segmentOrderById(dt.segment_id) <= segmentOrder
  );

  let mentalState = character.initial_mental_state || "미정";
  let stance = "";
  const traits = [...((character.personality && character.personality.traits) || [])];

  applied.forEach((dt) => {
    if (dt.trait_key === "mental_state") {
      mentalState = dt.value;
    } else if (dt.trait_key === "stance_to_narrator") {
      stance = dt.value;
    } else if (dt.trait_key === "add_trait") {
      if (!traits.includes(dt.value)) traits.push(dt.value);
    } else if (dt.trait_key === "remove_trait") {
      const idx = traits.indexOf(dt.value);
      if (idx >= 0) traits.splice(idx, 1);
    }
  });

  return { mentalState, stance, traits, applied };
}

function buildEdges(events, locations) {
  const edges = [];
  let previousLocation = "";

  events.forEach((event) => {
    const firstLocation = event.locations[0] || "";
    if (event.event_type === "movement" && previousLocation && firstLocation && previousLocation !== firstLocation) {
      edges.push({
        edge_id: makeId("G", edges.length),
        source_type: "location",
        source_id: locationIdByName(locations, previousLocation),
        target_type: "location",
        target_id: locationIdByName(locations, firstLocation),
        relation_type: "moves_to",
        evidence_segment_ids: event.evidence_segment_ids,
        certainty: event.certainty
      });
    }
    if (firstLocation) previousLocation = firstLocation;
  });

  if (edges.length === 0 && locations.length > 1) {
    for (let index = 0; index < locations.length - 1; index += 1) {
      edges.push({
        edge_id: makeId("G", edges.length),
        source_type: "location",
        source_id: locations[index].location_id,
        target_type: "location",
        target_id: locations[index + 1].location_id,
        relation_type: "associated_with",
        evidence_segment_ids: unique([
          ...(locations[index].evidence_segment_ids || []),
          ...(locations[index + 1].evidence_segment_ids || [])
        ]).slice(0, 2),
        certainty: "inferred"
      });
    }
  }

  return edges;
}

function inferEventType(sentence) {
  for (const item of eventLexicon) {
    if (item.words.some((word) => sentence.includes(word))) return item.type;
  }
  return "background";
}

function inferCertainty(sentence) {
  if (/같|듯|아마|추정|분명하지|확실하지|인지/.test(sentence)) return "inferred";
  if (/상징|꿈|생각|떠올/.test(sentence)) return "symbolic";
  return "explicit";
}

function inferMentalState(text) {
  if (/불안|두려|알 수 없|확실하지|분명하지/.test(text)) return "불안정";
  if (/생각|떠올|느꼈|느껴/.test(text)) return "성찰";
  if (/말없이|침묵|누워|오래/.test(text)) return "정체";
  if (/밝|햇빛|나갔|걸었/.test(text)) return "외부 지향";
  return "미정";
}

function inferRelationChange(text, characterName) {
  if (characterName === "아내" && /바라보|말없이|닫혔|사이/.test(text)) return "거리감 증가";
  if (/이야기|말|불렸/.test(text)) return "접촉 발생";
  return "";
}

function confidenceFromHits(hitCount, total) {
  const base = total ? hitCount / total : 0;
  return Math.min(0.96, Math.max(0.45, 0.48 + base));
}

function firstSentence(text) {
  return splitSentences(text)[0] || text;
}

function summarizeSentence(sentence) {
  return sentence.length > 86 ? `${sentence.slice(0, 84)}...` : sentence;
}

function summarizeScene(segments, events) {
  if (events.length) return events.slice(0, 2).map((event) => event.summary).join(" ");
  return summarizeSentence(segments.map((segment) => segment.text).join(" "));
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function locationIdByName(locations, name) {
  return locations.find((location) => location.canonical_name === name)?.location_id || "";
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return `h${Math.abs(hash)}`;
}

function runAnalysis() {
  const result = analyzeText(els.sourceText.value);
  Object.assign(state, result);
  state.currentSegment = Math.min(Math.max(1, state.currentSegment), Math.max(1, state.segments.length));
  els.readerPosition.max = String(Math.max(1, state.segments.length));
  els.readerPosition.value = String(state.currentSegment);
  render();
}

async function loadInitialSampleText() {
  try {
    const response = await fetch(SAMPLE_TEXT_URL);
    if (!response.ok) {
      throw new Error(`Failed to load ${SAMPLE_TEXT_URL}: ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    console.error(error);
    return "";
  }
}

function initApp() {
  bindEvents();
  els.sourceText.value = sampleText;
  if (!sampleText) {
    els.sourceText.placeholder = "texts/wings.txt를 불러오지 못했습니다. 로컬 서버로 실행하세요.";
  }
  runAnalysis();
}

function visibleSegmentLimit() {
  return state.spoilerSafe ? state.currentSegment : Number.MAX_SAFE_INTEGER;
}

function segmentOrderById(segmentId) {
  if (!segmentId) return Infinity;
  return state.segments.find((segment) => segment.segment_id === segmentId)?.order ?? Infinity;
}

function isVisibleAfter(segmentId) {
  return segmentOrderById(segmentId) <= visibleSegmentLimit();
}

function visibleEvents() {
  return state.events.filter((event) => isVisibleAfter(event.reader_visible_after_segment_id));
}

function currentTimelineEvents() {
  const currentSegmentId = state.segments[state.currentSegment - 1]?.segment_id || "";
  const filter = els.eventTypeFilter?.value || "all";
  return visibleEvents().filter((event) => {
    const belongsToCurrentTimeline = event.evidence_segment_ids.includes(currentSegmentId);
    const matchesFilter = filter === "all" || event.event_type === filter;
    return belongsToCurrentTimeline && matchesFilter;
  });
}

function recentTimelineEvents(limit = MAP_TIMELINE_WINDOW) {
  const filter = els.eventTypeFilter?.value || "all";
  return state.events
    .filter((event) => {
      const isBeforeReader = segmentOrderById(event.reader_visible_after_segment_id) <= state.currentSegment;
      const matchesFilter = filter === "all" || event.event_type === filter;
      return isBeforeReader && matchesFilter;
    })
    .slice(-limit);
}

function render() {
  renderReader();
  renderGraph();
  renderEvidence();
  renderTimeline();
  renderCharacters();
  renderEditors();
  renderExport();
}

function renderReader() {
  els.readerStats.textContent = `${state.segments.length} 문단`;
  els.readerPositionLabel.textContent = `${state.currentSegment} / ${Math.max(1, state.segments.length)}`;
  els.paragraphList.innerHTML = "";

  if (!state.segments.length) {
    els.paragraphList.innerHTML = `<div class="empty-state">분석할 원문을 입력하세요.</div>`;
    return;
  }

  state.segments.forEach((segment) => {
    const item = document.createElement("article");
    item.className = "paragraph-item";
    if (segment.order === state.currentSegment) item.classList.add("current");
    if (state.spoilerSafe && segment.order > state.currentSegment) item.classList.add("spoiler");
    item.innerHTML = `
      <div class="paragraph-number">${segment.segment_id}</div>
      <p class="paragraph-text">${escapeHtml(segment.text)}</p>
    `;
    item.addEventListener("click", () => {
      state.currentSegment = segment.order;
      els.readerPosition.value = String(segment.order);
      render();
    });
    els.paragraphList.appendChild(item);
  });
}

function renderGraph() {
  const graphEvents = recentTimelineEvents();
  const graphLocNames = new Set(graphEvents.flatMap((event) => event.locations));
  const visibleLocs = state.locations.filter((location) => graphLocNames.has(location.canonical_name));

  const currentSegmentId = state.segments[state.currentSegment - 1]?.segment_id || "";
  const currentEvents = graphEvents.filter((e) =>
    e.evidence_segment_ids.includes(currentSegmentId)
  );
  const currentLocNames = new Set(currentEvents.flatMap((e) => e.locations));
  const fallbackCurrentLoc = latestTimelineLocationId(graphEvents);

  const graphSegmentIds = new Set(graphEvents.flatMap((event) => event.evidence_segment_ids));
  const visibleLocIds = new Set(visibleLocs.map((l) => l.location_id));
  const edges = state.edges.filter(
    (edge) =>
      visibleLocIds.has(edge.source_id) &&
      visibleLocIds.has(edge.target_id) &&
      edge.evidence_segment_ids.some((sid) => graphSegmentIds.has(sid))
  );

  els.mapStats.textContent = `${visibleLocs.length} 노드 · 최근 ${graphEvents.length} 이벤트`;
  els.spaceGraph.innerHTML = "";

  if (!visibleLocs.length) {
    drawSvgText("최근 10개 타임라인에 서술된 장소가 없습니다.", 450, 280, "graph-label");
    return;
  }

  // 4) 위치 배치: narrative_coords 우선, 없으면 원형 fallback
  const centerX = 450;
  const centerY = 280;
  const radius = Math.min(230, 110 + visibleLocs.length * 18);
  const positions = new Map();
  visibleLocs.forEach((location, index) => {
    if (location.narrative_coords) {
      positions.set(location.location_id, { ...location.narrative_coords });
    } else {
      const angle = (Math.PI * 2 * index) / visibleLocs.length - Math.PI / 2;
      const x = visibleLocs.length === 1 ? centerX : centerX + Math.cos(angle) * radius;
      const y = visibleLocs.length === 1 ? centerY : centerY + Math.sin(angle) * radius * 0.72;
      positions.set(location.location_id, { x, y });
    }
  });

  // 5) 엣지 렌더
  edges.forEach((edge) => {
    const source = positions.get(edge.source_id);
    const target = positions.get(edge.target_id);
    if (!source || !target) return;
    const line = svgEl("line", {
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      class: `graph-edge ${edge.certainty}`
    });
    els.spaceGraph.appendChild(line);
  });

  // 6) 노드 렌더 (실제/허구 구분)
  visibleLocs.forEach((location) => {
    const position = positions.get(location.location_id);
    const isReal = location.is_fictional === false;
    const isCurrent =
      currentLocNames.has(location.canonical_name) ||
      (currentLocNames.size === 0 && location.location_id === fallbackCurrentLoc);

    const group = svgEl("g", {
      class: `graph-node-group ${isReal ? "real" : "fictional"} ${isCurrent ? "current" : ""}`,
      "data-location-id": location.location_id
    });

    if (isReal) {
      // 실제 장소: 핀 모양 (원 + 삼각형 꼭지)
      const pinPath = svgEl("path", {
        d: `M ${position.x} ${position.y - 38}
            a 22 22 0 1 0 0.01 0
            M ${position.x - 12} ${position.y - 18}
            L ${position.x} ${position.y}
            L ${position.x + 12} ${position.y - 18}
            Z`,
        class: `graph-node real ${isCurrent ? "current" : ""}`
      });
      group.appendChild(pinPath);
    } else {
      // 허구 장소: 원형
      const circle = svgEl("circle", {
        cx: position.x,
        cy: position.y - 18,
        r: 28,
        class: `graph-node fictional ${isCurrent ? "current" : ""}`
      });
      group.appendChild(circle);
    }

    const label = svgEl("text", {
      x: position.x,
      y: position.y + 8,
      class: "graph-label"
    });
    label.textContent = location.canonical_name;

    const caption = svgEl("text", {
      x: position.x,
      y: position.y + 24,
      class: "graph-caption"
    });
    caption.textContent = isReal
      ? `실제 · ${location.real_world_candidate ? "좌표 " + (location.real_coords ? "✓" : "—") : location.type}`
      : `허구 · ${location.type}`;

    const title = svgEl("title", {});
    title.textContent =
      location.symbolic_meaning ||
      location.real_world_candidate ||
      location.canonical_name;

    group.append(label, caption, title);
    group.addEventListener("click", () => {
      const firstSeg = location.evidence_segment_ids?.[0];
      if (firstSeg) focusSegment(firstSeg);
    });
    els.spaceGraph.appendChild(group);
  });
}

function renderEvidence() {
  const events = visibleEvents().slice(-8).reverse();
  els.evidenceList.innerHTML = "";
  if (!events.length) {
    els.evidenceList.innerHTML = `<div class="empty-state">표시할 근거가 없습니다.</div>`;
    return;
  }
  events.forEach((event) => {
    const item = document.createElement("article");
    item.className = "evidence-item";
    item.innerHTML = `
      <div class="tag-row">
        <span class="tag fact">${event.event_id}</span>
        <span class="tag ${event.certainty}">${labelCertainty(event.certainty)}</span>
        <span class="tag">${labelEvent(event.event_type)}</span>
      </div>
      <p>${escapeHtml(event.evidence[0] || event.summary)}</p>
    `;
    els.evidenceList.appendChild(item);
  });
}

function renderTimeline() {
  const filter = els.eventTypeFilter.value;
  const events = visibleEvents().filter((event) => filter === "all" || event.event_type === filter);
  els.timelineList.innerHTML = "";
  if (!events.length) {
    els.timelineList.innerHTML = `<div class="empty-state">표시할 사건이 없습니다.</div>`;
    return;
  }
  events.forEach((event) => {
    const item = document.createElement("article");
    item.className = "timeline-item";
    item.innerHTML = `
      <div class="timeline-index">
        <strong>${event.event_id}</strong><br>
        ${event.scene_id}
      </div>
      <div>
        <div class="tag-row">
          <span class="tag">${labelEvent(event.event_type)}</span>
          <span class="tag ${event.certainty}">${labelCertainty(event.certainty)}</span>
          ${event.characters.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("")}
          ${event.locations.map((name) => `<span class="tag fact">${escapeHtml(name)}</span>`).join("")}
        </div>
        <p>${escapeHtml(event.summary)}</p>
      </div>
    `;
    item.addEventListener("click", () => focusSegment(event.evidence_segment_ids[0]));
    els.timelineList.appendChild(item);
  });
}

function renderCharacters() {
  const visible = state.characters.filter((c) =>
    isVisibleAfter(c.first_appearance_segment_id)
  );
  els.characterStats.textContent = `${visible.length} / ${state.characters.length} 명`;
  els.characterCards.innerHTML = "";
  if (!visible.length) {
    els.characterCards.innerHTML = `<div class="empty-state">현재 시점에 등장한 인물이 없습니다.</div>`;
    return;
  }

  visible.forEach((character) => {
    const stateNow = characterStateAt(character, state.currentSegment);
    const lastChange = stateNow.applied[stateNow.applied.length - 1];
    const physicalState = latestStatesForCharacter(character.character_id);
    const physLoc = state.locations.find(
      (l) => l.location_id === physicalState?.physical_location_id
    );

    const appearance = character.appearance || { text: "", traits: [] };
    const personality = character.personality || { traits: [] };

    const appearanceTagsHtml = (appearance.traits || [])
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join("");
    const personalityTagsHtml = stateNow.traits
      .map((t) => {
        const isAdded = stateNow.applied.some(
          (dt) => dt.trait_key === "add_trait" && dt.value === t
        );
        return `<span class="tag ${isAdded ? "added" : ""}">${escapeHtml(t)}</span>`;
      })
      .join("");

    const changeHistoryHtml = stateNow.applied.length
      ? stateNow.applied
          .slice(-5)
          .map((dt) => {
            const seg = state.segments.find((s) => s.segment_id === dt.segment_id);
            const segLabel = seg ? `P${String(seg.order).padStart(3, "0")}` : dt.segment_id;
            const arrow =
              dt.trait_key === "mental_state"
                ? `${escapeHtml(dt.previous_value || "?")} → ${escapeHtml(dt.value)}`
                : dt.trait_key === "add_trait"
                ? `+ ${escapeHtml(dt.value)}`
                : dt.trait_key === "stance_to_narrator"
                ? `관계: ${escapeHtml(dt.value)}`
                : `${escapeHtml(dt.trait_key)}: ${escapeHtml(dt.value)}`;
            const isLast = dt === lastChange;
            return `<li class="${isLast ? "current-change" : ""}">${segLabel} ${arrow}</li>`;
          })
          .join("")
      : `<li class="muted">아직 변화 없음</li>`;

    const card = document.createElement("article");
    card.className = "character-card";
    card.innerHTML = `
      <header class="card-header">
        <h3>${escapeHtml(character.canonical_name)}${
      character.real_name ? ` <small>(${escapeHtml(character.real_name)})</small>` : ""
    }</h3>
        <span class="tag fact">${Math.round(character.confidence * 100)}%</span>
      </header>
      <div class="tag-row">
        <span class="tag">${escapeHtml(character.role || "인물")}</span>
      </div>

      <section class="char-section">
        <h4>외양</h4>
        ${appearance.text ? `<p>${escapeHtml(appearance.text)}</p>` : ""}
        <div class="tag-row">${appearanceTagsHtml}</div>
      </section>

      <section class="char-section">
        <h4>성격 (현재 시점)</h4>
        <div class="tag-row">${personalityTagsHtml}</div>
      </section>

      <section class="char-section">
        <h4>현재 상태 <small>(P${String(state.currentSegment).padStart(3, "0")} 시점)</small></h4>
        <ul class="fact-list">
          <li>심리: <strong>${escapeHtml(stateNow.mentalState)}</strong></li>
          ${stateNow.stance ? `<li>관계: ${escapeHtml(stateNow.stance)}</li>` : ""}
          <li>위치: ${escapeHtml(physLoc?.canonical_name || "미정")}</li>
        </ul>
      </section>

      <section class="char-section">
        <h4>변화 이력</h4>
        <ul class="change-history">${changeHistoryHtml}</ul>
      </section>
    `;

    if (lastChange) {
      card.addEventListener("click", () => {
        const seg = state.segments.find((s) => s.segment_id === lastChange.segment_id);
        if (seg) focusSegment(lastChange.segment_id);
      });
    }

    els.characterCards.appendChild(card);
  });
}

function renderEditors() {
  renderCharacterEditor();
  renderLocationEditor();
  renderEventEditor();
}

function renderCharacterEditor() {
  els.characterEditor.innerHTML = "";
  state.characters.forEach((character) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <input data-kind="character" data-field="canonical_name" data-id="${character.character_id}" value="${escapeAttr(character.canonical_name)}" aria-label="인물명">
      <input data-kind="character" data-field="role" data-id="${character.character_id}" value="${escapeAttr(character.role)}" aria-label="역할">
      <textarea data-kind="character" data-field="description" data-id="${character.character_id}" aria-label="설명">${escapeHtml(character.description)}</textarea>
    `;
    els.characterEditor.appendChild(row);
  });
}

function renderLocationEditor() {
  els.locationEditor.innerHTML = "";
  state.locations.forEach((location) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <input data-kind="location" data-field="canonical_name" data-id="${location.location_id}" value="${escapeAttr(location.canonical_name)}" aria-label="장소명">
      <select data-kind="location" data-field="type" data-id="${location.location_id}" aria-label="장소 유형">
        ${["interior", "exterior", "public", "symbolic", "inferred"].map((type) => `<option value="${type}" ${location.type === type ? "selected" : ""}>${type}</option>`).join("")}
      </select>
      <textarea data-kind="location" data-field="description" data-id="${location.location_id}" aria-label="설명">${escapeHtml(location.description)}</textarea>
    `;
    els.locationEditor.appendChild(row);
  });
}

function renderEventEditor() {
  els.eventEditor.innerHTML = "";
  visibleEvents().forEach((event) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <select data-kind="event" data-field="event_type" data-id="${event.event_id}" aria-label="사건 유형">
        ${["appearance", "movement", "conversation", "perception", "conflict", "realization", "stasis", "symbolic", "background"].map((type) => `<option value="${type}" ${event.event_type === type ? "selected" : ""}>${labelEvent(type)}</option>`).join("")}
      </select>
      <select data-kind="event" data-field="certainty" data-id="${event.event_id}" aria-label="확실성">
        ${["explicit", "inferred", "symbolic"].map((type) => `<option value="${type}" ${event.certainty === type ? "selected" : ""}>${labelCertainty(type)}</option>`).join("")}
      </select>
      <textarea data-kind="event" data-field="summary" data-id="${event.event_id}" aria-label="사건 요약">${escapeHtml(event.summary)}</textarea>
    `;
    els.eventEditor.appendChild(row);
  });
}

function renderExport() {
  if (state.exportFormat === "csv") {
    els.exportOutput.value = toCsv();
  } else if (state.exportFormat === "md") {
    els.exportOutput.value = toMarkdown();
  } else {
    els.exportOutput.value = JSON.stringify(exportPayload(), null, 2);
  }
}

function exportPayload() {
  return {
    work: state.work,
    segments: state.segments,
    scenes: state.scenes,
    characters: state.characters,
    locations: state.locations,
    events: state.events,
    states: state.states,
    graph: state.edges
  };
}

function toCsv() {
  const rows = [["event_id", "scene_id", "type", "certainty", "characters", "locations", "summary", "evidence"]];
  state.events.forEach((event) => {
    rows.push([
      event.event_id,
      event.scene_id,
      event.event_type,
      event.certainty,
      event.characters.join("|"),
      event.locations.join("|"),
      event.summary,
      event.evidence.join(" ")
    ]);
  });
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function toMarkdown() {
  const lines = ["# Novel IF Analysis", "", "## Scenes", ""];
  state.scenes.forEach((scene) => {
    lines.push(`### ${scene.scene_id}. ${scene.title}`, "", scene.summary || "요약 없음", "");
  });
  lines.push("## Characters", "");
  state.characters.forEach((character) => {
    lines.push(`- **${character.canonical_name}**: ${character.role || "인물"} (${Math.round(character.confidence * 100)}%)`);
  });
  lines.push("", "## Events", "");
  state.events.forEach((event) => {
    lines.push(`- ${event.event_id} [${labelEvent(event.event_type)} / ${labelCertainty(event.certainty)}] ${event.summary}`);
  });
  return lines.join("\n");
}

function csvCell(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function latestStatesForCharacter(characterId) {
  return state.states
    .filter((item) => item.character_id === characterId && isVisibleAfter(item.segment_id))
    .sort((a, b) => segmentOrderById(b.segment_id) - segmentOrderById(a.segment_id))[0];
}

function latestVisibleLocationId() {
  const locationEvent = visibleEvents().slice().reverse().find((event) => event.locations.length);
  if (!locationEvent) return "";
  return locationIdByName(state.locations, locationEvent.locations[0]);
}

function latestTimelineLocationId(events) {
  const locationEvent = events.slice().reverse().find((event) => event.locations.length);
  if (!locationEvent) return "";
  return locationIdByName(state.locations, locationEvent.locations[0]);
}

function eventOrLocationFirstSegment(location) {
  return location.evidence_segment_ids?.[0] || "";
}

function focusSegment(segmentId) {
  const segment = state.segments.find((item) => item.segment_id === segmentId);
  if (!segment) return;
  state.currentSegment = segment.order;
  els.readerPosition.value = String(segment.order);
  render();
}

function labelEvent(type) {
  const labels = {
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
  return labels[type] || type;
}

function labelCertainty(type) {
  const labels = {
    explicit: "명시",
    inferred: "추정",
    symbolic: "상징"
  };
  return labels[type] || type;
}

function drawSvgText(text, x, y, className) {
  const node = svgEl("text", { x, y, class: className });
  node.textContent = text;
  els.spaceGraph.appendChild(node);
}

function svgEl(name, attrs) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
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

function bindEvents() {
  els.loadSampleBtn.addEventListener("click", () => {
    els.sourceText.value = sampleText;
    state.currentSegment = 1;
    runAnalysis();
  });

  els.analyzeBtn.addEventListener("click", () => {
    state.currentSegment = 1;
    runAnalysis();
  });

  els.readerPosition.addEventListener("input", (event) => {
    state.currentSegment = Number(event.target.value);
    render();
  });

  els.spoilerToggle.addEventListener("change", (event) => {
    state.spoilerSafe = event.target.checked;
    render();
  });

  els.eventTypeFilter.addEventListener("change", () => {
    renderGraph();
    renderTimeline();
  });

  els.rebuildBtn.addEventListener("click", () => {
    state.edges = buildEdges(state.events, state.locations);
    state.states = buildCharacterStates(state.segments, state.characters, state.locations, state.events);
    render();
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const { kind, field, id } = target.dataset;
    if (!kind || !field || !id) return;
    updateEntity(kind, id, field, target.value);
    renderGraph();
    renderEvidence();
    renderTimeline();
    renderCharacters();
    renderExport();
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.remove("active"));
      $$(".tab-panel").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $(`#${tab.dataset.tab}Tab`).classList.add("active");
    });
  });

  els.exportJsonBtn.addEventListener("click", () => setExportFormat("json"));
  els.exportCsvBtn.addEventListener("click", () => setExportFormat("csv"));
  els.exportMdBtn.addEventListener("click", () => setExportFormat("md"));
  els.copyExportBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.exportOutput.value);
    } catch (_error) {
      els.exportOutput.select();
      document.execCommand("copy");
    }
    els.copyExportBtn.textContent = "복사됨";
    window.setTimeout(() => {
      els.copyExportBtn.textContent = "복사";
    }, 1200);
  });
}

function updateEntity(kind, id, field, value) {
  const collection = {
    character: state.characters,
    location: state.locations,
    event: state.events
  }[kind];
  const idField = {
    character: "character_id",
    location: "location_id",
    event: "event_id"
  }[kind];
  const entity = collection?.find((item) => item[idField] === id);
  if (!entity) return;
  const previousValue = entity[field];
  entity[field] = value;
  if (field === "canonical_name") {
    entity.aliases = unique([value, ...(entity.aliases || []).filter((alias) => alias !== previousValue)]);
    const eventField = kind === "character" ? "characters" : kind === "location" ? "locations" : "";
    if (eventField) {
      state.events.forEach((event) => {
        event[eventField] = event[eventField].map((item) => (item === previousValue ? value : item));
      });
    }
  }
}

function setExportFormat(format) {
  state.exportFormat = format;
  renderExport();
  $$(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === "export"));
  $$(".tab-panel").forEach((item) => item.classList.toggle("active", item.id === "exportTab"));
}

initApp();
