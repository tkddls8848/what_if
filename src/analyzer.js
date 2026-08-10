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
  PERIOD_TERM_LEXICON,
  STATUS,
  CUSTOM_SAMPLE_ID
} from "./config.js";
import {
  annotateEntityIntervals,
  annotateRelationIntervals,
  annotateStateIntervals
} from "./core/asof.js";
import { auditAnalysis } from "./core/audit.js";
import { normalizeSourceText } from "./core/text.js";

// 결합형(`에게는`)을 따로 적는다. `aliasPattern()`은 조사를 하나만 허용하므로
// 여기 없는 결합형은 통째로 매칭되지 않는다 — `아내에게는`이 그렇게 빠져 있었다.
const CHARACTER_PARTICLES = [
  "에게서는", "한테서는", "에게서", "한테서", "에게는", "한테는", "에게도", "한테도",
  "께서는", "께서", "에게", "한테",
  "은", "는", "이", "가", "을", "를", "와", "과", "도", "의", "만"
];
const CHARACTER_SUBJECT_PARTICLES = new Set(["에게서는", "한테서는", "에게서", "한테서", "에게는", "한테는", "에게도", "한테도", "께서는", "께서", "에게", "한테", "은", "는", "이", "가", "와", "과"]);
const LOCATION_PARTICLES = ["에서부터", "으로부터", "에서는", "에서도", "까지", "부터", "에서", "으로", "에는", "에도", "에", "로", "을", "를", "은", "는", "이", "가", "와", "과", "의", "도", "만"];
const LOCATIVE_PARTICLES = new Set(["에서부터", "으로부터", "에서는", "에서도", "까지", "부터", "에서", "으로", "에는", "에도", "에", "로"]);

// 긴 조사를 먼저 시도해야 `에서는`이 `에`로 잘리지 않는다.
const CHARACTER_PARTICLE_PATTERN = particleAlternation(CHARACTER_PARTICLES);
const LOCATION_PARTICLE_PATTERN = particleAlternation(LOCATION_PARTICLES);

