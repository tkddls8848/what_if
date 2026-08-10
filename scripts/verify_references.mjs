#!/usr/bin/env node
/**
 * 시대 용어 사전의 외부 링크 실존 확인.
 *
 * 이 기능은 서술을 생성하지 않고 **링크만** 건다. 그래서 깨진 링크는 단순한 흠이
 * 아니라 기능 자체가 없는 것과 같다. 사전에 항목을 추가하면 반드시 이 스크립트를
 * 돌려라.
 *
 * 확인하는 것:
 *  - 문서가 존재하는가 (missing)
 *  - 동음이의 문서가 아닌가 (`경성역`처럼 여러 대상을 가리키면 맥락이 안 된다)
 *  - 리다이렉트가 아닌가 (최종 제목으로 적어야 나중에 깨지지 않는다)
 *
 *   node scripts/verify_references.mjs
 *   node scripts/verify_references.mjs --json
 *
 * 네트워크가 없으면 실패가 아니라 `skipped`로 끝난다 — 오프라인에서도 앱은 동작하고,
 * 이 검사는 사전을 고칠 때만 필요하다.
 */
import { PERIOD_TERM_LEXICON } from "../src/config.js";

const asJson = process.argv.includes("--json");
const API = "https://ko.wikipedia.org/w/api.php";
const BATCH = 40;

const links = PERIOD_TERM_LEXICON.flatMap((entry) =>
  entry.references.map((reference) => ({ term: entry.term, ...reference }))
);

function titleOf(url) {
  const match = String(url).match(/^https:\/\/ko\.wikipedia\.org\/wiki\/(.+)$/u);
  return match ? decodeURIComponent(match[1]).replace(/_/g, " ") : null;
}

const problems = [];
const nonWiki = links.filter((link) => !titleOf(link.url));
nonWiki.forEach((link) => problems.push({ ...link, issue: "ko.wikipedia.org 링크가 아니다 — 직접 확인 필요" }));

const wikiLinks = links.filter((link) => titleOf(link.url));
const titles = [...new Set(wikiLinks.map((link) => titleOf(link.url)))];

let checked = 0;
let offline = false;
try {
  for (let index = 0; index < titles.length; index += BATCH) {
    const chunk = titles.slice(index, index + BATCH);
    const url = `${API}?action=query&format=json&origin=*&prop=pageprops&titles=${encodeURIComponent(chunk.join("|"))}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const pages = Object.values(body.query?.pages || {});
    const normalized = new Map((body.query?.normalized || []).map((item) => [item.to, item.from]));
    const redirected = new Map((body.query?.redirects || []).map((item) => [item.to, item.from]));
    checked += chunk.length;

    pages.forEach((page) => {
      const source = normalized.get(page.title) || page.title;
      const affected = wikiLinks.filter((link) => titleOf(link.url) === source || titleOf(link.url) === page.title);
      const flag = (issue) => affected.forEach((link) => problems.push({ ...link, issue }));
      if (page.missing !== undefined) return flag("문서가 없다");
      if (page.pageprops?.disambiguation !== undefined) return flag("동음이의 문서다 — 구체적인 문서를 지목해라");
    });
    (body.query?.redirects || []).forEach((item) => {
      wikiLinks
        .filter((link) => titleOf(link.url) === item.from)
        .forEach((link) => problems.push({ ...link, issue: `리다이렉트다 — 최종 제목 '${item.to}'로 적어라` }));
    });
    void redirected;
  }
} catch (error) {
  const message = `네트워크로 확인하지 못했다 (${error.message}). 링크 ${links.length}개는 미확인 상태다.`;
  if (asJson) console.log(JSON.stringify({ status: "skipped", reason: message, links: links.length }, null, 2));
  else console.log(`[건너뜀] ${message}`);
  offline = true;
}

if (offline) {
  // 오프라인이면 위에서 이미 알렸다. 미확인을 실패로 만들지 않는다.
} else if (asJson) {
  console.log(JSON.stringify({ status: problems.length ? "failed" : "ok", checked, links: links.length, problems }, null, 2));
} else {
  console.log(`\n시대 용어 링크 검증 — 용어 ${PERIOD_TERM_LEXICON.length}개 · 링크 ${links.length}개 · 문서 ${checked}개 조회\n`);
  if (!problems.length) console.log("문제 없음. 모든 링크가 실존하는 단일 문서를 가리킨다.");
  else problems.forEach((problem) => console.log(`[문제] ${problem.term} → ${problem.label}\n        ${problem.issue}\n        ${problem.url}`));
}

// process.exit()를 쓰지 않는다. 열려 있는 fetch 핸들이 있는 상태로 강제 종료하면
// Windows에서 libuv assertion으로 죽는다. 종료 코드만 정하고 이벤트 루프가 비게 둔다.
process.exitCode = problems.length && !offline ? 1 : 0;
