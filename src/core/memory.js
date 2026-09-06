/**
 * 프롬프트 조립.
 *
 * 프롬프트는 고정 프리픽스 + 기억 4층이다(스펙 5절). **M1은 프리픽스와 단기 기억만
 * 만든다.** 상태 블록은 M3, 요약 체인과 RAG는 M4다. 자리를 지금 만들어 두지 않는
 * 이유는, 빈 블록도 토큰을 먹고 모델이 그것을 지시로 오해하기 때문이다.
 *
 * 최근 턴은 대화 로그가 아니라 user/assistant 쌍으로 싣는다. 한 덩어리 텍스트로 넣으면
 * 모델이 그것을 "지금까지의 서술"이 아니라 "따라 써야 할 예시"로 다루는 경향이 있다.
 */

import { renderNarratorPrefix } from "./card.js";
import { recentTurns, DEFAULT_RECENT_TURNS } from "./session.js";
import { CHOICE_MARKER, SCENE_MARKER } from "./narration.js";
import { createSimState, stageLabel, recoveryLabel } from "./sim.js";

/**
 * 한국어 기준 어림값. src/llm/budget.js와 같은 상수지만 core는 llm을 참조하지 않으므로
 * 독립적으로 정의한다 — 값이 어긋나지 않는지는 tests/budget.test.mjs가 두 모듈을 함께
 * import해서 확인한다. 그 테스트를 위해서만 export한다.
 */
export const CHARS_PER_TOKEN = 1.2;

export const OUTPUT_RULES = `
[출력 형식]
1. 먼저 장면을 서술한다. 서술은 300자에서 700자 사이로 쓴다.
2. 위 [현재 상태]에 적힌 장면 줄을 본다. "장면: 아직 정해지지 않음"이라고 되어 있으면 아직 첫 장면이 정해지지 않은 것이므로, 서술이 끝난 다음(선택지보다 앞에) 아래 형식으로 장면 정보를 반드시 쓴다. 이미 장소·시간·날씨가 적혀 있다면, 그중 하나라도 지금 장면에서 달라졌을 때만 같은 형식으로 한 번 쓰고, 셋 다 그대로면 이 블록은 통째로 생략한다 — 매 턴 쓰는 게 아니라 첫 장면이거나 바뀌었을 때만 쓴다.

${SCENE_MARKER}
장소: (예: 3학년 2반 교실)
시간: (예: 밤)
날씨: (예: 비)
visual: (예: empty Korean high school classroom at night, fluorescent light on rows of desks, rain streaking the windows)
</장면>

이 블록은 배경 그림을 다시 그릴지 판단하는 용도라, 장소·시간·날씨·visual 네 가지만 적는다. 장소·시간·날씨는 지금까지처럼 한국어로 쓴다(화면에 보이는 이름표이자 캐시 키다). visual은 다르다 — **반드시 영어로** 쓴다. 그림을 실제로 그리는 이미지 모델은 영어 캡션만 이해하고, 한국어를 넣으면 뜻 없는 잡음으로 처리해 아무 배경이나 그려 버린다. visual에는 구체적인 시각 명사만 적는다: 장소, 조명, 날씨, 시간대, 벽이나 바닥에 놓인 것. 인물이 누구인지, 인물이 무엇을 하는지, 인물의 생김새·옷차림·이름은 절대 적지 않는다 — 사람이 아니라 텅 빈 배경만 그리기 위한 자리다.
3. 서술(과, 있다면 장면 블록)이 끝나면 출력의 끝에 반드시 아래 형식으로 선택지 3개를 쓴다.

${CHOICE_MARKER}
1. (행동 또는 대사)
2. (행동 또는 대사)
3. (행동 또는 대사)

4. 서술 본문에는 ${SCENE_MARKER}나 ${CHOICE_MARKER}를 쓰지 않는다.
5. 선택지는 서로 방향이 달라야 한다. 같은 행동의 말만 바꾼 것을 세 개 늘어놓지 않는다.
6. 사용자를 대신해 사용자의 행동을 서술하지 않는다. 사용자가 방금 한 행동의 결과만 쓴다.
`.trim();

