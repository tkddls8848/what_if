"use strict";

/**
 * Cloudflare Workers AI 이미지 클라이언트 — 모델 레지스트리.
 *
 * 왜 레지스트리인가: 이 파일은 원래 flux-1-schnell 하나만 하드코딩하고 있었다.
 * flux-1-schnell은 **4스텝 증류(distilled) 모델**이다 — 증류는 속도를 사는 대신
 * 프롬프트 순응도를 버린다. 그런데 플레이어가 신고한 결함(교실·밤·비라고 써도
 * 그런 그림이 안 나온다)은 정확히 "내용 충실도"의 문제이고, 해상도는 플레이어의
 * 관심사가 아니다. 즉 가장 싸고 빠르지만 가장 말을 안 듣는 모델이 하필 이 앱의
 * 기본값이었다 — 그래서 모델을 교체 가능하게 만들고, Cloudflare가 "프롬프트
 * 순응도가 뛰어나다"고 명시한 두 모델(phoenix-1.0, lucid-origin) 중 더 싸고
 * negative_prompt를 받는 phoenix-1.0을 새 기본값으로 둔다(아래 DEFAULT_IMAGE_MODEL).
 *
 * 세 모델은 요청 바디와 응답 모양이 전부 다르다:
 *
 *   @cf/black-forest-labs/flux-1-schnell
 *     body:     { prompt, steps }                     — width/height/negative_prompt 없음
 *     response: { result: { image: <base64> } }        — JPEG
 *     seed를 절대 보내지 않는다(아래 flux 전용 설명 참고 — 필드가 있기만 해도 400).
 *
 *   @cf/leonardo/phoenix-1.0
 *     body:     { prompt, negative_prompt, width, height, num_steps, guidance, seed }
 *     response: 바이너리 스트림(JSON이 아니다 — arrayBuffer로 받아 base64로 바꾼다)
 *
 *   @cf/leonardo/lucid-origin
 *     body:     { prompt, guidance, seed, width, height, num_steps }  — negative_prompt 없음
 *     response: { image: <base64> }                    — flux와 달리 result로 감싸지 않는다
 *
 * @cf/black-forest-labs/flux-2-klein-4b는 넣지 않는다 — 단가(출력 타일당 26.05
 * Neurons)만 확인했을 뿐 요청/응답 스키마를 검증하지 못했다. 이 파일의 다른 세
 * 모델처럼 실제로 필드 하나하나를 대조 확인하기 전에는 스키마를 추측해서 넣지
 * 않는다(추측이 틀리면 400을 내는 게 아니라 조용히 잘못된 이미지를 만들 수도
 * 있다 — flux의 seed 필드가 그랬듯 문서와 실제 배포가 어긋나는 사례가 이미
 * 있었다).
 *
 * 레지스트리가 알 수 없는 model id를 만나면 항상 구조화 오류 INVALID_ARGUMENT를
 * 낸다 — 조용히 기본 모델로 넘어가지 않는다. server.js가 /api/turn의 narration
 * model을 NEURONS_PER_MTOK 화이트리스트로 검증하는 것과 같은 이유다: 검증되지
 * 않은 model 문자열이 업스트림 URL 경로(`ai/run/{model}`)에 그대로 들어가므로,
 * 알려진 모델만 허용해야 서버가 임의의 Cloudflare v4 API 경로를 호출하는 통로가
 * 되지 않는다(server.js의 해당 주석 참고).
 *
 * `createImageClient({ model })`에서 `model`을 아예 생략하면(레거시 호출부·기존
 * 테스트) flux-1-schnell로 동작한다 — 이 파일이 원래 하드코딩하던 그 모델
 * 그대로다. 애플리케이션의 새 기본값(phoenix-1.0)은 이 레벨의 암묵적 기본값이
 * 아니라 DEFAULT_IMAGE_MODEL을 server.js가 명시적으로 읽어(IMAGE_MODEL
 * 환경변수, 없으면 이 상수) `model`에 채워 넣는 방식으로 적용된다. 두 기본값을
 * 분리해 둔 이유: 이 파일에 대한 기존 단위 테스트들은 `model`을 아예 넘기지
 * 않고 flux 전용 바디 모양(steps만 있고 width/height/negative_prompt는 없음)을
 * 그대로 기대한다 — 그 테스트를 건드리지 않고 앱 차원의 기본 모델만 바꾸려면
 * 이 분리가 필요하다.
 *
 * src/llm/cloudflare.js와 왜 요청 배관을 공유하지 않는가:
 * cloudflare.js의 fetch/타임아웃/abort 처리(`send`)는 factory 내부 클로저라 외부에
 * export되어 있지 않고, 그걸 꺼내려면 채팅 전용으로 다듬어진 그 파일의 공개면을
 * 이미지 호출을 위해 넓혀야 한다. 반면 여기서 필요한 배관(POST 한 번, JSON 또는
 * 바이너리 본문, 스트리밍 없음)은 narrate()의 SSE 프레임 파싱에 비하면 훨씬
 * 얇다. 그래서 같은 *규약*(fetch 주입, 구조화 오류, 토큰 비노출)은 그대로
 * 따르되 배관 코드는 이 파일에 독립적으로 둔다.
 *
 * error_code 어휘는 cloudflare.js와 같다: ABORTED | CONNECTION_FAILED | TIMEOUT |
 * AUTH_FAILED | QUOTA_EXHAUSTED | CAPACITY | RATE_LIMITED | UPSTREAM_ERROR |
 * BAD_RESPONSE | NOT_CONFIGURED | INVALID_ARGUMENT(모델 레지스트리에 없는 model id)
 *
 * 429 분류(QUOTA_EXHAUSTED code 3036 / CAPACITY code 3040 / 그 외 RATE_LIMITED)는
 * cloudflare.js의 mapStatus와 같은 근거를 따른다 — 자세한 설명은 그 파일 참고.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 60000;

/** flux-1-schnell — 이 파일의 원래 유일한 모델. 이름·의미를 바꾸지 않는다. */
const MODEL = "@cf/black-forest-labs/flux-1-schnell";
const DEFAULT_STEPS = 4;
const MAX_STEPS = 8;

