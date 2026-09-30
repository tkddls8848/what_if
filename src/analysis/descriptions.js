// Analysis: descriptions. See doc/CODE_MAP.md for the call path.
import { makeId, unique, escapeRegExp, aliasRegex } from "./helpers.js";
import { VISUAL_DESCRIPTION_LEXICON, STATUS } from "../config.js";

const DESCRIPTION_SUBJECT_PARTICLES = {
  character: new Set(["께서는", "께서", "은", "는", "이", "가"]),
  location: new Set(["에서는", "에서도", "에는", "에도", "에서", "에", "은", "는", "이", "가"])
};

/** 문서가 길수록 우연한 한 단어보다 주어+묘사 근거가 함께 있어야 한다. */
function descriptionEvidenceMinimum(segmentCount) {
  return Math.min(2, Math.max(1, Math.ceil(Math.max(1, segmentCount) / 8)));
}

/** 쉼표·문장부호 경계를 보존한 원문 절과 단락 내부 offset. */
function splitClauses(text) {
  const clauses = [];
  let start = 0;
  for (const boundary of String(text || "").matchAll(/---+|[,;.!?。！？]+/gu)) {
    const end = boundary.index + boundary[0].length;
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    if (raw.trim()) clauses.push({ text: raw.trim(), start: start + leading, end: end - trailing });
    start = end;
  }
  const raw = text.slice(start);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  if (raw.trim()) clauses.push({ text: raw.trim(), start: start + leading, end: text.length - trailing });
  return clauses;
}

function descriptionAliases(entity, entityType, characters, locations) {
  const aliases = unique(entity.aliases || []);
  if (entityType !== "character") return aliases;
  return aliases.filter((alias) => {
    const namesAnotherCharacter = characters.some((candidate) =>
      candidate.character_id !== entity.character_id &&
      candidate.canonical_name &&
      alias.includes(candidate.canonical_name));
    const namesLocation = locations.some((location) => location.name === alias);
    return !namesAnotherCharacter && !namesLocation;
  });
}

function subjectTermPattern(entries) {
  return unique(entries.flatMap((entry) => entry.subject_terms || []))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

/**
 * 별칭 자체는 반드시 `aliasRegex()`로 찾고, 여기서는 그 표층형이 절의 주어인지 판정한다.
 * 소유격은 `복녀의 숙인 얼굴은`처럼 묘사 사전의 신체·공간 말이 주어일 때만 허용한다.
 */
function subjectAliasHit(clause, aliases, entityType, entries) {
  const particles = DESCRIPTION_SUBJECT_PARTICLES[entityType];
  const subjectTerms = subjectTermPattern(entries);
  const hits = [];
  unique(aliases).sort((a, b) => b.length - a.length).forEach((alias) => {
    if (!alias || alias.length < 2) return;
    for (const match of clause.matchAll(aliasRegex(alias, entityType, "gu"))) {
      const suffix = match[0].slice(alias.length);
      const aliasAlreadyInflected = [...particles].some((particle) => alias.endsWith(particle));
      if (particles.has(suffix) || (!suffix && aliasAlreadyInflected)) {
        const subjectParticle = suffix || [...particles].find((particle) => alias.endsWith(particle)) || "";
        const strength = ["께서는", "께서", "은", "는", "이", "가"].includes(subjectParticle) ? 1 : 0;
        hits.push({ index: match.index, alias, form: match[0], kind: "direct", strength });
        continue;
      }
      if (suffix !== "의" || !subjectTerms) continue;
      const following = clause.slice(match.index + match[0].length, match.index + match[0].length + 32);
      const ownedSubject = new RegExp(`^(?:[^,;.!?。！？]{0,24})?(?:${subjectTerms})(?:에서는|에서도|에는|에도|은|는|이|가)`, "u");
      if (ownedSubject.test(following)) hits.push({ index: match.index, alias, form: match[0], kind: "owned-subject", strength: 1 });
    }
  });
  return hits.sort((a, b) => a.index - b.index || b.alias.length - a.alias.length)[0] || null;
}

/**
 * 인물·장소가 주어인 절 중 외형·복식·공간 어휘가 실제로 있는 원문 span만 수집한다.
 * 결과를 segment에 두므로 `asOf()`가 segment를 자를 때 미래 묘사도 함께 사라진다.
 */
function extractDescriptionSpans(segments, characters, locations) {
  const targets = [
    ...characters.map((entity) => ({ entity, entity_type: "character", entity_id: entity.character_id, entity_name: entity.canonical_name })),
    ...locations.map((entity) => ({ entity, entity_type: "location", entity_id: entity.location_id, entity_name: entity.name }))
  ];
  const minimum = descriptionEvidenceMinimum(segments.length);
  let descriptionIndex = 0;

  segments.forEach((segment) => {
    const spans = [];
    splitClauses(segment.text).forEach((clause) => {
      const candidates = targets.map((target) => {
        const entries = VISUAL_DESCRIPTION_LEXICON.filter((entry) => entry.entity_types.includes(target.entity_type));
        const aliases = descriptionAliases(target.entity, target.entity_type, characters, locations);
        const subject = subjectAliasHit(clause.text, aliases, target.entity_type, entries);
        return subject ? { target, entries, subject } : null;
      }).filter(Boolean);
      const lastDirectCharacterSubject = Math.max(-1, ...candidates
        .filter((candidate) => candidate.target.entity_type === "character" && candidate.subject.kind === "direct")
        .map((candidate) => candidate.subject.index));

      candidates.forEach(({ target, entries, subject }) => {
        if (target.entity_type === "character" && subject.kind === "direct" && subject.index < lastDirectCharacterSubject) return;
        const subjectEnd = subject.index + subject.form.length;
        const afterSubject = clause.text.slice(subjectEnd);
        const beforeSubject = clause.text.slice(Math.max(0, subject.index - 24), subject.index);

        const matched = entries
          .map((entry) => ({
            category: entry.category,
            terms: unique(entry.words.filter((word) => {
              if (!word || !clause.text.includes(word)) return false;
              if (subject.kind === "owned-subject") return afterSubject.includes(word);
              if (entry.category === "appearance") return afterSubject.includes(word);
              if (entry.category === "space") return afterSubject.includes(word) || beforeSubject.includes(word);
              const wearsClothing = ["입", "걸치", "벗", "쓰는", "쓰고"].some((verb) => afterSubject.includes(verb));
              return wearsClothing && afterSubject.includes(word) || word === "매무새" && beforeSubject.includes(word);
            }))
          }))
          .filter((entry) => entry.terms.length);
        const matchedTerms = unique(matched.flatMap((entry) => entry.terms));
        const evidenceScore = subject.strength + matchedTerms.length;
        if (!matched.length || evidenceScore < minimum) return;

        spans.push({
          description_id: makeId("desc", descriptionIndex),
          entity_type: target.entity_type,
          entity_id: target.entity_id,
          entity_name: target.entity_name,
          subject_text: subject.form,
          subject_kind: subject.kind,
          categories: matched.map((entry) => entry.category),
          matched_terms: matchedTerms,
          segment_id: segment.segment_id,
          text: clause.text,
          char_start: segment.char_start + clause.start,
          char_end: segment.char_start + clause.end,
          image: null,
          status: STATUS.SUGGESTED,
          confidence: Math.min(0.94, 0.72 + evidenceScore * 0.04),
          method: "subject-description-lexicon"
        });
        descriptionIndex += 1;
      });
    });
    segment.description_spans = spans.sort((a, b) => a.char_start - b.char_start || a.entity_id.localeCompare(b.entity_id));
  });
}

export { extractDescriptionSpans };
