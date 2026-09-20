import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { directScene, buildQuestions, sameScene, DEFAULT_CONFIDENCE_THRESHOLD } = require("../src/server/director.js");
const { normalizeWorld } = await import("../src/core/card.js");

const world = normalizeWorld({
  world_id: "demo",
  stage: {
    locations: [
      { id: "classroom_3_2", ko: "3학년 2반 교실", visual: "empty Korean classroom at night, rows of desks" },
      { id: "hallway", ko: "복도", visual: "empty Korean school corridor at night, lockers" },
      { id: "front_gate", ko: "정문 앞", visual: "empty school front gate at night, wet asphalt" }
    ],
    times: ["저녁", "밤", "자정"],
    weathers: ["비", "흐림"]
  }
});

const NARRATION = "그는 가방을 챙겨 교실 문을 열었다. 불 꺼진 복도가 길게 뻗어 있었다.";

function choice(value, confidence) {
  return { type: "choice", choice: value, confidence, noul: null, score: null, probabilities: null };
}

function fakeClient({ answers = null, fail = null, capture = null } = {}) {
  return {
    async ask(args) {
      if (capture) Object.assign(capture, args);
      if (fail) return fail;
      return { ok: true, answers, usage: { input_tokens: 150, output_tokens: 0 }, model: "jev-1.13.0" };
    }
  };
}

const CLASSROOM = { place: choice("classroom_3_2", 0.95), time: choice("밤", 0.9), weather: choice("비", 0.85) };
const HALLWAY = { place: choice("hallway", 0.93), time: choice("밤", 0.9), weather: choice("비", 0.85) };
const PRIOR_CLASSROOM = { location_id: "classroom_3_2", place: "3학년 2반 교실", time: "밤", weather: "비" };

// --- 질문 만들기 ---

test("buildQuestions: 세 질문을 한 호출에 싣는다", () => {
  const questions = buildQuestions(world.stage);
  assert.deepEqual(Object.keys(questions).sort(), ["place", "time", "weather"]);
  for (const q of Object.values(questions)) assert.equal(q.type, "choice");
});

test("buildQuestions: 장소의 criteria는 id를 키로, 한국어 이름을 설명으로 쓴다", () => {
  const { place } = buildQuestions(world.stage);
  assert.deepEqual(place.criteria, {
    classroom_3_2: "3학년 2반 교실",
    hallway: "복도",
    front_gate: "정문 앞"
  });
});

test('buildQuestions: "그 외" 탈출구를 두지 않는다', () => {
  // 탈출구를 두면 "미지의 장소 → 프롬프트 생성"이라는 두 번째 경로가 생기고,
  // 그게 정확히 이 설계가 없애려는 것이다. authored되지 않은 장소로 서술이
  // 넘어가면 신뢰도가 낮게 나와 장면이 유지되는 것으로 충분하다.
  const questions = buildQuestions(world.stage);
  const keys = Object.keys(questions.place.criteria);
  assert.equal(keys.length, 3);
  for (const key of keys) {
    assert.ok(!/other|기타|그 외|unknown/i.test(key), `탈출구가 생겼다: ${key}`);
  }
});

test("buildQuestions: 장면이 바뀌었는지는 묻지 않는다(비교하면 나오는 값이다)", () => {
  const questions = buildQuestions(world.stage);
  assert.equal(questions.changed, undefined);
  assert.equal(questions.scene_changed, undefined);
});

// --- 정상 판정 ---

test("directScene: 세 답이 모두 확신이면 장면을 만들고 visual을 조회한다", async () => {
  const result = await directScene({ world, previousScene: null, narration: NARRATION, client: fakeClient({ answers: HALLWAY }) });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.scene, {
    location_id: "hallway",
    place: "복도",
    time: "밤",
    weather: "비",
    visual: "empty Korean school corridor at night, lockers"
  });
  assert.equal(result.low_confidence, false);
});

