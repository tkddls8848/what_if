"use strict";

/**
 * Google Gemini(AI Studio) REST 클라이언트 — Cloudflare 할당이 마르면 대신 서술을 잇는다.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
 *   POST .../{MODEL}:streamGenerateContent?alt=sse        (스트리밍)
 *   x-goog-api-key: {API_KEY}
 *
 * 키를 헤더로 보낸다. Gemini는 `?key=`로도 받지만 URL에 실으면 프록시 로그·에러
 * 메시지·리퍼러에 키가 그대로 남는다 — 그럴 이유가 없다.
 *
 * 규약은 src/llm/cloudflare.js와 같다.
 *   - fetch 주입 가능 → 네트워크 없이 단위 테스트
 *   - 모든 실패를 { ok:false, error_code, message, retryable }로 변환
 *   - stack trace, 로컬 경로, 원문 예외, **API 키**를 호출부로 노출하지 않는다
 *   - narrate()가 ok:false를 돌려줬다면 onToken은 한 번도 불리지 않았다.
 *     이 불변식이 src/llm/fallback.js가 폴백해도 되는지 판단하는 근거다 —
 *     화면에 이미 흐른 글자는 되돌릴 수 없으므로, 한 글자라도 나갔으면
 *     다른 제공처로 다시 쓸 수 없다. 여기서 깨뜨리면 폴백이 서술을 겹쳐 쓴다.
 *
 * error_code 어휘는 cloudflare.js와 같고 하나가 더 있다 — CONTENT_FILTERED.
 * Cloudflare에는 없던 실패다(Gemini는 안전 필터로 생성 자체를 거부할 수 있다).
 * 이건 가용성 문제가 아니라 내용에 대한 판단이므로 다른 제공처로 넘겨도 결과가
 * 같을 이유가 없다 — fallback.js가 이 코드에서는 다음 제공처로 넘어가지 않는다.
 *
 * error_code 어휘: ABORTED | CONNECTION_FAILED | TIMEOUT | AUTH_FAILED | QUOTA_EXHAUSTED |
 * CAPACITY | RATE_LIMITED | UPSTREAM_ERROR | BAD_RESPONSE | NOT_CONFIGURED |
 * INVALID_ARGUMENT | CONTENT_FILTERED
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_MAX_TOKENS = 700;

/**
 * 기본값을 gemini-2.5-flash로 둔다. 무료 티어 일일 요청 한도는 gemini-3-flash가
 * 더 크지만(1,500 RPD vs 500 RPD), 여기서 확실한 건 2.5-flash가 오래 존재해 온
 * 안정된 이름이라는 점뿐이다. 폴백이 정작 필요한 순간에 404로 죽는 것보다
 * 한도가 작은 편이 낫다. 한도를 늘리려면 GEMINI_MODEL로 바꾼다(.env.example 참고).
 */
const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * 모델 이름은 URL 경로에 그대로 들어간다. fetch/URL이 경로의 `..`를 정규화하므로
 * 검증 없이 넘기면 인증된 요청이 엉뚱한 API 경로로 갈 수 있다 — server.js가
 * /api/turn의 model을 가격표로 제한하는 것과 같은 이유다. Cloudflare 모델과 달리
 * 이 값은 사용자가 아니라 운영자(환경변수)가 넣지만, 방어는 값을 쓰는 자리에 둔다.
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 상한을 두고 자른다 — 업스트림 메시지가 길어도 오류 객체를 부풀리지 않는다. */
const UPSTREAM_MESSAGE_MAX = 300;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * OpenAI 모양 messages를 Gemini의 systemInstruction + contents로 옮긴다.
 *
 * 세 가지가 다르다:
 *   1. system은 별도 필드(systemInstruction)다.
 *   2. assistant는 "model"이라 부른다.
 *   3. contents는 user 턴으로 시작해야 안전하다. core/memory.js는 첫 턴에
 *      system → assistant(opening) → user 순서로 쌓으므로(session.opening),
 *      그대로 옮기면 model 턴으로 시작한다. 이때 그 턴을 **버리지 않고**
 *      systemInstruction 끝에 라벨을 붙여 옮긴다 — 오프닝은 플레이어가 이미
 *      읽은 글이고 다음 서술이 그것과 이어져야 하므로, 내용을 잃으면 안 된다.
 */