function particleAlternation(particles) {
  return [...particles].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
}
const HUMAN_REFERENCE_NAMES = new Set([
  "나", "너", "우리", "그녀", "그분", "이분", "저분", "마나님", "아내", "남편", "어머니", "아버지", "엄마", "아빠",
  "할머니", "할아버지", "형", "누나", "언니", "오빠", "동생", "아들", "딸", "부처", "부부", "장인", "장모", "시어머니",
  "선생", "선생님", "사장", "사장님", "감독", "의사", "경찰", "주인", "손님", "서방", "영감", "색시", "신부", "신랑",
  "아이", "소년", "소녀", "여자", "남자", "여인", "여편네", "사내", "노인", "청년", "아가씨", "아주머니", "아저씨"
]);
const NON_PERSON_NAMES = new Set([
  "모양", "조밥", "마음", "생각", "생활", "시간", "오늘", "어제", "내일", "얼굴", "머리", "소리", "웃음", "그림자",
  "세상", "신용", "동정", "돈벌이", "품삯", "비결", "사흘", "가을", "바구니", "활극", "원문", "사건", "장소", "상태",
  "송충이", "송충", "빈민굴", "방안", "대문", "거리", "집", "길", "사람", "그것", "이것", "저것", "무엇", "어디", "누구"
]);
const LOCATION_EXACT_NAMES = new Set([
  "방", "집", "거리", "길", "옥상", "시장", "골목", "마당", "학교", "병원", "정거장", "백화점", "도시", "마을",
  "강", "산", "바다", "숲", "밭", "부엌", "창고", "가게", "주막", "다방", "호텔", "여관", "궁", "성", "빈민굴", "묘지"
]);
const LOCATION_STOP_NAMES = new Set(["불길", "시집", "계집", "고집", "편집", "모집", "수집", "징역", "기억", "능력", "세력", "매력", "가능성", "특성", "여성", "남성", "방송", "서방"]);
// 개별 인물이 아니라 무리를 가리키는 말. 사람 지칭어이긴 하지만 인물 seed가 되면
// 「감자」의 `부처`(=부부)·`여인들`·`중국인들`처럼 한 명분 자리를 집합이 차지한다.
const COLLECTIVE_REFERENCE_NAMES = new Set(["부처", "부부", "우리", "저희", "내외", "양주", "그들", "저들", "이들"]);
// 서술자/청자 대명사는 토큰 스캔이 아니라 `narratorSeedEvidence()`로만 판단한다.
const PRONOUN_ONLY_NAMES = new Set(["나", "너", "저"]);
// `왕 서방`처럼 성(姓) 뒤에 띄어 쓰는 칭호. 이 목록에 있는 말만 앞 토큰과 되붙인다.
const SURNAME_TITLE_HEADS = new Set(["서방", "영감", "선생", "생원", "진사", "참봉", "주사", "도령", "대감", "나리", "부인", "여사", "사장", "박사", "감독"]);
const KOREAN_SURNAMES = new Set([
  "김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송", "전", "홍",
  "유", "고", "문", "양", "손", "배", "백", "허", "남", "심", "노", "하", "곽", "성", "차", "주", "우", "구", "민", "진",
  "지", "엄", "채", "원", "천", "방", "공", "현", "함", "변", "여", "추", "도", "소", "석", "선", "설", "마", "길", "연",
  "위", "표", "명", "기", "반", "왕", "금", "옥", "육", "인", "맹", "제", "모", "탁", "국", "어", "은", "편", "용"
]);
// 대명사 `나`의 명확한 곡용형만 본다. `나는`은 동사 `나다`("열 다섯 살 나는 해에")와
// 겹쳐서 3인칭 작품에도 걸린다.
const NARRATOR_PRONOUN_RE = /(^|[^가-힣])(내가|나를|나의|나에게|나한테|나와|나도)(?=[^가-힣]|$)/gu;
const QUOTED_SPAN_RE = /"[^"]*"|[“”][^“”]*[“”]|'[^']*'|「[^」]*」|『[^』]*』/gu;
const LOCATION_SUFFIX_RE = /(정거장|백화점|공동묘지|빈민굴|옥상|시장|골목|마당|학교|병원|도시|마을|바다|부엌|창고|가게|주막|다방|호텔|여관|묘지|거리|방|집|길|문|역|강|산|숲|밭|궁|성)$/u;
const PERSON_ACTION_RE = /(말하|말했|대답|묻|물었|부르|불렀|가(?:고|서|며|려|았다|겠)|오(?:고|며|았다|겠)|나가|들어오|돌아오|걷|앉|일어나|웃|울|보(?:고|았|며)|먹|마시|주(?:고|었)|받|만나|생각하|느끼|죽|살|일하|잠들|깨)/u;
const MOVEMENT_CONTEXT_RE = /(가(?:고|서|며|다가|았다)|오(?:고|며|다가|았다)|나가|들어오|돌아오|걷|건너|지나|따라|오르|내리|도착|떠나)/u;

function splitTrailingParticle(word, particles) {
  for (const particle of particles) {
    if (word.length > particle.length && word.endsWith(particle)) {
      return { base: word.slice(0, -particle.length), particle };
    }
  }
  return { base: word, particle: "" };
}

function isHumanReference(name) {
  return HUMAN_REFERENCE_NAMES.has(name) || /(?:님|씨|서방|부인|아내|남편|어머니|아버지|할머니|할아버지|선생|사장|감독|의사|경찰|주인|손님|영감|색시|신부|신랑|아이|소년|소녀|여인|여편네|사내|노인|청년|아가씨|아주머니|아저씨|사람들|여인들|인들|녀)$/u.test(name);
}

