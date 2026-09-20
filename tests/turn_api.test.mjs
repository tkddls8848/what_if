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
    // 폴백 체인은 평소에 한 번도 안 불리므로, 설정 여부를 여기서 볼 수 있어야
    // 한다 — 정작 할당이 마른 날에 키가 비어 있었다는 걸 그때 알면 늦다.
    assert.deepEqual(body.providers.map((item) => item.provider), ["cloudflare", "gemini"]);
    assert.equal(body.providers[0].configured, true);
    // 이 테스트 파일은 GEMINI_API_KEY를 세팅하지 않는다 — 미설정으로 보여야 한다.
    assert.equal(body.providers[1].configured, false);
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

/** Gemini SSE 대역의 본문. 서술 + 선택지 블록을 두 프레임에 나눠 보낸다. */
const GEMINI_SSE_BODY = [
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: "등대 불빛이 한 번 꺼졌다.\n\n" }] } }]
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: "<선택지>\n1. 가\n2. 나\n3. 다" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3650, candidatesTokenCount: 500, totalTokenCount: 4150 }
  })}\n\n`
].join("");

/** Cloudflare가 하루 할당(code 3036)을 소진했을 때 실제로 보내는 모양. */
function quotaExhausted(res) {
  res.statusCode = 429;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    success: false,
    errors: [{ code: 3036, message: "Account limited" }]
  }));
}

test("POST /api/turn: Cloudflare 할당이 마르면 Gemini가 턴을 이어 받는다", async () => {
  const cf = await startFakeCloudflare((_req, res) => quotaExhausted(res));
  const gemini = await startFakeCloudflare((req, res) => {
    // 폴백은 자기 모델을 써야 한다 — 호출부가 넘긴 Cloudflare 모델 이름이
    // 그대로 오면 실제 Gemini에서는 404다(fallback.js의 modelFor 참고).
    assert.ok(req.url.includes("/models/gemini-2.5-flash:streamGenerateContent"), `폴백 URL이 이상하다: ${req.url}`);
    assert.equal(req.headers["x-goog-api-key"], "gem-secret");
    res.setHeader("Content-Type", "text/event-stream");
    res.end(GEMINI_SSE_BODY);
  });
  process.env.CF_API_BASE = cf.url;
  process.env.GEMINI_API_BASE = gemini.url;
  process.env.GEMINI_API_KEY = "gem-secret";

  const { server, port } = await listen();
  try {
    // 장부는 프로세스 전역이라 앞선 테스트가 이미 쓴 양이 남아 있다. 절대값이
    // 아니라 "이 턴이 얼마를 더했는가"를 본다 — 더한 값이 0이어야 한다.
    const before = await (await fetch(`http://127.0.0.1:${port}/api/cf/health`)).json();

    const response = await post(port, {
      session: { session_id: "s-fallback", world_id: "demo" },
      user_input: "옆에 선다"
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.turn.narration, "등대 불빛이 한 번 꺼졌다.");
    assert.deepEqual(body.turn.choices, ["가", "나", "다"]);
    assert.equal(body.provider, "gemini");
    // 실제로 답한 모델로 기록한다 — 요청한 Cloudflare 모델 이름이 아니다.
    assert.equal(body.turn.model, "gemini-2.5-flash");
    // Neuron은 Cloudflare의 단위다. Gemini가 쓴 양은 그 장부의 대상이 아니므로
    // 0으로 적지 않고 "모른다"고 알린다(turn.js·budget.js의 원칙).
    assert.equal(body.budget_unknown, true);
    assert.equal(body.budget.used, before.budget.used, "Gemini 턴이 Neuron 장부를 움직였다");
    const text = JSON.stringify(body);
    assert.ok(!text.includes("gem-secret"), "Gemini 키가 응답에 샜다");
  } finally {
    server.close();
    cf.server.close();
    gemini.server.close();
    delete process.env.CF_API_BASE;
    delete process.env.GEMINI_API_BASE;
    delete process.env.GEMINI_API_KEY;
  }
});

