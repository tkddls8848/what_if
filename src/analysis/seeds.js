// Analysis: seeds. See doc/CODE_MAP.md for the call path.
import { CHARACTER_PARTICLES, CHARACTER_SUBJECT_PARTICLES, LOCATION_PARTICLES, LOCATIVE_PARTICLES, normalizeLocationType, cleanName, makeId, unique, listFrom, expandAliasCandidates, stripKoreanParticle, normalizeLexiconId, clampConfidence } from "./helpers.js";
import { seedApplies, findSeedMentions } from "./entities.js";
import { CHARACTER_SEEDS, LOCATION_SEEDS, EVENT_LEXICON, MENTAL_STATE_LEXICON, PHYSICAL_STATE_LEXICON, EVENT_LABELS } from "../config.js";

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
const NAMED_LOCATION_HEAD_SUFFIXES = new Set(["성"]);
const COMPOUND_LOCATION_ALIAS_SUFFIXES = new Set(["밭"]);
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

function locationSeedMinimum(segmentCount) {
  return segmentCount >= 20 ? { count: 2, segments: 2 } : { count: 1, segments: 1 };
}

function precedingLocationWord(text, start) {
  return text.slice(Math.max(0, start - 16), start).match(/(?:^|[^가-힣])([가-힣]{2,8})\s$/u)?.[1] || "";
}

function isNamedLocationHead(name, suffix, following) {
  return name === suffix && NAMED_LOCATION_HEAD_SUFFIXES.has(suffix) &&
    /^\s*(?:안|밖)(?:에서|으로|에는|에도|에|의|은|는)?(?:\s|$)/u.test(following);
}

