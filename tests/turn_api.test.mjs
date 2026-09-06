import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

process.env.NOVEL_IF_CACHE = "0";
process.env.CF_ACCOUNT_ID = "acc-test";
process.env.CF_API_TOKEN = "tok-secret";
// 이 파일의 가짜 Cloudflare 서버(startFakeCloudflare)는 flux-1-schnell 모양의
// 응답({result:{image}})만 흉내 낸다. 이미지 모델 레지스트리가 생기면서
// server.js의 실제 기본값은 phoenix-1.0(바이너리 응답, 다른 요청 바디)으로
// 바뀌었으므로, IMAGE_MODEL을 여기서 명시적으로 flux로 고정해 이 테스트가
// 원래 검증하던 것(캐시 히트/미스, SCENE_ROOT 오염 가드)을 계속 flux 모양
// 응답으로 그대로 검증하게 한다 — 이 파일은 이미지 모델 선택 자체를 다루지
// 않는다(그건 tests/scene.test.mjs, tests/image_client.test.mjs 몫이다).
process.env.IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
// 이 파일의 턴 테스트는 판정자(로컬 Ollama) 이야기가 아니다. 개발 머신에 진짜
// Ollama가 떠 있으면 매 턴마다 실제 추론이 돌아 테스트가 느려지고 머신마다 결과가
// 달라진다 — 아무도 듣지 않는 로컬 포트로 고정해 항상 "Ollama 없음" 경로를 타게
// 한다. "Ollama가 꺼져 있어도 턴은 성공한다"는 아래에 별도 테스트로 못 박는다.
process.env.OLLAMA_URL = "http://127.0.0.1:1";
// 이 파일은 실제 Express 앱을 부팅해 /api/turn을 직접 두드린다 — narration이
// <장면> 블록을 실으면 server.js가 진짜로 scene.resolveScene을 호출해 파일을
// 쓴다. rootDir를 실제 저장소 ROOT로 두면 이 테스트가 저장소 작업 트리에
// data/scenes/를 남긴다(테스트가 실패해도, 프로세스가 죽어도 남는다 — try/finally
// 정리는 성공 경로에만 기댈 수 있어 근본적으로 약하다). CF_API_BASE/OLLAMA_URL과
// 같은 패턴으로 SCENE_ROOT를 임시 디렉터리로 돌려,애초에 저장소 밖에만 쓰게 한다.
const SCENE_ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-scene-root-"));
process.env.SCENE_ROOT = SCENE_ROOT_DIR;
after(() => {
  delete process.env.SCENE_ROOT;
  fs.rmSync(SCENE_ROOT_DIR, { recursive: true, force: true });
});

const serverModule = await import("../server.js");
const { app } = serverModule.default || serverModule;

const SSE_BODY = [
  'data: {"response":"복도 끝에서 발소리가 멈췄다.\\n\\n"}\n\n',
  'data: {"response":"<선택지>\\n1. 가\\n2. 나\\n3. 다"}\n\n',
  'data: {"response":"","usage":{"prompt_tokens":3650,"completion_tokens":500,"total_tokens":4150}}\n\n',
  "data: [DONE]\n\n"
].join("");

/** Workers AI 대역. CF_API_BASE로 주입한다. */
function startFakeCloudflare(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const WORLDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "worlds");
// 실제 저장소의 data/scenes/ — SCENE_ROOT를 임시 디렉터리로 돌린 뒤로는 이 경로에
// 아무것도 써지면 안 된다. 오염 가드 테스트가 이 상수로 "안 써졌다"를 확인한다.
const REPO_SCENES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "scenes");
// 진짜 장면 파일은 이제 여기(SCENE_ROOT_DIR/data/scenes)에 써진다.
const TEST_SCENES_DIR = path.join(SCENE_ROOT_DIR, "data", "scenes");
const sceneModule = await import("../src/server/scene.js");
const { sceneHash } = sceneModule.default || sceneModule;

async function post(port, body, accept) {
  return fetch(`http://127.0.0.1:${port}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(accept ? { Accept: accept } : {}) },
    body: JSON.stringify(body)
  });
}

test("GET /api/cf/health: 설정 여부만 알리고 비밀을 싣지 않는다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/cf/health`);
    const body = await response.json();
    assert.equal(body.configured, true);
    assert.equal(body.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    assert.equal(body.budget.free_per_day, 10000);
    const text = JSON.stringify(body);
    assert.ok(!text.includes("tok-secret"), "API 토큰이 응답에 샜다");
    assert.ok(!text.includes("acc-test"), "account id가 응답에 샜다");
  } finally {
    server.close();
  }
});