/**
 * 새 애플리케이션 기본 모델. server.js가 IMAGE_MODEL 환경변수가 비어 있을 때
 * 이 값으로 폴백한다 — flux-1-schnell(4스텝 증류, 속도만 사고 순응도를 버림)
 * 대신 "프롬프트 순응도가 뛰어나다"고 Cloudflare가 명시한 phoenix-1.0을 쓴다.
 * lucid-origin("가장 프롬프트에 반응적")도 후보였지만, phoenix-1.0이 더 싸고
 * (아래 rates 비교) negative_prompt를 받는 유일한 모델이라 phoenix-1.0을 고른다
 * — negative_prompt가 있으면 "사람 없음"을 프롬프트 문구로 우회하지 않고 실제
 * 부정 채널로 걸 수 있다(src/server/scene.js의 NEGATIVE_PROMPT 참고).
 */
const DEFAULT_IMAGE_MODEL = "@cf/leonardo/phoenix-1.0";

/**
 * 기본 생성 크기. Cloudflare 단가표는 512×512 타일 1장 단위로 과금하므로,
 * 1024×1024(=4타일)의 1/4 비용이다. 플레이어가 신고한 문제는 해상도가 아니라
 * 내용 충실도였고, 플레이어 본인도 해상도는 신경 쓰지 않는다고 했다 — 그러니
 * 4배 비싼 해상도를 기본으로 둘 이유가 없다. 이 크기를 받는 모델(phoenix,
 * lucid)에만 적용된다. flux-1-schnell은애초에 width/height를 받지 않는다.
 */
const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;

/**
 * phoenix-1.0의 num_steps 기본값. Cloudflare 문서 기본값은 25(1~50 범위)인데,
 * 스텝당 10 Neurons이라 그대로 쓰면 스텝만으로 250 Neurons가 나간다. 확산
 * 모델 대부분이 대략 20스텝 근방에서 품질이 수렴한다는 것이 일반적인 경험칙이고,
 * phoenix는 flux처럼 극단적으로 증류된 모델이 아니라 스텝을 좀 줄여도 flux의
 * 4스텝처럼 순응도가 무너지지 않는다. 그래서 20으로 낮춰 스텝 비용을 200
 * Neurons(기본값 대비 20% 절감)로 잡는다. 이보다 더 내리지는 않는다 — 그렇게
 * 하면 "속도를 사려고 순응도를 버린다"는, 이번 교체로 없애려던 바로 그 문제를
 * 다른 모델에서 반복하게 된다.
 */
