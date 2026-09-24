"use strict";

/**
 * 턴 오케스트레이터.
 *
 * 한 턴은 세 호출이다 — ①서술 생성(Cloudflare→Gemini 폴백 체인, 스트리밍),
 * ②판정(로컬 Ollama, 구조화 출력), ③장면 판정(Jev, 닫힌 선택지). ①이 끝나
 * 스트림이 화면에 다 보인 "다음에" ②와 ③을 돈다 — 둘 다 독자가 글을 보는 속도를
 * 늦추면 안 되기 때문이다(비용 계량이 스트림 이후에 도는 것과 같은 자리).
 * ②는 judgeClient가, ③은 directorClient가 주어졌을 때만 돈다: 그 인자 없이 부르는
 * 옛 호출부(테스트/서버 경로)는 지금까지와 똑같이 동작해야 한다.
 *
 * ②와 ③은 같은 이유로 서술자와 분리돼 있다 — 서술자에게 채점 기준(트리거 목록)이나
 * 무대 목록(장소 id)을 보여주면 이야기가 그 목록에 맞춰진다(judge.js 머리주석).
 *
 * 흐름: 조립(core/memory) → 서술 호출(llm/cloudflare) → 가르기(core/narration) →
 * 계량(llm/budget) → 판정(server/judge) → 반영(core/sim) → 장면 판정(server/director).
 * 이 파일은 순서만 안다 — 점수를 매기는 규칙도, 프롬프트 문구도 여기 없다.
 *
 * src/server/는 CommonJS, src/core/는 ESM이라 await import()로 접근한다
 * (선례: src/server/wikisource.js). judge.js/director.js는 같은 CommonJS라 require로
 * 바로 접근한다.
 */

const { estimateTokens, DEFAULT_NARRATION_MODEL } = require("../llm/budget");
const judge = require("./judge");
const director = require("./director");

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

/**
 * 장면 판정 단계. directorClient가 없으면(기능을 아직 안 쓰는 호출부) 아무 일도
 * 하지 않고 직전 장면을 그대로 돌려준다 — judgeClient와 같은 관용이다.
 * "판정을 시도했지만 실패했다"와 "애초에 판정을 요청하지 않았다"는 다르므로,
 * 후자는 scene_unavailable이 아니다.
 *
 * 실패했을 때 **턴은 성공시킨다.** 배경 그림 하나 때문에 턴을 잃지 않는다는 것이
 * 지금 계약이고(README: "장면 배경 이미지는 실패해도 턴은 성공한 채 끝난다"),
 * 별도 폴백 모델은 두지 않는다 — 두면 AGENTS.md의 "parallel old/new execution
 * paths 금지"에 정면으로 걸리고, 배경 그림 하나 때문에 유지할 만한 복잡도가 아니다.
 *
 * 대신 모르는 것을 "없음"으로 적지 않는다 — scene_unavailable: true로 알린다
 * (judge_unavailable과 같은 원칙).
 */
