"use strict";

const path = require("path");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

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
        prompt: buildOllamaPrompt(text)
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

function buildOllamaPrompt(text) {
  const clipped = text.slice(0, 28000);
  return `너는 한국어 소설 분석기의 seed lexicon 생성기다. 아래 원문에서 이 작품에만 적용할 인물 seed, 장소 seed, 이벤트 분류 seed, 심리/감정 seed, 신체상태 seed, 사건 후보를 추출하라.

규칙:
- 원문에 근거가 있는 항목만 반환한다.
- characters와 locations는 이후 규칙 기반 analyzer가 사용할 동적 seed lexicon이다.
- event_types, mental_states, physical_states는 이후 브라우저 analyzer가 사용할 동적 분류 lexicon이다.
- aliases에는 원문에 실제로 등장하는 호칭, 띄어쓰기 변형, 조사 없는 기본형을 넣는다.
- words에는 원문에 실제로 반복되거나 강하게 드러나는 한국어 단서 표현을 넣는다.
- evidence에는 원문에서 그대로 찾을 수 있는 짧은 구절을 넣는다.
- event.type은 고정 분류와 달라도 된다. 영문 소문자, 숫자, underscore로 된 짧은 id를 쓰고 label에 한국어 표시명을 넣는다.
- JSON만 반환한다. 설명 문장은 쓰지 않는다.

반환 형식:
{
  "characters": [
    {"name": "", "aliases": [], "role": "", "description": "", "evidence": ""}
  ],
  "locations": [
    {"name": "", "aliases": [], "type": "inferred", "description": "", "evidence": ""}
  ],
  "event_types": [
    {"type": "background", "label": "배경", "words": [], "description": ""}
  ],
  "mental_states": [
    {"state": "", "words": [], "description": ""}
  ],
  "physical_states": [
    {"state": "", "words": [], "description": ""}
  ],
  "events": [
    {"type": "background", "summary": "", "characters": [], "locations": [], "evidence": "", "confidence": 0.7}
  ]
}

원문:
${clipped}`;
}