const PHOENIX_DEFAULT_STEPS = 20;

/**
 * phoenix-1.0의 guidance 기본값. Cloudflare 문서 기본값(2, 범위 2~10)을 그대로
 * 쓴다 — guidance는 단가표에 별도 항목이 없어(타일·스텝만 과금) 바꿔도 비용이
 * 달라지지 않는다. 비용상의 이유로 조정할 근거가 없으니 문서 기본값을 그대로
 * 신뢰한다.
 */
const PHOENIX_DEFAULT_GUIDANCE = 2;

/**
 * lucid-origin의 num_steps 기본값. Cloudflare 문서는 이 모델의 num_steps
 * 기본값을 명시하지 않는다(범위 1~40만 문서화되어 있다) — 확인되지 않은 값을
 * 추측해서 "문서 기본값"인 것처럼 적지 않기 위해, phoenix와 같은 근거(확산
 * 모델은 대략 20스텝에서 품질이 수렴)로 우리가 직접 20을 고른다. lucid는 이번
 * 교체의 기본 모델이 아니라(phoenix가 기본) 레지스트리 완결성을 위해 지원할
 * 뿐이므로 이 값은 호출부가 언제든 steps를 넘겨 덮어쓸 수 있다.
 */
const LUCID_DEFAULT_STEPS = 20;
const LUCID_DEFAULT_GUIDANCE = 4.5; // Cloudflare 문서 기본값 그대로.

const TILES_PER_IMAGE = 1;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/** 상한을 두고 자른다 — Cloudflare 메시지가 비정상적으로 길어도 오류 객체를 부풀리지 않는다. */
const UPSTREAM_MESSAGE_MAX = 300;

/**
 * 429 본문에서 Cloudflare의 오류 코드·메시지만 골라낸다(화이트리스트). 본문의 다른
 * 필드는 절대 들여다보지 않는다 — 그래야 이 두 필드 밖에 무엇이 섞여 있어도
 * 새어 나가지 않는다. cloudflare.js의 classify429와 같다.
 */
function classify429(body) {
  const err = body && Array.isArray(body.errors) ? body.errors[0] : null;
  const code = err && typeof err.code === "number" ? err.code : null;
  const message = err && typeof err.message === "string" ? err.message.slice(0, UPSTREAM_MESSAGE_MAX) : null;
  return { code, message };
}

/**
 * 상태 코드를 구조화 오류로 옮긴다. src/llm/cloudflare.js의 mapStatus와 같은 판단
 * 기준을 그대로 따른다 —
 *   - 401/403: 재시도해도 소용없고 사람이 토큰을 고쳐야 한다. 본문은 절대 싣지
 *     않는다(토큰 일부가 섞여 돌아올 수 있다).
 *   - 429 code 3036(하루 무료 할당 소진): QUOTA_EXHAUSTED, 재시도 무의미.
 *   - 429 code 3040(데이터센터 용량 부족, 계정 할당과 무관): CAPACITY, 재시도하면 풀릴 수 있다.
 *   - 그 외/코드 불명 429: RATE_LIMITED. 추측하지 않고 Cloudflare가 보낸 code·message를
 *     그대로 옮긴다(classify429로 두 필드만 화이트리스트).
 */
