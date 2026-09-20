"use strict";

/**
 * 미술감독 — 이번 턴의 배경을 다시 그릴지, 어디를 그릴지 판정한다.
 *
 * `judge.js`와 짝이고 같은 자리(서술 스트림이 끝난 다음)에서 돈다. 판정자가
 * "이번 턴이 어떤 트리거를 밟았는가"를 묻는다면, 미술감독은 "지금 어디인가"를
 * 묻는다. 둘 다 서술자와 **분리된 호출**인 이유가 같다 — 서술자에게 목록을
 * 보여주면 이야기가 그 목록에 맞춰진다(`judge.js` 머리주석: "채점 기준을 알면
 * 그 기준에 맞춰 장면을 쓰게 된다"). 장소 목록도 마찬가지라, 그릴 수 있는 곳이
 * 셋뿐인 걸 알면 서술자는 옥상으로 나가야 할 장면에서 복도에 머무른다.
 *
 * 나눈 덕에 서술자는 옥상으로 가고, 미술감독은 "목록에 없음 → 장면 유지"로
 * 끝낸다. 이야기는 다치지 않는다.
 *
 * ## 서술자는 더 이상 장면을 쓰지 않는다
 *
 * 예전에는 서술자가 산문 안에 `<장면>` 블록을 직접 써 넣었고, 그 블록의 유무가
 * "이미지를 다시 그려야 하는가"의 유일한 신호였다. 그 배선은 창작 모델에게
 * 분류와 조건 분기를 동시에 시키는 것이라 네 가지로 고장났다(블록 누락, 같은
 * 장소의 다른 표기, visual에 한글 혼입, 매 턴 발주서 재생성). 이 모듈은 그
 * 판정을 **닫힌 선택지로만 답하는 별도 호출**로 옮긴 것이다.
 *
 * ## 문장을 만들지 않는다
 *
 * 이미지 프롬프트(`visual`)는 여기서 생성되지 않는다. 세계관 파일의
 * `world.stage.locations[].visual`에 **사람이 미리 써 둔** 영어 문장을 id로
 * 조회할 뿐이다. 그래서 그림이 맘에 안 들어 고치면 다음 턴에 날아가지 않고
 * 계속 반영된다.
 *
 * CommonJS. src/core/를 참조하지 않는다 — world는 이미 정규화된 채로
 * 넘어온다(server.js의 loadWorld → core/card.js의 loadWorldFile).
 *
 * error_code 어휘: INVALID_ARGUMENT | (client.ask가 돌려주는 그대로)
 * CONNECTION_FAILED | TIMEOUT | AUTH_FAILED | PAYMENT_REQUIRED | QUOTA_EXHAUSTED |
 * CAPACITY | RATE_LIMITED | UPSTREAM_ERROR | BAD_RESPONSE | NOT_CONFIGURED | ABORTED
 */

/**
 * 신뢰도 임계. 세 답 중 하나라도 이 값 미만이면 장면을 유지한다(안 그린다).
 *
 * "모르면 바꾸지 않는다"가 안전한 기본값인 이유: 잘못 바꾸면 **틀린 그림**이
 * 걸리고, 안 바꾸면 **조금 낡은 그림**이 걸린다. 후자가 덜 나쁘다.
 *
 * **0.5는 골든셋으로 정한 값이다**(설계 초기값은 0.7이었다). 30턴 골든셋
 * (tests/fixtures/golden/scene_director.golden.json)을 임계별로 훑은 결과:
 *
 * ```
 * 임계   전환 recall  전환 precision  장소 정확도
 * 0.70   0.478        1.000           1.000
 * 0.50   0.652        1.000           1.000
 * 0.35   0.739        1.000           1.000
 * 0.00   0.826        1.000           1.000   <- 임계를 없앤 상한
 * ```
 *
 * 읽는 법 둘.
 *
 * 1. 이 구간에서 **precision과 장소 정확도가 임계와 무관하게 1.000이다.** 임계를
 *    낮춰도 틀린 그림이 늘지 않았다 — 0.7은 맞는 답까지 같이 버리고 있었다.
 *    그래서 0.7을 유지할 근거가 이 데이터에는 없다.
 * 2. 그렇다고 0으로 내리지 않는다. 임계를 없애면 "모르면 바꾸지 않는다"는 안전
 *    장치 자체가 사라지고, FP가 0인 것은 30턴에서 관측된 사실이지 보장이 아니다.
 *    0.5는 "확신이 반도 안 되면 그리지 않는다"는 읽히는 선이라 곡선에 맞춘 값이
 *    아니다.
 *
 * 축별로 다른 값이 필요한지도 봤다(설계 13절 열린 질문 2) — 네 기준을 동시에
 * 만족하는 축별 조합은 **없었다**. 병목이 임계가 아니라 전환 감지 recall의
 * 상한(0.826)이기 때문이다. 자세한 것은 doc/2026-09-20-m0-jev-probe.md 6절.
 *
 * 운영에서는 SCENE_CONFIDENCE로 덮어쓴다.
 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * 서술을 state에 실을 때의 상한. Jev의 컨텍스트는 32k라 한 턴 서술(300~700자)은
 * 애초에 문제가 안 되지만, 호출부가 무엇을 넘길지는 이 모듈이 정하지 않으므로
 * 상한을 둔다. 앞쪽을 남긴다 — 장면 전환은 보통 문단 앞에서 일어난다.
 */
