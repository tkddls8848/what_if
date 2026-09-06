import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * 회귀 가드: 로컬 Neuron 장부는 이 프로세스가 오늘 얼마나 썼는지에 대한
 * "어림값"일 뿐이다 — 다른 기기, 같은 계정의 다른 애플리케이션, 과금 없이
 * 실패한 요청은 이 숫자에 전혀 보이지 않는다. 그래서 이 숫자는 절대로
 * "모델을 불러도 되는가"를 판정하는 근거가 될 수 없다. 사용자가 Cloudflare
 * 429를 겪고 "우리 카운터가 자기를 막았다"고 합리적으로 의심했던 사건이
 * 있었다 — 실제로는 아니었지만, 이 파일이 없으면 다음 사람이 선의로 "한도
 * 넘으면 호출하지 말자" 체크를 넣어도 아무 테스트도 못 잡는다.
 *
 * 이 파일에 넣은 이유: budget.js 자체의 표면(1, 2)과 그 표면을 실제로 쓰는
 * 두 얇은 오케스트레이션 경로(3: runTurn, 4: HTTP)를 한 파일에 모아, "장부는
 * 절대 문지기가 아니다"라는 하나의 요구사항을 한 곳에서 끝까지 추적한다.
 * tests/budget.test.mjs는 장부 자체의 계산(단가·누적·롤오버)을 다루는 파일이라
 * 성격이 다르다.
 */

const budgetModule = await import("../src/llm/budget.js");
const { createBudget, FREE_NEURONS_PER_DAY } = budgetModule;
const { runTurn } = await import("../src/server/turn.js");
const { normalizeWorld, normalizeCard } = await import("../src/core/card.js");
const { createSession } = await import("../src/core/session.js");

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const world = normalizeWorld({ world_id: "demo", title: "야간 자율학습", setting: "밤의 학교", tone: "건조하다" });
const cards = [normalizeCard({ card_id: "seorin", world_id: "demo", canonical_name: "한서린" })];

const FULL = [
  "복도 끝에서 발소리가 멈췄다.",
  "",
  "<선택지>",
  "1. 아무 말 없이 옆에 선다",
  "2. \"혼자 두면 또 무리할 거잖아\"",
  "3. 돌아서서 그대로 나간다"
].join("\n");

/** tests/turn.test.mjs의 fakeClient와 같은 모양. FULL을 한 조각으로 흘려보낸다. */
function fakeClient({ usage = { prompt_tokens: 3650, completion_tokens: 500, total_tokens: 4150 } } = {}) {
  return {
    async narrate({ onToken }) {
      if (onToken) onToken(FULL);
      return { ok: true, text: FULL, usage };
    }
  };
}

function budgetAt(iso) {
  return createBudget({ now: () => new Date(iso) });
}

/** 반복 record()로 장부를 FREE_NEURONS_PER_DAY 너머로 밀어붙인다. */
function overspend(ledger, times = 60) {
  let last;
  for (let i = 0; i < times; i++) {
    last = ledger.record({ model: MODEL, inputTokens: 3650, outputTokens: 500 });
  }
  return last;
}

// --- 1. budget.js는 문지기 함수를 내보내지 않는다 ---

const KNOWN_EXPORTS = [
  "NEURONS_PER_MTOK",
  "NEURONS_PER_IMAGE",
  "FREE_NEURONS_PER_DAY",
  "DEFAULT_NARRATION_MODEL",
  "CHARS_PER_TOKEN",
  "neuronsFor",
  "neuronsForImage",
  "estimateTokens",
  "createBudget"
];

test("budget.js: export 목록이 요율표·기록·추정 아홉 개로 닫혀 있다", () => {
  // 이 장부는 이 세션의 추정치다 — 계정의 진짜 잔액이 아니다. export 목록이
  // 이 아홉 개를 벗어나 하나라도 늘어나면(이름이 무엇이든) 이 테스트가 즉시
  // 걸린다. "판정 함수만 이름으로 걸러낸다"가 아니라 표면 자체를 닫아 두는
  // 이유는, 판정 함수는 canSpend 같은 뻔한 이름 대신 얼마든지 다른 이름
  // (예: shouldContinue, gate, throttle)으로 숨어들 수 있기 때문이다.
  // CJS를 await import()로 읽으면 네임스페이스 객체에 named export 외에도
  // 합성된 default/module.exports 키가 따라붙는다(cjs-module-lexer 상호운용).
  // 실제 module.exports 객체(=default)의 키만 봐야 진짜 표면을 보는 것이다.
  const actual = Object.keys(budgetModule.default).sort();
  assert.deepEqual(actual, [...KNOWN_EXPORTS].sort(),
    "budget.js의 export 목록이 바뀌었다. 새 export가 '호출해도 되는가'를 답하는 함수라면 절대 추가하면 안 된다.");
});

test("budget.js: 새로 추가되는 어떤 export도 boolean을 돌려주는 함수이면 잡아낸다", () => {
  // 이름 목록(canSpend/isExhausted/...)을 블랙리스트로 대는 대신, 실제로 함수를
  // 호출해 반환 타입을 본다 — 다음 사람이 전혀 다른 이름으로 문지기 함수를
  // 만들어도(예: gate(), throttleOk(), withinLimit()) 이 테스트는 이름을 몰라도 잡는다.
  const predicateNamePattern = /^(can|is|has|check|should|may|allow|block|deny|reject|gate|throttle|within|exceed)/i;
  const harmlessArgSets = [
    [],
    [undefined],
    [{}],
    [0],
    [FREE_NEURONS_PER_DAY + 1],
    [{ used: FREE_NEURONS_PER_DAY + 1, freePerDay: FREE_NEURONS_PER_DAY }],
    [{ model: MODEL, inputTokens: 1, outputTokens: 1 }]
  ];

  for (const [name, value] of Object.entries(budgetModule.default)) {
    if (typeof value !== "function") continue;

    assert.ok(!predicateNamePattern.test(name),
      `${name}이라는 이름 자체가 판정 함수처럼 보인다 — budget.js는 "써도 되는가"를 판정하지 않는다.`);

    for (const args of harmlessArgSets) {
      let result;
      try {
        result = value(...args);
      } catch {
        continue; // 이 인자 조합으로는 호출이 안 됐다 — 다른 조합으로 계속 확인.
      }
      assert.notEqual(typeof result, "boolean",
        `${name}(${JSON.stringify(args)}) 호출이 boolean(${result})을 돌려준다 — budget.js가 지출 가부를 스스로 판정하는 함수를 내보내면 안 된다.`);
    }
  }
});

test("budget.js: createBudget()이 돌려주는 장부 객체에도 판정 함수가 없다", () => {
  // record/recordImage/snapshot 세 메서드만 있어야 한다 — 이 중 하나가
  // "지금 써도 되는지"를 boolean으로 답하기 시작하면 그게 바로 우리가 막으려는
  // 문지기다.
  const predicateNamePattern = /^(can|is|has|check|should|may|allow|block|deny|reject|gate|throttle|within|exceed)/i;
  const ledger = createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
  const harmlessArgSets = [[], [undefined], [{}], [{ model: MODEL, inputTokens: 1, outputTokens: 1 }]];

  for (const [name, value] of Object.entries(ledger)) {
    if (typeof value !== "function") continue;
    assert.ok(!predicateNamePattern.test(name),
      `장부 메서드 ${name}이 판정 함수 이름처럼 보인다.`);
    for (const args of harmlessArgSets) {
      let result;
      try {
        result = value(...args);
      } catch {
        continue;
      }
      assert.notEqual(typeof result, "boolean",
        `장부.${name}(${JSON.stringify(args)})가 boolean(${result})을 돌려준다 — 장부 객체는 판정하지 않는다.`);
    }
  }
});

// --- 2. record()는 한도를 넘어도 정직하게 계속 기록할 뿐 아무것도 막지 않는다 ---

test("createBudget.record: 10,000 Neurons를 넘겨도 계속 기록하고, remaining은 음수로 정직하게 내려간다", () => {
  // 한도를 넘었다고 기록을 멈추거나 remaining을 0에서 바닥 찍으면, 그 순간부터
  // 화면의 숫자가 거짓말을 시작한다("이 세션 추정치"가 아니라 "가짜 진실"이
  // 된다). 오히려 한도를 넘었다는 사실이 음수로 정확히 드러나야 한다 — 그래야
  // 사용자가 "우리 카운터 탓에 막혔나?"를 스스로 판단할 수 있다.
  const ledger = budgetAt("2026-09-05T10:00:00Z");
  const last = overspend(ledger, 60); // 60 * 199.7407 ≈ 11,984.4 Neurons
  assert.ok(last.used > FREE_NEURONS_PER_DAY, `장부가 10,000을 넘겨 쌓여야 한다 (실제 ${last.used})`);
  assert.ok(last.remaining < 0, `한도를 넘으면 remaining은 음수여야 한다 (실제 ${last.remaining})`);
  assert.ok(Math.abs(last.remaining - (FREE_NEURONS_PER_DAY - last.used)) < 0.001,
    "remaining은 여전히 free_per_day - used를 그대로 보고한다(바닥을 찍지 않는다)");

  // 한도를 넘은 뒤에도 record()는 계속 받아준다 — 거부도, throw도 없다.
  assert.doesNotThrow(() => ledger.record({ model: MODEL, inputTokens: 3650, outputTokens: 500 }));
  const state = ledger.snapshot();
  assert.ok(state.used > last.used, "한도를 넘었어도 다음 record()가 계속 누적한다");
  assert.ok(state.remaining < last.remaining, "한도를 넘은 뒤에도 remaining은 계속 더 음수 쪽으로 움직인다");
});

// --- 3. 장부가 이미 한도를 넘어도 runTurn은 모델을 부르고 성공한다 ---