function mapStatus(status, body) {
  if (status === 401 || status === 403) {
    return errorResult(
      "AUTH_FAILED",
      "Cloudflare API 토큰이 거부되었습니다. Workers AI Read/Edit 권한이 있는지 확인하세요.",
      false
    );
  }
  if (status === 429) {
    const { code, message } = classify429(body);

    if (code === 3036) {
      return errorResult(
        "QUOTA_EXHAUSTED",
        "Workers AI 하루 무료 할당(10,000 Neurons)을 모두 사용했습니다. 할당은 매일(UTC 기준) 초기화되고, 그 전에 계속 쓰려면 Workers AI Paid 플랜으로 업그레이드해야 합니다.",
        false
      );
    }
    if (code === 3040) {
      return errorResult(
        "CAPACITY",
        "Workers AI가 지금 요청을 처리할 데이터센터 용량이 부족합니다. 이 계정의 무료 할당 소진과는 무관하며, 잠시 후 다시 시도하면 풀릴 수 있습니다.",
        true
      );
    }

    const codeLabel = code !== null ? code : "unknown";
    const messageLabel = message || "(메시지 없음)";
    return errorResult(
      "RATE_LIMITED",
      `Workers AI가 요청을 429로 거부했습니다. Cloudflare 오류 code=${codeLabel}: ${messageLabel}`,
      true
    );
  }
  return errorResult("UPSTREAM_ERROR", `Workers AI 오류 (HTTP ${status})`, status >= 500);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** width/height처럼 "범위보다는 양수인지"만 중요한 값. */
function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function withSeed(body, seed) {
  const n = Number(seed);
  if (seed !== undefined && seed !== null && seed !== "" && Number.isFinite(n)) {
    body.seed = n;
  }
  return body;
}

// --- 모델별 요청 바디 빌더 ---
//
// 모두 같은 모양의 인자 { prompt, negativePrompt, width, height, steps, guidance, seed }를
// 받고, 자기 모델이 받지 않는 필드는 만들지 않는다(width/height를 아예 안 받는
// flux, negative_prompt를 안 받는 flux·lucid). 호출부가 이 인자들을 안 채워도
// 되도록 generate()가 먼저 모델별 기본값을 채워 넣은 뒤 이 함수들을 부른다 —
// 그래서 이 함수들 자신은 기본값을 다시 채우지 않고 clamp만 한다.

/**
 * flux-1-schnell. `seed`는 구조 분해 대상에 아예 없다 — 호출부가 seed를 넘겨도
 * 이 함수가 읽지 않으므로 요청 본문에 절대 실리지 않는다. 실제 배포된
 * flux-1-schnell은 `seed` 필드가 존재하기만 해도(값과 무관하게) 400을 낸다
 * (`AiError: Bad input: ... '/seed' at '/' not allowed`, code 5006) — Cloudflare의
 * 모델 문서 페이지가 seed를 파라미터로 문서화하고 있는 것과 다르다(실측 확인:
 * seed=0, seed=12345 둘 다 400, seed를 아예 뺀 {prompt, steps}만 200).
 */
function buildFluxBody({ prompt, steps }) {
  return {
    prompt: String(prompt || ""),
    steps: clamp(steps, 1, MAX_STEPS, DEFAULT_STEPS)
  };
}

/** phoenix-1.0. negative_prompt가 있을 때만 키를 만든다(빈 값이면 아예 안 보낸다). */
function buildPhoenixBody({ prompt, negativePrompt, width, height, steps, guidance, seed }) {
  const body = {
    prompt: String(prompt || ""),
    width: clamp(width, 0, 2048, DEFAULT_WIDTH),
    height: clamp(height, 0, 2048, DEFAULT_HEIGHT),
    num_steps: clamp(steps, 1, 50, PHOENIX_DEFAULT_STEPS),
    guidance: clamp(guidance, 2, 10, PHOENIX_DEFAULT_GUIDANCE)
  };
  if (negativePrompt) body.negative_prompt = String(negativePrompt);
  return withSeed(body, seed);
}

/**
 * lucid-origin. negative_prompt는 이 모델 스키마에 없다 — 넘어와도 절대 담지
 * 않는다(구조 분해 대상에서 뺀다).
 */
function buildLucidBody({ prompt, width, height, steps, guidance, seed }) {
  const body = {
    prompt: String(prompt || ""),
    width: positiveOr(width, DEFAULT_WIDTH),
    height: positiveOr(height, DEFAULT_HEIGHT),
    num_steps: clamp(steps, 1, 40, LUCID_DEFAULT_STEPS),
    guidance: clamp(guidance, 0, 10, LUCID_DEFAULT_GUIDANCE)
  };
  return withSeed(body, seed);
}

// --- 모델별 응답 파서 ---
//
// 셋 다 다른 모양이다: flux는 { result: { image } }, lucid는 { image }(result로
// 안 감싼다), phoenix는 JSON이 아니라 바이너리 스트림이다. 여기서 통일된
// { ok:true, base64 } 또는 구조화 오류로 바꿔 generate()가 모델과 무관하게
// 다룰 수 있게 한다.

async function readJsonImage(response, extractImage) {
  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    return errorResult("BAD_RESPONSE", "Workers AI가 JSON이 아닌 응답을 반환했습니다.", false);
  }
  const image = extractImage(payload);
  if (typeof image !== "string" || image.length === 0) {
    return errorResult("BAD_RESPONSE", "Workers AI 응답에 이미지 데이터가 없습니다.", false);
  }
  return { ok: true, base64: image };
}