/**
 * 장면 줄. rule 2("직전 장면에서 달라졌으면")가 답할 수 있으려면 모델이 먼저
 * 직전 장면이 무엇인지 알아야 한다 — session이 current_scene을 안 준다면(첫 턴,
 * 또는 아직 <장면> 블록이 한 번도 안 나온 경우) 그 사실 자체를 명시한다. 침묵하면
 * "장면이 그대로다"로 오독되어 첫 장면 블록이 영영 생략된다(이 기능이 실전에서
 * 한 번도 발동하지 못한 원인).
 */
function renderSceneLine(currentScene) {
  if (!currentScene || (!currentScene.place && !currentScene.time && !currentScene.weather)) {
    return "장면: 아직 정해지지 않음";
  }
  const { place, time, weather } = currentScene;
  return `장소: ${place || "미상"} · ${time || "미상"} · ${weather || "미상"}`;
}

/**
 * [현재 상태] 블록 — 관계 단계와 회복을 숫자 없이 서술어로 알려준다. "호감도
 * 48/100" 같은 숫자를 서술자가 보면 숫자를 향해 글을 쓰게 된다(스펙 2절). 단계·
 * 회복 구간 → 문구 매핑은 sim.js가 소유한다(그 경계를 정의하는 모듈이므로).
 */
function renderStateBlock({ world, cards, sim, currentScene }) {
  const characters = (sim && sim.characters) || {};
  const lines = [renderSceneLine(currentScene)];
  for (const card of cards) {
    const entry = characters[card.card_id];
    const stage = entry ? entry.stage : "0_stranger";
    lines.push(`${card.canonical_name || card.card_id}: ${stageLabel(stage)}`);
  }
  const protagonistName = (world && world.protagonist && world.protagonist.name) || "너";
  lines.push(`${protagonistName}: ${recoveryLabel(sim ? sim.recovery : 0)}`);
  return `[현재 상태]\n${lines.join("\n")}\n`;
}

export function buildMessages({ world, cards = [], session, userInput = "", simState = null } = {}) {
  // simState가 없으면(호출부가 아직 안 넘겼거나, 세션에 sim이 없는 옛 세션) 카드마다
  // 0_stranger/회복 0에서 시작한 것으로 본다 — sim.createSimState과 같은 기본값.
  const sim = simState || createSimState({ cards });
  const stages = {};
  for (const card of cards) {
    stages[card.card_id] = (sim.characters && sim.characters[card.card_id] && sim.characters[card.card_id].stage) || "0_stranger";
  }

  const prefix = renderNarratorPrefix({ world, cards, stages, pov: session?.pov ?? null });
  const stateBlock = renderStateBlock({ world, cards, sim, currentScene: session?.current_scene ?? null });
  const messages = [{ role: "system", content: `${prefix}\n${stateBlock}\n${OUTPUT_RULES}` }];

  const turns = recentTurns(session, session?.settings?.recent_turns ?? DEFAULT_RECENT_TURNS);

  // 먼저 살아남는 user/assistant 쌍을 만든다. 오프닝 삽입 여부는 "원본 슬라이스가
  // 비었는가"가 아니라 "쌍이 하나라도 살아남았는가"로 판단해야 한다. 원본 슬라이스
  // 기준으로 판단하면, 최근 턴에 서술이 빈 턴 하나만 있을 때(모델이 빈 응답을 준
  // 경우) turns.length는 1이라 오프닝 삽입을 건너뛰는데, 그 턴은 아래에서 결국
  // 필터링돼 사라진다 — 프롬프트에 오프닝도 이력도 남지 않게 된다.
  const pairs = [];
  for (const turn of turns) {
    // 한 턴은 쌍으로 들어가거나 통째로 빠진다. 모델이 빈 서술을 돌려준 실패한 턴을
    // 사용자 발화만 남겨 실으면, 답을 못 받은 지시처럼 보이고 같은 역할 메시지가
    // 연달아 붙어 chat 형식도 깨진다.
    if (!turn.user_input || !turn.narration) continue;
    pairs.push({ role: "user", content: turn.user_input });
    pairs.push({ role: "assistant", content: turn.narration });
  }

  // 오프닝은 살아남은 쌍이 하나도 없을 때만 넣는다. 이후에는 살아남은 최근 턴이
  // 그 자리를 대신한다.
  if (pairs.length === 0 && session?.opening) {
    messages.push({ role: "assistant", content: session.opening });
  }

  messages.push(...pairs);

  messages.push({ role: "user", content: String(userInput || "") });

  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return { messages, estimatedInputTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
}
