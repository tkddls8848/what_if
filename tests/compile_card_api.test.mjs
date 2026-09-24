import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.GEMINI_API_KEY = "";
process.env.CF_ACCOUNT_ID = "";
process.env.CF_API_TOKEN = "";
const { default: serverModule } = await import("../server.js");
const { app } = serverModule;

async function listen(server) {
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
test("설정 본문 → SSE 진행 → 검토 대기 저장 → 검수 확정의 전체 API 흐름", async () => {
  const worldId = `compile-api-test-${process.pid}`;
  const file = fileURLToPath(new URL(`../data/worlds/${worldId}.json`,import.meta.url));
  const original = {world:{world_id:worldId,title:"임시 세계관"},cards:[]};
  fs.writeFileSync(file,JSON.stringify(original),{flag:"wx"});
  const evidence = "미라는 이 마을의 사서다.";
  let fail = false;
  const fake = http.createServer(async (req,res) => {
    let input = "";for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    res.setHeader("Content-Type","application/json");
    if (fail) {res.statusCode = 503;res.end(JSON.stringify({error:"offline"}));return;}
    assert.equal(body.model,"qwen3.5:4b");
    const result = body.prompt.startsWith("인물 관계") ? {relationships:[]} : {cards:[{canonical_name:"미라",traits:["조용함"],evidence}]};
    res.end(JSON.stringify({response:JSON.stringify(result)}));
  });
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = await listen(fake);
  const server = http.createServer(app);
  const base = await listen(server);
  const post = (path,body,stream = false) => fetch(base + path,{method:"POST",headers:{"Content-Type":"application/json",...(stream ? {Accept:"text/event-stream"} : {})},body:JSON.stringify(body)});
  try {
    const path = `/api/worlds/${worldId}/compile`;
    const text = `${evidence} 미라는 조용하게 책을 정리한다. `.repeat(80);
    const response = await post(path,{text},true);
    const stream = await response.text();
    assert.match(stream,/event: progress/);assert.match(stream,/event: done/);
    const stored = JSON.parse(fs.readFileSync(file,"utf8"));
    assert.equal(stored.cards.length,1);
    assert.equal(stored.cards[0].status,"suggested");
    assert.equal(stored.sources[0].text,text);
    const cardId = stored.cards[0].card_id;
    // 새 카드가 확정되기 전에는 클라우드를 부르지 않고 거부한다.
    const turn = await post("/api/turn",{session:{world_id:worldId,card_ids:[cardId]},user_input:"들어간다"});
    assert.equal(turn.status,400);
    const update = await fetch(`${base}/api/worlds/${worldId}/cards/${cardId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({canonical_name:"미라",traits:["조용함"],taboos:[],examples:[],knowledge_as_of:"1화",status:"confirmed"})});
    assert.equal(update.status,200);
    const repeat = await post(path,{text});
    assert.equal((await repeat.json()).skipped,1);
    assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).cards[0].status,"confirmed");
    const before = fs.readFileSync(file,"utf8");
    fail = true;
    assert.equal((await post(path,{text})).status,502);
    assert.equal(fs.readFileSync(file,"utf8"),before);
    assert.equal((await post(path,{text,url:"https://example.fandom.com/wiki/A"})).status,400);
    assert.equal((await post(path,{text,model:"unbounded:70b"})).status,400);
  } finally {
    server.close();fake.close();fs.unlinkSync(file);
    if (previous === undefined) delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL = previous;
  }
});
