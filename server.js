"use strict";

const path = require("path");
const express = require("express");

const { createOllamaClient, isAllowedSmallModel } = require("./src/server/ollama_client");
const pipeline = require("./src/server/pipeline");
const prompts = require("./src/server/prompts");
const cache = require("./src/server/cache");
const whatif = require("./src/server/whatif");
const wikisource = require("./src/server/wikisource");

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
  const ollama = await getClient().health();
  res.json({
    ok: ollama.reachable,
    ollama,
    cache: { enabled: cache.cacheEnabled() },
    pipeline: { prompt_version: prompts.PROMPT_VERSION }
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

  const cacheKey = cache.makeKey({ text, model, promptVersion: prompts.PROMPT_VERSION });
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
    result = await pipeline.runScenePipeline({ text, model, client, onProgress });
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

/**
 * 위키문헌 본문 가져오기. 위키문헌 호스트만 허용한다 — 임의 URL을 받으면 이 서버가
 * 열린 프록시가 된다. 권리 표기는 자동 판정하지 않고 `unverified`로 돌려준다.
 */
app.get("/api/import/wikisource", async (req, res) => {
  const result = await wikisource.importWikisource(req.query?.url);
  if (!result.ok) {
    const status = result.error_code === "INVALID_ARGUMENT" ? 400 : 502;
    res.status(status).json(errorBody(result.error_code, result.message, result.retryable));
    return;
  }
  res.json(result.document);
});

/**
 * what-if 분기 생성.
 *
 * 서버는 브라우저가 만든 **분기 시점 스냅샷만** 받는다. 원문도, 분기 이후 사건도
 * 받지 않는다 — 모델에게 원작을 베낄 재료를 주지 않는 것이 핵심 설계다.
 * 결과는 생성물이므로 캐시하지 않는다(같은 전제로 다시 돌리면 다른 전개가 나와야 한다).
 */
app.post("/api/whatif", async (req, res) => {
  const seed = req.body?.seed;
  const model = String(req.body?.model || "qwen3.5:4b").trim();
  const premise = String(req.body?.premise || "").trim();
  const count = Number(req.body?.count) || 2;

  if (!seed || !Number(seed.fork_segment)) {
    res.status(400).json(errorBody("INVALID_ARGUMENT", "seed.fork_segment가 필요합니다."));
    return;
  }
  if (seed.text || seed.segments) {
    res.status(400).json(errorBody("INVALID_ARGUMENT", "seed에 원문을 넣지 마세요. 분기 시점 스냅샷만 보냅니다."));
    return;
  }
  if (!isAllowedSmallModel(model)) {
    res.status(400).json(errorBody(
      "INVALID_ARGUMENT",
      "Use a 4b-7b Ollama model tag, for example qwen3.5:4b, gemma4:e4b, gemma3:4b, or qwen3:4b."
    ));
    return;
  }

  let result;
  try {
    result = await whatif.runWhatIf({ seed, premise, count, model, client: getClient() });
  } catch (error) {
    console.error("[whatif] error:", error);
    result = { ok: false, error_code: "INTERNAL", message: "분기 생성 내부 오류", retryable: false };
  }

  if (!result.ok) {
    res.status(result.error_code === "BAD_REQUEST" ? 400 : 502).json({
      ...errorBody(result.error_code, result.message, result.retryable),
      diagnostics: result.diagnostics
    });
    return;
  }
  res.json({ model: result.model, alternatives: result.alternatives, diagnostics: result.diagnostics });
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
