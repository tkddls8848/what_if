"use strict";

/**
 * 턴 오케스트레이터.
 *
 * 한 턴은 두 호출이다 — ①서술 생성(Cloudflare, 스트리밍)과 ②판정(로컬 Ollama, 구조화
 * 출력). ①이 끝나 스트림이 화면에 다 보인 "다음에" ②를 돈다 — 판정이 독자가 글을
 * 보는 속도를 늦추면 안 되기 때문이다(비용 계량이 스트림 이후에 도는 것과 같은
 * 자리). ②는 judgeClient가 주어졌을 때만 돈다: 옛 호출부(judgeClient 없이 부르는
 * 테스트/서버 경로)는 지금까지와 똑같이 동작해야 한다.
 *
 * 흐름: 조립(core/memory) → 서술 호출(llm/cloudflare) → 가르기(core/narration) →
 * 계량(llm/budget) → 판정(server/judge, judgeClient가 있을 때만) → 반영(core/sim).
 * 이 파일은 순서만 안다 — 점수를 매기는 규칙도, 프롬프트 문구도 여기 없다.
 *
 * src/server/는 CommonJS, src/core/는 ESM이라 await import()로 접근한다
 * (선례: src/server/wikisource.js). judge.js는 같은 CommonJS라 require로 바로 접근한다.
 */

const { estimateTokens, DEFAULT_NARRATION_MODEL } = require("../llm/budget");
const judge = require("./judge");

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * 판정 단계. judgeClient가 없으면(기능을 아직 안 쓰는 호출부) 아무 일도 하지
 * 않고 원래 state를 그대로 돌려준다 — "판정을 시도했지만 실패했다"와 "애초에
 * 판정을 요청하지 않았다"는 다르다. 후자는 judge_unavailable이 아니다.
 *
 * cards가 여럿이면(현재 콘텐츠는 카드가 하나뿐이지만) 카드마다 attraction/dislike는
 * 따로 판정하되, relief/strain(주인공의 회복 — 카드별이 아니라 턴 전체에 하나뿐인
 * 전역 축)은 모든 카드 호출에서 나온 이름을 합쳐(중복 제거) 마지막 한 번만
 * 반영한다. 카드마다 반영하면 같은 턴의 회복 변화가 카드 수만큼 중복 집계된다.
 *
 * 카드 중 하나라도 판정 호출 자체가 실패하면(Ollama가 죽어 있다 등) 이번 턴
 * 전체를 판정 불가로 본다 — 일부만 반영하면 "이 카드는 판정했는데 저 카드는
 * 안 했다"는 절반의 상태가 되고, 그건 "모른다"보다 나쁘다(스펙: 모르는 값은
 * 0이 아니라 null로 — budget.js의 원칙과 같다).
 */
async function runJudgment({ cards, protagonist, userInput, narration, simState, judgeClient, judgeModel }) {
  if (!judgeClient) return { simState, judge_unavailable: false, last_change: null };

  const sim = await import("../core/sim.js");
  const perCard = [];
  const reliefNames = new Set();
  const strainNames = new Set();

  for (const card of cards) {
    const verdict = await judge.judgeTurn({
      card, protagonist, userInput, narration, client: judgeClient, model: judgeModel
    });
    if (!verdict.ok) {
      return { simState, judge_unavailable: true, last_change: null };
    }
    perCard.push({ card, verdict });
    for (const name of verdict.relief) reliefNames.add(name);
    for (const name of verdict.strain) strainNames.add(name);
  }

  if (perCard.length === 0) return { simState, judge_unavailable: false, last_change: null };

  let state = simState;
  let lastChange = null;
  perCard.forEach(({ card, verdict }, i) => {
    const isLast = i === perCard.length - 1;
    state = sim.applyJudgment(state, {
      card_id: card.card_id,
      attraction: verdict.attraction,
      dislike: verdict.dislike,
      relief: isLast ? [...reliefNames] : [],
      strain: isLast ? [...strainNames] : [],
      card,
      protagonist
    });
    lastChange = state.last_change;
  });

  return { simState: state, judge_unavailable: false, last_change: lastChange };
}

