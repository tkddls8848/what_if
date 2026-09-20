"use strict";

/**
 * TypeSafe Jev 클라이언트 — 타입이 정해진 질문에 확률이 달린 값으로 답하는 모델.
 *
 * 규약은 src/llm/cloudflare.js·src/llm/image.js와 같다.
 *   - fetch 주입 가능 → 네트워크 없이 단위 테스트
 *   - 모든 실패를 { ok:false, error_code, message, retryable }로 변환
 *   - stack trace, 로컬 경로, 원문 예외, **API 토큰**을 호출부로 노출하지 않는다
 *
 * 이 모듈은 도메인을 모른다. 장소도 날씨도 모르고, 질문이 무엇을 뜻하는지도
 * 모른다 — 질문을 그대로 실어 보내고 답을 그대로 돌려줄 뿐이다. "어떤 질문을
 * 할 것인가"와 "그 답을 어떻게 쓸 것인가"는 src/server/director.js의 몫이다.
 *
 * ## 호출 경로 — `ai/run/{model}`이 아니다
 *
 * Jev는 Cloudflare의 **서드파티 모델**이라 Workers AI 모델과 경로가 다르다.
 * 이 저장소의 다른 클라이언트가 쓰는 `POST /accounts/{id}/ai/run/{model}`에
 * `typesafe/jev`를 넣으면 400 `7000 No route for that URI`가 온다. 실제 경로는
 * 모델 이름을 **바디에** 싣는 통합 엔드포인트다.
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run
 *   { "model": "typesafe/jev", "input": { "state": ..., "questions": ... } }
 *
 * 확인 기록은 doc/2026-09-20-m0-jev-probe.md에 있다(M0).
 *
 * ## AI Gateway 경유
 *
 * `gatewayId`(server.js의 `CF_GATEWAY_ID`)를 주면 같은 바디를 **AI Gateway 데이터
 * 플레인**으로 보낸다. 로그·캐시·레이트리밋·BYOK가 거기 붙는다.
 *
 *   POST https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}/ai/run
 *
 * 인증 헤더가 두 개로 갈린다 — `Authorization`은 지금까지처럼 Cloudflare 토큰이고,
 * 게이트웨이에 "Authenticated Gateway"를 켰다면 `cf-aig-authorization`에 게이트웨이
 * 토큰(`aigToken`)을 따로 실어야 한다. 안 켰으면 `aigToken`을 비워 둔다.
 *
 * gatewayId가 없으면 위의 v4 직접 경로로 간다. **두 경로는 같은 바디·같은 응답
 * 계약이고, 갈리는 것은 URL과 헤더뿐이다** — AGENTS.md의 "parallel old/new
 * execution paths 금지"에 걸리지 않도록 분기를 URL 조립 한 곳에 가둔다.
 *
 * ## 과금 — 무료 Neuron 할당 밖이다
 *
 * Jev는 서드파티 모델이라 Workers AI 하루 무료 할당(10,000 Neurons)에 포함되지
 * 않고 AI Gateway 통합 과금으로 계산된다. 잔액이 없으면 **402 code 2021**이 온다.
 * 이건 사람이 게이트웨이에 크레딧을 넣거나 BYOK를 켜야 풀리는 실패라, 재시도로
 * 풀리는 RATE_LIMITED나 토큰을 고쳐야 하는 AUTH_FAILED와 대응이 전혀 다르다 —
 * 그래서 PAYMENT_REQUIRED로 따로 가른다(cloudflare.js가 401/403과 429를
 * UPSTREAM_ERROR에서 갈라낸 것과 같은 이유: 대응이 다르면 코드도 달라야 한다).
 *
 * 게이트웨이가 아예 없거나 이름이 틀리면 데이터 플레인이 **401 AiGatewayError
 * 2009**를 낸다(계정에 그 게이트웨이가 있는지를 노출하지 않으려고 404가 아니라
 * 401을 쓴다). 이건 Cloudflare 토큰 문제가 아니므로 AUTH_FAILED로 뭉뚱그리지 않고
 * 따로 안내한다 — 고치는 방법이 "토큰 권한"이 아니라 "게이트웨이를 만들어라"다.
 *
 * error_code 어휘: ABORTED | CONNECTION_FAILED | TIMEOUT | AUTH_FAILED |
 * PAYMENT_REQUIRED | QUOTA_EXHAUSTED | CAPACITY | RATE_LIMITED | UPSTREAM_ERROR |
 * BAD_RESPONSE | NOT_CONFIGURED | INVALID_ARGUMENT
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
/** AI Gateway 데이터 플레인. 제어 플레인(api.cloudflare.com)과 호스트가 다르다. */
const GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1";
const DEFAULT_TIMEOUT_MS = 30000;