test("directScene: visual은 생성되지 않고 world에서 조회된다", async () => {
  // 이 설계의 핵심이다 — 발주서가 생성물이면 그림을 고쳐도 다음 턴에 날아간다.
  const result = await directScene({ world, narration: NARRATION, client: fakeClient({ answers: CLASSROOM }) });
  const authored = world.stage.locations.find((l) => l.id === "classroom_3_2").visual;
  assert.equal(result.scene.visual, authored);
});

test("directScene: 첫 장면(직전이 null)은 changed가 true다", async () => {
  const result = await directScene({ world, previousScene: null, narration: NARRATION, client: fakeClient({ answers: CLASSROOM }) });
  assert.equal(result.changed, true);
});

test("directScene: 직전과 세 축이 모두 같으면 changed는 false다", async () => {
  const result = await directScene({
    world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers: CLASSROOM })
  });
  assert.equal(result.changed, false);
  assert.equal(result.scene.location_id, "classroom_3_2");
});

test("directScene: 장소가 같아도 시간대가 바뀌면 다시 그린다", async () => {
  const result = await directScene({
    world, previousScene: PRIOR_CLASSROOM, narration: NARRATION,
    client: fakeClient({ answers: { ...CLASSROOM, time: choice("자정", 0.88) } })
  });
  assert.equal(result.changed, true);
  assert.equal(result.scene.time, "자정");
});

test("directScene: 장소가 같아도 날씨가 바뀌면 다시 그린다", async () => {
  const result = await directScene({
    world, previousScene: PRIOR_CLASSROOM, narration: NARRATION,
    client: fakeClient({ answers: { ...CLASSROOM, weather: choice("흐림", 0.81) } })
  });
  assert.equal(result.changed, true);
  assert.equal(result.scene.weather, "흐림");
});

// --- 신뢰도 게이트 ---

test("directScene: 하나라도 임계 미만이면 장면을 유지한다", async () => {
  for (const key of ["place", "time", "weather"]) {
    const answers = { ...CLASSROOM, [key]: { ...CLASSROOM[key], confidence: 0.4 } };
    const result = await directScene({
      world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers })
    });
    assert.equal(result.changed, false, `${key}가 흔들렸는데 그림을 바꿨다`);
    assert.equal(result.low_confidence, true);
    assert.deepEqual(result.scene, PRIOR_CLASSROOM);
  }
});

test("directScene: 임계값 경계에서는 같거나 크면 통과다", async () => {
  const atThreshold = {
    place: choice("hallway", DEFAULT_CONFIDENCE_THRESHOLD),
    time: choice("밤", DEFAULT_CONFIDENCE_THRESHOLD),
    weather: choice("비", DEFAULT_CONFIDENCE_THRESHOLD)
  };
  const pass = await directScene({ world, narration: NARRATION, client: fakeClient({ answers: atThreshold }) });
  assert.equal(pass.low_confidence, false);

  const below = {
    place: choice("hallway", DEFAULT_CONFIDENCE_THRESHOLD - 0.01),
    time: choice("밤", 0.9),
    weather: choice("비", 0.9)
  };
  const fail = await directScene({ world, narration: NARRATION, client: fakeClient({ answers: below }) });
  assert.equal(fail.low_confidence, true);
});

test("directScene: 임계값은 호출부가 바꿀 수 있다", async () => {
  // 기본값(0.5)에 걸리지 않도록 양쪽 다 기본값에서 떨어뜨려 고른다 — 기본값이
  // 골든셋으로 바뀌어도 이 테스트가 재는 것(임계를 덮어쓸 수 있는가)은 그대로다.
  const answers = { place: choice("hallway", 0.45), time: choice("밤", 0.45), weather: choice("비", 0.45) };
  const strict = await directScene({ world, narration: NARRATION, client: fakeClient({ answers }), threshold: 0.6 });
  assert.equal(strict.low_confidence, true);

  const loose = await directScene({ world, narration: NARRATION, client: fakeClient({ answers }), threshold: 0.4 });
  assert.equal(loose.low_confidence, false);
});

