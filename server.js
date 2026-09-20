"use strict";

const path = require("path");
const express = require("express");

const { createOllamaClient, isAllowedSmallModel } = require("./src/server/ollama_client");
const pipeline = require("./src/server/pipeline");
const prompts = require("./src/server/prompts");
const cache = require("./src/server/cache");
const whatif = require("./src/server/whatif");
const wikisource = require("./src/server/wikisource");

const fs = require("fs");

const { createCloudflareClient } = require("./src/llm/cloudflare");
const { createGeminiClient, DEFAULT_MODEL: DEFAULT_GEMINI_MODEL } = require("./src/llm/gemini");
const { createFallbackClient } = require("./src/llm/fallback");
const { createImageClient, DEFAULT_IMAGE_MODEL } = require("./src/llm/image");
const { createJevClient } = require("./src/llm/jev");
const { createBudget, DEFAULT_NARRATION_MODEL, NEURONS_PER_MTOK } = require("./src/llm/budget");
const turn = require("./src/server/turn");
const scene = require("./src/server/scene");
const env = require("./src/server/env");

const ROOT = __dirname;

// .env는 있으면 읽고 없으면 조용히 넘어간다 — 선택 사항이다. 이미 세팅된 실제
// 환경변수(셸에서 $env:로 넣었거나 CI/배포가 주입한 값)가 항상 파일보다 우선한다.
// 아래에서 process.env를 읽는 어떤 코드보다 먼저 호출해야 의미가 있다.
// 값은 절대 로그로 남기지 않는다 — 키 이름만 남긴다.
const envResult = env.loadEnvFile(path.join(ROOT, ".env"));
if (envResult.loaded && envResult.applied.length > 0) {
  console.log(`[env] .env에서 적용: ${envResult.applied.join(", ")}`);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/** 프로세스 수명 동안 유지되는 하루 장부. M4에서 파일로 옮긴다. */
const turnBudget = createBudget();

function getCloudflareClient() {
  return createCloudflareClient({
    accountId: process.env.CF_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN,
    apiBase: process.env.CF_API_BASE,
    timeoutMs: Number(process.env.CF_TIMEOUT_MS) || 120000
  });
}

function getGeminiClient() {
  return createGeminiClient({
    apiKey: process.env.GEMINI_API_KEY,
    apiBase: process.env.GEMINI_API_BASE,
    model: String(process.env.GEMINI_MODEL || "").trim() || DEFAULT_GEMINI_MODEL,
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || Number(process.env.CF_TIMEOUT_MS) || 120000
  });
}

/**
 * 서술 제공처 체인 — Cloudflare가 주, Gemini 무료 티어가 폴백이다.
 *
 * 순서를 이렇게 두는 이유는 두 무료 할당의 모양이 다르기 때문이다. Cloudflare는
 * 하루 10,000 Neurons를 **토큰량**으로 재고, Gemini 무료 티어는 **요청 수**로
 * 잰다(gemini-2.5-flash 기준 하루 500회). 서술 한 번은 프롬프트가 길어 Neurons를
 * 빨리 먹지만 요청은 한 번뿐이다 — 그래서 Cloudflare를 먼저 태워 토큰 예산을 다
 * 쓰고, 그게 마르는(QUOTA_EXHAUSTED) 시점부터 요청 수로 재는 쪽으로 넘어가는
 * 편이 하루에 칠 수 있는 턴 수를 가장 크게 만든다.
 *
 * GEMINI_API_KEY가 없으면 체인에 Cloudflare만 남는다 — 지금까지와 정확히 같게
 * 동작한다(fallback.js가 설정 안 된 제공처는 시도조차 하지 않는다).
 * 반대로 CF_* 없이 GEMINI_API_KEY만 넣으면 Gemini 단독으로도 돈다.
 *
 * 이미지(src/llm/image.js)에는 폴백이 없다. Gemini에는 Workers AI의 텍스트→이미지
 * 모델에 대응하는 경로가 이 코드가 쓰는 형태로 존재하지 않는다 — 장면 그림은
 * 지금도 Cloudflare 전용이고, 실패해도 턴은 성공한 채 끝난다(아래 /api/turn 끝부분).
 */
function getNarrationClient() {
  return createFallbackClient({
    providers: [
      { name: "cloudflare", client: getCloudflareClient(), model: DEFAULT_NARRATION_MODEL },
      { name: "gemini", client: getGeminiClient(), model: String(process.env.GEMINI_MODEL || "").trim() || DEFAULT_GEMINI_MODEL }
    ]
  });
}

/**
 * 서술과 같은 Cloudflare 계정/토큰을 쓴다 — 계정은 하나, 호출하는 모델만 다르다.
 *
 * IMAGE_MODEL이 비어 있으면 DEFAULT_IMAGE_MODEL(phoenix-1.0)로 폴백한다 —
 * flux-1-schnell(4스텝 증류)을 기본값으로 두지 않는다(src/llm/image.js 상단
 * 설명 참고: 증류 모델은 속도를 사려고 프롬프트 순응도를 버리는데, 플레이어가
 * 신고한 문제는 정확히 그 순응도였다). IMAGE_MODEL에 레지스트리에 없는 값이
 * 오면 createImageClient()가 조용히 기본값으로 넘어가지 않고, 매 generate()
 * 호출에서 구조화 오류 INVALID_ARGUMENT를 낸다 — 그 오류는 아래 /api/turn의
 * scene.resolveScene 호출부가 이미 로그로 남긴다(턴 자체는 실패시키지 않는다).
 *
 * IMAGE_WIDTH/IMAGE_HEIGHT가 비어 있으면 image.js의 기본값(512×512)을 쓴다 —
 * 512×512는 Cloudflare 타일(512×512) 1장이라 1024×1024(4장)의 1/4 비용이고,
 * 플레이어가 해상도보다 내용 충실도를 우선한다고 명시했으니 이 크기를 기본으로
 * 삼는다. width/height를 안 받는 모델(flux-1-schnell)에는 이 값이 전달돼도
 * image.js의 buildFluxBody가 애초에 읽지 않는다.
 */
function getImageClient() {
  return createImageClient({
    accountId: process.env.CF_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN,
    apiBase: process.env.CF_API_BASE,
    timeoutMs: Number(process.env.CF_IMAGE_TIMEOUT_MS) || 60000,
    model: String(process.env.IMAGE_MODEL || "").trim() || DEFAULT_IMAGE_MODEL,
    width: Number(process.env.IMAGE_WIDTH) || undefined,
    height: Number(process.env.IMAGE_HEIGHT) || undefined
  });
}

/**
 * 미술감독(src/server/director.js)이 쓰는 Jev 클라이언트.
 *
 * 서술·이미지와 같은 Cloudflare 계정/토큰을 쓰지만 **과금은 다르다** — Jev는
 * 서드파티 모델이라 Workers AI 하루 무료 할당(10,000 Neurons)이 아니라 AI Gateway
 * 통합 과금으로 계산된다. 게이트웨이 잔액이 없으면 매 호출이 PAYMENT_REQUIRED로
 * 떨어지고, 그 턴은 장면을 유지한 채 성공한다(src/server/turn.js의 runDirection).
 * 자세한 경로와 과금 확인 기록은 doc/2026-09-20-m0-jev-probe.md에 있다.
 *
 * 타임아웃이 서술(120초)보다 훨씬 짧은 것은 의도다 — 이 호출은 독자가 이미 서술과
 * 선택지를 다 받은 뒤에 배경 그림 하나를 위해 도는 것이라, 오래 매달릴 이유가 없다.
 */
function getDirectorClient() {
  return createJevClient({
    accountId: process.env.CF_ACCOUNT_ID,
    apiToken: process.env.CF_API_TOKEN,
    apiBase: process.env.CF_API_BASE,
    // CF_GATEWAY_ID를 채우면 AI Gateway 데이터 플레인으로 나간다(로그·캐시·BYOK가
    // 거기 붙는다). 비우면 v4 직접 경로다 — 둘은 URL만 다르고 바디·응답 계약이 같다.
    gatewayId: process.env.CF_GATEWAY_ID,
    // 게이트웨이에 "Authenticated Gateway"를 켰을 때만 필요하다.
    aigToken: process.env.CF_AIG_TOKEN,
    timeoutMs: Number(process.env.JEV_TIMEOUT_MS) || 30000
  });
}

/**
 * 세계관 파일 읽기.
 *
 * world_id가 그대로 경로에 들어가므로 문자 집합을 제한한다. `../`를 허용하면 이 서버가
 * 임의 파일 읽기 도구가 된다 — 위키문헌 호스트 화이트리스트와 같은 이유다.
 */
// i 플래그를 쓰지 않는다 — 파일 시스템이 Windows에서는 대소문자를 구분하지 않고
// Linux에서는 구분한다. i를 주면 개발 환경(Windows)에서 로드되던 세계관이
// 배포 환경(Linux)에서 404가 나는 것을 여기서는 통과시켜 버려 뒤늦게 드러난다.
const WORLD_ID = /^[a-z0-9_-]+$/;

async function loadWorld(worldId) {
  if (!WORLD_ID.test(String(worldId || ""))) {
    return { ok: false, status: 400, error_code: "INVALID_ARGUMENT", message: "world_id 형식이 올바르지 않습니다." };
  }
  const file = path.join(ROOT, "data", "worlds", `${worldId}.json`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return { ok: false, status: 404, error_code: "NOT_FOUND", message: `세계관 '${worldId}'을 찾을 수 없습니다.` };
  }

  // 파싱은 됐지만 모양이 계약과 다른 파일이 있다. loadWorldFile은 raw.world를 바로 읽으므로
  // 최상위가 null이면 여기서 던지고, 그대로 두면 핸들러 밖으로 나가 프로세스가 죽는다.
  try {
    const { loadWorldFile } = await import("./src/core/card.js");
    return { ok: true, ...loadWorldFile(raw) };
  } catch (error) {
    console.error("[world] load error:", error);
    return { ok: false, status: 500, error_code: "INTERNAL", message: `세계관 '${worldId}'을 읽을 수 없습니다.` };
  }
}

app.use(express.json({ limit: "2mb" }));

// ROOT 전체를 정적으로 연다. data/ 아래가 공개로 노출되는 것은 예전에는 곁다리
// 부작용이었지만, 이제는 의도적인 설계다 — src/server/scene.js가 쓰는
// data/scenes/{world_id}/{hash}.png를 이 미들웨어가 그대로 서빙해서 별도의
// 이미지 서빙 라우트를 만들지 않는다. 생성된 PNG는 저장소에 커밋하지 않는다
// (.gitignore의 data/scenes/ 참고) — 서빙 대상이지 저장소 자산이 아니다.
app.use(
  express.static(ROOT, {
    extensions: ["html"],
    // index 옵션 기본값이 "index.html"이라 그대로 두면 정적 미들웨어가 "/"를 먼저
    // 가로채 index.html을 내려주고, 아래 app.get("/")는 영영 실행되지 않는다.
    // "/"를 랜딩 페이지로 쓰려면 여기서 디렉터리 인덱스를 꺼야 한다.
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".txt")) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    }
  })
);

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "home.html"));
});

