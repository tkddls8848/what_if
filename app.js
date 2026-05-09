"use strict";

const sampleText = `나는 좁은 방에서 오래 누워 있었다. 문 밖에서는 아내의 발소리가 들렸고, 나는 그것이 나를 지키는 소리인지 멀어지는 소리인지 알 수 없었다.

아내는 낮마다 안쪽 방에 머물렀다. 나는 벽 하나를 사이에 두고 그녀의 기침과 서랍 여닫는 소리를 들었다. 방은 둘로 나뉘었지만 냄새와 침묵은 섞여 있었다.

어느 저녁, 박제가 찾아와 낮은 목소리로 아내와 이야기했다. 나는 그들의 말을 다 듣지 못했다. 다만 내 이름이 잠깐 불렸고, 곧 방문이 닫혔다.

다음 날 나는 거리에 나갔다. 햇빛은 너무 밝았고 사람들은 나를 알아보지 못했다. 나는 백화점 쪽으로 걸었지만, 그곳이 목적지인지 도피처인지 분명하지 않았다.

나는 다시 방으로 돌아왔다. 아내는 말없이 나를 바라보았다. 그 시선 때문에 나는 내가 떠난 적이 없었던 사람처럼 느껴졌다.

마지막으로 나는 옥상 같은 높은 곳을 떠올렸다. 날개가 있다면 다시 한번 날아 보겠다고 생각했다. 그 생각은 사실인지 상징인지 내게도 확실하지 않았다.`;

const knownCharacters = [
  { canonical: "나", aliases: ["나", "나는", "내", "내가", "나를", "나의"], role: "화자" },
  { canonical: "아내", aliases: ["아내", "그녀"], role: "배우자" },
  { canonical: "박제", aliases: ["박제"], role: "방문자" },
  { canonical: "사람들", aliases: ["사람들", "군중"], role: "주변 인물" }
];

const locationSeeds = [
  { canonical: "방", aliases: ["방", "좁은 방", "안쪽 방", "방문"], type: "interior" },
  { canonical: "거리", aliases: ["거리", "길", "문 밖"], type: "exterior" },
  { canonical: "백화점", aliases: ["백화점"], type: "public" },
  { canonical: "옥상", aliases: ["옥상", "높은 곳"], type: "symbolic" }
];

const eventLexicon = [
  { type: "movement", words: ["갔다", "나갔다", "걸었", "돌아왔", "떠났", "향했", "이동", "들어갔", "나왔"] },
  { type: "conversation", words: ["말", "이야기", "목소리", "불렸", "물었", "대답"] },
  { type: "perception", words: ["보았", "들었", "느꼈", "알 수", "생각", "바라보", "떠올"] },
  { type: "conflict", words: ["지키", "닫혔", "두려", "불안", "갈등", "멀어지"] },
  { type: "realization", words: ["깨달", "분명", "확실", "느껴졌", "알았다"] }
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
  const events = extractEvents(segments, characters, locations);
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
      description: `${seed.type} 공간으로 추정됨`,
      real_world_candidate: "",
      parent_location_id: "",
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

function visibleSegmentLimit() {
  return state.spoilerSafe ? state.currentSegment : Number.MAX_SAFE_INTEGER;
}

function segmentOrderById(segmentId) {
  return state.segments.find((segment) => segment.segment_id === segmentId)?.order || 0;
}

function isVisibleAfter(segmentId) {
  return segmentOrderById(segmentId) <= visibleSegmentLimit();
}

function visibleEvents() {
  return state.events.filter((event) => isVisibleAfter(event.reader_visible_after_segment_id));
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
  const locations = state.locations.filter((location) => {
    const firstEvidence = eventOrLocationFirstSegment(location);
    return firstEvidence ? isVisibleAfter(firstEvidence) : true;
  });
  const locationIds = new Set(locations.map((location) => location.location_id));
  const edges = state.edges.filter((edge) => locationIds.has(edge.source_id) && locationIds.has(edge.target_id));
  els.mapStats.textContent = `${locations.length} 노드`;
  els.spaceGraph.innerHTML = "";

  if (!locations.length) {
    drawSvgText("분석된 장소가 없습니다.", 450, 280, "graph-label");
    return;
  }

  const centerX = 450;
  const centerY = 280;
  const radius = Math.min(230, 110 + locations.length * 18);
  const positions = new Map();

  locations.forEach((location, index) => {
    const angle = (Math.PI * 2 * index) / locations.length - Math.PI / 2;
    const x = locations.length === 1 ? centerX : centerX + Math.cos(angle) * radius;
    const y = locations.length === 1 ? centerY : centerY + Math.sin(angle) * radius * 0.72;
    positions.set(location.location_id, { x, y });
  });

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

  const currentLocationId = latestVisibleLocationId();
  locations.forEach((location) => {
    const position = positions.get(location.location_id);
    const group = svgEl("g", {});
    const circle = svgEl("circle", {
      cx: position.x,
      cy: position.y,
      r: 54,
      class: `graph-node ${location.location_id === currentLocationId ? "current" : ""}`
    });
    const label = svgEl("text", {
      x: position.x,
      y: position.y - 4,
      class: "graph-label"
    });
    label.textContent = location.canonical_name;
    const caption = svgEl("text", {
      x: position.x,
      y: position.y + 22,
      class: "graph-caption"
    });
    caption.textContent = `${location.type} ${Math.round(location.confidence * 100)}%`;
    group.append(circle, label, caption);
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
  els.characterStats.textContent = `${state.characters.length} 명`;
  els.characterCards.innerHTML = "";
  if (!state.characters.length) {
    els.characterCards.innerHTML = `<div class="empty-state">분석된 인물이 없습니다.</div>`;
    return;
  }

  state.characters.forEach((character) => {
    const states = latestStatesForCharacter(character.character_id);
    const location = state.locations.find((item) => item.location_id === states?.physical_location_id);
    const card = document.createElement("article");
    card.className = "character-card";
    card.innerHTML = `
      <h3>${escapeHtml(character.canonical_name)}</h3>
      <div class="tag-row">
        <span class="tag">${escapeHtml(character.role || "인물")}</span>
        <span class="tag fact">${Math.round(character.confidence * 100)}%</span>
      </div>
      <p>${escapeHtml(character.description || "")}</p>
      <ul class="fact-list">
        <li>최근 위치: ${escapeHtml(location?.canonical_name || "미정")}</li>
        <li>상태: ${escapeHtml(states?.mental_state || "미정")}</li>
        <li>관계 변화: ${escapeHtml(states?.relation_changes || "없음")}</li>
      </ul>
    `;
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
        ${["appearance", "movement", "conversation", "perception", "conflict", "realization", "background"].map((type) => `<option value="${type}" ${event.event_type === type ? "selected" : ""}>${labelEvent(type)}</option>`).join("")}
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

  els.eventTypeFilter.addEventListener("change", renderTimeline);

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

bindEvents();
els.sourceText.value = sampleText;
runAnalysis();
