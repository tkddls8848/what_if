"use strict";

const path = require("path");
const express = require("express");

const { createOllamaClient, isAllowedSmallModel } = require("./src/server/ollama_client");
const { buildKoreanMorphContext, checkMorphWorker } = require("./src/server/morph");
const pipeline = require("./src/server/pipeline");
const prompts = require("./src/server/prompts");
const cache = require("./src/server/cache");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

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

// 요청 시점에 생성 — 테스트가 OLLAMA_URL을 바꿔 fake 서버를 주입할 수 있다.
function getClient() {
  return createOllamaClient({
    baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 120000
  });
}

function errorBody(errorCode, message, retryable = false) {
  return { ok: false, error: message, error_code: errorCode, message, retryable };
}

app.get("/api/ollama/health", async (_req, res) => {
  const client = getClient();
  const [ollama, python] = await Promise.all([client.health(), checkMorphWorker()]);
  res.json({
    ok: ollama.reachable,
    ollama,
    python,
    cache: { enabled: cache.cacheEnabled() },
    pipeline: { prompt_version: prompts.PROMPT_VERSION, default_mode: "scene" }
  });
});

app.get("/api/ollama/models", async (_req, res) => {
  const result = await getClient().listModels();
  if (!result.ok) {
    res.status(502).json(errorBody(result.error_code, result.message, result.retryable));
    return;
  }
  const models = result.models
    .filter((model) => model.capabilities?.includes("completion"))
    .map(({ name, parameter_size, context_length, allowed }) => ({
      name, parameter_size, context_length, installed: true, allowed
    }))
    .filter((model) => model.allowed);
  res.json({ models });
});

app.post("/api/analyze/ollama", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const model = String(req.body?.model || "qwen3.5:4b").trim();
  const mode = req.body?.mode === "single" ? "single" : "scene";
  const force = Boolean(req.body?.force);
  const wantsStream = String(req.headers.accept || "").includes("text/event-stream");

  if (!text) {
    res.status(400).json(errorBody("INVALID_ARGUMENT", "text is required"));
    return;
  }
  if (!isAllowedSmallModel(model)) {
    res.status(400).json(errorBody(
      "INVALID_ARGUMENT",
      "Use a 4b-7b Ollama model tag, for example qwen3.5:4b, gemma4:e4b, gemma3:4b, or qwen3:4b."
    ));
    return;
  }

  const sse = wantsStream ? startSse(res) : null;

  const cacheKey = cache.makeKey({ text, model, mode, promptVersion: prompts.PROMPT_VERSION });
  if (cache.cacheEnabled() && !force) {
    const cached = cache.readCache(cacheKey);
    if (cached) {
      const body = { ...cached, diagnostics: { ...cached.diagnostics, cache: "hit" } };
      if (sse) {
        sse.send("done", body);
        sse.end();
      } else {
        res.json(body);
      }
      return;
    }
  }

  const client = getClient();
  const onProgress = (progress) => {
    if (sse) sse.send("progress", progress);
  };

  let result;
  try {
    if (mode === "single") {
      const morphContext = await buildKoreanMorphContext(text);
      result = await pipeline.runSinglePipeline({ text, model, client, morphContext });
    } else {
      result = await pipeline.runScenePipeline({ text, model, client, onProgress });
    }
  } catch (error) {
    result = { error: { ok: false, error_code: "INTERNAL", message: "분석 파이프라인 내부 오류", retryable: false } };
    console.error("[analyze] pipeline error:", error);
  }

  if (result.error) {
    const body = {
      ...errorBody(result.error.error_code, result.error.message, result.error.retryable),
      diagnostics: result.diagnostics
    };
    if (sse) {
      sse.send("error", body);
      sse.end();
    } else {
      res.status(502).json(body);
    }
    return;
  }

  const body = {
    model,
    mode,
    analysis: result.payload,
    diagnostics: { ...result.diagnostics, cache: "miss" }
  };
  if (cache.cacheEnabled()) cache.writeCache(cacheKey, body);

  if (sse) {
    sse.send("done", body);
    sse.end();
  } else {
    res.json(body);
  }
});

function startSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    }
  };
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Novel IF  http://localhost:${PORT}`);
  });
}

module.exports = { app };