/** Cloudflare 통합 엔드포인트에서 쓰는 모델 이름. `@cf/` 접두가 없다(서드파티라서). */
const MODEL = "typesafe/jev";

/** 상한을 두고 자른다 — 업스트림 메시지가 길어도 오류 객체를 부풀리지 않는다. */
const UPSTREAM_MESSAGE_MAX = 300;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * 오류 본문에서 code·message만 골라낸다(화이트리스트). 본문의 다른 필드는 절대
 * 들여다보지 않는다 — cloudflare.js의 classify429와 같은 관용이고 같은 이유다.
 */
function pickError(body) {
  // v4 API는 `errors`, AI Gateway 데이터 플레인은 `error`로 보낸다. 둘 다 받는다.
  const list = body && (Array.isArray(body.errors) ? body.errors : Array.isArray(body.error) ? body.error : null);
  const err = list ? list[0] : null;
  if (!err) return { code: null, message: null };
  const code = typeof err.code === "number" ? err.code : null;
  const message = typeof err.message === "string" ? err.message.slice(0, UPSTREAM_MESSAGE_MAX) : null;
  return { code, message };
}

function label(code) {
  return code !== null ? code : "unknown";
}

/**
 * 상태 코드를 구조화 오류로 옮긴다. cloudflare.js의 mapStatus와 같은 표에
 * 402(게이트웨이 잔액 부족)와 404(모델을 못 찾음)를 더한 것이다.
 *
 * 404를 UPSTREAM_ERROR의 기본 문구에서 갈라내는 이유: M0에서 확인한 대로 이
 * 엔드포인트는 모르는 모델 이름에 404 `7003 Model not found`를 낸다. 재시도로
 * 풀리지 않고 모델 이름이나 계정 접근 권한을 사람이 고쳐야 하는 실패다.
 */
function mapStatus(status, body, viaGateway = false) {
  if (status === 401 || status === 403) {
    // 401/403 본문은 읽지 않는다 — 토큰 일부가 섞여 돌아올 수 있다(cloudflare.js와
    // 같은 규칙). 그래서 원인은 **본문이 아니라 우리 설정**으로 가른다: 게이트웨이를
    // 거쳐 보냈다면 이 401은 거의 항상 AI Gateway의 2009이고, 그건 "토큰이 틀렸다"가
    // 아니라 보통 "그 이름의 게이트웨이가 이 계정에 없다"이다(존재 여부를 노출하지
    // 않으려고 404 대신 401을 쓴다). 고치는 방법이 전혀 다르므로 — 토큰 권한을
    // 아무리 고쳐도 게이트웨이가 없으면 영영 안 풀린다 — 안내를 갈라 준다.
    if (viaGateway) {
      return errorResult(
        "AUTH_FAILED",
        "AI Gateway가 요청을 거부했습니다. CF_GATEWAY_ID가 실제로 존재하는 게이트웨이 이름인지, 인증 게이트웨이라면 CF_AIG_TOKEN이 맞는지 확인하세요.",
        false
      );
    }
    return errorResult(
      "AUTH_FAILED",
      "Cloudflare API 토큰이 거부되었습니다. Workers AI Read/Edit 권한이 있는지 확인하세요.",
      false
    );
  }
  if (status === 402) {
    const { code, message } = pickError(body);
    return errorResult(
      "PAYMENT_REQUIRED",
      `Jev는 Workers AI 무료 할당이 아니라 AI Gateway 통합 과금으로 계산됩니다. 게이트웨이에 크레딧을 넣거나 BYOK를 켜세요. Cloudflare 오류 code=${label(code)}: ${message || "(메시지 없음)"}`,
      false
    );
  }
  if (status === 404) {
    const { code, message } = pickError(body);
    return errorResult(
      "UPSTREAM_ERROR",
      `Cloudflare가 모델을 찾지 못했습니다. code=${label(code)}: ${message || "(메시지 없음)"}`,
      false
    );
  }
  if (status === 429) {
    const { code, message } = pickError(body);
    if (code === 3036) {
      return errorResult("QUOTA_EXHAUSTED", "Workers AI 하루 무료 할당을 모두 사용했습니다.", false);
    }
    if (code === 3040) {
      return errorResult("CAPACITY", "Workers AI가 지금 요청을 처리할 용량이 부족합니다. 잠시 후 다시 시도하세요.", true);
    }
    return errorResult(
      "RATE_LIMITED",
      `Jev 호출이 429로 거부되었습니다. Cloudflare 오류 code=${label(code)}: ${message || "(메시지 없음)"}`,
      true
    );
  }
  return errorResult("UPSTREAM_ERROR", `Jev 오류 (HTTP ${status})`, status >= 500);
}