function toGeminiBody(messages) {
  const systemParts = [];
  const contents = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content) continue;
    if (message.role === "system") {
      systemParts.push(content);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    // 같은 역할이 연달아 오면 한 턴으로 합친다. Gemini는 교대를 기대하고,
    // 합치는 편이 빈 턴을 끼워 넣어 교대를 흉내 내는 것보다 원문에 가깝다.
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: content });
    } else {
      contents.push({ role, parts: [{ text: content }] });
    }
  }

  // 선두의 model 턴을 systemInstruction으로 옮긴다(위 3번).
  while (contents.length > 0 && contents[0].role === "model") {
    const moved = contents.shift();
    systemParts.push(`[이전 서술]\n${moved.parts.map((part) => part.text).join("\n")}`);
  }

  const body = { contents };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  return body;
}

/**
 * 429 본문에서 어떤 할당이 걸렸는지만 골라낸다(화이트리스트).
 *
 * Cloudflare가 code 3036(하루 할당 소진)과 3040(용량 부족)을 같은 429로 묶어
 * 보내듯, Gemini도 분당 한도와 일일 한도를 같은 429/RESOURCE_EXHAUSTED로 보낸다.
 * 둘은 대응이 정반대다 — 분당 한도는 잠시 뒤 풀리고, 일일 한도는 내일까지 안 풀린다.
 * QuotaFailure violations의 quotaId에 그 구분이 들어 있다(예:
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier" vs "...PerMinute...").
 *
 * quotaId와 retryDelay 두 필드만 본다. 본문의 다른 필드는 들여다보지 않는다 —
 * 그래야 이 둘 밖에 무엇이 섞여 있어도(프롬프트 조각 등) 새어 나가지 않는다.
 */
function classifyQuota(body) {
  const details = body && body.error && Array.isArray(body.error.details) ? body.error.details : [];
  let quotaId = null;
  let retryDelay = null;

  for (const detail of details) {
    const type = typeof detail?.["@type"] === "string" ? detail["@type"] : "";
    if (type.endsWith("QuotaFailure") && Array.isArray(detail.violations)) {
      const violation = detail.violations.find((item) => typeof item?.quotaId === "string");
      if (violation) quotaId = violation.quotaId.slice(0, UPSTREAM_MESSAGE_MAX);
    }
    if (type.endsWith("RetryInfo") && typeof detail.retryDelay === "string") {
      retryDelay = detail.retryDelay.slice(0, 32);
    }
  }
  return { quotaId, retryDelay, perDay: Boolean(quotaId && /PerDay/iu.test(quotaId)) };
}

/** 400 본문에 키가 잘못됐다는 표시가 있는지만 본다(ErrorInfo.reason). */
function isBadKey(body) {
  const details = body && body.error && Array.isArray(body.error.details) ? body.error.details : [];
  return details.some((detail) => detail?.reason === "API_KEY_INVALID");
}

/**
 * 상태 코드를 구조화 오류로 옮긴다.
 *
 * 400/401/403 본문은 메시지를 싣지 않는다 — Gemini의 400 메시지에는 거부된
 * 요청의 필드 경로나 내용 조각이 섞여 돌아올 수 있다. 대신 status 문자열(열거값)만
 * 옮긴다. 429는 quotaId/retryDelay 두 필드만 화이트리스트로 뽑아 싣는다.
 */
function mapStatus(status, body) {
  if (status === 401 || status === 403 || (status === 400 && isBadKey(body))) {
    return errorResult(
      "AUTH_FAILED",
      "Gemini API 키가 거부되었습니다. AI Studio에서 발급한 키가 GEMINI_API_KEY에 들어 있는지 확인하세요.",
      false
    );
  }

  if (status === 429) {
    const { quotaId, retryDelay, perDay } = classifyQuota(body);
    const idLabel = quotaId || "(할당 이름 없음)";

    if (perDay) {
      return errorResult(
        "QUOTA_EXHAUSTED",
        `Gemini 무료 티어의 하루 요청 한도(RPD)를 모두 사용했습니다. 태평양 표준시 자정에 초기화됩니다. 걸린 할당: ${idLabel}`,
        false
      );
    }
    const delayLabel = retryDelay ? ` ${retryDelay} 후 다시 시도할 수 있습니다.` : "";
    return errorResult(
      "RATE_LIMITED",
      `Gemini가 요청을 429로 거부했습니다(분당 한도로 보입니다).${delayLabel} 걸린 할당: ${idLabel}`,
      true
    );
  }

  if (status === 503) {
    return errorResult(
      "CAPACITY",
      "Gemini 모델이 지금 과부하 상태입니다. 할당 소진과는 무관하며, 잠시 후 다시 시도하면 풀릴 수 있습니다.",
      true
    );
  }

  if (status === 400) {
    const label = typeof body?.error?.status === "string" ? body.error.status : "INVALID_ARGUMENT";
    return errorResult("INVALID_ARGUMENT", `Gemini가 요청을 거부했습니다 (${label}).`, false);
  }

  return errorResult("UPSTREAM_ERROR", `Gemini 오류 (HTTP ${status})`, status >= 500);
}