test("directScene: 신뢰도가 null이면 미달로 본다(모르는 것은 확신이 아니다)", async () => {
  const answers = {
    place: { type: "choice", choice: "hallway", confidence: null, noul: null, score: null, probabilities: null },
    time: choice("밤", 0.9),
    weather: choice("비", 0.9)
  };
  const result = await directScene({ world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers }) });
  assert.equal(result.low_confidence, true);
  assert.equal(result.changed, false);
});

test("directScene: 유지된 턴에도 답은 실어 보낸다(빠진 장소 로그의 재료)", async () => {
  const answers = { place: choice("front_gate", 0.22), time: choice("밤", 0.9), weather: choice("비", 0.9) };
  const result = await directScene({ world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers }) });
  assert.equal(result.answers.place.choice, "front_gate");
  assert.equal(result.answers.place.confidence, 0.22);
});

test("directScene: 첫 턴에 확신이 없으면 장면 없이 끝난다(지어내지 않는다)", async () => {
  const answers = { place: choice("hallway", 0.2), time: choice("밤", 0.9), weather: choice("비", 0.9) };
  const result = await directScene({ world, previousScene: null, narration: NARRATION, client: fakeClient({ answers }) });
  assert.equal(result.ok, true);
  assert.equal(result.scene, null);
  assert.equal(result.changed, false);
});

// --- 정의역 방어 ---

test("directScene: 목록 밖의 답은 확신이 높아도 받지 않는다", async () => {
  // Jev에서는 구조적으로 일어날 수 없지만, 방어는 이중화한다(judge.js의
  // keepKnown과 sim.applyJudgment가 같은 관용을 쓴다).
  const answers = { place: choice("rooftop", 0.99), time: choice("밤", 0.9), weather: choice("비", 0.9) };
  const result = await directScene({ world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers }) });
  assert.equal(result.changed, false);
  assert.deepEqual(result.scene, PRIOR_CLASSROOM);
});

test("directScene: 시간·날씨도 목록 밖이면 받지 않는다", async () => {
  const badTime = { ...CLASSROOM, time: choice("새벽", 0.99) };
  const r1 = await directScene({ world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers: badTime }) });
  assert.equal(r1.changed, false);

  const badWeather = { ...CLASSROOM, weather: choice("맑음", 0.99) };
  const r2 = await directScene({ world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers: badWeather }) });
  assert.equal(r2.changed, false);
});

test("directScene: 답이 통째로 빠져도 던지지 않고 장면을 유지한다", async () => {
  const result = await directScene({
    world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers: {} })
  });
  assert.equal(result.ok, true);
  assert.equal(result.low_confidence, true);
  assert.deepEqual(result.scene, PRIOR_CLASSROOM);
});

// --- state ---

test("directScene: 직전 장면과 이번 턴 서술만 state에 싣는다", async () => {
  const capture = {};
  await directScene({ world, previousScene: PRIOR_CLASSROOM, narration: NARRATION, client: fakeClient({ answers: CLASSROOM, capture }) });

  assert.deepEqual(capture.state.previous_scene, { place: "3학년 2반 교실", time: "밤", weather: "비" });
  assert.equal(capture.state.narration, NARRATION);
});

test("directScene: 직전 장면이 없으면 previous_scene은 null이다", async () => {
  const capture = {};
  await directScene({ world, previousScene: null, narration: NARRATION, client: fakeClient({ answers: CLASSROOM, capture }) });
  assert.equal(capture.state.previous_scene, null);
});

test("directScene: 아주 긴 서술은 상한까지만 싣는다", async () => {
  const capture = {};
  const long = "가".repeat(9000);
  await directScene({ world, narration: long, client: fakeClient({ answers: CLASSROOM, capture }) });
  assert.ok(capture.state.narration.length < long.length);
});

// --- 실패 ---

test("directScene: 클라이언트 오류를 그대로 올려 보낸다", async () => {
  const fail = { ok: false, error_code: "PAYMENT_REQUIRED", message: "잔액 없음", retryable: false };
  const result = await directScene({ world, narration: NARRATION, client: fakeClient({ fail }) });
  assert.deepEqual(result, fail);
});

