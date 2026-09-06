"use strict";

/**
 * Cloudflare Workers AI 비용 계량.
 *
 * 단가는 developers.cloudflare.com/workers-ai/platform/pricing/ 에서 확인한 값이며
 * 100만 토큰당Neurons다. 무료 할당은 하루 10,000 Neurons, 초과분은 1,000 Neurons당
 * $0.011다.
 *
 * 모르는 모델의 비용을 0으로 보고하지 않는다 — 계량기가 조용히 거짓말을 하면
 * 예산 표시 전체가 무의미해진다. 단가가 없으면 null을 돌려주고 호출부가 판단한다.
 */

const NEURONS_PER_MTOK = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26668, output: 204805 },
  "@cf/meta/llama-3.1-8b-instruct": { input: 25608, output: 75147 },
  "@cf/google/gemma-3-12b-it": { input: 31371, output: 50560 },
  "@cf/mistralai/mistral-7b-instruct-v0.1": { input: 10000, output: 17300 }
};

/**
 * 이미지 모델은 토큰이 아니라 타일(512×512)과 스텝으로 값이 매겨진다 — 텍스트
 * 모델과 단위가 달라 NEURONS_PER_MTOK와 같은 표에 못 담는다. developers.cloudflare.com
 * 단가표 기준.
 *
 * flux-1-schnell 외 두 모델(phoenix-1.0, lucid-origin)을 추가한 이유는
 * src/llm/image.js 상단 설명 참고 — 4스텝 증류 모델(flux)은 속도를 사려고
 * 프롬프트 순응도를 버리는데, 플레이어가 요구한 건 정확히 그 순응도였다.
 * 이 표의 값은 src/llm/image.js의 IMAGE_MODELS 레지스트리에 있는 같은 모델의
 * rates와 반드시 같아야 한다 — 두 표가 갈라지면 계량기가 실제로 청구되는
 * 값과 다른 숫자를 보여준다. tests/budget.test.mjs가 image.js를 함께 import해서
 * 세 모델 모두 이 표와 일치하는지 확인한다(CHARS_PER_TOKEN을 core/memory.js와
 * 교차 확인하는 것과 같은 패턴).
 *
 * flux-2-klein-4b(출력 타일당 26.05 Neurons)는 넣지 않는다 — 요청/응답 스키마를
 * 확인하지 못해 src/llm/image.js 레지스트리에도 없다. 스키마 없이 단가만 넣으면
 * 실제로는 호출할 수 없는 모델의 가격표만 늘어난다.
 */
const NEURONS_PER_IMAGE = {
  "@cf/black-forest-labs/flux-1-schnell": { tile: 4.8, step: 9.6 },
  "@cf/leonardo/phoenix-1.0": { tile: 530, step: 10 },
  "@cf/leonardo/lucid-origin": { tile: 636, step: 12 }
};

const FREE_NEURONS_PER_DAY = 10000;
const DEFAULT_NARRATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * 한국어 기준 어림값. 실제 usage가 오면 그것으로 대체된다(스펙 12절 5번).
 * src/core/memory.js도 같은 값을 독립적으로 정의한다(core는 llm을 참조하지 않으므로).
 * 두 값이 어긋나지 않는지는 tests/budget.test.mjs가 두 모듈을 함께 import해서 확인한다.
 * 그 테스트를 위해서만 export한다.
 */
const CHARS_PER_TOKEN = 1.2;

function neuronsFor({ model, inputTokens = 0, outputTokens = 0 } = {}) {
  const rate = NEURONS_PER_MTOK[model];
  if (!rate) return null;
  return (Number(inputTokens) * rate.input + Number(outputTokens) * rate.output) / 1e6;
}

/**
 * 이미지 생성 비용. neuronsFor와 이름을 나란히 두되 단위(타일·스텝)가 달라 별도
 * 함수다 — 하나로 합치면 토큰 인자에 타일·스텝을 욱여넣는 모양이 되어 호출부가
 * 헷갈린다. 단가를 모르는 모델은 여기서도 0이 아니라 null이다.
 */
function neuronsForImage({ model, tiles = 0, steps = 0 } = {}) {
  const rate = NEURONS_PER_IMAGE[model];
  if (!rate) return null;
  return Number(tiles) * rate.tile + Number(steps) * rate.step;
}

function estimateTokens(text) {
  const chars = String(text || "").length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 하루 단위 장부. Cloudflare의 무료 할당이 하루마다 초기화되므로 UTC 날짜가 바뀌면
 * 사용량을 0으로 되돌린다. 프로세스가 재시작되면 장부도 사라진다 — M1에서는
 * 영속화하지 않는다(M4에서 세션 저장과 함께 파일로 옮긴다).
 */
function createBudget({ freePerDay = FREE_NEURONS_PER_DAY, now = () => new Date() } = {}) {
  let day = null;
  let used = 0;

  function roll() {
    const today = now().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
  }

  function state() {
    return { day, used, remaining: freePerDay - used, free_per_day: freePerDay };
  }

  return {
    record({ model, inputTokens = 0, outputTokens = 0 } = {}) {
      roll();
      const neurons = neuronsFor({ model, inputTokens, outputTokens });
      if (neurons === null) return { neurons: null, ...state() };
      used += neurons;
      return { neurons, ...state() };
    },
    /**
     * 이미지 한 장을 장부에 반영한다. record()는 토큰 모양 인자를 받으므로 타일·
     * 스텝을 그 자리에 억지로 끼워 넣지 않고 별도 경로를 둔다.
     */
    recordImage({ model, tiles = 0, steps = 0 } = {}) {
      roll();
      const neurons = neuronsForImage({ model, tiles, steps });
      if (neurons === null) return { neurons: null, ...state() };
      used += neurons;
      return { neurons, ...state() };
    },
    snapshot() {
      roll();
      return state();
    }
  };
}

module.exports = {
  NEURONS_PER_MTOK,
  NEURONS_PER_IMAGE,
  FREE_NEURONS_PER_DAY,
  DEFAULT_NARRATION_MODEL,
  CHARS_PER_TOKEN,
  neuronsFor,
  neuronsForImage,
  estimateTokens,
  createBudget
};