/**
 * 생성이 안전 필터에 막혔는지 본다.
 *
 * 두 자리에서 막힌다 — 프롬프트 단계(promptFeedback.blockReason)와 응답 단계
 * (candidate.finishReason). STOP과 MAX_TOKENS만 정상이고, 나머지(SAFETY,
 * PROHIBITED_CONTENT, RECITATION, BLOCKLIST, SPII...)는 내용 때문에 끊긴 것이다.
 */
const NORMAL_FINISH = new Set(["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"]);

function blockReason(body) {
  const prompt = body?.promptFeedback?.blockReason;
  if (typeof prompt === "string" && prompt) return prompt;
  const finish = body?.candidates?.[0]?.finishReason;
  if (typeof finish === "string" && finish && !NORMAL_FINISH.has(finish)) return finish;
  return null;
}

function extractText(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

/**
 * Gemini의 usageMetadata를 cloudflare.js와 같은 모양으로 옮긴다. 이름만 다르고
 * 뜻은 같다 — 호출부(turn.js의 계량)가 제공처를 몰라도 되도록 여기서 맞춘다.
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.promptTokenCount) || 0;
  const completion = Number(usage.candidatesTokenCount) || 0;
  if (prompt === 0 && completion === 0) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.totalTokenCount) || prompt + completion
  };
}

function createGeminiClient({ apiKey, fetchImpl, timeoutMs, apiBase, model: defaultModel } = {}) {
  const key = String(apiKey || "");
  const base = String(apiBase || API_BASE).replace(/\/+$/u, "");
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fallbackModel = String(defaultModel || "").trim() || DEFAULT_MODEL;

  function isConfigured() {
    return key.length > 0;
  }

  /**
   * 헤더가 올 때까지만 시간 제한을 건다 — cloudflare.js와 같은 이유다. 스트리밍
   * 본문은 길게 이어지므로 같은 타이머로 재면 정상 생성이 중간에 끊긴다.
   */
  async function send(model, payload, stream, signal) {
    if (!isConfigured()) {
      return errorResult("NOT_CONFIGURED", "GEMINI_API_KEY 환경변수가 필요합니다.", false);
    }
    const name = String(model || "").trim() || fallbackModel;
    if (!MODEL_NAME.test(name)) {
      return errorResult("INVALID_ARGUMENT", "Gemini 모델 이름 형식이 올바르지 않습니다.", false);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const relay = () => controller.abort();
    if (signal) signal.addEventListener("abort", relay, { once: true });
    const release = () => {
      if (signal) signal.removeEventListener("abort", relay);
    };

    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    let response;
    try {
      response = await doFetch(`${base}/models/${name}:${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      release();
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        if (timedOut) return errorResult("TIMEOUT", `Gemini 응답 시간 초과 (${timeout}ms)`, true);
        if (signal && signal.aborted) return errorResult("ABORTED", "요청이 취소되었습니다.", false);
        return errorResult("TIMEOUT", `Gemini 응답 시간 초과 (${timeout}ms)`, true);
      }
      return errorResult("CONNECTION_FAILED", "Gemini에 연결할 수 없습니다.", true);
    }
    clearTimeout(timer);

    if (!response.ok) {
      // 400과 429만 본문을 읽는다 — 키 오류인지, 어느 할당이 걸렸는지는 본문
      // 없이 구분할 수 없다. 읽더라도 mapStatus가 정해진 필드만 꺼내 쓴다.
      let errorBody = null;
      if (response.status === 400 || response.status === 429) {
        try {
          errorBody = await response.json();
        } catch (_error) {
          errorBody = null; // 파싱 못 하면 미분류로 떨어진다 — 죽지 않는다.
        }
      }
      release();
      return mapStatus(response.status, errorBody);
    }
    return { ok: true, response, release };
  }

  function buildPayload(messages, maxTokens, temperature) {
    return {
      ...toGeminiBody(messages),
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature
      }
    };
  }

  async function complete({ model, messages, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE, signal } = {}) {
    const sent = await send(model, buildPayload(messages, maxTokens, temperature), false, signal);
    if (!sent.ok) return sent;

    let body;
    try {
      body = await sent.response.json();
    } catch (_error) {
      sent.release();
      return errorResult("BAD_RESPONSE", "Gemini가 JSON이 아닌 응답을 반환했습니다.", false);
    }
    sent.release();

    const text = extractText(body);
    if (!text) {
      const blocked = blockReason(body);
      if (blocked) {
        return errorResult("CONTENT_FILTERED", `Gemini 안전 필터가 생성을 거부했습니다 (${blocked}).`, false);
      }
      return errorResult("BAD_RESPONSE", "Gemini 응답에 텍스트가 없습니다.", false);
    }
    return { ok: true, text, usage: normalizeUsage(body.usageMetadata) };
  }

  /**
   * 스트리밍 생성. 프레임 조립은 cloudflare.js와 같은 이유로 같은 모양이다 —
   * SSE 프레임은 청크 경계와 무관하게 도착하므로 "\n\n"이 나올 때까지 모았다가 자른다.
   * 다른 점 둘:
   *   - Gemini는 [DONE] 센티널을 보내지 않는다. 본문이 끝나면 그게 끝이다.
   *   - 프레임마다 전체 GenerateContentResponse가 오고 usageMetadata는 누적값이라
   *     마지막 것이 총계다(이건 Workers AI와 같다).
   *
   * truncated: true는 **읽기가 중간에 끊겼다**는 뜻이고 max_tokens와는 무관하다 —
   * cloudflare.js와 같은 뜻이어야 호출부가 제공처를 몰라도 된다. 안전 필터가
   * 도중에 끊은 경우도 여기 포함한다(글이 끝나지 않은 채 멈춘 건 마찬가지다).
   *
   * 한 글자도 못 받은 채 안전 필터에 막혔다면 ok:false(CONTENT_FILTERED)로 끝낸다.
   * 이미 글자가 나간 뒤라면 화면을 되돌릴 수 없으므로 ok:true에 truncated를 켜
   * "여기서 끊겼다"고 알린다 — 없던 일로 만들지 않는다.
   */
  async function narrate({ model, messages, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE, onToken, signal } = {}) {
    const sent = await send(model, buildPayload(messages, maxTokens, temperature), true, signal);
    if (!sent.ok) return sent;

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage = null;
    let truncated = false;
    let unterminated = false;
    let blocked = null;

    const consume = (block, final = false) => {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch (_error) {
          // 도중의 깨진 프레임 하나는 버린다. 마지막 잔여 버퍼가 파싱되지 않으면
          // 프레임이 끝나기 전에 연결이 닫혔다는 뜻이므로 잘림으로 본다.
          if (final && payload) unterminated = true;
          continue;
        }
        const piece = extractText(frame);
        if (piece) {
          text += piece;
          if (onToken) onToken(piece);
        }
        const stopped = blockReason(frame);
        if (stopped) blocked = stopped;
        const normalized = normalizeUsage(frame.usageMetadata);
        if (normalized) usage = normalized;
      }
    };

    try {
      for await (const chunk of sent.response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          consume(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
        }
      }
      if (buffer.trim()) consume(buffer, true);
    } catch (_error) {
      truncated = true;
    }

    // 스트림을 다 읽은 뒤에야 abort 릴레이를 뗀다 — 본문 순회 중에는 호출자의
    // 취소가 fetch까지 닿아야 한다.
    sent.release();

    if (!text && blocked) {
      return errorResult("CONTENT_FILTERED", `Gemini 안전 필터가 생성을 거부했습니다 (${blocked}).`, false);
    }
    return { ok: true, text, usage, truncated: truncated || unterminated || Boolean(blocked) };
  }

  return { complete, narrate, isConfigured, timeoutMs: timeout, model: fallbackModel };
}

module.exports = {
  createGeminiClient,
  API_BASE,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  toGeminiBody
};
