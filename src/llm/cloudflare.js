"use strict";

/**
 * Cloudflare Workers AI REST 클라이언트.
 *
 * Workers 배포 없이 Node에서 직접 호출한다.
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
 *   Authorization: Bearer {API_TOKEN}
 * 토큰은 `Workers AI - Read`와 `Workers AI - Edit` 두 권한이 필요하다.
 *
 * 규약은 src/server/ollama_client.js와 같다.
 *   - fetch 주입 가능 → 네트워크 없이 단위 테스트
 *   - 모든 실패를 { ok:false, error_code, message, retryable }로 변환
 *   - stack trace, 로컬 경로, 원문 예외, **API 토큰**을 호출부로 노출하지 않는다
 *
 * 이 모듈은 도메인을 모른다. 프롬프트가 무엇을 뜻하는지, 비용이 얼마인지 알지 않는다.
 * 토큰 수만 그대로 보고하고 해석은 호출부에 맡긴다.
 *
 * error_code 어휘: ABORTED | CONNECTION_FAILED | TIMEOUT | AUTH_FAILED | QUOTA_EXHAUSTED |
 * CAPACITY | RATE_LIMITED | UPSTREAM_ERROR | BAD_RESPONSE | NOT_CONFIGURED
 *
 * 429는 원인이 하나가 아니다 — Cloudflare가 HTTP 429로 묶어 보내는 오류 코드 중
 * 최소 두 가지는 서로 무관하다:
 *   - code 3036: 하루 무료 할당(10,000 Neurons) 소진 → QUOTA_EXHAUSTED, 재시도해도
 *     소용없다(초기화될 때까지 기다리거나 유료 플랜으로 전환해야 한다).
 *   - code 3040: 데이터센터 용량 부족(계정 할당과 무관) → CAPACITY, 잠시 후 재시도하면
 *     풀릴 수 있다.
 *   - 그 외/코드를 알 수 없는 429 → RATE_LIMITED. 원인을 확인하지 못했으므로 추측하지
 *     않고 Cloudflare가 보낸 code·message를 그대로 옮겨 싣는다.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_MAX_TOKENS = 700;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/** 상한을 두고 자른다 — Cloudflare 메시지가 비정상적으로 길어도 오류 객체를 부풀리지 않는다. */
const UPSTREAM_MESSAGE_MAX = 300;

/**
 * 429 본문에서 Cloudflare의 오류 코드·메시지만 골라낸다(화이트리스트). 본문의 다른
 * 필드는 절대 들여다보지 않는다 — 그래야 이 두 필드 밖에 무엇이 섞여 있어도
 * 새어 나가지 않는다.
 */
function classify429(body) {
  const err = body && Array.isArray(body.errors) ? body.errors[0] : null;
  const code = err && typeof err.code === "number" ? err.code : null;
  const message = err && typeof err.message === "string" ? err.message.slice(0, UPSTREAM_MESSAGE_MAX) : null;
  return { code, message };
}