app.get("/analyze", (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/check", (_req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/play", (_req, res) => {
  res.sendFile(path.join(ROOT, "play.html"));
});

// 요청 시점에 생성 — 테스트가 OLLAMA_URL을 바꿔 fake 서버를 주입할 수 있다.
function getClient() {
  return createOllamaClient({
    baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 120000
  });
}

// CF_API_BASE/OLLAMA_URL과 같은 패턴: 기본값은 ROOT지만, 테스트가 SCENE_ROOT를
// 임시 디렉터리로 바꿔 실제 저장소 밖에 장면 이미지를 쓰게 할 수 있다. 요청
// 시점에 읽어야 테스트가 server.js를 import한 뒤에도 값을 바꿀 수 있다.
function getSceneRoot() {
  return process.env.SCENE_ROOT || ROOT;
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
  const abort = watchDisconnect(res);

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
    result = await pipeline.runScenePipeline({ text, model, client, onProgress, signal: abort.signal });
  } catch (error) {
    result = { error: { ok: false, error_code: "INTERNAL", message: "분석 파이프라인 내부 오류", retryable: false } };
    console.error("[analyze] pipeline error:", error);
  }

  // 요청자가 이미 떠났으면 보낼 곳도, 부분 결과를 캐시할 이유도 없다.
  if (abort.signal.aborted) return;

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

/** 설정 여부와 예산만 알린다. account id와 토큰은 어떤 경우에도 응답에 넣지 않는다. */
/**
 * 세계관 목록. 피커와 요약 카드에 쓸 만큼만 돌려준다 — 파일 전체(카드 상세, 규칙,
 * 오프닝 전문)를 다 보내면 목록 하나 그리자고 여러 세계관의 전체 프롬프트 프리픽스를
 * 네트워크로 흘리는 셈이라 낭비다. 상세가 필요하면 /api/worlds/:world_id를 부른다.
 */
app.get("/api/worlds", async (_req, res) => {
  const dir = path.join(ROOT, "data", "worlds");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    console.error("[worlds] list error:", error);
    files = [];
  }

  const worlds = [];
  for (const file of files) {
    const worldId = file.slice(0, -".json".length);
    const loaded = await loadWorld(worldId);
    if (!loaded.ok) {
      // 파일 하나가 깨졌다고 목록 전체가 죽으면 안 된다 — loadWorld가 이미 파싱/모양
      // 오류를 잡아 ok:false로 돌려주므로 여기서는 건너뛰고 계속한다.
      console.error(`[worlds] '${worldId}' 건너뜀: ${loaded.message}`);
      continue;
    }
    worlds.push({
      world_id: loaded.world.world_id,
      title: loaded.world.title,
      setting: loaded.world.setting,
      card_names: loaded.cards.map((card) => card.canonical_name)
    });
  }

  res.json({ worlds });
});