const MAX_NARRATION_CHARS = 4000;

/**
 * `Choice`의 criteria는 객체 `{ 선택지키: 설명 }`다.
 *
 * 장소는 `id → ko`가 그대로 들어맞는다(기계용 키와 사람이 읽을 설명이 이미
 * 나뉘어 있다). 시간대·날씨는 세계관 파일에 문자열 배열로 authored되어 키와
 * 설명이 같은 한국어 낱말이다 — `{ "밤": "밤" }`이 중복처럼 보이지만, 그 낱말
 * 자체가 사람이 읽을 설명이라 따로 지어낼 것이 없다. 없는 설명을 여기서
 * 만들어 붙이면 그건 세계관 저작물이 아니라 코드가 만든 문장이 된다.
 */
function criteriaFromList(values) {
  const out = {};
  for (const value of values) out[value] = value;
  return out;
}

function criteriaFromLocations(locations) {
  const out = {};
  for (const loc of locations) out[loc.id] = loc.ko || loc.id;
  return out;
}

/**
 * 세 질문을 한 번에 만든다. Jev는 한 호출에 여러 질문을 병렬로 받으므로
 * 장소·시간·날씨를 각각 부르지 않는다.
 *
 * **"장면이 바뀌었는가"는 묻지 않는다.** 세 답을 직전 장면과 비교하면 나오는
 * 값을 한 번 더 묻는 것은 중복이고, 두 답이 어긋날 때 무엇을 믿을지가 또
 * 문제가 된다.
 *
 * **"그 외" 탈출구도 두지 않는다.** authored되지 않은 장소로 서술이 넘어가면
 * 장소의 신뢰도가 낮게 나오고 그 턴은 장면이 유지된다. 탈출구를 두면
 * "미지의 장소 → 프롬프트 생성"이라는 두 번째 경로가 생기고, 그게 정확히 이
 * 설계가 없애려는 것이다.
 */
function buildQuestions(stage) {
  return {
    place: {
      type: "choice",
      instructions: "이 서술이 **끝나는 시점에** 인물이 있는 장소를 고른다. 서술 도중 거쳐 간 장소가 아니라 마지막에 도착해 있는 곳이다. 언급만 되고 가지 않은 장소는 고르지 않는다.",
      criteria: criteriaFromLocations(stage.locations)
    },
    time: {
      type: "choice",
      instructions: "이 서술이 끝나는 시점의 시간대를 고른다. 서술에 시각이 드러나면 그것을 따르고, 안 드러나면 직전 장면의 시간대가 이어진다고 본다.",
      criteria: criteriaFromList(stage.times)
    },
    weather: {
      type: "choice",
      instructions: "이번 턴 서술의 날씨를 고른다. 날씨가 서술에 나오지 않으면 직전 장면의 날씨가 이어진다고 본다.",
      criteria: criteriaFromList(stage.weathers)
    }
  };
}

/**
 * 답 하나가 쓸 만한지 본다. 신뢰도가 **null이면 미달로 본다** — "신뢰도가 0"과
 * "신뢰도를 모른다"는 다르지만, 둘 다 "확신을 확인하지 못했다"라는 점에서는
 * 같고, 이 규칙의 기본값은 "모르면 바꾸지 않는다"이다.
 */
function isConfident(answer, threshold) {
  return Boolean(
    answer &&
    typeof answer.choice === "string" &&
    answer.choice.length > 0 &&
    typeof answer.confidence === "number" &&
    answer.confidence >= threshold
  );
}

/** 답이 정의역 안에 있는지 확인한다. Jev에서는 구조적으로 보장되지만, 방어는 이중화한다. */
function inDomain(value, allowed) {
  return allowed.includes(value);
}

function sameScene(a, b) {
  if (!a || !b) return false;
  return a.location_id === b.location_id && a.time === b.time && a.weather === b.weather;
}