test("POST /api/turn: GEMINI_API_KEY가 없으면 Cloudflare 실패가 그대로 나온다", async () => {
  const cf = await startFakeCloudflare((_req, res) => quotaExhausted(res));
  process.env.CF_API_BASE = cf.url;

  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s-noquota", world_id: "demo" },
      user_input: "옆에 선다"
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error_code, "QUOTA_EXHAUSTED");
    // 폴백이 없으니 "폴백도 모두 실패" 같은 군더더기가 붙지 않는다 —
    // 메시지는 지금까지와 똑같아야 한다.
    assert.ok(!body.message.includes("폴백"));
  } finally {
    server.close();
    cf.server.close();
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

// --- 장면 판정과 배경 이미지 (미술감독 → 이미지) ---
//
// 서술자는 더 이상 장면을 쓰지 않는다. 장면은 서술이 끝난 뒤 도는 Jev 호출이
// 정하고, 그 결과가 바뀌었을 때만 이미지가 만들어진다. 여기서는 그 배선이
// server.js의 SSE까지 실제로 이어지는지 본다(단위 테스트만으로는 안 잡히는 경로).

/** demo 세계관의 3학년 2반 교실을 확신 있게 고르는 Jev 응답(실물 봉투 모양). */
function jevAnswer(locationId, time, weather, confidence = 0.96) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      state: "Completed",
      gatewayMetadata: { keySource: "Unified" },
      result: {
        model: "jev-1.13.0",
        answers: {
          place: { type: "choice", choice: locationId, confidence, probabilities: { [locationId]: confidence } },
          time: { type: "choice", choice: time, confidence, probabilities: { [time]: confidence } },
          weather: { type: "choice", choice: weather, confidence, probabilities: { [weather]: confidence } }
        },
        usage: { input_tokens: 640, output_tokens: 124 }
      }
    }
  };
}

/**
 * Workers AI 대역 — 이제 세 종류의 요청을 받는다.
 *   1. 이미지: .../ai/run/@cf/black-forest-labs/flux-1-schnell
 *   2. 장면 판정: .../ai/run          (모델을 바디에 싣는 통합 엔드포인트)
 *   3. 서술: .../ai/run/@cf/meta/...  (SSE)
 * 1번을 먼저 걸러야 한다 — 이미지 URL도 "/ai/run"을 포함한다.
 */
function fakeWorkersAi({ sseBody, jev, onImage }) {
  return (req, res) => {
    if (req.url.includes("flux-1-schnell")) {
      if (onImage) onImage();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result: { image: "/9j/4AAQSkZJRg==" } }));
      return;
    }
    if (/\/ai\/run\/?(\?.*)?$/.test(req.url)) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(jev));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(sseBody);
  };
}