test("runTurn: 장부가 이미 10,000 Neurons를 넘겨도 모델을 부르고 ok:true로 서술을 돌려준다", async () => {
  // 이게 이 파일 전체의 핵심 주장이다. 이 장부는 이 프로세스의 추정치일
  // 뿐이므로, 넘었다고 호출을 막으면 계정에 실제로 여유가 있어도(다른 기기가
  // 오늘 하나도 안 썼을 수도 있다) 이유도 모른 채 플레이가 멈춘다 — 사용자가
  // 실제로 겪었던 429 오인 소동이 정확히 이 형태였다.
  const ledger = budgetAt("2026-09-05T10:00:00Z");
  overspend(ledger, 60);
  assert.ok(ledger.snapshot().remaining < 0, "선행 조건: 장부가 이미 한도를 넘어야 한다");

  const result = await runTurn({
    world, cards, session: createSession({ world_id: "demo" }), userInput: "옆에 선다",
    client: fakeClient(), model: MODEL, budget: ledger
  });

  assert.equal(result.ok, true, "장부가 한도를 넘었어도 턴은 성공해야 한다 — 모델이 실제로 불렸다");
  assert.equal(result.turn.narration, "복도 끝에서 발소리가 멈췄다.", "narration이 실제로 왔다(모델 호출이 스킵되지 않았다)");
  assert.ok(ledger.snapshot().used > 0, "이번 호출도 장부에 정직하게 더해진다(막지 않았을 뿐 계량은 계속한다)");
});

// --- 4. HTTP 경로: 장부가 넘쳐도 POST /api/turn은 200이다 ---

process.env.NOVEL_IF_CACHE = "0";
process.env.CF_ACCOUNT_ID = "acc-test";
process.env.CF_API_TOKEN = "tok-secret";
process.env.IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
// tests/turn_api.test.mjs와 같은 이유: 진짜 Ollama가 떠 있으면 판정 경로가
// 테스트를 느리고 머신 의존적으로 만든다. 이 파일은 판정을 다루지 않는다.
process.env.OLLAMA_URL = "http://127.0.0.1:1";
const SCENE_ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-budget-gate-scene-root-"));
process.env.SCENE_ROOT = SCENE_ROOT_DIR;
after(() => {
  delete process.env.SCENE_ROOT;
  fs.rmSync(SCENE_ROOT_DIR, { recursive: true, force: true });
});

const serverModule = await import("../server.js");
const { app } = serverModule.default || serverModule;

/** narration 한 조각과, usage로 지정한 만큼의 사용량을 보고하는 가짜 Cloudflare SSE 응답. */
function sseBody({ narration = "복도 끝에서 발소리가 멈췄다.", usage } = {}) {
  const lines = [
    `data: ${JSON.stringify({ response: `${narration}\n\n<선택지>\n1. 가\n2. 나\n3. 다` })}\n\n`
  ];
  if (usage) lines.push(`data: ${JSON.stringify({ response: "", usage })}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

function startFakeCloudflare(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/turn: 프로세스 장부가 10,000 Neurons를 넘긴 뒤에도 다음 턴은 200으로 성공한다", async () => {
  // server.js의 turnBudget은 프로세스 수명 동안 유지되는 하나뿐인 장부다(모듈
  // 비공개라 테스트에서 직접 손댈 수 없다). 그래서 첫 턴에서 아주 큰 usage를
  // 보고하는 가짜 응답으로 실제로 한도를 넘겨 쌓은 뒤, 그다음 턴이 여전히
  // 200으로 성공하는지를 본다 — remaining의 부호 자체는 여기서 확인하지 않는다
  // (그건 위의 budget.js 단위 테스트 몫이다). 여기서 확인할 것은 딱 하나,
  // 요청이 실제로 끝까지 갔다는 것뿐이다.
  const fake = await startFakeCloudflare((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    // completion_tokens를 크게 잡아 한 턴만으로 10,000 Neurons를 훌쩍 넘긴다
    // (204805 Neurons / 1e6 per output token * 60000 ≈ 12,288 Neurons).
    res.end(sseBody({ usage: { prompt_tokens: 100, completion_tokens: 60000, total_tokens: 60100 } }));
  });
  process.env.CF_API_BASE = fake.url;
  const { server, port } = await listen();
  try {
    const spend = await post(port, {
      session: { session_id: "s-budget-gate-1", world_id: "demo" },
      user_input: "옆에 선다"
    });
    assert.equal(spend.status, 200, "장부를 넘기려는 첫 요청부터 실패하면 이 테스트는 아무것도 증명하지 못한다");

    const health = await fetch(`http://127.0.0.1:${port}/api/cf/health`);
    const healthBody = await health.json();
    assert.ok(healthBody.budget.remaining < 0, "선행 조건: 프로세스 장부가 실제로 한도를 넘겨야 한다");

    const next = await post(port, {
      session: { session_id: "s-budget-gate-2", world_id: "demo" },
      user_input: "다시 한번"
    });
    assert.equal(next.status, 200, "장부가 한도를 넘긴 뒤에도 다음 턴은 여전히 200으로 모델을 불러야 한다");
    const nextBody = await next.json();
    assert.equal(nextBody.turn.narration, "복도 끝에서 발소리가 멈췄다.", "모델이 실제로 불려 서술이 왔다");
  } finally {
    server.close();
    fake.server.close();
    delete process.env.CF_API_BASE;
  }
});