function isRejectedCharacterName(name) {
  // `없`·`있`으로 끝나면 형용사 어간이 잘린 것이다(`실없이` → `실없` + `이`). 조사를 하나만
  // 떼는 분해에서는 이런 꼬리가 주격 후보처럼 보이지만 명사 자리에 설 수 없다.
  return !name || NON_PERSON_NAMES.has(name) || LOCATION_SUFFIX_RE.test(name) ||
    /(?:없|있)$/u.test(name) || /(?:없이|듯이|까지|부터|에서|으로|하고|하며|하게|적인|스럽게)$/u.test(name);
}

function isCollectiveReference(name) {
  return COLLECTIVE_REFERENCE_NAMES.has(name) || /들$/u.test(name);
}

/**
 * `왕 서방`처럼 성과 칭호가 띄어쓰기로 갈린 이름을 되붙인다.
 *
 * 토큰이 `[가-힣]+`이라 공백을 넘지 못한다. 그래서 이런 이름은 칭호(`서방`)만 후보로
 * 남고, 정작 사람을 가르는 성은 1음절이라 길이 검사에서 탈락했다. 「감자」에서 필수
 * 인물 `왕 서방`이 통째로 누락된 채 보통명사 `서방`이 대신 인물로 올라온 이유다.
 */
function precedingSurname(text, start, base) {
  if (!SURNAME_TITLE_HEADS.has(base)) return "";
  const surname = text.slice(Math.max(0, start - 3), start).match(/(?:^|[^가-힣])([가-힣])\s$/u)?.[1] || "";
  return KOREAN_SURNAMES.has(surname) ? surname : "";
}

/**
 * 서술자 `나`는 원문에 대명사가 있다고 해서 생기지 않는다. 3인칭 작품도 **대사 안에서는**
 * `나`를 쓰기 때문이다. 「감자」가 그랬다: 대사에 4회, 서술에 1회뿐인데 서술자로 잡혔다.
 * 인용 부호 안을 걷어내고, 서술부에 명확한 곡용형이 충분히 반복될 때만 인정한다.
 * (「날개」 서술부 54회·6형태 / 「감자」 1회·1형태로 분리된다.)
 */
function narratorSeedEvidence(segments) {
  const forms = new Set();
  const segmentIds = new Set();
  let hits = 0;
  segments.forEach((segment) => {
    for (const match of segment.text.replace(QUOTED_SPAN_RE, " ").matchAll(NARRATOR_PRONOUN_RE)) {
      hits += 1;
      forms.add(match[2]);
      segmentIds.add(segment.segment_id);
    }
  });
  return hits >= 3 && forms.size >= 2 ? { hits, segmentIds } : null;
}

/**
 * 동적 seed의 인물 채택 기준.
 *
 * 예전 기준은 사람 지칭어(`explicitHuman`)이기만 하면 근거를 아예 보지 않았다. 그래서
 * 1회 등장에 행위 문맥도 없는 `아버지`·`노인`이 들어왔고, 정렬까지 사람 지칭어 우선이라
 * 상위 14칸을 친족·직함 보통명사가 독점했다. 「감자」에서 인물이 14명 나온 이유다.
 * 지금은 사람 지칭어를 **문턱을 낮추는 근거**로만 쓰고 근거 자체는 언제나 요구한다.
 */
function characterSeedSurvives(name, item, minimum) {
  if (isCollectiveReference(name)) return false;
  // 성+칭호는 이름 자체가 강한 근거다. 보통명사가 우연히 이 꼴이 되지는 않는다.
  if (name.includes(" ")) return item.count >= minimum.count;
  if (item.count < minimum.count || item.segmentIds.size < minimum.segments) return false;
  if (item.explicitHuman) return true;
  // 사람 지칭어가 아니면 고유명사일 가능성에만 기대는 셈이므로 근거를 훨씬 더 요구한다.
  return item.count >= minimum.count + 1 && item.actorContexts >= 2 && item.segmentIds.size >= minimum.segments + 1;
}

/**
 * 근거 문턱은 문서 길이에 따라 달라야 한다. 장편에서 단락 하나에만 한 번 나오는 말은
 * 잡음이지만, 두세 단락짜리 입력에서는 그게 문서의 전부다. 고정 문턱을 쓰면 둘 중
 * 하나는 반드시 틀린다.
 */