test("POST /api/turn: 장면이 바뀌면 scene 이벤트를 보내고, 같은 장면은 다시 그리지 않는다", async () => {
  let imageCalls = 0;
  const fake = await startFakeCloudflare(fakeWorkersAi({
    sseBody: SSE_BODY,
    jev: jevAnswer("classroom_3_2", "밤", "비"),
    onImage: () => { imageCalls += 1; }
  }));
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const first = await post(port, {
      session: { session_id: "s1", world_id: "demo" },
      user_input: "옆에 선다"
    }, "text/event-stream");
    const firstText = await first.text();

    const narrationDeltas = [...firstText.matchAll(/event: narration\ndata: (\{.*\})/g)]
      .map((m) => JSON.parse(m[1]).delta)
      .join("");
    assert.ok(narrationDeltas.includes("복도 끝에서 발소리가 멈췄다"), `서술이 스트림에 안 왔다: ${JSON.stringify(narrationDeltas)}`);
    assert.ok(!narrationDeltas.includes("<선택지>"), "선택지 마커가 서술 스트림에 샜다");

    assert.ok(firstText.includes("event: scene"), "첫 턴에 scene 이벤트가 안 왔다");
    assert.equal(imageCalls, 1);

    // 세션의 current_scene이 첫 턴에서 정해졌다. 두 번째 턴에 같은 답이 오면
    // 장면이 안 바뀐 것이므로 **이미지를 아예 부르지 않는다** — 캐시 히트조차
    // 필요 없다(설계 6절).
    const done = [...firstText.matchAll(/event: done\ndata: (\{[\s\S]*?\})\n\n/g)].pop();
    assert.ok(done, "done 이벤트가 없다");
    const session = JSON.parse(done[1]).session;
    assert.equal(session.current_scene.location_id, "classroom_3_2");

    const second = await post(port, { session, user_input: "다시 한번" }, "text/event-stream");
    const secondText = await second.text();
    assert.ok(!secondText.includes("event: scene"), "장면이 안 바뀌었는데 scene 이벤트를 보냈다");
    assert.equal(imageCalls, 1, "장면이 안 바뀌었는데 이미지를 또 그렸다");

    const hash = sceneHash({
      worldId: "demo",
      scene: { location_id: "classroom_3_2", time: "밤", weather: "비" }
    });
    assert.ok(fs.existsSync(path.join(TEST_SCENES_DIR, "demo", `${hash}.jpg`)), "장면 이미지 파일이 안 써졌다");
    // 오염 가드: SCENE_ROOT를 돌렸으니 실제 저장소의 data/scenes/에는 아무것도
    // 남으면 안 된다. server.js가 getSceneRoot() 대신 ROOT를 하드코딩하면 여기서 깨진다.
    assert.ok(
      !fs.existsSync(path.join(REPO_SCENES_DIR, "demo", `${hash}.jpg`)),
      "SCENE_ROOT를 무시하고 실제 저장소(data/scenes/)에 장면 이미지를 썼다"
    );
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 장소가 바뀌면 다시 그리고, 캐시된 장면으로 돌아오면 이미지 API를 안 부른다", async () => {
  let imageCalls = 0;
  // 앞 테스트가 이미 (classroom_3_2, 밤, 비)를 캐시에 써 뒀다. 같은 해시를 쓰면
  // 첫 턴부터 캐시 히트라 "새로 그린다"를 못 본다 — 시간대를 달리해 키를 가른다.
  let jev = jevAnswer("classroom_3_2", "자정", "비");
  const fake = await startFakeCloudflare((req, res) => fakeWorkersAi({
    sseBody: SSE_BODY,
    jev,
    onImage: () => { imageCalls += 1; }
  })(req, res));
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const r1 = await post(port, { session: { session_id: "s2", world_id: "demo" }, user_input: "a" }, "text/event-stream");
    const t1 = await r1.text();
    const s1 = JSON.parse([...t1.matchAll(/event: done\ndata: (\{[\s\S]*?\})\n\n/g)].pop()[1]).session;
    assert.equal(imageCalls, 1);

    // 복도로 이동 → 새 그림
    jev = jevAnswer("hallway", "자정", "비");
    const r2 = await post(port, { session: s1, user_input: "b" }, "text/event-stream");
    const t2 = await r2.text();
    const s2 = JSON.parse([...t2.matchAll(/event: done\ndata: (\{[\s\S]*?\})\n\n/g)].pop()[1]).session;
    assert.ok(t2.includes("event: scene"), "장소가 바뀌었는데 scene 이벤트가 없다");
    assert.equal(s2.current_scene.location_id, "hallway");
    assert.equal(imageCalls, 2);

    // 교실로 복귀 → 장면은 바뀌었지만 이미 그린 적이 있으므로 캐시에서 온다.
    // 이게 location_id를 캐시 키로 쓰는 이유다 — 라벨이 흔들려도 같은 파일이다.
    jev = jevAnswer("classroom_3_2", "자정", "비");
    const r3 = await post(port, { session: s2, user_input: "c" }, "text/event-stream");
    const t3 = await r3.text();
    assert.ok(t3.includes("event: scene"), "장소가 되돌아왔는데 scene 이벤트가 없다");
    assert.equal(imageCalls, 2, "재방문인데 이미지 API를 또 불렀다 — 캐시가 안 먹었다");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 신뢰도가 낮으면 장면을 유지하고 이미지를 그리지 않는다", async () => {
  let imageCalls = 0;
  const fake = await startFakeCloudflare(fakeWorkersAi({
    sseBody: SSE_BODY,
    // 서술이 authored되지 않은 곳으로 넘어갔다 — 장소 신뢰도가 무너진다.
    jev: jevAnswer("hallway", "밤", "비", 0.3),
    onImage: () => { imageCalls += 1; }
  }));
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s3", world_id: "demo" },
      user_input: "옥상으로 나간다"
    }, "text/event-stream");
    const text = await response.text();

    assert.ok(text.includes("event: done"), "턴 자체는 성공해야 한다");
    assert.ok(!text.includes("event: scene"), "확신이 없는데 그림을 바꿨다");
    assert.equal(imageCalls, 0);
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});

test("POST /api/turn: 장면 판정이 실패해도 턴은 성공하고 scene_unavailable로 알린다", async () => {
  // 게이트웨이 잔액이 없으면 402가 온다. 배경 그림 하나 때문에 턴을 잃지 않는다.
  const fake = await startFakeCloudflare((req, res) => {
    if (/\/ai\/run\/?(\?.*)?$/.test(req.url)) {
      res.statusCode = 402;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        success: false,
        errors: [{ code: 2021, message: "Insufficient balance; add money to your gateway or use BYOK" }]
      }));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(SSE_BODY);
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const response = await post(port, {
      session: { session_id: "s4", world_id: "demo" },
      user_input: "옆에 선다"
    });
    const body = await response.json();

    assert.equal(response.status, 200, "장면 판정 실패로 턴을 실패시키면 안 된다");
    assert.equal(body.scene_unavailable, true, "모르는 값을 없음으로 적지 않는다");
    assert.deepEqual(body.turn.choices, ["가", "나", "다"], "서술과 선택지는 정상이어야 한다");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
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
