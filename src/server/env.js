"use strict";

const fs = require("fs");

/**
 * `.env` 파일을 읽어 `process.env`에 채워 넣는다.
 *
 * 왜 필요한가: `/play`가 쓰는 CF_ACCOUNT_ID·CF_API_TOKEN을 매 세션 PowerShell에
 * `$env:`로 손으로 넣던 것을 없애기 위해서다. 손으로 넣으면 실제 토큰이 셸
 * 히스토리에 남고, 새 터미널을 열 때마다 다시 쳐야 하고, 어디에도 문서화되지
 * 않는다. `.env`는 저장소 루트에 한 번 만들어 두면 되고, `.gitignore`가
 * `.env`를 커밋에서 막아 준다.
 *
 * **이미 설정된 환경변수는 절대 덮어쓰지 않는다.** 이 규칙이 이 모듈의 핵심이다.
 * 테스트가 `process.env.CF_ACCOUNT_ID`를 먼저 세팅하고 `server.js`를 import하면,
 * 개발자 로컬 디스크에 어떤 `.env`가 있든 없든 테스트 결과가 같아야 한다 —
 * 그러려면 파일이 아니라 이미 세팅된 값이 항상 이긴다. 같은 이유로 CI 환경변수나
 * 배포 환경변수도 로컬 `.env` 파일에 절대 밀리지 않는다. 이 모듈은 "파일이 기본값,
 * 환경변수가 우선순위"라는 한 문장으로 요약된다.
 *
 * 외부 패키지(dotenv 등)를 쓰지 않는다 — 이 저장소는 빌드 단계가 없고 의존성을
 * 늘리지 않는다는 원칙이 있어서, 필요한 최소 파싱만 직접 구현한다.
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

    if (Object.prototype.hasOwnProperty.call(process.env, parsed.key)) {
      result.skipped.push(parsed.key);
      continue;
    }

    process.env[parsed.key] = parsed.value;
    result.applied.push(parsed.key);
  }

  return result;
}

module.exports = { loadEnvFile };