/**
 * phoenix-1.0 전용. 응답이 base64를 담은 JSON이 아니라 이미지 바이트 그 자체인
 * 바이너리 스트림이다 — arrayBuffer로 통째로 받아 base64로 인코딩해서, 이
 * 클라이언트를 쓰는 다른 코드(src/server/scene.js)가 "모델마다 base64 얻는 법이
 * 다르다"는 사실을 몰라도 되게 한다.
 */
async function readBinaryImage(response) {
  let buffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (_error) {
    return errorResult("BAD_RESPONSE", "Workers AI 응답 바이트를 읽을 수 없습니다.", false);
  }
  if (buffer.length === 0) {
    return errorResult("BAD_RESPONSE", "Workers AI가 빈 응답을 반환했습니다.", false);
  }
  return { ok: true, base64: buffer.toString("base64") };
}

/**
 * 모델 레지스트리. 키는 Cloudflare 모델 id(업스트림 URL 경로 세그먼트와 동일).
 *
 *   buildBody(args)     — 이 모델이 받는 필드만 골라 요청 바디를 만든다.
 *   parseResponse(res)  — fetch Response를 { ok:true, base64 } 또는 구조화 오류로.
 *   acceptsNegativePrompt — src/server/scene.js가 negative_prompt를 만들지 말지 결정.
 *   acceptsSize         — width/height를 받는 모델인지(타일 수 계산에도 쓴다).
 *   rates               — { tile, step } Neurons 단가. src/llm/budget.js의
 *                          NEURONS_PER_IMAGE와 같은 값이어야 한다(테스트가 교차 확인한다).
 *   defaults            — generate()가 호출부 인자에 없는 필드를 채울 때 쓰는 값.
 */
const MODELS = {
  [MODEL]: {
    buildBody: buildFluxBody,
    parseResponse: (response) => readJsonImage(response, (payload) => payload && payload.result && payload.result.image),
    acceptsNegativePrompt: false,
    acceptsSize: false,
    rates: { tile: 4.8, step: 9.6 },
    defaults: { steps: DEFAULT_STEPS }
  },
  "@cf/leonardo/phoenix-1.0": {
    buildBody: buildPhoenixBody,
    parseResponse: readBinaryImage,
    acceptsNegativePrompt: true,
    acceptsSize: true,
    rates: { tile: 530, step: 10 },
    defaults: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, steps: PHOENIX_DEFAULT_STEPS, guidance: PHOENIX_DEFAULT_GUIDANCE }
  },
  "@cf/leonardo/lucid-origin": {
    buildBody: buildLucidBody,
    parseResponse: (response) => readJsonImage(response, (payload) => payload && payload.image),
    acceptsNegativePrompt: false,
    acceptsSize: true,
    rates: { tile: 636, step: 12 },
    defaults: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, steps: LUCID_DEFAULT_STEPS, guidance: LUCID_DEFAULT_GUIDANCE }
  }
};

/** width×height를 512 타일 개수로 환산한다. 512×512(기본값)는 항상 1타일이다. */
function tilesFor(width, height) {
  const w = positiveOr(width, DEFAULT_WIDTH);
  const h = positiveOr(height, DEFAULT_HEIGHT);
  return Math.ceil(w / 512) * Math.ceil(h / 512);
}