function buildDynamicSeedLexicon(payloadInput, model) {
  // 서버 payload는 캐시 파일에서도 올 수 있다. 배열 자리에 다른 값이 들어와도
  // seed 생성이 던지지 않아야 한다 — 던지면 호출부가 조용히 분석을 잃는다.
  const payload = payloadInput && typeof payloadInput === "object" ? payloadInput : {};
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
    characters: [...listFrom(payload.characters), ...eventCharacterSeeds].map((item) => {
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
    locations: [...listFrom(payload.locations), ...eventLocationSeeds].map((item) => {
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
    eventTypes: listFrom(payload.event_types).map((item) => {
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
    mentalStates: listFrom(payload.mental_states).map((item) => {
      const stateName = cleanName(item.state || item.label || item.name);
      return {
        state: stateName,
        words: unique(listFrom(item.words).map(cleanName)),
        description: item.description || "",
        method: `ollama-dynamic-seed:${model}`
      };
    }).filter((entry) => entry.state && entry.words.length),
    physicalStates: listFrom(payload.physical_states).map((item) => {
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
    ...listFrom(payload.event_frames).flatMap((frame) => {
      if (field === "characters") return listFrom(frame?.who).map(cleanName);
      if (field === "locations") return listFrom(frame?.where).map(cleanName);
      return [];
    }),
    ...listFrom(payload.relationships).flatMap((relationship = {}) => {
      const names = [];
      if (field === "characters" && relationship.source_type === "character") names.push(relationship.source);
      if (field === "characters" && relationship.target_type === "character") names.push(relationship.target);
      if (field === "locations" && relationship.source_type === "location") names.push(relationship.source);
      if (field === "locations" && relationship.target_type === "location") names.push(relationship.target);
      return names.map(cleanName);
    }),
    ...listFrom(payload.state_changes).map((change) => field === "characters" ? cleanName(change?.character) : "")
  ]
    .filter(Boolean));
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
  const namedHeads = new Map();
  const compoundAliases = new Map();
  const minimum = locationSeedMinimum(segments.length);

  const itemFor = (name) => {
    const item = counts.get(name) || { count: 0, particles: new Set(), segmentIds: new Set(), aliases: new Set([name]) };
    counts.set(name, item);
    return item;
  };

  segments.forEach((segment) => {
    for (const match of segment.text.matchAll(/[가-힣A-Za-z0-9]+/gu)) {
      const { base: name, particle } = splitTrailingParticle(match[0], LOCATION_PARTICLES);
      const suffix = name.match(LOCATION_SUFFIX_RE)?.[1] || "";
      if (!suffix || name.length > 14) continue;
      const following = followingClause(segment.text, match.index + match[0].length);
      const preceding = precedingLocationWord(segment.text, match.index);

      // `평양 성 안으로`처럼 고유 지명이 generic 공간어 앞에서 띄어 쓰이면 토큰 스캔은
      // `평양`과 `성`을 갈라 둘 다 버린다. 구조는 여기서 발견하되, 실제 표층형 횟수는
      // 아래에서 aliasPattern()을 쓰는 mention 채널로 다시 세어 장문 문턱을 적용한다.
      if (preceding && isNamedLocationHead(name, suffix, following)) {
        const item = namedHeads.get(preceding) || { aliases: new Set([preceding]), structuralSegments: new Set() };
        item.aliases.add(`${preceding} ${name}`);
        item.structuralSegments.add(segment.segment_id);
        namedHeads.set(preceding, item);
      }

      // 공백 때문에 `채마 밭`이 `밭`으로 잘리는 경우다. 장문에서는 같은 복합 표층형이
      // 두 문단 이상 반복될 때만 alias로 승격하고, 짧은 입력에서는 한 번을 전부로 본다.
      if (preceding && name === suffix && COMPOUND_LOCATION_ALIAS_SUFFIXES.has(suffix)) {
        const aliases = compoundAliases.get(name) || new Map();
        const alias = `${preceding} ${name}`;
        const evidence = aliases.get(alias) || { count: 0, segmentIds: new Set() };
        evidence.count += 1;
        evidence.segmentIds.add(segment.segment_id);
        aliases.set(alias, evidence);
        compoundAliases.set(name, aliases);
      }

      if (!locationEvidence(name, suffix, particle, following)) continue;
      const item = itemFor(name);
      item.count += 1;
      if (particle) item.particles.add(particle);
      item.segmentIds.add(segment.segment_id);
    }
  });

  namedHeads.forEach((head, name) => {
    const mentions = findSeedMentions(segments, [name], "location", "");
    const segmentIds = new Set(mentions.map((mention) => mention.segment_id));
    if (mentions.length < minimum.count || segmentIds.size < minimum.segments) return;
    const item = itemFor(name);
    item.count += mentions.length;
    segmentIds.forEach((segmentId) => item.segmentIds.add(segmentId));
    head.aliases.forEach((alias) => item.aliases.add(alias));
  });

  compoundAliases.forEach((aliases, name) => {
    const item = counts.get(name);
    if (!item) return;
    aliases.forEach((evidence, alias) => {
      if (evidence.count >= minimum.count && evidence.segmentIds.size >= minimum.segments) item.aliases.add(alias);
    });
  });

  // `우리집`·`전주집`처럼 generic `집`과 같은 문서에서만 생긴 파생형은 별도 장소가
  // 아니라 그 집의 표층 alias로 보존한다. compound만 있는 문서에서는 함부로 접지 않는다.
  const genericHouse = counts.get("집");
  if (genericHouse) {
    [...counts.entries()].forEach(([name, item]) => {
      if (name === "집" || !name.endsWith("집")) return;
      genericHouse.count += item.count;
      item.particles.forEach((particle) => genericHouse.particles.add(particle));
      item.segmentIds.forEach((segmentId) => genericHouse.segmentIds.add(segmentId));
      item.aliases.forEach((alias) => genericHouse.aliases.add(alias));
      counts.delete(name);
    });
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 14)
    .map(([name, item]) => ({
      name,
      aliases: expandAliasCandidates([...item.aliases, ...singleSyllableParticleForms(name)]),
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

export { inferLocationTypeFromName, normalizeMentionReferences, hasStaticSampleSeeds, buildDocumentSeedLexicon, mergeSeedLexicons, buildDynamicSeedLexicon };