/**
 * 응답 봉투를 벗긴다.
 *
 * 실물 응답은 **이중으로 감싸여 있다**(2026-09-20 라이브 확인). Cloudflare v4의
 * `result` 안에 게이트웨이 실행 레코드가 있고, 그 안의 `result`가 제공자 응답이다:
 *
 * ```json
 * { "success": true, "errors": [],
 *   "result": {
 *     "state": "Completed",
 *     "gatewayMetadata": { "keySource": "Unified" },
 *     "result": {
 *       "model": "jev-1.13.0",
 *       "answers": { "place": { "type":"choice", "choice":"hallway",
 *                               "probabilities": {...}, "confidence": 0.96 } },
 *       "usage": { "input_tokens": 407, "output_tokens": 47 } } } }
 * ```
 *
 * 문서(그리고 TypeSafe 직접 호출)는 가장 안쪽 모양만 적어 두므로, 세 깊이를 모두
 * 열어 본다 — 봉투가 바뀌어도(Cloudflare가 흔히 그러듯 공지 없이) 조용히 깨지지
 * 않는다. `answers`가 어느 깊이에도 없으면 추측하지 않고 BAD_RESPONSE로 드러낸다.
 */
function hasAnswers(node) {
  return Boolean(node && typeof node === "object" && node.answers && typeof node.answers === "object");
}

function unwrap(body) {
  if (!body || typeof body !== "object") return null;
  const inner = body.result;
  const innermost = inner && typeof inner === "object" ? inner.result : null;
  if (hasAnswers(innermost)) return innermost;
  if (hasAnswers(inner)) return inner;
  if (hasAnswers(body)) return body;
  return null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  if (input === 0 && output === 0) return null;
  return { input_tokens: input, output_tokens: output };
}

/**
 * 답 하나를 정규화한다. 세 질문 종류(choice/noul/score)가 서로 다른 필드를
 * 채우므로 있는 것만 담고 없는 것은 null로 둔다 — **모르는 값을 0으로 적지
 * 않는다**(budget.js의 원칙 그대로. 신뢰도 0과 "신뢰도를 모른다"는 director의
 * 임계 판단에서 정반대로 갈린다).
 */
function normalizeAnswer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    type: typeof raw.type === "string" ? raw.type : null,
    choice: typeof raw.choice === "string" ? raw.choice : null,
    noul: num(raw.noul),
    score: num(raw.score),
    confidence: num(raw.confidence),
    probabilities: raw.probabilities && typeof raw.probabilities === "object" ? raw.probabilities : null
  };
}

function createJevClient({
  accountId, apiToken, fetchImpl, apiBase, timeoutMs, model, gatewayId, aigToken, gatewayBase
} = {}) {
  const account = String(accountId || "");
  const token = String(apiToken || "");
  const base = String(apiBase || API_BASE).replace(/\/+$/, "");
  const gateway = String(gatewayId || "").trim();
  const gatewayRoot = String(gatewayBase || GATEWAY_BASE).replace(/\/+$/, "");
  const aig = String(aigToken || "").trim();
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const resolvedModel = model === undefined ? MODEL : String(model);

  function isConfigured() {
    return account.length > 0 && token.length > 0;
  }

  /**
   * 보낼 곳. 게이트웨이를 설정했으면 데이터 플레인, 아니면 v4 직접 경로다.
   * 바디는 두 경로가 완전히 같다 — 여기서 갈리는 것은 URL뿐이다.
   */
  function endpoint() {
    return gateway
      ? `${gatewayRoot}/${account}/${gateway}/ai/run`
      : `${base}/accounts/${account}/ai/run`;
  }

  /**
   * 헤더. `cf-aig-authorization`은 게이트웨이에 "Authenticated Gateway"를 켰을
   * 때만 붙인다 — 안 켠 게이트웨이에 보내도 무해하지만, 안 켰는데 토큰이 없어서
   * 빈 문자열을 싣는 일은 없어야 하므로 값이 있을 때만 넣는다.
   */
  function headers() {
    const out = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    if (gateway && aig) out["cf-aig-authorization"] = `Bearer ${aig}`;
    return out;
  }

  /**
   * ask({ state, questions, signal })
   *   -> { ok:true, answers: { <이름>: { type, choice, noul, score, confidence, probabilities } }, usage, model }
   *   -> { ok:false, error_code, message, retryable }
   *
   * state는 문자열이나 객체, questions는 이름 -> `{ type, instructions, criteria }`.
   * `choice`의 criteria는 객체 `{ 선택지키: 설명 }`, `score`는 등급 문자열 배열이다.
   * 이 함수는 그 내용을 해석하지 않고 그대로 싣는다.
   */
  async function ask({ state, questions, signal } = {}) {
    if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) {
      return errorResult("INVALID_ARGUMENT", "questions가 최소 하나 필요합니다.", false);
    }
    if (!isConfigured()) {
      return errorResult("NOT_CONFIGURED", "CF_ACCOUNT_ID와 CF_API_TOKEN 환경변수가 필요합니다.", false);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const relay = () => controller.abort();
    if (signal) signal.addEventListener("abort", relay, { once: true });
    const release = () => { if (signal) signal.removeEventListener("abort", relay); };

    let response;
    try {
      response = await doFetch(endpoint(), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: resolvedModel, input: { state, questions } }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      release();
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        if (!timedOut && signal && signal.aborted) {
          return errorResult("ABORTED", "요청이 취소되었습니다.", false);
        }
        return errorResult("TIMEOUT", `Jev 응답 시간 초과 (${timeout}ms)`, true);
      }
      return errorResult("CONNECTION_FAILED", "Jev에 연결할 수 없습니다.", true);
    }
    clearTimeout(timer);
    release();

    if (!response.ok) {
      // 401/403은 본문을 읽지 않는다 — 토큰 일부가 섞여 돌아올 수 있다
      // (cloudflare.js와 같은 규칙). 나머지는 code·message만 화이트리스트로 뽑는다.
      let errorBody = null;
      if (response.status !== 401 && response.status !== 403) {
        try {
          errorBody = await response.json();
        } catch (_error) {
          errorBody = null; // 파싱 못 해도 죽지 않는다 — 코드 없는 분류로 떨어진다.
        }
      }
      return mapStatus(response.status, errorBody, Boolean(gateway));
    }

    let body;
    try {
      body = await response.json();
    } catch (_error) {
      return errorResult("BAD_RESPONSE", "Jev가 JSON이 아닌 응답을 반환했습니다.", false);
    }

    const payload = unwrap(body);
    if (!payload) {
      return errorResult("BAD_RESPONSE", "Jev 응답에 answers가 없습니다.", false);
    }

    const answers = {};
    for (const [name, raw] of Object.entries(payload.answers)) {
      const normalized = normalizeAnswer(raw);
      if (normalized) answers[name] = normalized;
    }

    return {
      ok: true,
      answers,
      usage: normalizeUsage(payload.usage),
      // 실제로 답한 모델 버전(예: "jev-1.13.0"). 요청한 이름과 다를 수 있다 —
      // turn.js가 "요청한 모델이 아니라 실제로 답한 모델로 기록한다"는 규칙과 같다.
      model: typeof payload.model === "string" ? payload.model : resolvedModel
    };
  }

  // gatewayId는 노출한다(어느 경로로 나가는지는 운영자가 알아야 한다). 토큰 두 개는
  // 절대 노출하지 않는다 — cloudflare.js/image.js와 같은 규칙이다.
  return { ask, isConfigured, accountId: account, timeoutMs: timeout, model: resolvedModel, gatewayId: gateway || null };
}

module.exports = { createJevClient, API_BASE, GATEWAY_BASE, MODEL, DEFAULT_TIMEOUT_MS };
