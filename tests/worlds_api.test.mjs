/**
 * GET /api/worlds, GET /api/worlds/:world_id.
 *
 * turn_api.test.mjs와 별도 파일로 둔다 — 저 파일은 /api/turn(턴 생성) 경로 하나에
 * 집중하고, 여기는 순수 조회용 세계관 목록/상세 경로다. server_api.test.mjs나
 * routes.test.mjs처럼 이 레포는 라우트 그룹 단위로 테스트 파일을 나누는 관례를 쓴다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.NOVEL_IF_CACHE = "0";
process.env.CF_ACCOUNT_ID = "acc-test";
process.env.CF_API_TOKEN = "tok-secret";

const serverModule = await import("../server.js");
const { app } = serverModule.default || serverModule;

const WORLDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "worlds");

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// demo.json의 인물 이름은 이 테스트가 소유한 값이 아니다 — 실제 파일을 읽어 기대값을
// 뽑는다. 리터럴로 박아두면 세계관 파일 내용이 바뀔 때마다(개명 등) 이 API 계약과
// 무관한 이유로 테스트가 깨진다.
function loadDemoRaw() {
  return JSON.parse(fs.readFileSync(path.join(WORLDS_DIR, "demo.json"), "utf8"));
}

test("카드 검수 저장은 세계관과 다른 카드 필드를 보존하고 잘못된 요청을 거부한다", async () => {
  const worldId = `review-test-${process.pid}`;
  const file = path.join(WORLDS_DIR, `${worldId}.json`);
  const raw = { world: {world_id:worldId,title:"검수 테스트",opening:"첫 장면"},
    cards:[{card_id:"a",canonical_name:"인물",persona:{values:["약속"]},romance:{care_signs:["문을 잡는다"]}}] };
  fs.writeFileSync(file, JSON.stringify(raw), {flag:"wx"});
  const {server,port} = await listen();
  const url = `http://127.0.0.1:${port}/api/worlds/${worldId}/cards/a`;
  const payload = {canonical_name:"수정한 인물",traits:["신중"],taboos:["거짓말"],examples:["괜찮아."],knowledge_as_of:"1화",status:"confirmed"};
  try {
    const response = await fetch(url, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    assert.equal(response.status, 200);
    const saved = JSON.parse(fs.readFileSync(file,"utf8"));
    assert.deepEqual(saved.world,raw.world);
    assert.deepEqual(saved.cards[0].romance,raw.cards[0].romance);
    assert.deepEqual(saved.cards[0].persona.values,["약속"]);
    assert.equal(saved.cards[0].canonical_name,"수정한 인물");
    const bad = await fetch(url, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload,traits:"잘못된 값"})});
    assert.equal(bad.status,400);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),saved);
  } finally { server.close(); fs.unlinkSync(file); }
});

test("GET /api/worlds: 두 세계관을 제목·등장인물 이름과 함께 목록으로 돌려준다", async () => {
  const demoRaw = loadDemoRaw();
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/worlds`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const ids = body.worlds.map((w) => w.world_id);
    assert.ok(ids.includes("demo"), "demo가 목록에 없다");
    assert.ok(ids.includes("lighthouse"), "lighthouse가 목록에 없다");

    const demo = body.worlds.find((w) => w.world_id === "demo");
    assert.equal(demo.title, demoRaw.world.title);
    assert.deepEqual(demo.card_names, demoRaw.cards.map((c) => c.canonical_name));

    const lighthouse = body.worlds.find((w) => w.world_id === "lighthouse");
    assert.equal(lighthouse.title, "등대지기의 겨울");
    assert.deepEqual(lighthouse.card_names, ["표관수", "설아"]);
  } finally {
    server.close();
  }
});

test("GET /api/worlds/demo: 정규화된 world와 cards를 오프닝과 함께 돌려준다", async () => {
  const demoRaw = loadDemoRaw();
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/worlds/demo`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.world.world_id, "demo");
    assert.equal(body.world.title, demoRaw.world.title);
    assert.ok(body.world.opening.length > 0, "오프닝이 비어 있다");
    assert.ok(Array.isArray(body.cards));
    assert.ok(body.cards.some((card) => card.canonical_name === demoRaw.cards[0].canonical_name));
  } finally {
    server.close();
  }
});

test("GET /api/worlds/nope: 없는 세계관은 404다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/worlds/nope`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error_code, "NOT_FOUND");
  } finally {
    server.close();
  }
});

test("GET /api/worlds/:world_id: 경로 조작을 거부한다 (INVALID_ARGUMENT)", async () => {
  const { server, port } = await listen();
  try {
    // fetch/URL은 리터럴 "../../"를 경로 세그먼트로 보고 요청을 보내기 전에
    // 정규화해 버린다("/api/worlds/../../package" -> "/package") — 그러면 우리
    // 라우트에 도달하지도 못해 이 가드를 테스트한 게 아니게 된다. "/"를 %2F로
    // 인코딩해 하나의 경로 세그먼트로 유지해야 실제로 world_id 파라미터 안에
    // "../../package"가 들어간 채로 우리 핸들러까지 도달한다 — WORLD_ID 정규식이
    // 그 값을 거부하는지를 확인하는 것이 이 테스트의 목적이다.
    const segment = encodeURIComponent("../../package");
    const response = await fetch(`http://127.0.0.1:${port}/api/worlds/${segment}`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("GET /api/worlds: 깨진 세계관 파일이 있어도 목록 전체가 죽지 않는다", async () => {
  const worldId = "broken-worlds-list-test";
  const worldFile = path.join(WORLDS_DIR, `${worldId}.json`);
  assert.ok(!fs.existsSync(worldFile), "테스트 파일이 이미 존재한다 — 이름이 충돌한다");
  fs.writeFileSync(worldFile, "{ not valid json");

  try {
    const { server, port } = await listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/worlds`);
      assert.equal(response.status, 200);
      const body = await response.json();
      const ids = body.worlds.map((w) => w.world_id);
      assert.ok(!ids.includes(worldId), "깨진 파일이 목록에 섞여 들어왔다");
      assert.ok(ids.includes("demo"), "깨진 파일 때문에 나머지 목록도 사라졌다");
      assert.ok(ids.includes("lighthouse"), "깨진 파일 때문에 나머지 목록도 사라졌다");
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(worldFile, { force: true });
    assert.ok(!fs.existsSync(worldFile), "테스트가 생성한 파일이 정리되지 않았다");
  }
});