function createImageClient({ accountId, apiToken, fetchImpl, apiBase, timeoutMs, model, width, height, steps, guidance } = {}) {
  const account = String(accountId || "");
  const token = String(apiToken || "");
  const base = String(apiBase || API_BASE).replace(/\/+$/, "");
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  // model을 아예 안 주면(레거시 호출부·기존 테스트) flux-1-schnell — 이 파일이
  // 원래 하드코딩하던 그 모델. 앱의 새 기본값(phoenix-1.0)은 server.js가
  // DEFAULT_IMAGE_MODEL을 읽어 여기 명시적으로 채워 넣는 몫이다(파일 상단 설명).
  const resolvedModel = model === undefined ? MODEL : String(model);
  const clientDefaults = { width, height, steps, guidance };

  function isConfigured() {
    return account.length > 0 && token.length > 0;
  }

  /**
   * generate({ prompt, negativePrompt, width, height, steps, guidance, seed })
   *   -> { ok:true, base64, usage: { steps, tiles } }
   *   -> { ok:false, error_code, message, retryable }
   *
   * 모델별로 안 받는 필드는 여기서 채워 넣어도 buildBody가 무시한다(예: flux에
   * negativePrompt를 넘겨도 buildFluxBody는 애초에 그 인자를 읽지 않는다).
   *
   * prompt는 1~2048자(Cloudflare 스키마 제약). 길이 검증은 여기서 하지 않는다 —
   * 어디를 자를지는 도메인 판단이라 src/server/scene.js가 한다.
   */
  async function generate(args = {}) {
    const modelConfig = MODELS[resolvedModel];
    if (!modelConfig) {
      // 화이트리스트에 없는 model id — 조용히 기본 모델로 넘어가지 않는다.
      // server.js가 narration model을 NEURONS_PER_MTOK로 검증하는 것과 같은
      // 이유(모델 문자열이 업스트림 URL 경로에 그대로 들어간다).
      return errorResult(
        "INVALID_ARGUMENT",
        `지원하지 않는 이미지 모델입니다: ${resolvedModel}`,
        false
      );
    }

    if (!isConfigured()) {
      return errorResult(
        "NOT_CONFIGURED",
        "CF_ACCOUNT_ID와 CF_API_TOKEN 환경변수가 필요합니다.",
        false
      );
    }

    const d = modelConfig.defaults || {};
    const resolvedArgs = {
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      width: args.width !== undefined ? args.width : (clientDefaults.width !== undefined ? clientDefaults.width : d.width),
      height: args.height !== undefined ? args.height : (clientDefaults.height !== undefined ? clientDefaults.height : d.height),
      steps: args.steps !== undefined ? args.steps : (clientDefaults.steps !== undefined ? clientDefaults.steps : d.steps),
      guidance: args.guidance !== undefined ? args.guidance : (clientDefaults.guidance !== undefined ? clientDefaults.guidance : d.guidance),
      seed: args.seed
    };

    const body = modelConfig.buildBody(resolvedArgs);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);

    let response;
    try {
      response = await doFetch(`${base}/accounts/${account}/ai/run/${resolvedModel}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return errorResult("TIMEOUT", `Workers AI 응답 시간 초과 (${timeout}ms)`, true);
      }
      return errorResult("CONNECTION_FAILED", "Workers AI에 연결할 수 없습니다.", true);
    }
    clearTimeout(timer);

    if (!response.ok) {
      // 429만 본문을 읽는다 — 할당 소진(3036)과 용량 부족(3040)은 본문 없이 구분할
      // 수 없다. 401/403은 여전히 본문을 읽지 않는다(토큰 노출 우려).
      let errorBody = null;
      if (response.status === 429) {
        try {
          errorBody = await response.json();
        } catch (_error) {
          errorBody = null; // 파싱 못 하면 미분류 429로 떨어진다 — 죽지 않는다.
        }
      }
      return mapStatus(response.status, errorBody);
    }

    const parsed = await modelConfig.parseResponse(response);
    if (!parsed.ok) return parsed;

    const stepsUsed = body.steps !== undefined ? body.steps : body.num_steps;
    const tiles = modelConfig.acceptsSize ? tilesFor(body.width, body.height) : TILES_PER_IMAGE;

    return {
      ok: true,
      base64: parsed.base64,
      usage: { steps: stepsUsed, tiles }
    };
  }

  return { generate, isConfigured, accountId: account, timeoutMs: timeout, model: resolvedModel };
}

module.exports = {
  createImageClient,
  IMAGE_MODEL: MODEL,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS: MODELS,
  DEFAULT_STEPS,
  MAX_STEPS,
  PHOENIX_DEFAULT_STEPS,
  PHOENIX_DEFAULT_GUIDANCE,
  LUCID_DEFAULT_STEPS,
  LUCID_DEFAULT_GUIDANCE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  TILES_PER_IMAGE
};