/**
 * 상태 코드를 구조화 오류로 옮긴다.
 *
 * 401/403과 429를 UPSTREAM_ERROR에서 갈라내는 이유는 대응이 다르기 때문이다 —
 * 인증 실패는 재시도해도 소용없고 사람이 토큰을 고쳐야 한다.
 *
 * 429는 한 걸음 더 나눈다. Cloudflare는 최소 두 가지 무관한 사유를 같은 HTTP 429로
 * 묶어 보낸다:
 *   - code 3036 "하루 무료 할당을 모두 사용했습니다" → QUOTA_EXHAUSTED, 재시도 무의미.
 *   - code 3040 "전달할 데이터센터가 더 없습니다"(용량 부족, 계정 할당과 무관)
 *     → CAPACITY, 재시도하면 풀릴 수 있다.
 *   - 그 외/코드 불명 → RATE_LIMITED. 원인을 확인하지 못했으니 추측하지 않고
 *     Cloudflare가 실제로 보낸 code·message를 그대로 옮긴다.
 *
 * 401/403 본문은 여전히 절대 싣지 않는다 — 토큰 일부가 섞여 돌아올 수 있다. 429
 * 본문은 code/message 두 필드만 화이트리스트로 뽑아 싣는다(classify429).
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

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const completion = Number(usage.completion_tokens) || 0;
  const prompt = Number(usage.prompt_tokens) || 0;
  if (completion === 0 && prompt === 0) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion
  };
}

function createCloudflareClient({ accountId, apiToken, fetchImpl, timeoutMs, apiBase } = {}) {
  const account = String(accountId || "");
  const token = String(apiToken || "");
  const base = String(apiBase || API_BASE).replace(/\/+$/, "");
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  function isConfigured() {
    return account.length > 0 && token.length > 0;
  }

  /**
   * 헤더가 올 때까지만 시간 제한을 건다. 스트리밍 본문은 길게 이어지므로 같은 타이머로
   * 재면 정상 생성이 중간에 끊긴다. 본문 단계의 이탈은 호출부가 넘긴 signal(클라이언트
   * 접속 종료)이 처리한다.
   */
  async function send(model, payload, signal) {
    if (!isConfigured()) {
      return errorResult(
        "NOT_CONFIGURED",
        "CF_ACCOUNT_ID와 CF_API_TOKEN 환경변수가 필요합니다.",
        false
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const relay = () => controller.abort();
    if (signal) signal.addEventListener("abort", relay, { once: true });

    const release = () => {
      if (signal) signal.removeEventListener("abort", relay);
    };

    let response;
    try {
      response = await doFetch(`${base}/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      release();
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        if (timedOut) {
          return errorResult("TIMEOUT", `Workers AI 응답 시간 초과 (${timeout}ms)`, true);
        }
        if (signal && signal.aborted) {
          return errorResult("ABORTED", "요청이 취소되었습니다.", false);
        }
        return errorResult("TIMEOUT", `Workers AI 응답 시간 초과 (${timeout}ms)`, true);
      }
      return errorResult("CONNECTION_FAILED", "Workers AI에 연결할 수 없습니다.", true);
    }
    clearTimeout(timer);

    if (!response.ok) {
      // 429만 본문을 읽는다 — 어느 사유(할당 소진 vs 용량 부족)인지 이 본문 없이는
      // 구분할 수 없다. 401/403은 여전히 본문을 읽지 않는다(토큰 노출 우려).
      let errorBody = null;
      if (response.status === 429) {
        try {
          errorBody = await response.json();
        } catch (_error) {
          errorBody = null; // 파싱 못 하면 미분류 429로 떨어진다 — 죽지 않는다.
        }
      }
      release();
      return mapStatus(response.status, errorBody);
    }
    return { ok: true, response, release };
  }

  async function complete({ model, messages, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE, signal } = {}) {
    const sent = await send(model, {
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature
    }, signal);
    if (!sent.ok) return sent;

    let body;
    try {
      body = await sent.response.json();
    } catch (_error) {
      sent.release();
      return errorResult("BAD_RESPONSE", "Workers AI가 JSON이 아닌 응답을 반환했습니다.", false);
    }

    const result = body && body.result;
    if (!result || typeof result.response !== "string") {
      sent.release();
      return errorResult("BAD_RESPONSE", "Workers AI 응답에 result.response가 없습니다.", false);
    }
    sent.release();
    return { ok: true, text: result.response, usage: normalizeUsage(result.usage) };
  }

  /**
   * 스트리밍 생성.
   *
   * SSE 프레임은 청크 경계와 무관하게 도착한다. 한 프레임이 두 청크에 걸치거나 한
   * 청크에 여러 프레임이 들어 있으므로, "\n\n"이 나올 때까지 버퍼에 모았다가 자른다.
   * 프레임 하나가 깨져도 스트림 전체를 버리지 않는다 — 이미 사용자 화면에 흐른 글자를
   * 되돌릴 수 없으므로, 살릴 수 있는 만큼 살리고 계속 읽는 편이 낫다.
   *
   * usage는 마지막으로 본 값을 쓴다. Workers AI는 프레임마다 usage를 실어 보내며
   * 누적값이므로 마지막 것이 총계다.
   *
   * truncated: true는 **읽기가 중간에 끊겼다**는 뜻이고, 모델이 max_tokens에 걸린 것과는 무관하다.
   * 두 경로에서 켜진다 — 본문 순회 중의 I/O 실패, 그리고 마지막 프레임이 잘린 채 스트림이 끝난 경우.
   * onToken이 예외를 던져도 같은 경로로 들어와 truncated가 켜진다.
   * 이때도 반환은 ok: true이고 text에는 그때까지 받은 내용이 들어 있다. 호출부는 이 플래그를 반드시 확인해야 한다.
   */
  async function narrate({ model, messages, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE, onToken, signal } = {}) {
    const sent = await send(model, {
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature
    }, signal);
    if (!sent.ok) return sent;

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage = null;
    let done = false;
    let truncated = false;
    let unterminated = false; // 마지막 프레임이 잘린 채 스트림이 얌전히 끝났다

    const consume = (block, final = false) => {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { done = true; return; }
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch (_error) {
          // 스트림 도중의 깨진 프레임 하나는 버린다. 그러나 마지막 잔여 버퍼가 파싱되지
          // 않는다면 그건 프레임이 끝나기 전에 연결이 닫혔다는 뜻이므로 잘림으로 본다.
          if (final && payload) unterminated = true;
          continue;
        }
        const piece = typeof frame.response === "string" ? frame.response : "";
        if (piece) {
          text += piece;
          if (onToken) onToken(piece);
        }
        const normalized = normalizeUsage(frame.usage);
        if (normalized) usage = normalized;
      }
    };

    try {
      for await (const chunk of sent.response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while (!done && (cut = buffer.indexOf("\n\n")) !== -1) {
          consume(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
        }
        if (done) break;
      }
      if (!done && buffer.trim()) consume(buffer, true);
    } catch (_error) {
      truncated = true;
    }

    // 스트림을 다 읽은 뒤에야 abort 릴레이를 뗀다 — 본문 순회 중에는 호출자의
    // 취소가 fetch까지 닿아야 한다.
    sent.release();

    return { ok: true, text, usage, truncated: truncated || unterminated };
  }

  return { complete, narrate, isConfigured, send, accountId: account, timeoutMs: timeout };
}

module.exports = { createCloudflareClient, API_BASE, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE };
