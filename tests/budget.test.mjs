import assert from "node:assert/strict";
import test from "node:test";

const { neuronsFor, neuronsForImage, estimateTokens, createBudget, NEURONS_PER_MTOK, NEURONS_PER_IMAGE, FREE_NEURONS_PER_DAY } =
  await import("../src/llm/budget.js");

test("neuronsFor: 스펙 3-3절 표준 시나리오와 같은 값을 낸다", () => {
  // 입력 3,650 / 출력 500 토큰 → 199.74 Neurons (스펙 3-3절)
  const n = neuronsFor({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    inputTokens: 3650,
    outputTokens: 500
  });
  assert.ok(Math.abs(n - 199.7407) < 0.001, `expected ~199.74, got ${n}`);

  // 무료 할당 10,000 Neurons ÷ 199.74 = 50턴
  assert.equal(Math.floor(FREE_NEURONS_PER_DAY / n), 50);
});

test("neuronsFor: 단가를 모르는 모델은 0이 아니라 null을 돌려준다", () => {
  // 모르는 모델의 비용을 0으로 보고하면 계량기가 조용히 거짓말을 한다.
  assert.equal(neuronsFor({ model: "@cf/unknown/model", inputTokens: 1000, outputTokens: 100 }), null);
});

test("neuronsFor: 8B는 70B 대비 35% 싸다 (스펙 3-3절 근거)", () => {
  const big = neuronsFor({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  const small = neuronsFor({ model: "@cf/meta/llama-3.1-8b-instruct", inputTokens: 3650, outputTokens: 500 });
  const saving = (big - small) / big;
  assert.ok(saving > 0.3 && saving < 0.4, `expected ~35% saving, got ${(saving * 100).toFixed(1)}%`);
});

test("estimateTokens: 한국어를 1.2자/토큰으로 어림한다", () => {
  assert.equal(estimateTokens("가나다라마바사아자차"), 9); // 10자 / 1.2 = 8.33 → 9
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
});

test("createBudget: 사용량을 누적하고 남은 양을 돌려준다", () => {
  const budget = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const first = budget.record({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    inputTokens: 3650,
    outputTokens: 500
  });
  assert.ok(Math.abs(first.neurons - 199.7407) < 0.001);
  assert.ok(Math.abs(first.used - 199.7407) < 0.001);
  assert.ok(Math.abs(first.remaining - (10000 - 199.7407)) < 0.001);
  assert.equal(first.day, "2026-09-05");

  budget.record({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  assert.ok(Math.abs(budget.snapshot().used - 399.4814) < 0.001);
});

test("createBudget: 날짜가 바뀌면 사용량이 0으로 돌아간다", () => {
  let clock = new Date("2026-09-05T23:59:00Z");
  const budget = createBudget({ now: () => clock });
  budget.record({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  assert.ok(budget.snapshot().used > 0);

  clock = new Date("2026-09-06T00:01:00Z");
  const rolled = budget.snapshot();
  assert.equal(rolled.used, 0);
  assert.equal(rolled.day, "2026-09-06");
  assert.equal(rolled.remaining, 10000);
});

test("createBudget: 단가를 모르는 모델은 사용량을 늘리지 않고 neurons=null을 보고한다", () => {
  const budget = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const result = budget.record({ model: "@cf/unknown/model", inputTokens: 1000, outputTokens: 100 });
  assert.equal(result.neurons, null);
  assert.equal(result.used, 0);
});

test("NEURONS_PER_MTOK: 문서에서 확인한 네 모델의 단가를 담는다", () => {
  assert.deepEqual(NEURONS_PER_MTOK["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], { input: 26668, output: 204805 });
  assert.deepEqual(NEURONS_PER_MTOK["@cf/meta/llama-3.1-8b-instruct"], { input: 25608, output: 75147 });
});

// --- 이미지 계량 (M1 step 3a: 장면 배경 이미지) ---

test("neuronsForImage: 스펙에 적힌 단가(타일당 4.80, 스텝당 9.60)로 계산한다", () => {
  const n = neuronsForImage({ model: "@cf/black-forest-labs/flux-1-schnell", tiles: 1, steps: 4 });
  assert.ok(Math.abs(n - (4.8 + 4 * 9.6)) < 0.0001);
});

test("neuronsForImage: 단가를 모르는 모델은 0이 아니라 null을 돌려준다", () => {
  assert.equal(neuronsForImage({ model: "@cf/unknown/image-model", tiles: 1, steps: 4 }), null);
});

test("NEURONS_PER_IMAGE: flux-1-schnell 단가를 담는다", () => {
  assert.deepEqual(NEURONS_PER_IMAGE["@cf/black-forest-labs/flux-1-schnell"], { tile: 4.8, step: 9.6 });
});

test("createBudget.recordImage: 이미지 비용을 텍스트 사용량과 같은 장부에 누적한다", () => {
  const budget = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const result = budget.recordImage({ model: "@cf/black-forest-labs/flux-1-schnell", tiles: 1, steps: 4 });
  assert.ok(Math.abs(result.neurons - 43.2) < 0.0001);
  assert.ok(Math.abs(result.used - 43.2) < 0.0001);

  budget.record({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", inputTokens: 3650, outputTokens: 500 });
  assert.ok(Math.abs(budget.snapshot().used - (43.2 + 199.7407)) < 0.001, "텍스트와 이미지 사용량이 한 장부에서 합산된다");
});

test("createBudget.recordImage: 단가를 모르는 모델은 사용량을 늘리지 않고 neurons=null이다", () => {
  const budget = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const result = budget.recordImage({ model: "@cf/unknown/image-model", tiles: 1, steps: 4 });
  assert.equal(result.neurons, null);
  assert.equal(result.used, 0);
});

test("CHARS_PER_TOKEN: llm/budget.js와 core/memory.js가 같은 값을 쓴다", async () => {
  // core/는 llm/을 import할 수 없어 이 상수는 두 곳에 독립적으로 정의돼 있다.
  // 어긋나면 서버가 쓰는 예산 어림값과 프롬프트가 쓰는 어림값이 갈라진다.
  const budgetModule = await import("../src/llm/budget.js");
  const memoryModule = await import("../src/core/memory.js");
  assert.equal(budgetModule.CHARS_PER_TOKEN, memoryModule.CHARS_PER_TOKEN);
});

// --- 이미지 모델 레지스트리 확장 (phoenix-1.0, lucid-origin) ---
//
// flux-1-schnell(4스텝 증류 — 속도를 사려고 프롬프트 순응도를 버림) 하나만
// 계량하던 표를, "프롬프트 순응도가 뛰어나다"고 Cloudflare가 명시한 두 모델로
// 넓힌다. src/llm/image.js 쪽 레지스트리와 이 표가 갈라지면 계량기가 실제
// 청구되는 값과 다른 숫자를 보여주므로, 아래에서 두 표를 교차 확인한다
// (CHARS_PER_TOKEN을 core/memory.js와 교차 확인하는 것과 같은 패턴).

test("NEURONS_PER_IMAGE: phoenix-1.0·lucid-origin 단가를 담는다", () => {
  assert.deepEqual(NEURONS_PER_IMAGE["@cf/leonardo/phoenix-1.0"], { tile: 530, step: 10 });
  assert.deepEqual(NEURONS_PER_IMAGE["@cf/leonardo/lucid-origin"], { tile: 636, step: 12 });
});

test("neuronsForImage: phoenix-1.0 512×512(타일 1장) 한 장은 스텝 20 기준 730 Neurons이다", () => {
  const n = neuronsForImage({ model: "@cf/leonardo/phoenix-1.0", tiles: 1, steps: 20 });
  assert.ok(Math.abs(n - 730) < 0.0001);
});

test("neuronsForImage: phoenix-1.0은 flux-1-schnell보다 한 자릿수 넘게 비싸다(내용 충실도의 대가)", () => {
  const flux = neuronsForImage({ model: "@cf/black-forest-labs/flux-1-schnell", tiles: 1, steps: 4 });
  const phoenix = neuronsForImage({ model: "@cf/leonardo/phoenix-1.0", tiles: 1, steps: 20 });
  assert.ok(phoenix / flux > 10, `phoenix가 flux보다 10배 넘게 비싸야 한다 (실제 ${(phoenix / flux).toFixed(1)}배)`);
});

test("NEURONS_PER_IMAGE: flux-2-klein-4b는 없다(스키마를 확인하지 못해 레지스트리에도 없다) — 0이 아니라 null", () => {
  assert.equal(neuronsForImage({ model: "@cf/black-forest-labs/flux-2-klein-4b", tiles: 1, steps: 1 }), null);
});

test("NEURONS_PER_IMAGE: src/llm/image.js의 IMAGE_MODELS 레지스트리와 단가가 정확히 일치한다", async () => {
  // 이 파일은 llm/budget.js를 llm/image.js와 별도로 import해 표를 두 벌 유지한다
  // (budget.js는 "도메인을 모른다"는 자기 설명을 지키려고 image.js를 require하지
  // 않는다). 그래서 값이 갈라지지 않는지는 여기서 코드로 확인한다 — 사람이
  // 두 파일을 눈으로 맞춰 보는 것에 기대지 않는다.
  const { IMAGE_MODELS } = await import("../src/llm/image.js");
  for (const [model, rate] of Object.entries(NEURONS_PER_IMAGE)) {
    assert.ok(IMAGE_MODELS[model], `budget.js에는 있는데 image.js 레지스트리에는 없는 모델: ${model}`);
    assert.deepEqual(IMAGE_MODELS[model].rates, rate, `${model}의 단가가 image.js와 budget.js에서 다르다`);
  }
  for (const model of Object.keys(IMAGE_MODELS)) {
    assert.ok(NEURONS_PER_IMAGE[model], `image.js 레지스트리에는 있는데 budget.js에는 없어 계량이 null이 되는 모델: ${model}`);
  }
});
