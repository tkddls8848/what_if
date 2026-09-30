"use strict";

const fs = require("fs");
const SECRET_KEYS = new Set(["CF_ACCOUNT_ID", "CF_API_TOKEN", "GEMINI_API_KEY", "CF_AI_GATEWAY_TOKEN"]);

/**
 * `.env`에서 SECRET_KEYS의 자격증명만 읽는다. 기존 셸/CI 값이 우선한다.
 * 일반 설정은 settings.js가 JSON에서 읽으며 process.env에 복사하지 않는다.
 */

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `.env` 한 줄을 파싱한다. 실패하면 null을 돌려준다 — 호출자가 그 줄을 무시하고
 * 나머지 줄은 계속 읽도록 하기 위해서다. 깨진 `.env` 한 줄 때문에 서버 부팅이
 * 멈추면 안 된다.
 */
function parseLine(line) {
  let text = line.trim();
  if (!text || text.startsWith("#")) return null;

  if (text.startsWith("export ")) {
    text = text.slice("export ".length).trimStart();
  }

  const eq = text.indexOf("=");
  if (eq <= 0) return null;

  const key = text.slice(0, eq).trim();
  if (!KEY_PATTERN.test(key)) return null;

  let value = text.slice(eq + 1).trim();

  const quoted = value.length >= 2 &&
    ((value[0] === '"' && value[value.length - 1] === '"') ||
      (value[0] === "'" && value[value.length - 1] === "'"));

  if (quoted) {
    // 따옴표 안의 `#`은 주석이 아니다 — 따옴표를 벗기기만 하고 더 건드리지 않는다.
    value = value.slice(1, -1);
  } else {
    // 따옴표 없는 값의 트레일링 `#` 주석만 잘라낸다. 값 중간의 `#`은 그대로 둔다
    // (예: URL 쿼리스트링). 공백 뒤에 오는 `#`만 주석으로 본다.
    const hashIndex = value.indexOf(" #");
    if (hashIndex !== -1) value = value.slice(0, hashIndex);
    else if (value.startsWith("#")) value = "";
    value = value.trim();
  }

  return { key, value };
}

/**
 * `.env` 파일을 읽어 process.env에 적용한다.
 *
 * @param {string} filePath `.env` 절대 경로
 * @returns {{ loaded: boolean, applied: string[], skipped: string[] }}
 *   loaded  파일이 존재해서 읽혔는지
 *   applied process.env에 새로 세팅한 키 목록
 *   skipped 파일에 있었지만 이미 process.env에 있어서 건너뛴 키 목록
 */
function loadEnvFile(filePath) {
  const result = { loaded: false, applied: [], skipped: [] };

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    // 파일이 없는 게 정상 상태다 — 대부분의 체크아웃에는 .env가 없다.
    return result;
  }

  result.loaded = true;

  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (!SECRET_KEYS.has(parsed.key)) {
      result.skipped.push(parsed.key);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(process.env, parsed.key)) {
      result.skipped.push(parsed.key);
      continue;
    }

    process.env[parsed.key] = parsed.value;
    result.applied.push(parsed.key);
  }

  return result;
}

module.exports = { loadEnvFile, parseLine };