async function runDirection({ world, previousScene, narration, directorClient, confidenceThreshold, signal }) {
  if (!directorClient) {
    return { scene: previousScene || null, changed: false, scene_unavailable: false, low_confidence: false, answers: null };
  }

  const directed = await director.directScene({
    world,
    previousScene,
    narration,
    client: directorClient,
    threshold: confidenceThreshold,
    signal
  });

  if (!directed.ok) {
    // 장면을 유지한다. 직전 장면이 있으면 화면은 그대로고, 없으면 배경이 없는
    // 채로 턴이 끝난다 — 둘 다 턴 자체는 성공이다.
    return {
      scene: previousScene || null,
      changed: false,
      scene_unavailable: true,
      low_confidence: false,
      answers: null,
      error_code: directed.error_code,
      message: directed.message
    };
  }

  return {
    scene: directed.scene,
    changed: directed.changed,
    scene_unavailable: false,
    low_confidence: directed.low_confidence,
    // 신뢰도 미달로 유지된 턴을 서술과 함께 남기면 "빠진 장소" 목록이 된다 —
    // 사람이 그걸 읽고 world.stage에 장소를 추가한다. 로그는 server.js가 남긴다.
    answers: directed.answers || null
  };
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
  judgeModel,
  directorClient,
  confidenceThreshold
} = {}) {
  const input = String(userInput || "").trim();
  if (!input) return errorResult("INVALID_ARGUMENT", "행동을 입력하세요.", false);
  if (session?.ended) return errorResult("INVALID_ARGUMENT", "끝난 이야기입니다. 기록에서 분기하거나 새 이야기를 시작하세요.", false);
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

  // usage가 없다고 0으로 집계하면 계량기가 조용히 거짓말을 한다. 어림값이라고 표시하고 센다.
  const estimated = !generated.usage;
  const inputTokens = generated.usage ? generated.usage.prompt_tokens : estimatedInputTokens;
  const outputTokens = generated.usage ? generated.usage.completion_tokens : estimateTokens(generated.text);

  // 요청한 모델이 아니라 **실제로 답한** 모델로 계량하고 기록한다. 폴백 체인
  // (llm/fallback.js)이 Cloudflare 대신 Gemini로 넘어갔다면 둘은 다르다. 요청한
  // 이름으로 적으면 Gemini가 쓴 글을 Cloudflare 단가로 장부에 올리게 된다.
  // 폴백을 안 쓰는 옛 호출부는 generated.model이 없으니 지금까지와 똑같다.
  //
  // 결과적으로 Cloudflare가 아닌 제공처가 답한 턴은 budget_unknown: true가 된다 —
  // budget.js의 가격표에 그 모델이 없기 때문이다. 이건 버그가 아니라 사실이다.
  // Neuron은 Cloudflare의 단위이고, Gemini 무료 티어가 쓴 양은 Neuron으로 잴 수
  // 없다. "모르는 값을 0으로 적지 않는다"는 budget.js의 원칙 그대로다. 무엇이
  // 답했는지는 아래 provider로 따로 알린다.
  const servedModel = generated.model || model;
  const recorded = ledger.record({ model: servedModel, inputTokens, outputTokens });

  const turn = sessionApi.makeTurn({
    index: sessionApi.nextTurnIndex(session),
    session_id: session?.session_id,
    user_input: input,
    narration: parsed.narration,
    choices: parsed.choices,
    model: servedModel,
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

  // 장면 판정도 서술이 다 흐른 다음이다(판정과 같은 자리). 매 턴 조건 없이
  // 묻는다 — 예전 고장("블록을 안 써서 그림이 그대로")은 묻는 것 자체가
  // 조건부였기 때문에 생겼다.
  const priorScene = session?.current_scene || null;
  const direction = await runDirection({
    world,
    previousScene: priorScene,
    narration: parsed.narration,
    directorClient,
    confidenceThreshold,
    signal
  });

  // direction.scene은 항상 "이번 턴에 화면이 들고 갈 장면"이다 — 바뀌었으면 새
  // 장면, 아니면 직전 장면 그대로. 판정이 실패했거나 신뢰도가 모자랐으면
  // director가 이미 직전 장면을 그대로 돌려줬으므로 여기서 다시 고를 것이 없다.
  turn.truncated = Boolean(generated.truncated);
  turn.snapshot = { sim: structuredClone(simState), current_scene: structuredClone(direction.scene || null) };
  const nextSession = {
    ...sessionApi.appendTurn(session, turn),
    sim: simState,
    current_scene: direction.scene || null
  };

  return {
    ok: true,
    turn,
    session: nextSession,
    budget: recorded,
    // recorded.neurons가 null이면 단가를 몰라 계량하지 못했다는 뜻이다(budget.js 참고).
    // 이걸 호출부가 놓치면 미터는 그대로인데 Cloudflare는 실제로 과금한다 — 무료 턴처럼 보이는 유료 턴.
    budget_unknown: recorded.neurons === null,
    // 이 턴을 실제로 쓴 제공처. 폴백 체인을 안 쓰는 호출부에서는 null이다
    // ("Cloudflare였다"와 "누구였는지 이 경로는 모른다"는 다르다). UI는 이 값으로
    // budget_unknown이 "단가를 모른다"가 아니라 "Cloudflare가 아니었다"임을 구분한다.
    provider: generated.provider || null,
    // 이 턴이 폴백까지 내려오면서 지나친 실패들. 성공한 턴에서는 플레이어에게
    // 아무 일도 없어 보이지만, 주 제공처가 왜 답하지 못했는지는 운영자가 알아야
    // 한다(특히 AUTH_FAILED처럼 사람이 고쳐야 하는 것). server.js가 로그로 남긴다.
    provider_attempts: Array.isArray(generated.attempts) && generated.attempts.length > 0
      ? generated.attempts.map((item) => ({ provider: item.provider, error_code: item.error_code }))
      : null,
    truncated: Boolean(generated.truncated),
    // 판정 결과 — step 3의 UI가 "왜" 게이지가 움직였는지 보여줄 수 있도록 그대로 얹는다.
    sim: simState,
    last_change,
    // 판정 호출 자체가 실패했을 때만 true다(스펙: 모르는 값은 0이 아니라 이렇게
    // "모른다"고 알린다 — budget.js의 budget_unknown과 같은 원칙). judgeClient를
    // 아예 안 줬을 때는 false다 — 시도조차 안 한 것과 실패한 것은 다르다.
    judge_unavailable,
    // 이번 턴의 장면. 안 바뀐 턴에도 (직전 장면이 있으면) 값이 있다 — 화면 라벨과
    // 다음 턴의 [현재 상태]가 이 값을 쓴다. **그림을 그릴지는 scene이 아니라
    // scene_changed가 정한다.**
    scene: direction.scene,
    // server.js는 이 값이 true일 때만(그리고 서술 스트림이 다 끝난 다음에)
    // src/server/scene.js를 불러 이미지를 만든다.
    scene_changed: direction.changed,
    // 장면 판정 호출 자체가 실패했을 때만 true다 — judge_unavailable과 같은 원칙
    // (모르는 값을 "없음"으로 적지 않는다). directorClient를 아예 안 줬을 때는
    // false다: 시도조차 안 한 것과 실패한 것은 다르다.
    scene_unavailable: direction.scene_unavailable,
    // 세 답 중 하나라도 임계 미만이라 장면을 유지했다. 이 턴들을 서술과 함께
    // 모으면 world.stage에 빠진 장소 목록이 된다(server.js가 로그로 남긴다).
    scene_low_confidence: direction.low_confidence,
    scene_answers: direction.answers
  };
}

module.exports = { runTurn };
