import assert from "node:assert/strict";
import test from "node:test";

const wikisource = (await import("../src/server/wikisource.js")).default
  || await import("../src/server/wikisource.js");
const { importWikisource, parseTarget, stripWikiChrome } = wikisource;

const PAGE_HTML = `<div class="mw-parser-output">
  <div class="header_notes">머리말 장치</div>
  <table class="navbox"><tr><td>내비게이션</td></tr></table>
  <h2>감자<span class="mw-editsection">[편집]</span></h2>
  <p>싸움, 간통, 살인, 도둑, 구걸, 징역, 이 세상의 모든 비극과 활극의 근원지인 칠성문 밖 빈민굴로 오기 전까지는 복녀의 부처는 사농공상의 제2위에 드는 농민이었다.<sup class="reference">[1]</sup></p>
  <p>복녀는 원래 가난은 하나마 정직한 농가에서 규칙 있게 자라난 처녀였다. 그의 부모는 가난하였다.</p>
  <ol class="references"><li>각주</li></ol>
</div>`;

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: status < 400, status, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

test("only wikisource hosts are accepted", () => {
  assert.equal(parseTarget("https://ko.wikisource.org/wiki/감자").page, "감자");
  assert.equal(parseTarget("https://en.wikisource.org/wiki/Some_Page").host, "en.wikisource.org");

  assert.match(parseTarget("https://example.com/wiki/감자").error, /위키문헌 호스트만/u);
  assert.match(parseTarget("https://ko.wikipedia.org/wiki/감자").error, /위키문헌 호스트만/u);
  assert.match(parseTarget("http://ko.wikisource.org/wiki/감자").error, /https/u);
  assert.match(parseTarget("파일이름.txt").error, /URL 형식/u);
  assert.match(parseTarget("").error, /필요합니다/u);
  assert.match(parseTarget("https://ko.wikisource.org/wiki/%").error, /URL 인코딩/u);
});

test("strips MediaWiki chrome but keeps the body", () => {
  const stripped = stripWikiChrome(PAGE_HTML);
  assert.ok(!stripped.includes("내비게이션"));
  assert.ok(!stripped.includes("머리말 장치"));
  assert.ok(!stripped.includes("mw-editsection"));
  assert.ok(!stripped.includes("각주"));
  assert.ok(stripped.includes("칠성문 밖 빈민굴"));
});

test("imports a page as plain text with unverified rights", async () => {
  const fetchImpl = fakeFetch({ parse: { displaytitle: "<i>감자</i>", text: PAGE_HTML } });
  const result = await importWikisource("https://ko.wikisource.org/wiki/감자", { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.document.title, "감자");
  assert.equal(result.document.language, "ko");
  // 자동으로 공개도메인이라고 단정하지 않는다.
  assert.equal(result.document.rights, "unverified");
  assert.equal(result.document.source_url, "https://ko.wikisource.org/wiki/%EA%B0%90%EC%9E%90");
  assert.ok(result.document.text.includes("칠성문 밖 빈민굴"));
  assert.ok(!result.document.text.includes("<p>"));

  assert.match(fetchImpl.calls[0], /^https:\/\/ko\.wikisource\.org\/w\/api\.php\?action=parse/u);
});

test("upstream and empty results become structured errors", async () => {
  const apiError = await importWikisource("https://ko.wikisource.org/wiki/없는문서", {
    fetchImpl: fakeFetch({ error: { code: "missingtitle", info: "문서가 없습니다." } })
  });
  assert.equal(apiError.ok, false);
  assert.equal(apiError.error_code, "UPSTREAM_ERROR");

  const empty = await importWikisource("https://ko.wikisource.org/wiki/빈문서", {
    fetchImpl: fakeFetch({ parse: { text: "<p>짧음</p>" } })
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.error_code, "EMPTY_RESULT");

  const rejected = await importWikisource("https://evil.example.com/wiki/x", { fetchImpl: fakeFetch({}) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error_code, "INVALID_ARGUMENT");
});

test("connection failures are reported as retryable", async () => {
  const result = await importWikisource("https://ko.wikisource.org/wiki/감자", {
    fetchImpl: async () => { throw new Error("boom"); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "CONNECTION_FAILED");
  assert.equal(result.retryable, true);
});
