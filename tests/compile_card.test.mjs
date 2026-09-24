import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import compiler from "../src/server/compile_card.js";
import library from "../src/server/card_library.js";
import sourceApi from "../src/server/fetch_source.js";
import { isPlayableCard, normalizeCard } from "../src/core/card.js";

const evidence = "미라는 준의 친구이며 언제나 침착하다.";
const text = `${evidence} 미라는 말했다. 천천히 해도 괜찮아. 준은 신중하다. `.repeat(70);
const candidate = {canonical_name:"미라",aliases:["없는 별명"],traits:["침착함"],values:[],taboos:[],examples:["천천히 해도 괜찮아.","없는 대사"],evidence};
function client(overrides = {}) {
  return {async generateJson({prompt}) {
    if (prompt.startsWith("인물 관계")) return {ok:true,data:{relationships:[]}};
    return {ok:true,data:{cards:[{...candidate,...overrides}]}};
  }};
}
test("카드는 반복 근거를 합치고 원문 대사·위치를 보존하며 검토 대기로 생성된다", async () => {
  const progress = [];
  const result = await compiler.compileCards({text,worldId:"test",client:client(),onProgress:value=>progress.push(value)});
  assert.equal(result.ok,true);
  const card = result.cards[0];
  assert.equal(card.status,"suggested");
  assert.equal(card.knowledge_as_of,"");
  assert.deepEqual(card.persona.traits,["침착함"]);
  assert.deepEqual(card.aliases,[]);
  assert.deepEqual(card.speech.examples,["천천히 해도 괜찮아."]);
  assert.equal(isPlayableCard(card),false);
  assert.equal(isPlayableCard({...card,status:"confirmed"}),true);
  assert.ok(card.source.spans.length >= 2);
  for (const span of card.source.spans) assert.equal(text.slice(span.char_start,span.char_end),span.quote);
  for (const chunk of result.source.chunks) assert.equal(text.slice(chunk.char_start,chunk.char_end),chunk.text);
  assert.equal(progress.at(-1).phase,"relationships");
  assert.equal(normalizeCard(card).method,"ollama-card-compile");
});
test("원문에 없는 인물·근거는 버리고 한 구간의 중복 후보를 반복 확인으로 세지 않는다", async () => {
  assert.equal((await compiler.compileCards({text,worldId:"test",client:client({evidence:"조작된 근거"})})).error_code,"NO_CARDS");
  const one = await compiler.compileCards({text:text.slice(0,500),worldId:"test",client:{async generateJson(){return {ok:true,data:{cards:[candidate,candidate]}};}}});
  assert.equal(one.error_code,"NO_CARDS");
});
test("호출 실패·비정상 구조·취소는 카드 저장 없이 실패를 반환한다", async () => {
  const failed = await compiler.compileCards({text,worldId:"test",client:{async generateJson(){return {ok:false,error_code:"CONNECTION_FAILED"};}}});
  assert.equal(failed.error_code,"CONNECTION_FAILED");
  const bad = await compiler.compileCards({text,worldId:"test",client:{async generateJson(){return {ok:true,data:{cards:"bad"}};}}});
  assert.equal(bad.error_code,"BAD_RESPONSE");
  const abort = new AbortController();abort.abort();
  const cancelled = await compiler.compileCards({text,worldId:"test",client:client(),signal:abort.signal});
  assert.equal(cancelled.error_code,"ABORTED");
});
test("자동 저장은 기존 카드·세계관을 보존하고 재요청을 중복 저장하지 않는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"novel-card-test-"));
  const file = path.join(dir,"test.json");
  const raw = {world:{world_id:"test",setting:"원래 배경"},cards:[{card_id:"existing",canonical_name:"준",status:"confirmed"}]};
  fs.writeFileSync(file,JSON.stringify(raw));
  try {
    const compiled = await compiler.compileCards({text,worldId:"test",client:client()});
    assert.equal(library.saveGeneratedCards(dir,"test",compiled).added.length,1);
    assert.equal(library.saveGeneratedCards(dir,"test",compiled).added.length,0);
    const saved = JSON.parse(fs.readFileSync(file,"utf8"));
    assert.deepEqual(saved.world,raw.world);
    assert.deepEqual(saved.cards[0],raw.cards[0]);
    assert.equal(saved.sources.length,1);
    assert.equal(saved.sources[0].text,text);
  } finally {fs.unlinkSync(file);fs.rmdirSync(dir);}
});
test("Fandom URL은 문서 API로 변환하며 임의 호스트·자격증명·포트는 거부한다", () => {
  assert.ok(sourceApi.sourceTarget("https://example.fandom.com/ko/wiki/Character").api.startsWith("https://example.fandom.com/ko/api.php?"));
  for (const url of ["http://example.fandom.com/wiki/A","https://127.0.0.1/wiki/A","https://example.fandom.com.evil.test/wiki/A","https://user:pass@example.fandom.com/wiki/A","https://example.fandom.com:8080/wiki/A"]) assert.throws(()=>sourceApi.sourceTarget(url));
});
test("Fandom 본문을 공통 HTML 변환기로 읽고 실패하면 붙여넣기 안내를 제공한다", async () => {
  let requested;
  const result = await sourceApi.fetchSource("https://example.fandom.com/wiki/Mira",{fetchImpl:async (url,options)=>{
    requested = {url,options};return new Response(JSON.stringify({parse:{text:`<p>${text}</p>`}}));
  }});
  assert.equal(result.ok,true);assert.ok(result.text.includes(evidence));
  assert.equal(requested.options.redirect,"error");
  const denied = await sourceApi.fetchSource("https://example.fandom.com/wiki/Mira",{fetchImpl:async()=>new Response("blocked",{status:403})});
  assert.equal(denied.ok,false);assert.match(denied.message,/붙여/);
});