/**
 * 세계관 상세. 헤더·캐스트·오프닝을 한 번에 그리도록 정규화된 {world, cards}를
 * 그대로 돌려준다. 경로 조작 방지는 loadWorld 안의 WORLD_ID 검사를 그대로 재사용한다
 * — world_id가 파일 경로에 들어가는 지점은 한 곳(loadWorld)이어야 검사도 한 곳이다.
 */
app.get("/api/worlds/:world_id", async (req, res) => {
  const loaded = await loadWorld(req.params.world_id);
  if (!loaded.ok) {
    res.status(loaded.status).json(errorBody(loaded.error_code, loaded.message));
    return;
  }
  res.json({ world: loaded.world, cards: loaded.cards });
});

app.get("/api/cf/health", (_req, res) => {
  res.json({
    ok: true,
    configured: getCloudflareClient().isConfigured(),
    model: DEFAULT_NARRATION_MODEL,
    // 체인 전체를 그대로 보여 준다 — 어떤 제공처가 어떤 순서로 있고 각각 설정이
    // 됐는지. 폴백은 평소에 안 보이므로(주 제공처가 살아 있는 동안은 한 번도
    // 안 불린다), 정작 필요한 날에 키가 비어 있었다는 걸 그때 알게 되면 늦다.
    providers: getNarrationClient().describe(),
    budget: turnBudget.snapshot()
  });
});

