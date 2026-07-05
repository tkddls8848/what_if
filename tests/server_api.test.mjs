import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 서버 import 전에 테스트 환경을 고정한다
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-api-cache-"));
process.env.NOVEL_IF_CACHE_DIR = CACHE_DIR;
process.env.NOVEL_IF_CACHE = "0";
process.env.OLLAMA_TIMEOUT_MS = "4000";

const serverModule = await import("../server.js");
const { app } = serverModule.default || serverModule;

const MINI_NOVEL = `복녀는 가난한 집에서 자랐다. 복녀는 남편을 따라 칠성문 밖 빈민굴로 왔다.

왕 서방이 복녀를 불렀다. 복녀는 왕 서방의 밭으로 갔다.`;

function entitiesFor(prompt) {
  const characters = [];
  if (prompt.includes("복녀")) characters.push({ name: "복녀", aliases: [], role: "주인공", evidence: "복녀는", confidence: 0.8 });
  if (prompt.includes("남편")) characters.push({ name: "남편", aliases: [], evidence: "남편", confidence: 0.7 });
  if (prompt.includes("왕 서방")) characters.push({ name: "왕 서방", aliases: [], evidence: "왕 서방이", confidence: 0.7 });
  const locations = [];
  if (prompt.includes("빈민굴")) locations.push({ name: "빈민굴", aliases: [], evidence: "빈민굴", confidence: 0.8 });
  return { characters, locations };
}

/** 스크립트된 fake Ollama HTTP 서버 */
function startFakeOllama() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          models: [
            { name: "qwen3.5:4b", capabilities: ["completion"], details: { parameter_size: "4B" } },
            { name: "big:70b", capabilities: ["completion"], details: { parameter_size: "70B" } }
          ]
        }));
        return;
      }
      if (req.url === "/api/generate") {
        const { prompt } = JSON.parse(body);
        let data = {};
        if (prompt.includes("인물과 장소만 추출")) data = entitiesFor(prompt);
        else if (prompt.includes("사건 프레임과 인물 상태 변화만")) {
          data = {
            event_frames: prompt.includes("빈민굴로 왔다")
              ? [{ type: "movement", summary: "빈민굴 이주", who: ["복녀"], where: ["빈민굴"], evidence: "빈민굴로 왔다", confidence: 0.8 }]
              : [],
            state_changes: []
          };
        } else if (prompt.includes("노드 간 관계만 판정")) {
          data = { relationships: [] };
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ response: JSON.stringify(data), prompt_eval_count: 700, eval_count: 50 }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startApp() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const fakeOllama = await startFakeOllama();
const api = await startApp();
process.env.OLLAMA_URL = fakeOllama.url;

test.after(() => {
  fakeOllama.server.close();
  api.server.close();
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

test("GET /api/ollama/health: 도달성·허용 모델·캐시 상태를 보고한다", async () => {
  const response = await fetch(`${api.url}/api/ollama/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.ollama.reachable, true);
  assert.deepEqual(body.ollama.allowed_models, ["qwen3.5:4b"]);
  assert.ok("available" in body.python);
  assert.equal(body.cache.enabled, false);
  assert.equal(body.pipeline.default_mode, "scene");
});

test("GET /api/ollama/models: 허용 모델만 반환한다", async () => {
  const response = await fetch(`${api.url}/api/ollama/models`);
  const body = await response.json();
  assert.deepEqual(body.models.map((model) => model.name), ["qwen3.5:4b"]);
});

test("POST /api/analyze/ollama: text 없으면 400", async () => {
  const response = await fetch(`${api.url}/api/analyze/ollama`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.5:4b" })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error_code, "INVALID_ARGUMENT");
});

test("POST /api/analyze/ollama: 비허용 모델은 400", async () => {
  const response = await fetch(`${api.url}/api/analyze/ollama`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: MINI_NOVEL, model: "big:70b" })
  });
  assert.equal(response.status, 400);
});

test("POST /api/analyze/ollama (scene, 비스트림): 병합 결과와 진단을 반환한다", async () => {
  const response = await fetch(`${api.url}/api/analyze/ollama`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: MINI_NOVEL, model: "qwen3.5:4b" })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "scene");
  const names = body.analysis.characters.map((item) => item.name);
  assert.ok(names.includes("복녀"));
  assert.equal(body.diagnostics.cache, "miss");
  assert.ok(body.diagnostics.prompt_eval_total > 0);
});

test("POST /api/analyze/ollama (SSE): progress와 done 이벤트를 보낸다", async () => {
  const response = await fetch(`${api.url}/api/analyze/ollama`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text: MINI_NOVEL, model: "qwen3.5:4b" })
  });
  assert.ok(String(response.headers.get("content-type")).includes("text/event-stream"));
  const raw = await response.text();
  const events = raw.split("\n\n").filter(Boolean).map((chunk) => {
    const event = /event: (\S+)/.exec(chunk)?.[1];
    const data = /data: (.+)/.exec(chunk)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
  assert.ok(events.some((item) => item.event === "progress" && item.data.stage === "scene"));
  const done = events.find((item) => item.event === "done");
  assert.ok(done);
  assert.ok(done.data.analysis.characters.length > 0);
});

test("캐시 활성 시 두 번째 요청은 hit, force는 우회한다", async () => {
  process.env.NOVEL_IF_CACHE = "1";
  try {
    const request = (extra = {}) => fetch(`${api.url}/api/analyze/ollama`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: MINI_NOVEL, model: "qwen3.5:4b", ...extra })
    });
    const first = await (await request()).json();
    assert.equal(first.diagnostics.cache, "miss");
    const second = await (await request()).json();
    assert.equal(second.diagnostics.cache, "hit");
    const forced = await (await request({ force: true })).json();
    assert.equal(forced.diagnostics.cache, "miss");
  } finally {
    process.env.NOVEL_IF_CACHE = "0";
  }
});

test("Ollama 미기동이면 502와 CONNECTION_FAILED를 반환한다", async () => {
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = "http://127.0.0.1:9"; // 연결 불가 포트
  try {
    const response = await fetch(`${api.url}/api/analyze/ollama`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: MINI_NOVEL, model: "qwen3.5:4b" })
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error_code, "CONNECTION_FAILED");
    assert.equal(body.retryable, true);
  } finally {
    process.env.OLLAMA_URL = previous;
  }
});
