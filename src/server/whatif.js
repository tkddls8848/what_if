"use strict";

/**
 * what-if 분기 생성 (서버 측 Ollama 호출).
 *
 * 이 모듈이 보는 것은 브라우저가 보낸 **분기 시점 스냅샷(seed)뿐**이다. 원문도,
 * 분기 이후 사건도 받지 않는다. 모델이 원작 결말을 베낄 재료를 주지 않는 것이
 * 스포일러·표절을 막는 유일하게 확실한 방법이다. 검사는 브라우저가
 * `core/whatif.js`의 `detectCanonLeak`으로 사후에 한 번 더 한다.
 *
 * 두 단계로 나눈다 (WHAT-IF 논문의 메타프롬프팅 구조).
 *   1. 대안 행동 제안 — 분기 시점에서 인물이 달리 할 수 있었던 선택 2~3개
 *   2. 결과 전개 — 선택 하나당 사건 프레임과 상태 변화
 * 한 호출 = 한 작업 원칙은 추출 파이프라인과 같다. 4B 모델에 두 일을 한꺼번에
 * 시키면 스키마를 벗어난다.
 *
 * 추출과 달리 **생성**이므로 temperature를 올린다. 추출은 0.1, 분기는 0.6이다.
 */

const prompts = require("./prompts");

const WHATIF_PROMPT_VERSION = "whatif-v1";
const GENERATION_TEMPERATURE = 0.6;
const MAX_ALTERNATIVES = 3;

const EVENT_TYPES = [
  "appearance", "movement", "conversation", "perception",
  "conflict", "realization", "stasis", "symbolic", "background"
];

const PREMISE_SCHEMA = {
  type: "object",
  properties: {
    alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          actor: { type: "string" },
          premise: { type: "string" }
        },
        required: ["actor", "premise"]
      }
    }
  },
  required: ["alternatives"]
};

const BRANCH_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: EVENT_TYPES },
          summary: { type: "string" },
          characters: { type: "array", items: { type: "string" } },
          locations: { type: "array", items: { type: "string" } },
          confidence: { type: "number" }
        },
        required: ["type", "summary", "characters"]
      }
    },
    state_changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string" },
          mental_state: { type: "string" },
          physical_state: { type: "string" },
          location: { type: "string" },
          after_event_order: { type: "integer" }
        },
        required: ["character"]
      }
    }
  },
  required: ["events", "state_changes"]
};

function seedBlock(seed) {
  const characters = (seed.characters || []).map((character) => {
    const bits = [character.mental_state, character.physical_state, character.location]
      .filter(Boolean).join(" / ");
    return `- ${character.name}${character.role ? `(${character.role})` : ""}: ${bits || "상태 단서 없음"}`;
  }).join("\n") || "- (없음)";

  const events = (seed.recent_events || []).map((event) =>
    `- [${event.segment}] ${event.summary}`).join("\n") || "- (없음)";

  const locations = (seed.locations || []).map((location) => location.name).join(", ") || "(없음)";

  return `작품: ${seed.document?.title || "제목 미상"}
분기 시점: ${seed.fork_segment}번 단락 직후

이 시점까지 밝혀진 인물과 상태:
${characters}

이 시점까지 등장한 장소: ${locations}

직전 사건:
${events}`;
}

function premisePrompt({ seed, count }) {
  return `너는 한국어 소설의 특정 시점에서 "인물이 달리 행동했다면"을 제안하는 로컬 생성기다.
아래 정보는 그 시점까지 밝혀진 전부다. 이후 전개는 너에게 주어지지 않았고, 알고 있더라도 사용하면 안 된다.
작품의 결말이나 평론에서 얻은 지식을 쓰지 마라. JSON만 반환하라.

${seedBlock(seed)}

규칙:
- 위 인물 목록에 있는 인물만 actor로 쓴다.
- premise는 그 인물이 이 시점에서 실제로 선택할 수 있었던 다른 행동 한 가지다. 한 문장으로 쓴다.
- 원작에서 실제로 일어난 일을 그대로 적지 않는다. "달랐다면"에 해당해야 한다.
- 초자연적 개입, 시대에 맞지 않는 요소, 새로운 인물을 만들지 않는다.
- 서로 뚜렷하게 다른 대안 ${count}개를 낸다.`;
}

