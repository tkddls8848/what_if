"use strict";

const path = require("path");
const { spawn } = require("child_process");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const PYTHON_BIN = process.env.PYTHON || "python";
const KOREAN_MORPH_SCRIPT = path.join(ROOT, "scripts", "korean_morph.py");

app.use(express.json({ limit: "2mb" }));

app.use(
  express.static(ROOT, {
    extensions: ["html"],
    setHeaders(res, filePath) {
      if (filePath.endsWith(".txt")) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    }
  })
);

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/check", (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/api/ollama/models", async (_req, res) => {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) {
      res.status(502).json({ error: "ollama tags request failed" });
      return;
    }
    const payload = await response.json();
    const models = (payload.models || [])
      .filter((model) => model.capabilities?.includes("completion"))
      .map((model) => ({
        name: model.name,
        parameter_size: model.details?.parameter_size || "",
        context_length: model.details?.context_length || null,
        installed: true,
        allowed: isAllowedSmallModel(model.name, model.details?.parameter_size)
      }))
      .filter((model) => model.allowed);
    res.json({ models });
  } catch (error) {
    res.status(502).json({ error: "ollama unavailable", detail: String(error.message || error) });
  }
});

app.post("/api/analyze/ollama", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const model = String(req.body?.model || "qwen3.5:4b").trim();

  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  if (!isAllowedSmallModel(model)) {
    res.status(400).json({ error: "Use a 4b-7b Ollama model tag, for example qwen3.5:4b, gemma4:e4b, gemma3:4b, or qwen3:4b." });
    return;
  }

  try {
    const prompt = await buildOllamaPrompt(text);
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_ctx: 8192
        },
        prompt
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      res.status(502).json({ error: "ollama request failed", detail });
      return;
    }

    const payload = await response.json();
    const parsed = JSON.parse(payload.response || "{}");
    res.json({ model, analysis: parsed });
  } catch (error) {
    res.status(502).json({ error: "ollama unavailable or returned invalid JSON", detail: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Novel IF  http://localhost:${PORT}`);
});

function isAllowedSmallModel(model, parameterSize = "") {
  const tag = String(model || "");
  const size = String(parameterSize || "");
  return /(^|[:_-])([4-7](?:\.\d+)?)b\b/i.test(tag) ||
    /(^|[:_-])e[4-7]b\b/i.test(tag) ||
    /^([4-7](?:\.\d+)?)B$/i.test(size) ||
    /^Effective\s+[4-7]B$/i.test(size);
}

async function buildOllamaPrompt(text) {
  const clipped = text.slice(0, 22000);
  const morphContext = await buildKoreanMorphContext(text);
  const contextJson = JSON.stringify(morphContext, null, 2).slice(0, 12000);
  return `너는 로컬에서 실행되는 한국어 소설 지식그래프 추출기다. 외부 API나 외부 지식은 절대 사용하지 말고, 아래 원문과 전처리 컨텍스트만 근거로 JSON만 반환하라.

목표:
1. 작품 안에서 확인되는 인물, 장소, 사건 분류, 감정/신체 상태 seed를 추출한다.
2. 사건을 바로 관계 triple로 만들지 말고 먼저 5W1H 사건 프레임으로 펼친다.
3. 그 사건 프레임과 기존 노드 후보를 기준으로 노드 간 관계를 추출한다.
4. 사건으로 인한 인물 상태 변화를 별도로 추출한다.

중요 규칙:
- 원문 근거가 없는 항목은 만들지 않는다.
- evidence는 원문에서 그대로 찾을 수 있는 짧은 구절이어야 한다.
- 암시된 관계는 버리지 말고 confidence를 "inferred" 또는 "weak"으로 낮춰 표시한다.
- characters, locations, event_frames의 이름을 relationships와 state_changes에서 재사용한다.
- 관계는 아래 허용 스키마 안에서만 만든다.
- JSON 이외의 설명 문장을 출력하지 않는다.

허용 관계 스키마:
- character -> character: knows, family_of, ally_of, enemy_of, protects, threatens, depends_on, suspects, loves, hides_from, changes_attitude_to, speaks_to
- character -> event: participates_in, caused, witnessed, affected_by, investigated, escaped_from
- event -> event: caused_by, leads_to, happens_before, happens_after, reveals, contradicts
- character -> location: appears_in, located_at, came_from, went_to, trapped_at, owns
- event -> location: takes_place_at

반환 형식:
{
  "characters": [
    {"name": "", "aliases": [], "role": "", "description": "", "evidence": "", "confidence": 0.7}
  ],
  "locations": [
    {"name": "", "aliases": [], "type": "inferred", "description": "", "evidence": "", "confidence": 0.7}
  ],
  "event_types": [
    {"type": "movement", "label": "이동", "words": [], "description": ""}
  ],
  "mental_states": [
    {"state": "", "words": [], "description": ""}
  ],
  "physical_states": [
    {"state": "", "words": [], "description": ""}
  ],
  "event_frames": [
    {
      "id": "frame_001",
      "type": "background",
      "label": "배경",
      "summary": "",
      "who": [],
      "where": [],
      "when": "",
      "what_happened": "",
      "why_relevant": "",
      "result": "",
      "evidence": "",
      "confidence": 0.7
    }
  ],
  "relationships": [
    {
      "source": "",
      "source_type": "character",
      "target": "",
      "target_type": "event",
      "type": "participates_in",
      "label": "",
      "evidence": "",
      "confidence": "explicit"
    }
  ],
  "state_changes": [
    {
      "character": "",
      "trigger_event": "",
      "before": {"location": "", "mental_state": "", "physical_state": "", "knowledge": []},
      "after": {"location": "", "mental_state": "", "physical_state": "", "knowledge": []},
      "evidence": "",
      "confidence": "explicit"
    }
  ],
  "events": []
}

전처리 컨텍스트:
${contextJson}

원문:
${clipped}`;
}

async function buildKoreanMorphContext(text) {
  try {
    return await runMorphWorker(text);
  } catch (error) {
    return fallbackKoreanContext(text, `morph worker unavailable: ${error.message || error}`);
  }
}

function runMorphWorker(text) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [KOREAN_MORPH_SCRIPT], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("morph worker timeout"));
    }, 12000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `morph worker exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify({ text }));
  });
}

function fallbackKoreanContext(text, warning = "") {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+/g, " ")
    .trim();
  const segments = normalized.split(/\n\s*\n/g).map((part, index) => ({
    id: `seg_${String(index + 1).padStart(3, "0")}`,
    index: index + 1,
    text: part.trim().slice(0, 240)
  })).filter((segment) => segment.text);
  const fullText = segments.map((segment) => segment.text).join("\n");
  const names = countRegexCandidates(fullText, /([가-힣]{2,8})(?:은|는|이|가|을|를|에게|와|과|도|의|께서|에게서|한테|한테서)(?![가-힣])/g);
  const locations = countRegexCandidates(fullText, /([가-힣A-Za-z0-9 ]{1,14}(?:방|집|거리|길|문|역|옥상|시장|골목|마당|학교|병원|정거장|백화점|도시|마을|강|산|바다|숲|들|밭|부엌|창고|가게|주막|다방|호텔|여관|궁|성))/g);
  return {
    analyzer: "regex-fallback",
    warning,
    segments: segments.slice(0, 40),
    candidate_characters: names.slice(0, 40),
    candidate_locations: locations.slice(0, 30),
    candidate_state_words: [],
    candidate_event_sentences: []
  };
}

function countRegexCandidates(text, regex) {
  const counts = new Map();
  for (const match of text.matchAll(regex)) {
    const surface = String(match[0] || "").trim();
    const base = stripKoreanParticle(String(match[1] || surface).trim());
    if (base.length < 2) continue;
    const item = counts.get(base) || { base, surfaces: new Set(), count: 0 };
    item.surfaces.add(surface);
    item.count += 1;
    counts.set(base, item);
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .map((item) => ({ base: item.base, surfaces: Array.from(item.surfaces).slice(0, 8), count: item.count }));
}

// Node-side copy, intentionally separate from the browser analyzer's stripKoreanParticle
// (src/analyzer.js). server.js is a CommonJS Node process and cannot share the browser
// ESM modules — keep this local and do not try to unify the two.
function stripKoreanParticle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/(은|는|이|가|을|를|에게|와|과|도|의|으로|로|에서|에게서|께서|부터|까지|만|한테|한테서)$/u, "");
}
