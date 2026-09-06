"use strict";

/**
 * 판정자 — 이번 턴이 어떤 트리거를 밟았는지 이름으로 답하게 한다.
 *
 * 서술자(Cloudflare, 스트리밍)는 트리거 목록을 절대 보지 않는다
 * (core/card.js의 renderNarratorPrefix 참고) — 채점 기준을 알면 그 기준에 맞춰
 * 장면을 쓰게 되고, 그 순간 판정은 "실제로 쓰인 장면"이 아니라 "점수를 노린
 * 장면"에 대한 것이 된다. 구현자가 자기 코드를 직접 리뷰하지 않는 것과 같은
 * 이유로, 판정은 별도 호출(로컬 Ollama, structured output)로 나뉜다 — 이번 턴의
 * 입력/서술과 authored된 네 트리거 목록(renderJudgeContext)만 보고, 그중 어떤
 * 것이 실제로 일어났는지 정확한 이름으로 답한다.
 *
 * 여기서는 판정 결과를 만들 뿐 상태에 반영하지 않는다 — 반영(델타 계산, 클램프)은
 * core/sim.js의 applyJudgment가 한다. sim.applyJudgment도 authored 목록에 없는
 * 이름을 조용히 무시하지만, 플레이어에게 보여줄 판정 보고서 자체가 정직해야
 * 하므로 여기서도 한 번 더 거른다(같은 관용이 두 곳에 있는 것은 중복이 아니라
 * 방어의 이중화다).
 *
 * CommonJS. src/core/(ESM)는 await import()로 접근한다(선례: src/server/turn.js).
 */

const DEFAULT_JUDGE_MODEL = "qwen3.5:4b";

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    attraction: { type: "array", items: { type: "string" } },
    dislike: { type: "array", items: { type: "string" } },
    relief: { type: "array", items: { type: "string" } },
    strain: { type: "array", items: { type: "string" } }
  },
  required: ["attraction", "dislike", "relief", "strain"]
};

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

/**
 * authored 목록(카드/주인공이 실제로 쓴 트리거 이름들)에 실제로 있는 이름만
 * 남긴다. 모델이 목록에 없는 이름을 지어내도, 여기서 걸러 플레이어에게 정직한
 * 보고서만 나가게 한다.
 */
function keepKnown(names, authored) {
  const known = new Set(Array.isArray(authored) ? authored : []);
  return toStringArray(names).filter((name) => known.has(name));
}

function buildPrompt({ context, userInput, narration }) {
  return `너는 인터랙티브 픽션의 판정자다. 아래 트리거 목록 중 이번 턴에 실제로
일어난 것만, 목록에 있는 문자열 그대로(한 글자도 바꾸지 않고) 골라라. 목록에
없는 표현을 새로 지어내지 마라. 해당하는 게 하나도 없으면 그 배열은 비운다.

${context || "(이 인물/주인공에게 등록된 트리거가 없다.)"}

[플레이어 입력]
${String(userInput || "")}

[이번 턴 서술]
${String(narration || "")}

위 네 목록에서 실제로 일어난 항목만 각 배열에 정확한 문자열로 담아 답하라.`;
}

/**
 * judgeTurn({ card, protagonist, userInput, narration, client, model })
 *   -> { ok:true, attraction:[], dislike:[], relief:[], strain:[] }
 *   -> { ok:false, error_code, message, retryable }
 *
 * client는 src/server/ollama_client.js의 createOllamaClient() 결과(또는 같은
 * 모양의 generateJson을 가진 대역)를 기대한다.
 */
async function judgeTurn({ card, protagonist, userInput, narration, client, model = DEFAULT_JUDGE_MODEL } = {}) {
  if (!client || typeof client.generateJson !== "function") {
    return errorResult("CONNECTION_FAILED", "판정자 클라이언트가 없습니다.", true);
  }

  const { renderJudgeContext } = await import("../core/card.js");
  const context = renderJudgeContext({ card, protagonist });

  const prompt = buildPrompt({ context, userInput, narration });

  // 판정이지 생성이 아니다 — 온도를 낮게 유지한다(레포 관례: 추출류 호출은 0.1).
  const result = await client.generateJson({ model, prompt, format: JUDGE_SCHEMA, temperature: 0.1 });

  if (!result.ok) {
    return errorResult(
      result.error_code || "UPSTREAM_ERROR",
      result.message || "판정자 호출 실패",
      result.retryable !== false
    );
  }

  const romance = (card && card.romance) || {};
  const p = protagonist || {};
  const data = result.data || {};

  return {
    ok: true,
    attraction: keepKnown(data.attraction, romance.attraction_triggers),
    dislike: keepKnown(data.dislike, romance.dislike_triggers),
    relief: keepKnown(data.relief, p.relief_triggers),
    strain: keepKnown(data.strain, p.strain_triggers)
  };
}

module.exports = { judgeTurn, DEFAULT_JUDGE_MODEL, JUDGE_SCHEMA };
