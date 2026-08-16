"use strict";

/**
 * 위키문헌(Wikisource) 본문 가져오기.
 *
 * 내장 샘플 2편에 묶여 있으면 평가셋도 2편에서 못 벗어난다. 공개도메인 한국어
 * 근대문학의 가장 큰 창구가 위키문헌이므로 여기부터 연다.
 *
 * 보안: **위키문헌 호스트만 허용한다.** 임의 URL을 받으면 이 서버가 열린 프록시가
 * 된다. 로컬 전용 앱이라도 그건 만들면 안 되는 물건이다.
 *
 * 권리: 위키문헌 문서라고 전부 공개도메인은 아니다(번역·주석은 CC BY-SA일 수 있다).
 * 자동으로 `public-domain`을 붙이지 않고 `unverified`로 표시해 사용자가 확인하게 한다.
 * 이 값은 MCP의 원문 배포 게이트에도 그대로 작용한다.
 */

const ALLOWED_HOST = /^[a-z-]{2,12}\.wikisource\.org$/u;

function parseTarget(input) {
  const value = String(input || "").trim();
  if (!value) return { error: "위키문헌 URL 또는 문서 이름이 필요합니다." };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "URL 형식이 아닙니다. 예: https://ko.wikisource.org/wiki/감자" };
  }
  if (url.protocol !== "https:") return { error: "https URL만 허용합니다." };
  if (!ALLOWED_HOST.test(url.hostname)) {
    return { error: `위키문헌 호스트만 허용합니다(받은 값: ${url.hostname}).` };
  }

  const wikiMatch = url.pathname.match(/^\/wiki\/(.+)$/u);
  let page;
  try {
    page = wikiMatch ? decodeURIComponent(wikiMatch[1]) : url.searchParams.get("title");
  } catch {
    return { error: "문서 이름의 URL 인코딩이 올바르지 않습니다." };
  }
  if (!page) return { error: "문서 이름을 URL에서 찾지 못했습니다." };
  return { host: url.hostname, page, sourceUrl: url.href };
}

/** MediaWiki 파싱 HTML에서 본문이 아닌 장치를 걷어낸다. */
function stripWikiChrome(html) {
  return String(html || "")
    .replace(/<table\b[\s\S]*?<\/table>/giu, "")
    .replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/giu, "")
    .replace(/<span\b[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/span>/giu, "")
    .replace(/<div\b[^>]*class="[^"]*(?:navbox|noprint|printfooter|catlinks|header_notes|licenseContainer)[^"]*"[\s\S]*?<\/div>/giu, "")
    .replace(/<ol\b[^>]*class="[^"]*references[^"]*"[\s\S]*?<\/ol>/giu, "");
}

/**
 * @returns {Promise<{ok:true, document:object} | {ok:false, error_code:string, message:string}>}
 */
async function importWikisource(input, { fetchImpl, timeoutMs = 15000 } = {}) {
  const target = parseTarget(input);
  if (target.error) return { ok: false, error_code: "INVALID_ARGUMENT", message: target.error, retryable: false };

  const api = `https://${target.host}/w/api.php?action=parse&prop=text|displaytitle&formatversion=2&format=json&page=${encodeURIComponent(target.page)}`;
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await doFetch(api, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = error && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false,
      error_code: timedOut ? "TIMEOUT" : "CONNECTION_FAILED",
      message: timedOut ? `위키문헌 응답 시간 초과 (${timeoutMs}ms)` : "위키문헌에 연결할 수 없습니다.",
      retryable: true
    };
  }
  clearTimeout(timer);

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error_code: "BAD_RESPONSE", message: "위키문헌이 JSON이 아닌 응답을 반환했습니다.", retryable: false };
  }
  if (body?.error) {
    return { ok: false, error_code: "UPSTREAM_ERROR", message: `위키문헌 오류: ${body.error.info || body.error.code}`, retryable: false };
  }
  if (!response.ok || !body?.parse?.text) {
    return { ok: false, error_code: "UPSTREAM_ERROR", message: `문서를 가져오지 못했습니다 (HTTP ${response.status}).`, retryable: response.status >= 500 };
  }

  // HTML → 텍스트 변환은 EPUB과 같은 구현을 쓴다. 두 벌로 두면 결과가 갈라진다.
  const { htmlToText } = await import("../core/epub.js");
  const text = htmlToText(stripWikiChrome(body.parse.text));
  if (!text || text.length < 100) {
    return { ok: false, error_code: "EMPTY_RESULT", message: "본문을 찾지 못했습니다. 문서 이름을 확인하세요.", retryable: false };
  }

  return {
    ok: true,
    document: {
      title: String(body.parse.displaytitle || target.page).replace(/<[^>]+>/gu, ""),
      author: "",
      language: target.host.split(".")[0],
      source_url: target.sourceUrl,
      // 자동 판정하지 않는다 — 사용자가 확인해야 한다.
      rights: "unverified",
      text
    }
  };
}

module.exports = { ALLOWED_HOST, parseTarget, stripWikiChrome, importWikisource };