function branchPrompt({ seed, premise }) {
  const names = (seed.characters || []).map((character) => character.name).join(", ") || "(없음)";
  const places = (seed.locations || []).map((location) => location.name).join(", ") || "(없음)";

  return `너는 한국어 소설의 반사실 전개를 **구조화된 사건으로만** 쓰는 로컬 생성기다.
산문을 쓰지 말고 사건 프레임과 상태 변화만 JSON으로 반환하라.
아래 정보는 분기 시점까지 밝혀진 전부다. 이후 원작 전개는 주어지지 않았고, 알고 있더라도 사용하면 안 된다.

${seedBlock(seed)}

분기 전제: ${premise}

규칙:
- events: 이 전제 다음에 이어질 사건을 시간 순으로 3~6개 쓴다. 각 summary는 한 문장이다.
- characters에는 다음 이름만 쓴다: ${names}
- locations에는 다음 이름만 쓴다: ${places}
- 새 인물·새 장소를 만들지 않는다.
- state_changes: 사건으로 바뀐 인물의 심리·신체·위치만 적는다. after_event_order는 그 변화를 일으킨 사건의 순번(1부터)이다.
- 원작 문장을 인용하지 않는다. 원작에서 실제로 일어난 사건을 그대로 옮기지 않는다.
- 분기 시점의 상태·관계·위치와 모순되지 않게 쓴다.`;
}

/**
 * 분기 생성 실행.
 *
 * 반환: { ok: true, model, alternatives: [{ premise, payload }], diagnostics }
 * 실패는 ollama_client의 구조화 오류 계약을 그대로 전달한다.
 */
async function runWhatIf({ seed, premise = "", count = 2, model, client, numCtx = prompts.NUM_CTX } = {}) {
  if (!seed || !Number(seed.fork_segment)) {
    return { ok: false, error_code: "BAD_REQUEST", message: "분기 시점 seed가 필요합니다.", retryable: false };
  }
  const wanted = Math.max(1, Math.min(MAX_ALTERNATIVES, Number(count) || 1));
  const diagnostics = {
    prompt_version: WHATIF_PROMPT_VERSION,
    fork_segment: Number(seed.fork_segment),
    temperature: GENERATION_TEMPERATURE,
    calls: 0,
    failed: []
  };

  let premises = [];
  if (premise) {
    premises = [String(premise).slice(0, 200)];
  } else {
    const prompt = premisePrompt({ seed, count: wanted });
    if (!prompts.fitsBudget(prompt, numCtx)) {
      return { ok: false, error_code: "BUDGET_EXCEEDED", message: "분기 시드가 컨텍스트 예산을 넘었습니다.", retryable: false };
    }
    const result = await client.generateJson({
      model, prompt, format: PREMISE_SCHEMA, numCtx, temperature: GENERATION_TEMPERATURE
    });
    diagnostics.calls += 1;
    if (!result.ok) return { ...result, diagnostics };
    premises = (result.data?.alternatives || [])
      .map((item) => String(item?.premise || "").trim())
      .filter(Boolean)
      .slice(0, wanted);
    if (!premises.length) {
      return { ok: false, error_code: "EMPTY_RESULT", message: "대안 행동을 만들지 못했습니다.", retryable: true, diagnostics };
    }
  }

  const alternatives = [];
  for (const item of premises) {
    const prompt = branchPrompt({ seed, premise: item });
    if (!prompts.fitsBudget(prompt, numCtx)) {
      diagnostics.failed.push({ premise: item, error_code: "BUDGET_EXCEEDED" });
      continue;
    }
    let result = await client.generateJson({
      model, prompt, format: BRANCH_SCHEMA, numCtx, temperature: GENERATION_TEMPERATURE
    });
    diagnostics.calls += 1;
    if (!result.ok && result.error_code === "PARSE_FAILED") {
      result = await client.generateJson({
        model, prompt, format: BRANCH_SCHEMA, numCtx, temperature: GENERATION_TEMPERATURE
      });
      diagnostics.calls += 1;
    }
    if (!result.ok) {
      diagnostics.failed.push({ premise: item, error_code: result.error_code });
      continue;
    }
    alternatives.push({ premise: item, payload: result.data || {} });
  }

  if (!alternatives.length) {
    return {
      ok: false,
      error_code: "EMPTY_RESULT",
      message: "분기를 하나도 생성하지 못했습니다.",
      retryable: true,
      diagnostics
    };
  }

  return { ok: true, model, alternatives, diagnostics };
}

module.exports = {
  WHATIF_PROMPT_VERSION,
  GENERATION_TEMPERATURE,
  MAX_ALTERNATIVES,
  PREMISE_SCHEMA,
  BRANCH_SCHEMA,
  premisePrompt,
  branchPrompt,
  runWhatIf
};