app.post("/api/turn", async (req, res) => {
  const userInput = String(req.body?.user_input || "").trim();
  const model = String(req.body?.model || DEFAULT_NARRATION_MODEL).trim();
  const wantsStream = String(req.headers.accept || "").includes("text/event-stream");

  if (!userInput) {
    res.status(400).json(errorBody("INVALID_ARGUMENT", "행동을 입력하세요."));
    return;
  }

  // model은 llm/cloudflare.js에서 업스트림 URL 경로에 그대로 들어간다
  // (`${base}/accounts/${account}/ai/run/${model}`). fetch/URL은 경로 세그먼트의
  // `..`를 정규화하므로, 검증 없이 넘기면 `../../../../accounts/X/tokens/verify` 같은
  // 값이 인증된(Authorization: Bearer) 요청을 임의의 Cloudflare v4 API 경로로 보낼 수
  // 있다 — world_id를 WORLD_ID 정규식으로 제한하는 것과 같은 이유다. 가격표에 있는
  // 모델만 허용하면 검증과 동시에 계량 가능함도 보장된다.
  if (!Object.prototype.hasOwnProperty.call(NEURONS_PER_MTOK, model)) {
    res.status(400).json(errorBody(
      "INVALID_ARGUMENT",
      `지원하지 않는 model입니다. 다음 중 하나를 쓰세요: ${Object.keys(NEURONS_PER_MTOK).join(", ")}`
    ));
    return;
  }

  const { normalizeSession } = await import("./src/core/session.js");
  const session = normalizeSession(req.body?.session);

  const loaded = await loadWorld(session.world_id);
  if (!loaded.ok) {
    res.status(loaded.status).json(errorBody(loaded.error_code, loaded.message));
    return;
  }

  const sse = wantsStream ? startSse(res) : null;
  const abort = watchDisconnect(res);

  let result;
  try {
    result = await turn.runTurn({
      world: loaded.world,
      cards: loaded.cards,
      session,
      userInput,
      client: getNarrationClient(),
      model,
      budget: turnBudget,
      onNarration: (delta) => { if (sse) sse.send("narration", { delta }); },
      signal: abort.signal,
      // 로컬 Ollama가 판정자다. 없거나(설치 안 함) 죽어 있으면 judge.js가
      // CONNECTION_FAILED를 돌려주고 runTurn은 judge_unavailable:true로 턴을
      // 그대로 성공시킨다 — 판정 하나 때문에 턴을 잃지 않는다(스펙 그대로).
      judgeClient: getClient(),
      // 미술감독. 잔액이 없거나(PAYMENT_REQUIRED) 호출이 실패하면 runTurn이
      // scene_unavailable:true로 턴을 그대로 성공시킨다 — 배경 그림 하나 때문에
      // 턴을 잃지 않는다.
      directorClient: getDirectorClient(),
      confidenceThreshold: Number(process.env.SCENE_CONFIDENCE) || undefined
    });
  } catch (error) {
    console.error("[turn] error:", error);
    result = errorBody("INTERNAL", "턴 생성 내부 오류");
  }

  if (abort.signal.aborted) return;

  // 폴백이 실제로 쓰였으면 남긴다. 플레이어 화면에는 아무 일도 없어 보이지만
  // (그게 폴백의 목적이다), 주 제공처가 왜 답하지 못했는지는 운영자가 알아야
  // 한다 — 할당이 말랐는지, 토큰이 잘못됐는지는 대응이 전혀 다르다.
  if (result.ok && result.provider_attempts) {
    const trail = result.provider_attempts.map((item) => `${item.provider}=${item.error_code}`).join(", ");
    console.warn(`[turn] 폴백 사용: ${trail} → ${result.provider}`);
  }

  if (!result.ok) {
    const body = errorBody(result.error_code, result.message, result.retryable);
    if (sse) {
      sse.send("error", body);
      sse.end();
    } else {
      res.status(result.error_code === "INVALID_ARGUMENT" ? 400 : 502).json(body);
    }
    return;
  }

  const body = {
    turn: result.turn,
    session: result.session,
    budget: result.budget,
    truncated: result.truncated,
    budget_unknown: result.budget_unknown,
    // 게이지가 왜 움직였는지(last_change)와 판정기가 살아 있었는지(judge_unavailable)를
    // 실어 보낸다 — runTurn은 이미 이 값들을 계산해 돌려주지만, 이 응답 바디가 그동안
    // 빠뜨리고 있었다. play.html의 게이지/트리거 UI는 이 두 필드 없이는 아무것도
    // 그릴 수 없다(sim 자체는 session.sim에 이미 실려 있다).
    judge_unavailable: result.judge_unavailable,
    last_change: result.last_change,
    // 이 턴을 실제로 쓴 제공처. Cloudflare가 아니면 budget_unknown이 함께 true가
    // 되는데(Neuron은 Cloudflare의 단위다 — turn.js 참고), 이 필드가 있어야 UI가
    // "단가를 모른다"와 "Cloudflare가 아니라 무료 폴백이 썼다"를 구분해 보여 준다.
    provider: result.provider,
    // 장면 판정 호출이 실패했을 때만 true다(judge_unavailable과 같은 원칙 —
    // 모르는 값을 "없음"으로 적지 않는다). 이 턴은 장면을 유지한 채 성공했다.
    scene_unavailable: result.scene_unavailable
  };
  if (sse) {
    sse.send("done", body);
  } else {
    res.json(body);
  }

  // 장면 이미지는 서술이 화면에 완전히 다 흐른 "다음"이다 — 독자는 이미 서술과
  // 선택지를 전부 받았고, 이건 그 위에 몇 초 늦게 얹히는 배경 그림일 뿐이다.
  // result.scene이 null이면(장면이 안 바뀌었으면) 아무 것도 하지 않는다. 여기서
  // 실패해도(Workers AI 오류, 디스크 쓰기 실패 등) 턴은 이미 성공한 채로 끝났다 —
  // 그림 한 장 때문에 턴을 실패시키지 않는다. SSE가 아니면 보낼 채널이 없으니
  // 그래도 캐시는 데워 두고 조용히 끝낸다(다음에 같은 장면이 오면 즉시 나간다).
  // 장면 판정이 실패했으면 왜 실패했는지 운영자가 알아야 한다 — 특히
  // PAYMENT_REQUIRED(게이트웨이 잔액)처럼 사람이 고쳐야 하는 것. 플레이어 화면에는
  // 그냥 배경이 안 바뀐 것으로만 보인다.
  if (result.scene_unavailable) {
    console.warn("[director] 장면 판정 실패 — 장면을 유지합니다.");
  }

  // 신뢰도 미달로 장면을 유지한 턴. 이걸 서술과 함께 모으면 world.stage에 빠진
  // 장소의 목록이 된다(설계 6절의 "운영 대응은 로그다"). 서술은 앞부분만 남긴다 —
  // 로그에 본문을 통째로 쏟으면 읽을 수 없다.
  if (result.scene_low_confidence) {
    const answers = result.scene_answers || {};
    const summary = ["place", "time", "weather"]
      .map((key) => {
        const a = answers[key];
        return a ? `${key}=${a.choice}(${a.confidence})` : `${key}=?`;
      })
      .join(" ");
    console.warn(`[director] 신뢰도 미달로 장면 유지: ${summary} | ${result.turn.narration.slice(0, 80)}`);
  }

  // 그림을 그릴지는 scene이 아니라 scene_changed가 정한다 — 장면이 안 바뀐 턴에도
  // result.scene에는 (직전 장면이 있으면) 값이 들어 있다.
  if (result.scene_changed && result.scene) {
    try {
      const sceneResult = await scene.resolveScene({
        world: loaded.world,
        scene: result.scene,
        client: getImageClient(),
        budget: turnBudget,
        rootDir: getSceneRoot()
      });
      if (!sceneResult.ok) {
        console.error("[scene] resolve error:", sceneResult.error_code, sceneResult.message);
      } else if (sse) {
        sse.send("scene", { url: sceneResult.url, cached: sceneResult.cached });
      }
    } catch (error) {
      console.error("[scene] 내부 오류:", error);
    }
  }

  if (sse) sse.end();
});

/**
 * 클라이언트가 응답을 끝까지 받기 전에 끊었는지 지켜본다.
 *
 * 상세 분석은 장면 하나당 Ollama 호출 두 번이라 한 요청이 100회를 넘길 수 있다.
 * 화면을 닫은 사용자를 위해 그걸 끝까지 돌리면 다음 요청이 그만큼 밀린다.
 */
function watchDisconnect(res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function startSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  // 끊긴 소켓에 쓰면 EPIPE가 응답 객체의 error로 올라온다. 보낼 곳이 없으면 조용히 버린다.
  const open = () => !res.writableEnded && !res.destroyed;
  return {
    send(event, data) {
      if (!open()) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!open()) return;
      res.end();
    }
  };
}

if (require.main === module) {
  // 루프백에만 바인딩한다. 이 서버는 원문·분석 캐시를 인증 없이 노출하는 로컬 앱이고,
  // 0.0.0.0에 열면 같은 네트워크의 다른 기기가 그대로 접근한다.
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Novel IF  http://localhost:${PORT}`);
  });
}

module.exports = { app };
