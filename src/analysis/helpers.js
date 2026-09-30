// Analysis: helpers. See doc/CODE_MAP.md for the call path.
import { EVENT_LABELS } from "../config.js";

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

export { CHARACTER_PARTICLES, CHARACTER_SUBJECT_PARTICLES, LOCATION_PARTICLES, LOCATIVE_PARTICLES, normalizeLocationType, cleanName, makeId, unique, listFrom, expandAliasCandidates, stripKoreanParticle, normalizeLexiconId, clampConfidence, summarizeText, aliasRegex, escapeRegExp, matchesAliases, normalizeEventType };
