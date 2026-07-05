"use strict";

/**
 * Ollama HTTP client.
 *
 * - fetch 주입 가능 → 네트워크 없이 단위 테스트
 * - 모든 실패를 짧은 구조화 오류로 변환:
 *   { ok:false, error_code, message, retryable }
 *   error_code: CONNECTION_FAILED | TIMEOUT | UPSTREAM_ERROR | BAD_RESPONSE | PARSE_FAILED
 * - stack trace, 로컬 경로, 원문 예외는 클라이언트로 노출하지 않는다
 */

const DEFAULT_TIMEOUT_MS = 120000;

function isAllowedSmallModel(model, parameterSize = "") {
  const tag = String(model || "");
  const size = String(parameterSize || "");
  return /(^|[:_-])([4-7](?:\.\d+)?)b\b/i.test(tag) ||
    /(^|[:_-])e[4-7]b\b/i.test(tag) ||
    /^([4-7](?:\.\d+)?)B$/i.test(size) ||
    /^Effective\s+[4-7]B$/i.test(size);
}

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

function createOllamaClient({ baseUrl, fetchImpl, timeoutMs } = {}) {
  const base = String(baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const doFetch = fetchImpl || fetch;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await doFetch(`${base}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return errorResult("TIMEOUT", `Ollama 응답 시간 초과 (${base}, ${timeout}ms)`, true);
      }
      return errorResult("CONNECTION_FAILED", `Ollama에 연결할 수 없습니다 (${base}). Ollama가 실행 중인지 확인하세요.`, true);
    }
    clearTimeout(timer);

    let body = null;
    try {
      body = await response.json();
    } catch (_error) {
      return errorResult(
        "BAD_RESPONSE",
        `Ollama가 JSON이 아닌 응답을 반환했습니다 (HTTP ${response.status})`,
        response.status >= 500
      );
    }

    if (!response.ok) {
      const detail = typeof body?.error === "string" ? body.error.slice(0, 200) : `HTTP ${response.status}`;
      return errorResult("UPSTREAM_ERROR", `Ollama 오류: ${detail}`, response.status >= 500);
    }
    return { ok: true, status: response.status, body };
  }

  async function listModels() {
    const result = await request("/api/tags");
    if (!result.ok) return result;
    const models = (result.body.models || []).map((model) => ({
      name: model.name,
      parameter_size: model.details?.parameter_size || "",
      context_length: model.details?.context_length || null,
      capabilities: model.capabilities || [],
      allowed: isAllowedSmallModel(model.name, model.details?.parameter_size)
    }));
    return { ok: true, models };
  }

  /**
   * /api/generate 호출. format에 "json" 또는 JSON Schema 객체(structured outputs)를 받는다.
   * 성공: { ok, response, prompt_eval_count, eval_count }
   */
  async function generate({ model, prompt, format = "json", numCtx = 8192, temperature = 0.1 } = {}) {
    const result = await request("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format,
        options: { temperature, num_ctx: numCtx },
        prompt
      })
    });
    if (!result.ok) return result;
    return {
      ok: true,
      response: String(result.body.response ?? ""),
      prompt_eval_count: Number(result.body.prompt_eval_count) || 0,
      eval_count: Number(result.body.eval_count) || 0
    };
  }

  /**
   * generate + JSON 파싱. 파싱 실패는 PARSE_FAILED로 구분해 호출자가 재시도를 결정한다.
   */
  async function generateJson(args) {
    const result = await generate(args);
    if (!result.ok) return result;
    try {
      const data = JSON.parse(result.response || "{}");
      return {
        ok: true,
        data,
        prompt_eval_count: result.prompt_eval_count,
        eval_count: result.eval_count
      };
    } catch (_error) {
      return {
        ...errorResult("PARSE_FAILED", "Ollama 응답 JSON 파싱 실패", true),
        prompt_eval_count: result.prompt_eval_count,
        eval_count: result.eval_count,
        raw: result.response.slice(0, 400)
      };
    }
  }

  async function health() {
    const result = await listModels();
    if (!result.ok) {
      return { reachable: false, url: base, error_code: result.error_code, message: result.message, allowed_models: [] };
    }
    return {
      reachable: true,
      url: base,
      allowed_models: result.models.filter((model) => model.allowed).map((model) => model.name)
    };
  }

  return { request, listModels, generate, generateJson, health, baseUrl: base, timeoutMs: timeout };
}

module.exports = { createOllamaClient, isAllowedSmallModel };