test("POST /api/turn: JSON 모드로 턴을 돌려준다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.turn.narration, "복도 끝에서 발소리가 멈췄다.");
    assert.deepEqual(body.turn.choices, ["가", "나", "다"]);
    assert.equal(body.session.turn_count, 1);
    assert.ok(Math.abs(body.budget.used - 199.7407) < 0.001);
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: SSE 모드로 narration 조각을 먼저 흘리고 done으로 끝낸다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    }, "text/event-stream");
    const text = await response.text();

    assert.ok(text.includes("event: narration"));
    assert.ok(text.includes("event: done"));
    assert.ok(text.indexOf("event: narration") < text.indexOf("event: done"));
    assert.ok(!text.includes("<선택지>"), "마커가 SSE로 샜다");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 빈 입력은 400이다", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "demo" }, user_input: "  " });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("POST /api/turn: 없는 world_id는 404다", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "nope" }, user_input: "가" });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error_code, "NOT_FOUND");
  } finally {
    server.close();
  }
});

test("POST /api/turn: world_id 경로 조작을 거부한다", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "../../package" }, user_input: "가" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("POST /api/turn: 응답에 budget_unknown과 turn.session_id를 싣는다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    });
    const body = await response.json();
    // SSE_BODY의 usage는 가격표에 있는 모델 기준이라 단가를 알고 있다 → false.
    assert.equal(body.budget_unknown, false);
    assert.equal(body.turn.session_id, "s1");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: Ollama가 죽어 있어도(판정 불가) 턴은 200으로 성공한다", async () => {
  // 이 파일 전체가 OLLAMA_URL을 존재하지 않는 포트로 고정해 두었다(파일 상단 참고).
  // server.js가 이제 judgeClient를 넘기므로, 이 테스트가 없으면 "판정자가 죽어
  // 있어도 턴이 죽지 않는다"는 배선이 회귀해도 아무 테스트도 잡아내지 못한다.
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.turn.narration, "복도 끝에서 발소리가 멈췄다.");
    // play.html은 이 두 필드로 "게이지가 안 움직이는 게 버그가 아니라 판정기가
    // 죽어 있어서"라고 안내한다 — 응답에서 빠지면 그 안내를 띄울 방법이 없다.
    assert.equal(body.judge_unavailable, true, "판정자가 죽어 있으면 응답에도 그렇게 실려야 한다");
    assert.equal(body.last_change, null);
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: card_ids가 있으면 판정이 돌아 last_change와 sim이 응답에 채워진다", async () => {
  // play.html의 핵심 결함 재현/회귀 방지: 세션에 card_ids가 없으면 판정 대상
  // 카드가 없어 last_change가 절대 채워지지 않는다. 여기서는 card_ids를 채워
  // 보내 반대로("배선이 맞으면 실제로 채워진다") 확인한다. 이 테스트만은 이
  // 파일 상단이 고정한 죽은 OLLAMA_URL 대신 진짜 응답하는 대역 Ollama를 띄운다.
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;

  const fakeOllama = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        response: JSON.stringify({
          attraction: ["혼자 남은 이유를 캐묻지 않고 그냥 옆에 앉는다"],
          dislike: [],
          relief: ["해린이 곁에 있는 것을 밀어내지 않는다"],
          strain: []
        })
      }));
    });
  });
  await new Promise((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
  const prevOllamaUrl = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${fakeOllama.address().port}`;

  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s1", world_id: "demo", card_ids: ["haerin"] },
      user_input: "옆에 앉는다"
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.judge_unavailable, false);
    assert.ok(body.last_change, "card_ids가 있으면 last_change가 null이 아니어야 한다");
    assert.equal(body.last_change.card_id, "haerin");
    assert.ok(body.session.sim, "sim 상태가 세션에 실려야 한다");
    assert.ok(body.session.sim.characters.haerin.affection > 0, "attraction이 반영되어 호감이 올라야 한다");
    assert.ok(body.session.sim.recovery > 0, "relief가 반영되어 회복이 올라야 한다");
  } finally {
    server.close();
    fake.server.close();
    fakeOllama.close();
    delete process.env.CF_API_BASE;
    process.env.OLLAMA_URL = prevOllamaUrl;
  }
});

test("POST /api/turn: 알 수 없는 model은 400이다 (경로 주입 방지)", async () => {
  const { server, port } = await listen();
  try {
    // model이 llm/cloudflare.js에서 업스트림 URL 경로에 그대로 들어간다. 가격표에
    // 없는 값(경로 조작 포함)은 요청이 나가기 전에 거부되어야 한다.
    const response = await post(port, {
      session: { world_id: "demo" },
      user_input: "가",
      model: "../../../../accounts/x/tokens/verify"
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("POST /api/turn: 대문자가 섞인 world_id는 거부된다 (Windows/Linux 대소문자 불일치 방지)", async () => {
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "DEMO" }, user_input: "가" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error_code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

test("POST /api/turn: 업스트림 429는 502와 RATE_LIMITED로 나간다", async () => {
  const fake = await startFakeCloudflare((_req, res) => {
    res.statusCode = 429;
    res.end("{}");
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, { session: { world_id: "demo" }, user_input: "가" });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error_code, "RATE_LIMITED");
    assert.equal(body.retryable, true);
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 장면이 바뀌면 scene 이벤트를 보내고, 같은 장면은 캐시에서 온다(이미지 API 재호출 없음)", async () => {
  // 장면 블록을 맨 앞에 둔다 — narrator가 실제로 만드는 순서다. 예전 분할기는
  // 첫 마커에서 영구히 멈추는 방식이라 이 순서에서 narration 이벤트가 통째로
  // 비었다(2회차 수정에서 고친 결함). 이 자리에서 그 순서로 다시 확인한다.
  // visual 줄(영어)이 있어야 scene.resolveScene이 이미지를 실제로 만든다(A4:
  // visual이 없으면 한국어로 대체하지 않고 건너뛴다 — src/server/scene.js 참고).
  const SCENE_SSE_BODY = [
    'data: {"response":"<장면>\\n장소: 3학년 2반 교실\\n시간: 밤\\n날씨: 비\\nvisual: empty Korean high school classroom at night, fluorescent light on rows of desks, rain streaking the windows\\n</장면>\\n"}\n\n',
    'data: {"response":"복도 끝에서 발소리가 멈췄다.\\n\\n"}\n\n',
    'data: {"response":"<선택지>\\n1. 가\\n2. 나\\n3. 다"}\n\n',
    'data: {"response":"","usage":{"prompt_tokens":3650,"completion_tokens":500,"total_tokens":4150}}\n\n',
    "data: [DONE]\n\n"
  ].join("");

  let imageCalls = 0;
  // 실제 flux-1-schnell은 JPEG를 돌려준다(매직 바이트 FF D8 FF, base64로 "/9j/"로
  // 시작) — scene.js가 응답 바이트에서 형식을 감지해 확장자를 정하므로, 가짜
  // 응답도 진짜 매직 바이트를 실어야 한다("QkFTRTY0"처럼 임의의 문자열을 base64로
  // 감싼 값은 이제 형식 미상으로 거부된다).
  const fake = await startFakeCloudflare((req, res) => {
    if (req.url.includes("flux-1-schnell")) {
      imageCalls += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: { image: "/9j/4AAQSkZJRg==" } }));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SCENE_SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const first = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    }, "text/event-stream");
    const firstText = await first.text();

    // narration 이벤트들의 delta를 모아, 장면이 맨 앞이어도 그 뒤 서술이
    // 통째로 사라지지 않고 실제로 스트림에 실리는지 직접 확인한다(단위 테스트
    // 만으로는 안 잡히는 경로 — server.js의 SSE 배선까지 다 지나야 나온다).
    const narrationDeltas = [...firstText.matchAll(/event: narration\ndata: (\{.*\})/g)]
      .map((m) => JSON.parse(m[1]).delta)
      .join("");
    assert.notEqual(narrationDeltas, "", "장면이 맨 앞이면 narration 스트림이 통째로 비어버리는 결함이 있었다");
    assert.ok(narrationDeltas.includes("복도 끝에서 발소리가 멈췄다"), `서술이 스트림에 안 왔다: ${JSON.stringify(narrationDeltas)}`);
    assert.ok(!narrationDeltas.includes("장소"), "장면 데이터가 서술 스트림에 샜다");

    assert.ok(firstText.includes("event: scene"), "scene 이벤트가 안 왔다");
    assert.ok(!firstText.includes("<장면>"), "장면 마커가 스트림에 샜다");
    assert.ok(!firstText.includes("<선택지>"), "선택지 마커가 스트림에 샜다");
    assert.equal(imageCalls, 1);

    // 같은 세계관·같은 장면으로 두 번째 턴 — 캐시 적중이라 이미지 API가 또
    // 불리면 안 된다.
    const second = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "다시 한번"
    }, "text/event-stream");
    const secondText = await second.text();

    assert.ok(secondText.includes("event: scene"));
    assert.equal(imageCalls, 1, "캐시된 장면인데 이미지 API를 또 불렀다");

    const hash = sceneHash({ worldId: "demo", scene: { place: "3학년 2반 교실", time: "밤", weather: "비" } });
    // 파일은 SCENE_ROOT(임시 디렉터리) 아래에 써져야 한다 — 실제 저장소가 아니라.
    assert.ok(fs.existsSync(path.join(TEST_SCENES_DIR, "demo", `${hash}.jpg`)), "장면 이미지 파일이 안 써졌다");
    // 오염 가드: SCENE_ROOT를 돌렸으니 실제 저장소의 data/scenes/에는 이 턴이
    // 아무것도 남기면 안 된다. 이게 이 파일의 핵심 회귀 가드다 — server.js가
    // getSceneRoot() 대신 실수로 다시 ROOT를 하드코딩하면 여기서 즉시 깨진다.
    assert.ok(
      !fs.existsSync(path.join(REPO_SCENES_DIR, "demo", `${hash}.jpg`)),
      "SCENE_ROOT를 무시하고 실제 저장소(data/scenes/)에 장면 이미지를 썼다 — 서버가 getSceneRoot() 대신 ROOT를 쓰고 있는지 확인하라"
    );
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 장면 이미지는 요청 시점의 SCENE_ROOT를 따른다 — 이 테스트 파일이 실제 저장소를 건드리지 않는다는 근거", async () => {
  // 이 파일의 다른 모든 테스트는 파일 최상단에서 한 번 세팅한 SCENE_ROOT_DIR를
  // 공유한다. 그 공유값이 우연히 ROOT와 같아져도(예: 리팩터 실수로 getSceneRoot()가
  // 상수를 캐시해버리는 경우) 앞의 테스트들은 못 잡는다 — 여기서는 SCENE_ROOT를
  // 파일 시작 이후에 "다시" 다른 임시 디렉터리로 바꿔, server.js가 매 요청마다
  // process.env.SCENE_ROOT를 다시 읽는지(OLLAMA_URL/CF_API_BASE와 같은 요청-시점
  // 패턴을 실제로 따르는지)를 직접 확인한다.
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-scene-root-override-"));
  const previousSceneRoot = process.env.SCENE_ROOT;
  process.env.SCENE_ROOT = overrideDir;

  const SCENE_SSE_BODY = [
    'data: {"response":"<장면>\\n장소: 옥상\\n시간: 낮\\n날씨: 맑음\\nvisual: empty rooftop under a clear sky, waist-high railing, distant city lights\\n</장면>\\n"}\n\n',
    'data: {"response":"바람이 세게 불었다.\\n\\n"}\n\n',
    'data: {"response":"<선택지>\\n1. 가\\n2. 나\\n3. 다"}\n\n',
    'data: {"response":"","usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n',
    "data: [DONE]\n\n"
  ].join("");
  const fake = await startFakeCloudflare((req, res) => {
    if (req.url.includes("flux-1-schnell")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: { image: "/9j/4AAQSkZJRg==" } }));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SCENE_SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const res = await post(port, {
      session: { session_id: "s-override", world_id: "demo" },
      user_input: "옥상으로 간다"
    }, "text/event-stream");
    const text = await res.text();
    assert.ok(text.includes("event: scene"), "scene 이벤트가 안 왔다");

    const hash = sceneHash({ worldId: "demo", scene: { place: "옥상", time: "낮", weather: "맑음" } });
    // 이 요청이 SCENE_ROOT를 다시 읽었다면 파일은 overrideDir에 있어야 한다.
    assert.ok(
      fs.existsSync(path.join(overrideDir, "data", "scenes", "demo", `${hash}.jpg`)),
      "server.js가 요청 시점에 SCENE_ROOT를 다시 읽지 않는다 — 새 오버라이드 디렉터리에 안 써졌다"
    );
    // 그리고 어느 쪽 SCENE_ROOT를 쓰든 실제 저장소는 절대 건드리면 안 된다.
    assert.ok(
      !fs.existsSync(path.join(REPO_SCENES_DIR, "demo", `${hash}.jpg`)),
      "SCENE_ROOT 오버라이드에도 실제 저장소(data/scenes/)에 장면 이미지를 썼다"
    );
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
    process.env.SCENE_ROOT = previousSceneRoot;
    fs.rmSync(overrideDir, { recursive: true, force: true });
  }
});

test("POST /api/turn: 최상위가 null인 세계관 파일은 500이고, 서버는 죽지 않고 다음 요청을 받는다", async () => {
  const worldId = "broken-test-world";
  const worldFile = path.join(WORLDS_DIR, `${worldId}.json`);
  fs.writeFileSync(worldFile, "null");

  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const broken = await post(port, { session: { world_id: worldId }, user_input: "가" });
    assert.equal(broken.status, 500);
    const brokenBody = await broken.json();
    assert.equal(brokenBody.error_code, "INTERNAL");

    // 요지: 위 요청이 프로세스를 끝내지 않았다는 것 — 같은 서버에 바로 다음 요청을 보내
    // 정상적으로 처리되는지 확인한다.
    const ok = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.turn.narration, "복도 끝에서 발소리가 멈췄다.");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
    fs.rmSync(worldFile, { force: true });
  }
});