function characterSeedMinimum(segmentCount) {
  return segmentCount >= 20 ? { count: 2, segments: 2 } : { count: 1, segments: 1 };
}

function followingClause(text, end, limit = 64) {
  return text.slice(end, end + limit).split(/[.!?…。！？\n]/u, 1)[0];
}

function hasPersonActionContext(text, end) {
  return PERSON_ACTION_RE.test(followingClause(text, end));
}

function locationEvidence(name, suffix, particle, following) {
  if (LOCATION_STOP_NAMES.has(name) || isHumanReference(name) || /[어아]가게$/u.test(name)) return false;
  if (LOCATIVE_PARTICLES.has(particle)) return true;
  if (/^\s*(?:밖|안|앞|뒤|옆|근처)\b/u.test(following)) return true;
  if ((particle === "을" || particle === "를") && MOVEMENT_CONTEXT_RE.test(following)) return true;
  if (LOCATION_EXACT_NAMES.has(name)) return false;
  const prefixLength = name.length - suffix.length;
  if (["길", "문", "역", "방", "집"].includes(suffix)) return prefixLength >= 2;
  if (["강", "산", "숲", "밭", "궁", "성"].includes(suffix)) return false;
  return prefixLength >= 1;
}

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
    eventTypes: (payload.event_types || []).map((item) => {
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
    mentalStates: (payload.mental_states || []).map((item) => {
      const stateName = cleanName(item.state || item.label || item.name);
      return {
        state: stateName,
        words: unique(listFrom(item.words).map(cleanName)),
        description: item.description || "",
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((entry) => entry.state && entry.words.length),
    physicalStates: (payload.physical_states || []).map((item) => {
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
    ...(payload.event_frames || []).flatMap((frame) => {
      if (field === "characters") return listFrom(frame.who).map(cleanName);
      if (field === "locations") return listFrom(frame.where).map(cleanName);
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
    ...(payload.state_changes || []).map((change) => field === "characters" ? cleanName(change.character) : "")
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

/**
 * 별칭 하나를 원문에서 찾는 **단일 규칙**.
 *
 * mention 채널(`findSeedMentions`), 사건 채널(`extractEvents`), LLM 병합 채널
 * (`findMentionsForAliases`)이 모두 이 함수를 쓴다. 예전에는 셋이 서로 다른 규칙을
 * 썼다 — mention은 조사가 붙으면 거부(`복녀도` 누락), 나머지 둘은 경계 없는 substring
 * (`감독관`의 `감독`까지 매칭). 같은 문장에 대해 채널마다 다른 답이 나왔고, 그 불일치가
 * 그대로 `actor` 제약 위반으로 쌓였다.
 *
 * 규칙:
 * - 앞: 한글로 시작하는 별칭은 한글 뒤에 붙어 있으면 안 된다(단어 내부 매칭 금지).
 * - 뒤: 한글로 끝나는 별칭은 **조사 하나까지만** 허용하고 그 뒤는 한글이 아니어야 한다.
 *   `복녀도`는 허용, `복녀들`은 거부. `나가서`의 `나`+`가`도 뒤에 `서`가 있어 거부된다.
 *
 * 조사를 허용하되 그 뒤 경계를 반드시 보는 것이 핵심이다. 둘 중 하나만 하면
 * 누락이 남거나(경계만) 오탐이 는다(조사만).
 */
function aliasPattern(alias, entityType) {
  const escaped = escapeRegExp(alias);
  const head = /^[가-힣]/u.test(alias) ? "(?<![가-힣])" : "";
  if (!/[가-힣]$/u.test(alias)) return `${head}${escaped}`;
  const particles = entityType === "location" ? LOCATION_PARTICLE_PATTERN : CHARACTER_PARTICLE_PATTERN;
  return `${head}${escaped}(?:${particles})?(?![가-힣])`;
}

function aliasRegex(alias, entityType, flags = "u") {
  return new RegExp(aliasPattern(alias, entityType), flags);
}

/** 별칭 목록 중 하나라도 이 텍스트에 실제 표층형으로 나타나는가. */
function matchesAliases(text, aliases, entityType) {
  const source = String(text || "");
  return (aliases || []).some((alias) => alias && alias.length >= 2 && aliasRegex(alias, entityType).test(source));
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
    annotations: analysis.annotations.length
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
  const characters = buildDocumentCharacterSeeds(segments, method);
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

function buildDocumentCharacterSeeds(segments, method) {
  const counts = new Map();

  const addName = (name, particle, segmentId, actorContext = false, explicitHuman = false, count = 1) => {
    const cleaned = cleanName(name);
    if ((!explicitHuman && (cleaned.length < 2 || cleaned.length > 4)) || cleaned.length > 12 || (!explicitHuman && isRejectedCharacterName(cleaned))) return;
    const item = counts.get(cleaned) || { count: 0, actorContexts: 0, particles: new Set(), segmentIds: new Set(), explicitHuman: false };
    item.count += count;
    if (actorContext) item.actorContexts += 1;
    if (particle) item.particles.add(particle);
    if (segmentId) item.segmentIds.add(segmentId);
    item.explicitHuman ||= explicitHuman;
    counts.set(cleaned, item);
  };

  const narrator = narratorSeedEvidence(segments);
  if (narrator) {
    counts.set("나", {
      count: narrator.hits,
      actorContexts: narrator.hits,
      particles: new Set(),
      segmentIds: narrator.segmentIds,
      explicitHuman: true
    });
  }

  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(/[가-힣]+/gu)) {
      const { base, particle } = splitTrailingParticle(match[0], CHARACTER_PARTICLES);
      if (!particle || PRONOUN_ONLY_NAMES.has(base)) continue;
      const explicitHuman = isHumanReference(base);
      if (!explicitHuman && !CHARACTER_SUBJECT_PARTICLES.has(particle)) continue;
      const actorContext = hasPersonActionContext(segment.text, match.index + match[0].length);
      const surname = precedingSurname(segment.text, match.index, base);
      // 성이 붙은 자리는 칭호 단독으로도 세지 않는다. 그래야 `왕 서방`과 `서방`이
      // 같은 등장을 두 번 나눠 갖지 않는다.
      if (surname) addName(`${surname} ${base}`, particle, segment.segment_id, actorContext, true);
      else addName(base, particle, segment.segment_id, actorContext, explicitHuman);
    }
  });

  const minimum = characterSeedMinimum(segments.length);
  return Array.from(counts.entries())
    .filter(([name, item]) => characterSeedSurvives(name, item, minimum))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 14)
    .map(([name, item]) => ({
      canonical_name: name,
      aliases: expandAliasCandidates([name, ...pronounCaseAliases(name)]),
      role: name === "나" ? "화자 후보" : "인물 후보",
      description: `인물 지칭어와 행위 문맥으로 생성한 인물 seed입니다. 감지 ${item.count}회, 단락 ${item.segmentIds.size}곳.`,
      confidence: name === "나" ? 0.68 : name.includes(" ") ? 0.66 : item.explicitHuman ? 0.62 : 0.54,
      method
    }));
}

function buildDocumentLocationSeeds(segments, method) {
  const counts = new Map();
  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(/[가-힣A-Za-z0-9]+/gu)) {
      const { base: name, particle } = splitTrailingParticle(match[0], LOCATION_PARTICLES);
      const suffix = name.match(LOCATION_SUFFIX_RE)?.[1] || "";
      if (!suffix || name.length > 14) continue;
      const following = followingClause(segment.text, match.index + match[0].length);
      if (!locationEvidence(name, suffix, particle, following)) continue;
      const item = counts.get(name) || { count: 0, particles: new Set(), segmentIds: new Set() };
      item.count += 1;
      if (particle) item.particles.add(particle);
      item.segmentIds.add(segment.segment_id);
      counts.set(name, item);
    }
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 14)
    .map(([name, item]) => ({
      name,
      aliases: expandAliasCandidates([name, ...singleSyllableParticleForms(name)]),
      type: inferLocationTypeFromName(name),
      description: `장소 핵심 명사와 공간 문맥으로 생성한 장소 seed입니다. 감지 ${item.count}회.`,
      confidence: item.count > 1 ? 0.62 : 0.52,
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

/**
 * 한 글자 이름은 별칭 최소 길이(2)를 넘지 못해 그대로는 매칭에 쓰이지 못한다.
 * 「감자」의 `집`·`밭`·`길`이 그렇다. 조사 결합형을 만들어 주는 것이 유일한 통로이고,
 * 조사를 요구하는 편이 한 글자를 맨몸으로 찾는 것보다 오탐도 적다.
 * 두 글자 이상은 `aliasPattern()`이 조사를 규칙으로 처리하므로 열거하지 않는다.
 */
function singleSyllableParticleForms(name) {
  if (cleanName(name).length !== 1) return [];
  return LOCATION_PARTICLES.map((particle) => `${name}${particle}`);
}

/**
 * 대명사만 곡용형을 열거한다.
 *
 * 보통 이름은 `aliasPattern()`이 조사를 규칙으로 처리하므로 `복녀은`·`서방는`을 만들어
 * 둘 필요가 없다. 받침을 보지 않는 열거라 절반은 성립하지도 않는 형태였다.
 * 대명사는 다르다. `나`·`너`는 한 글자라 별칭 최소 길이(2)에 걸려 그대로는 매칭에
 * 쓰이지 못하고, `내가`·`네가`는 조사 결합이 아니라 별도 형태라 규칙으로 만들 수 없다.
 */
function pronounCaseAliases(name) {
  if (name === "나") return ["나는", "내가", "나를", "나에게", "나의", "나와", "나도"];
  if (name === "너") return ["너는", "네가", "너를", "너에게", "너의", "너와", "너도"];
  return [];
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

// \uc815\uaddc\ud654\ub294 core/text.js\uac00 \ub2e8\uc77c \uc815\uc758\ub97c \uac16\ub294\ub2e4 \u2014 EPUB \ucc55\ud130 offset\uc774 \uac19\uc740 \uaddc\uce59\uc5d0
// \uc758\uc874\ud558\ubbc0\ub85c \uc5ec\uae30\uc5d0 \ub450 \ubc88\uc9f8 \ud310\uc744 \ub9cc\ub4e4\uba74 \uacbd\uacc4\uac00 \uc5b4\uae0b\ub09c\ub2e4.
const normalizeText = normalizeSourceText;

// 서버 장면 파이프라인의 DEFAULT_TARGET_CHARS와 맞춘다. 긴 문단도 분석과
// 화면 양쪽에서 같은 segment 경계를 사용해야 LLM 상태 변화 앵커가 어긋나지 않는다.
const MAX_SEGMENT_CHARS = 1000;
const MAX_DISPLAY_SCENES = 12;

function splitParagraphWithOffsets(text, maxChars = MAX_SEGMENT_CHARS) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/u.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) break;

    const remaining = text.length - cursor;
    let end = remaining <= maxChars ? text.length : cursor + maxChars;
    if (end < text.length) {
      const window = text.slice(cursor, end + 1);
      const minBoundary = Math.floor(maxChars * 0.55);
      const boundaryPattern = /[.!?…。](?:["'’”」』》)]*)\s+/gu;
      let match;
      let sentenceEnd = -1;
      while ((match = boundaryPattern.exec(window))) {
        const candidate = match.index + match[0].trimEnd().length;
        if (candidate >= minBoundary && candidate <= maxChars) sentenceEnd = candidate;
      }
      if (sentenceEnd > 0) {
        end = cursor + sentenceEnd;
      } else {
        const whitespace = window.slice(0, maxChars + 1).search(/\s+\S*$/u);
        if (whitespace >= minBoundary) end = cursor + whitespace;
      }
    }

    const raw = text.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = cursor + leading;
    const trimmedEnd = end - trailing;
    if (trimmedEnd > start) {
      chunks.push({ text: text.slice(start, trimmedEnd), start, end: trimmedEnd });
    }
    cursor = Math.max(end, cursor + 1);
  }
  return chunks;
}

function buildSegments(text, documentId) {
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean);
  let cursor = 0;
  const segments = [];
  paragraphs.forEach((paragraph) => {
    const charStart = text.indexOf(paragraph, cursor);
    splitParagraphWithOffsets(paragraph).forEach((piece) => {
      const index = segments.length;
      segments.push({
        segment_id: makeId("seg", index),
        document_id: documentId,
        index: index + 1,
        scene_id: "",
        text: piece.text,
        char_start: charStart + piece.start,
        char_end: charStart + piece.end
      });
    });
    cursor = charStart + paragraph.length;
  });
  return segments;
}

/**
 * EPUB처럼 실제 챕터 경계를 아는 입력은 그 경계를 Scene으로 쓴다. 균등 분할은
 * "사건 순서 탐색용 임시 단위"라는 한계를 문서에 명시해 왔는데, 챕터를 알 수 있을 때
 * 굳이 그 근사를 쓸 이유가 없다.
 */
function buildChapterScenes(segments, documentId, chapters) {
  const scenes = [];
  chapters.forEach((chapter, index) => {
    const chapterSegments = segments.filter((segment) =>
      segment.char_start >= chapter.char_start && segment.char_start < chapter.char_end);
    if (!chapterSegments.length) return;

    const sceneId = makeId("scene", scenes.length);
    chapterSegments.forEach((segment) => { segment.scene_id = sceneId; });
    scenes.push({
      scene_id: sceneId,
      document_id: documentId,
      index: scenes.length + 1,
      title: chapter.title || `Chapter ${index + 1}`,
      start_segment_id: chapterSegments[0].segment_id,
      end_segment_id: chapterSegments[chapterSegments.length - 1].segment_id,
      source_ref: chapter.source_ref || null,
      summary: summarizeText(chapterSegments.map((segment) => segment.text).join(" "), 110)
    });
  });

  // 챕터 밖으로 밀려난 segment가 있으면 마지막 scene에 붙여 고아를 만들지 않는다.
  const orphan = segments.filter((segment) => !segment.scene_id);
  if (orphan.length && scenes.length) {
    orphan.forEach((segment) => { segment.scene_id = scenes[scenes.length - 1].scene_id; });
    scenes[scenes.length - 1].end_segment_id = orphan[orphan.length - 1].segment_id;
  }
  return scenes.length ? scenes : buildScenes(segments, documentId);
}

function buildScenes(segments, documentId, chapters = null) {
  if (chapters?.length) return buildChapterScenes(segments, documentId, chapters);
  const sceneSize = Math.max(1, Math.ceil(segments.length / Math.min(MAX_DISPLAY_SCENES, Math.max(1, segments.length))));
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

  return annotateRelationIntervals(analysis, relations);
}

/**
 * 검수 편집 이후 시간 구간과 제약 감사를 다시 계산한다.
 *
 * `buildCharacterStates`/`buildRelations`는 각자 자기 구간을 부여하지만, 인물·장소
 * 구간과 감사 결과는 문서 전체를 봐야 하므로 여기서 한 번에 갱신한다. 편집 경로가
 * 이 함수를 부르지 않으면 `/check` 배지와 진단이 옛 값으로 남는다.
 */
export function refreshNarrativeTime(analysis) {
  if (!analysis) return analysis;
  annotateEntityIntervals(analysis);
  annotateStateIntervals(analysis, analysis.states || []);
  annotateRelationIntervals(analysis, analysis.relations || []);
  analysis.diagnostics = analysis.diagnostics || {};
  analysis.diagnostics.audit = auditAnalysis(analysis);
  return analysis;
}