test("directScene: 클라이언트가 없으면 CONNECTION_FAILED다", async () => {
  const result = await directScene({ world, narration: NARRATION, client: null });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "CONNECTION_FAILED");
});

test("directScene: 서술이 비면 호출하지 않고 INVALID_ARGUMENT다", async () => {
  const capture = {};
  const result = await directScene({ world, narration: "   ", client: fakeClient({ answers: CLASSROOM, capture }) });
  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.equal(capture.state, undefined, "서술 없이 호출했다");
});

test("directScene: world.stage가 비면 저작의 공백이 드러난다", async () => {
  const bare = normalizeWorld({ world_id: "bare" });
  const result = await directScene({ world: bare, narration: NARRATION, client: fakeClient({ answers: CLASSROOM }) });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_ARGUMENT");
  assert.ok(result.message.includes("stage"));
});

test("directScene: locations만 있고 times가 비어도 거부한다", async () => {
  const partial = normalizeWorld({
    world_id: "partial",
    stage: { locations: [{ id: "a", ko: "가", visual: "v" }], times: [], weathers: ["비"] }
  });
  const result = await directScene({ world: partial, narration: NARRATION, client: fakeClient({ answers: CLASSROOM }) });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_ARGUMENT");
});

// --- sameScene ---

test("sameScene: 세 축이 같아야 같다. 화면 라벨은 비교에 쓰지 않는다", () => {
  assert.equal(sameScene(PRIOR_CLASSROOM, { ...PRIOR_CLASSROOM, place: "교실" }), true);
  assert.equal(sameScene(PRIOR_CLASSROOM, { ...PRIOR_CLASSROOM, location_id: "hallway" }), false);
  assert.equal(sameScene(PRIOR_CLASSROOM, null), false);
  assert.equal(sameScene(null, null), false);
});

// --- world 스키마 ---

test("normalizeWorld: stage를 정규화하고 id 없는 장소는 버린다", () => {
  const w = normalizeWorld({
    world_id: "x",
    stage: {
      locations: [{ id: "a", ko: "가", visual: "v" }, { ko: "id가 없다" }, "문자열"],
      times: ["밤"],
      weathers: ["비"]
    }
  });
  assert.equal(w.stage.locations.length, 1);
  assert.deepEqual(w.stage.locations[0], { id: "a", ko: "가", visual: "v" });
});

test("normalizeWorld: stage가 없는 옛 세계관도 죽지 않고 빈 집합이 된다", () => {
  const w = normalizeWorld({ world_id: "old" });
  assert.deepEqual(w.stage, { locations: [], times: [], weathers: [] });
});

// --- 실제 세계관 파일 ---

test("data/worlds: 모든 세계관이 그릴 수 있는 stage를 갖는다", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(process.cwd(), "data", "worlds");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, "세계관 파일이 없다");

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const w = normalizeWorld(raw.world);
    assert.ok(w.stage.locations.length > 0, `${file}: locations가 비었다`);
    assert.ok(w.stage.times.length > 0, `${file}: times가 비었다`);
    assert.ok(w.stage.weathers.length > 0, `${file}: weathers가 비었다`);

    const ids = new Set();
    for (const loc of w.stage.locations) {
      assert.ok(!ids.has(loc.id), `${file}: location id가 중복이다 — ${loc.id}`);
      ids.add(loc.id);
      assert.ok(loc.ko, `${file}: ${loc.id}에 한국어 이름이 없다`);
      assert.ok(loc.visual, `${file}: ${loc.id}에 visual이 없다 — 이 장소는 영영 안 그려진다`);
      // visual은 이미지 모델에 그대로 가는 영어 문장이다. 한글이 섞이면
      // resolveScene의 한글 게이트가 발동해 이미지를 아예 안 보낸다.
      assert.ok(!/[가-힣]/.test(loc.visual), `${file}: ${loc.id}의 visual에 한글이 섞였다`);
    }
  }
});