async function runTurn({
  world,
  cards = [],
  session,
  userInput,
  client,
  model = DEFAULT_NARRATION_MODEL,
  budget,
  onNarration,
  signal,
  judgeClient,
  judgeModel
} = {}) {
  const input = String(userInput || "").trim();
  if (!input) return errorResult("INVALID_ARGUMENT", "행동을 입력하세요.", false);
  // budget이 없으면 조용히 새 장부를 만들지 않는다. server.js는 항상 프로세스 전역
  // turnBudget을 넘기지만, 앞으로 생길 다른 호출부가 이 인자를 깜빡하면 매 턴 새
  // 장부가 생겨 미터가 영원히 0으로 보인다 — budget.js가 막으려던 바로 그 거짓말이다.
  if (!budget) return errorResult("INVALID_ARGUMENT", "budget(장부)이 필요합니다.", false);

  const memory = await import("../core/memory.js");
  const narration = await import("../core/narration.js");
  const sessionApi = await import("../core/session.js");

  const { messages, estimatedInputTokens } = memory.buildMessages({
    world, cards, session, userInput: input, simState: session?.sim
  });
  const splitter = narration.createNarrationSplitter();
  const ledger = budget;

  const generated = await client.narrate({
    model,
    messages,
    maxTokens: session?.settings?.max_tokens,
    onToken(piece) {
      const delta = splitter.push(piece);
      // onNarration이 던지면 스트림 전체가 죽는다. 화면 하나 때문에 턴을 잃지 않는다.
      if (delta && onNarration) {
        try { onNarration(delta); } catch (_error) { /* 무시 */ }
      }
    },
    signal
  });

  if (!generated.ok) return generated;

  const { delta } = splitter.finish();
  if (delta && onNarration) {
    try { onNarration(delta); } catch (_error) { /* 무시 */ }
  }

  const parsed = narration.parseNarration(generated.text);
  // 장면이 안 바뀌었으면 null이다(narration.parseScene 참고) — 이 값 자체가 "이미지를
  // 다시 그려야 하는가"의 신호다. 이 파일은 신호를 집어 나를 뿐, 프롬프트를 만들거나
  // 해시를 계산하지 않는다(그건 src/server/scene.js의 몫이고 server.js가 부른다).
  const scene = narration.parseScene(generated.text);

  // usage가 없다고 0으로 집계하면 계량기가 조용히 거짓말을 한다. 어림값이라고 표시하고 센다.
  const estimated = !generated.usage;
  const inputTokens = generated.usage ? generated.usage.prompt_tokens : estimatedInputTokens;
  const outputTokens = generated.usage ? generated.usage.completion_tokens : estimateTokens(generated.text);
  const recorded = ledger.record({ model, inputTokens, outputTokens });

  const turn = sessionApi.makeTurn({
    index: sessionApi.nextTurnIndex(session),
    session_id: session?.session_id,
    user_input: input,
    narration: parsed.narration,
    choices: parsed.choices,
    model,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      neurons: recorded.neurons,
      estimated
    }
  });

  // 판정은 서술이 화면에 완전히 다 흐른 "다음"이다 — onToken 콜백은 이미 전부
  // 끝났고, 여기서부터는 독자가 기다리는 스트림이 아니라 응답을 마무리하는
  // 회계(비용 계량과 같은 자리)다. judgeClient가 없으면 즉시 원래 state를 그대로
  // 돌려준다(위 runJudgment 참고) — 이 경로는 옛 호출부와 동작이 같다.
  const priorSim = session?.sim || null;
  const { simState, judge_unavailable, last_change } = await runJudgment({
    cards,
    protagonist: world?.protagonist,
    userInput: input,
    narration: parsed.narration,
    simState: priorSim,
    judgeClient,
    judgeModel
  });

  // scene이 null이면(장면이 안 바뀌었으면) 세션이 이미 갖고 있던 current_scene을
  // 그대로 들고 간다 — 매 턴 <장면> 블록이 나오는 게 아니므로, null을 그대로
  // 덮어쓰면 다음 턴의 [현재 상태]가 "아직 정해지지 않음"으로 되돌아가 rule 2가
  // 다시 매 턴 장면 블록을 강제하게 된다.
  const nextSession = {
    ...sessionApi.appendTurn(session, turn),
    sim: simState,
    current_scene: scene || session?.current_scene || null
  };

  return {
    ok: true,
    turn,
    session: nextSession,
    budget: recorded,
    // recorded.neurons가 null이면 단가를 몰라 계량하지 못했다는 뜻이다(budget.js 참고).
    // 이걸 호출부가 놓치면 미터는 그대로인데 Cloudflare는 실제로 과금한다 — 무료 턴처럼 보이는 유료 턴.
    budget_unknown: recorded.neurons === null,
    truncated: Boolean(generated.truncated),
    // 판정 결과 — step 3의 UI가 "왜" 게이지가 움직였는지 보여줄 수 있도록 그대로 얹는다.
    sim: simState,
    last_change,
    // 판정 호출 자체가 실패했을 때만 true다(스펙: 모르는 값은 0이 아니라 이렇게
    // "모른다"고 알린다 — budget.js의 budget_unknown과 같은 원칙). judgeClient를
    // 아예 안 줬을 때는 false다 — 시도조차 안 한 것과 실패한 것은 다르다.
    judge_unavailable,
    // 장면이 안 바뀐 턴에는 null이다. server.js는 이 값이 있을 때만(그리고 서술
    // 스트림이 다 끝난 다음에) src/server/scene.js를 불러 이미지를 만든다.
    scene
  };
}

module.exports = { runTurn };
