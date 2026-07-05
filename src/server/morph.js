"use strict";

/**
 * 한국어 전처리 워커 래퍼.
 * Python(kiwipiepy) → Python 정규식 → Node 정규식 순으로 fallback한다.
 * (server.js에서 분리 — 동작 동일)
 */

const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const KOREAN_MORPH_SCRIPT = path.join(ROOT, "scripts", "korean_morph.py");

function buildKoreanMorphContext(text, { pythonBin = process.env.PYTHON || "python", timeoutMs = 12000 } = {}) {
  return runMorphWorker(text, { pythonBin, timeoutMs }).catch((error) =>
    fallbackKoreanContext(text, `morph worker unavailable: ${error.message || error}`)
  );
}

function runMorphWorker(text, { pythonBin, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [KOREAN_MORPH_SCRIPT], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("morph worker timeout"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `morph worker exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify({ text }));
  });
}

/** health 진단용: Python 전처리 가용성 확인 (짧은 입력, 짧은 timeout). */
async function checkMorphWorker({ pythonBin = process.env.PYTHON || "python", timeoutMs = 4000 } = {}) {
  try {
    const result = await runMorphWorker("확인용 문장입니다.", { pythonBin, timeoutMs });
    return { available: true, analyzer: result.analyzer || "unknown" };
  } catch (error) {
    return { available: false, analyzer: "node-regex-fallback", message: String(error.message || error).slice(0, 120) };
  }
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+/g, " ")
    .trim();
}

const CHARACTER_CANDIDATE_RE = /(?<![가-힣])((?:[가-힣]{1,6}(?:님|씨|서방|부인|선생|사장|감독|의사|경찰))|아내|남편|어머니|아버지|할머니|할아버지|주인|손님|영감|색시|신부|신랑|아이|소년|소녀|여인|여편네|사내|노인|청년|아가씨|아주머니|아저씨)(?:은|는|이|가|을|를|에게|와|과|도|의|께서|에게서|한테|한테서)(?![가-힣])/gu;
const LOCATION_CANDIDATE_RE = /(?<![가-힣])([가-힣A-Za-z0-9]{0,12}(?:정거장|백화점|공동묘지|빈민굴|옥상|시장|골목|마당|학교|병원|도시|마을|바다|부엌|창고|가게|주막|다방|호텔|여관|묘지|거리|방|집|길|문|역|강|산|숲|밭|궁|성))(?:에서부터|으로부터|에서는|에서도|까지|부터|에서|으로|에는|에도|에|로|을|를|은|는|이|가|와|과|의|도)?(?![가-힣])/gu;

function fallbackKoreanContext(text, warning = "") {
  const normalized = normalizeText(text);
  const segments = normalized.split(/\n\s*\n/g).map((part, index) => ({
    id: `seg_${String(index + 1).padStart(3, "0")}`,
    index: index + 1,
    text: part.trim().slice(0, 240)
  })).filter((segment) => segment.text);
  const fullText = segments.map((segment) => segment.text).join("\n");
  const names = countRegexCandidates(fullText, CHARACTER_CANDIDATE_RE);
  const locations = countRegexCandidates(fullText, LOCATION_CANDIDATE_RE, isFallbackLocationName);
  return {
    analyzer: "regex-fallback",
    warning,
    segments: segments.slice(0, 40),
    candidate_characters: names.slice(0, 40),
    candidate_locations: locations.slice(0, 30),
    candidate_state_words: [],
    candidate_event_sentences: []
  };
}

/**
 * 장면 파이프라인의 규칙 채널 합의용 후보 이름 집합.
 * Python 없이 Node 정규식만 사용한다 (빠르고 결정적).
 */
function regexCandidateNames(text) {
  const normalized = normalizeText(text);
  const characters = countRegexCandidates(normalized, CHARACTER_CANDIDATE_RE).map((item) => item.base);
  const locations = countRegexCandidates(normalized, LOCATION_CANDIDATE_RE, isFallbackLocationName).map((item) => item.base);
  return { characters: new Set(characters), locations: new Set(locations) };
}

function countRegexCandidates(text, regex, predicate = () => true) {
  const counts = new Map();
  for (const match of text.matchAll(regex)) {
    const surface = String(match[0] || "").trim();
    const base = String(match[1] || surface).trim();
    if (base.length < 2 || !predicate(base)) continue;
    const item = counts.get(base) || { base, surfaces: new Set(), count: 0 };
    item.surfaces.add(surface);
    item.count += 1;
    counts.set(base, item);
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .map((item) => ({ base: item.base, surfaces: Array.from(item.surfaces).slice(0, 8), count: item.count }));
}

function isFallbackLocationName(name) {
  if (/^(?:불길|시집|계집|고집|편집|모집|수집|징역|기억|능력|세력|매력|가능성|특성|여성|남성|방송|서방)$/u.test(name)) return false;
  if (/[어아]가게$/u.test(name)) return false;
  return !/(?:님|씨|서방|부인|아내|남편|선생|사장|감독|의사|경찰|주인|손님|영감|색시|신부|신랑)$/u.test(name);
}

module.exports = {
  buildKoreanMorphContext,
  checkMorphWorker,
  fallbackKoreanContext,
  regexCandidateNames,
  normalizeText
};