/**
 * directScene({ world, previousScene, narration, userInput, client, threshold, signal })
 *   -> { ok:true, scene, changed, low_confidence, answers, usage, model }
 *   -> { ok:false, error_code, message, retryable }
 *
 * client는 src/llm/jev.js의 createJevClient() 결과(또는 같은 모양의 ask를 가진
 * 대역)를 기대한다.
 *
 * 반환하는 `scene`은 항상 **이번 턴에 화면이 들고 갈 장면**이다 — 바뀌었으면 새
 * 장면, 아니면 직전 장면 그대로(첫 턴이고 판정에 실패했으면 null). `changed`가
 * true일 때만 호출부가 그림을 그린다.
 *
 * 판정 규칙(세 답 전부가 임계 이상일 때만 움직인다):
 *
 * | 조건                          | 동작           | 이유                       |
 * | ----------------------------- | -------------- | -------------------------- |
 * | 전부 임계 이상 && 직전과 다름 | 새로 그린다    | 정상 전환                  |
 * | 전부 임계 이상 && 직전과 같음 | 그대로 둔다    | 캐시 히트조차 필요 없다    |
 * | 하나라도 임계 미만            | 장면을 유지한다 | 모르면 바꾸지 않는다       |
 */
async function directScene({
  world,
  previousScene = null,
  narration,
  client,
  threshold = DEFAULT_CONFIDENCE_THRESHOLD,
  signal
} = {}) {
  const stage = (world && world.stage) || null;
  const locations = (stage && stage.locations) || [];
  const times = (stage && stage.times) || [];
  const weathers = (stage && stage.weathers) || [];

  // 셋 중 하나라도 비면 질문을 만들 수 없다. 이건 모델의 불확실성이 아니라
  // 세계관 파일의 공백이므로 조용히 "유지"로 넘기지 않고 구조화 오류로 드러낸다 —
  // 로그를 보고 사람이 world에 stage를 채워야 고쳐진다.
  if (locations.length === 0 || times.length === 0 || weathers.length === 0) {
    return errorResult(
      "INVALID_ARGUMENT",
      "world.stage에 locations/times/weathers가 모두 필요합니다 — 이 세계관은 배경을 그릴 수 없습니다.",
      false
    );
  }

  const text = String(narration || "").trim();
  if (!text) {
    return errorResult("INVALID_ARGUMENT", "판정할 서술이 없습니다.", false);
  }

  if (!client || typeof client.ask !== "function") {
    return errorResult("CONNECTION_FAILED", "미술감독 클라이언트가 없습니다.", true);
  }

  // 직전 장면을 같이 싣는 이유: 날씨처럼 이번 턴 서술에 아예 안 나오는 축이
  // 있고, 그때 "직전과 같다"고 답할 근거가 이 값뿐이다.
  const state = {
    previous_scene: previousScene
      ? { place: previousScene.place || "", time: previousScene.time || "", weather: previousScene.weather || "" }
      : null,
    narration: text.length > MAX_NARRATION_CHARS ? text.slice(0, MAX_NARRATION_CHARS) : text
  };

  const asked = await client.ask({ state, questions: buildQuestions(stage), signal });
  if (!asked.ok) return asked;

  const answers = asked.answers || {};
  const place = answers.place;
  const time = answers.time;
  const weather = answers.weather;

  const locationIds = locations.map((loc) => loc.id);
  const confident =
    isConfident(place, threshold) && inDomain(place.choice, locationIds) &&
    isConfident(time, threshold) && inDomain(time.choice, times) &&
    isConfident(weather, threshold) && inDomain(weather.choice, weathers);

  if (!confident) {
    // 장면을 유지한다. 호출부가 로그를 남길 수 있도록 답 자체는 그대로 실어 보낸다
    // (신뢰도 미달로 유지된 턴을 서술과 함께 모으면 "빠진 장소" 목록이 된다).
    return {
      ok: true,
      scene: previousScene || null,
      changed: false,
      low_confidence: true,
      answers,
      usage: asked.usage || null,
      model: asked.model || null
    };
  }

  const location = locations.find((loc) => loc.id === place.choice);
  const scene = {
    location_id: location.id,
    // 화면 라벨이자 서술자에게 알려 줄 "여기가 어디다"의 한국어 이름.
    place: location.ko || location.id,
    time: time.choice,
    weather: weather.choice,
    // 사람이 미리 써 둔 영어 발주서. 생성물이 아니라 조회값이다.
    visual: location.visual || ""
  };

  return {
    ok: true,
    scene,
    changed: !sameScene(scene, previousScene),
    low_confidence: false,
    answers,
    usage: asked.usage || null,
    model: asked.model || null
  };
}

module.exports = {
  directScene,
  buildQuestions,
  sameScene,
  DEFAULT_CONFIDENCE_THRESHOLD,
  MAX_NARRATION_CHARS
};
