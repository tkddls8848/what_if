"use strict";
const { stripWikiChrome } = require("./wikisource");
const { MAX_SOURCE_CHARS } = require("./compile_card");

/** Fandom의 문서 URL을 MediaWiki parse 요청으로 바꾼다. 임의 서버로 중계하지 않는다. */
function sourceTarget(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9-]+\.fandom\.com$/.test(url.hostname)) throw new Error("Fandom의 https 문서 URL을 입력하세요. 다른 사이트는 본문을 붙여 넣어 주세요.");
  const match = url.pathname.match(/^\/(?:([a-z-]{2,12})\/)?wiki\/(.+)$/);
  if (!match) throw new Error("Fandom 문서 주소에서 /wiki/ 뒤의 문서 이름을 찾지 못했습니다.");
  const api = new URL(`${match[1] ? `/${match[1]}` : ""}/api.php`, url.origin);
  api.search = new URLSearchParams({action:"parse",prop:"text",format:"json",formatversion:"2",page:decodeURIComponent(match[2])}).toString();
  return {api:api.href,source_url:url.href};
}
async function fetchSource(url, {fetchImpl = fetch, timeoutMs = 15000} = {}) {
  let target;
  try { target = sourceTarget(url); } catch (error) { return {ok:false,error_code:"INVALID_ARGUMENT",message:error.message}; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.api,{signal:controller.signal,redirect:"error",headers:{Accept:"application/json"}});
    if (!response.ok) throw new Error(`자료 사이트가 HTTP ${response.status}로 응답했습니다.`);
    const reader = response.body.getReader();
    const parts = []; let size = 0;
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error("문서가 너무 큽니다. 필요한 부분만 붙여 넣어 주세요."); }
      parts.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (typeof body.parse?.text !== "string") throw new Error("문서 본문을 찾지 못했습니다.");
    const { htmlToText } = await import("../core/epub.js");
    const text = htmlToText(stripWikiChrome(body.parse.text));
    if (text.length < 100 || text.length > MAX_SOURCE_CHARS) throw new Error(`본문이 너무 짧거나 깁니다. 필요한 설정 자료 100~${MAX_SOURCE_CHARS}자를 붙여 넣어 주세요.`);
    return {ok:true,text,source_url:target.source_url};
  } catch (error) {
    return {ok:false,error_code:"SOURCE_FAILED",message:`${error.name === "AbortError" ? "자료 응답 시간이 초과됐습니다." : error.message} URL 가져오기가 안 되면 본문을 붙여 넣어 주세요.`};
  } finally { clearTimeout(timer); }
}
module.exports = {sourceTarget,fetchSource};
