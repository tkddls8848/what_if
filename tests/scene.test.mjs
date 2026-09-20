import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import scenePkg from "../src/server/scene.js";
import budgetPkg from "../src/llm/budget.js";
import imagePkg from "../src/llm/image.js";

const { resolveScene, sceneHash, seedFromHash, buildPrompt, detectImageExtension, NEGATIVE_PROMPT } = scenePkg;
const { createBudget } = budgetPkg;
const { IMAGE_MODELS, DEFAULT_IMAGE_MODEL } = imagePkg;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-scene-"));
}

function budget() {
  return createBudget({ now: () => new Date("2026-09-05T10:00:00Z") });
}

// world.setting/tone은 한국어 그대로 남겨 둔다 — buildPrompt가 더 이상 이 필드들을
// 쓰지 않는다는 것 자체가 회귀 테스트의 핵심이다(아래 "world.tone/setting은..." 참고).
// 이미지 프롬프트에 실제로 쓰이는 것은 visual_style(영어)뿐이다.
const world = {
  world_id: "demo",
  setting: "비 오는 밤의 고등학교, 3학년 2반 교실만 불이 켜져 있다.",
  tone: "차분하고 건조하다.",
  visual_style: "muted anime-style background art, cool blue-grey palette, soft fluorescent light, wet reflections"
};
// location_id/time/weather가 캐시 키이고, place는 화면 라벨(한국어)이며, visual만
// 이미지 프롬프트의 재료(영어)다 — Problem A의 수정 전체가 이 분리에 달려 있다.
// location_id와 visual은 둘 다 세계관 파일에 authored된 값을 director가 조회해
// 실어 준 것이지, 서술자가 매 턴 생성한 것이 아니다.
const scene = {
  location_id: "classroom_3_2",
  place: "3학년 2반 교실",
  time: "밤",
  weather: "비",
  visual: "empty Korean high school classroom at night, fluorescent light on rows of desks, rain streaking the windows"
};

// 실제 flux-1-schnell이 돌려주는 것과 같은 형식(JPEG, 매직 바이트 FF D8 FF)의
// base64. "AAAA"(=0x00 0x00 0x00) 같은 임의의 바이트는 더 이상 쓰지 않는다 —
// resolveScene이 이제 응답 바이트에서 실제 이미지 형식을 감지하므로, 매직
// 바이트가 없는 가짜 데이터는 (의도적으로) 구조화 오류가 된다.
const JPEG_B64 = "/9j/4AAQSkZJRg==";
const PNG_B64 = "iVBORw0KGgo=";

function fakeImageClient({ base64 = JPEG_B64, fail = null, onGenerate = null, model } = {}) {
  return {
    calls: 0,
    model, // 생략하면 undefined — 기존 테스트들은 이 필드를 몰랐고, resolveScene은
    // model을 모르는 client를 "negative_prompt 미지원"으로 보수적으로 취급한다
    // (src/server/scene.js 참고). 아래 negative prompt 전용 테스트만 명시적으로 채운다.
    async generate(args) {
      this.calls += 1;
      if (onGenerate) onGenerate(args);
      if (fail) return fail;
      return { ok: true, base64, usage: { steps: args.steps || 4, tiles: 1 } };
    }
  };
}

test("resolveScene: 캐시 미스는 클라이언트를 한 번 부르고 파일을 쓴다", async () => {
  const dir = tmpRoot();
  try {
    const captured = [];
    const client = fakeImageClient({ onGenerate: (args) => captured.push(args) });
    const result = await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.cached, false);
    assert.equal(client.calls, 1);

    // 실제 응답은 JPEG다 — 확장자는 .png로 하드코딩하지 않고 감지한 형식을 쓴다.
    const filePath = path.join(dir, "data", "scenes", "demo", `${sceneHash({ worldId: "demo", scene })}.jpg`);
    assert.ok(fs.existsSync(filePath), "파일이 써지지 않았다");
    assert.equal(fs.readFileSync(filePath).toString("base64"), JPEG_B64);
    assert.equal(result.url, `/data/scenes/demo/${sceneHash({ worldId: "demo", scene })}.jpg`);

    // 회귀 가드: seed는 절대 client.generate로 넘기지 않는다(실제 API가 그 필드의
    // 존재만으로 400을 낸다 — image_client.test.mjs가 클라이언트 쪽을 확인하고,
    // 여기서는 scene.js가 애초에 그 인자를 만들어 넘기지 않는지 확인한다).
    assert.ok(!Object.prototype.hasOwnProperty.call(captured[0], "seed"), "resolveScene이 seed를 넘겼다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: PNG 응답(매직 바이트 89 50 4E 47 ...)은 .png로 쓴다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient({ base64: PNG_B64 });
    const result = await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.cached, false);

    const filePath = path.join(dir, "data", "scenes", "demo", `${sceneHash({ worldId: "demo", scene })}.png`);
    assert.ok(fs.existsSync(filePath), "PNG 파일이 써지지 않았다");
    assert.equal(fs.readFileSync(filePath).toString("base64"), PNG_B64);
    assert.equal(result.url, `/data/scenes/demo/${sceneHash({ worldId: "demo", scene })}.png`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: 어느 형식과도 매직 바이트가 안 맞으면 구조화 오류이고 아무것도 쓰지 않는다", async () => {
  const dir = tmpRoot();
  try {
    // "AAAA" → 0x00 0x00 0x00, JPEG도 PNG도 아니다.
    const client = fakeImageClient({ base64: "AAAA" });
    const result = await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, "BAD_RESPONSE");

    const sceneDir = path.join(dir, "data", "scenes", "demo");
    const exists = fs.existsSync(sceneDir) && fs.readdirSync(sceneDir).length > 0;
    assert.equal(exists, false, "형식을 알 수 없는데 파일이 써졌다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectImageExtension: JPEG/PNG 매직 바이트를 구분하고, 둘 다 아니면 null이다", () => {
  assert.equal(detectImageExtension(Buffer.from(JPEG_B64, "base64")), "jpg");
  assert.equal(detectImageExtension(Buffer.from(PNG_B64, "base64")), "png");
  assert.equal(detectImageExtension(Buffer.from("AAAA", "base64")), null);
  assert.equal(detectImageExtension(Buffer.alloc(0)), null, "빈 버퍼도 죽지 않고 null이어야 한다");
});

test("resolveScene: 캐시 적중은 클라이언트를 아예 부르지 않는다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient();
    await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(client.calls, 1);

    const second = fakeImageClient(); // 새 클라이언트 — 불리면 calls가 늘어난다
    const result = await resolveScene({ world, scene, client: second, budget: budget(), rootDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.cached, true);
    assert.equal(second.calls, 0, "캐시가 있는데 클라이언트를 불렀다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sceneHash/seedFromHash: 같은 world_id+장면은 같은 키와 시드를 낸다", () => {
  const a = sceneHash({ worldId: "demo", scene });
  const b = sceneHash({ worldId: "demo", scene: { ...scene } });
  assert.equal(a, b);
  assert.equal(seedFromHash(a), seedFromHash(b));
  assert.ok(Number.isInteger(seedFromHash(a)) && seedFromHash(a) > 0, "시드는 양의 정수여야 한다");
});

test("sceneHash: 장소 id·시간·날씨 중 하나만 달라도 다른 키를 낸다", () => {
  const base = sceneHash({ worldId: "demo", scene });
  assert.notEqual(base, sceneHash({ worldId: "demo", scene: { ...scene, location_id: "rooftop" } }));
  assert.notEqual(base, sceneHash({ worldId: "demo", scene: { ...scene, time: "낮" } }));
  assert.notEqual(base, sceneHash({ worldId: "demo", scene: { ...scene, weather: "맑음" } }));
  assert.notEqual(base, sceneHash({ worldId: "other-world", scene }));
});

// 이게 이 설계 전체가 고치려던 고장이다. 예전 캐시 키는 서술자가 매 턴 새로
// 생성한 한국어 자유 문자열(place)이었다 — 같은 곳을 "교실"과 "3학년 2반 교실"로
// 다르게 부르면 다른 해시가 되어 같은 곳에 새 그림이 생겼다. 이제 키의 재료는
// 닫힌 집합의 id라, 라벨이 어떻게 흔들려도 같은 곳은 같은 파일이다.
test("sceneHash: 화면 라벨(place)이 달라도 location_id가 같으면 같은 키다", () => {
  const a = sceneHash({ worldId: "demo", scene });
  const b = sceneHash({ worldId: "demo", scene: { ...scene, place: "교실" } });
  assert.equal(a, b);
});

test("resolveScene: 같은 세계관에 다른 장면은 다른 파일을 만든다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient();
    const first = await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    const second = await resolveScene({
      world,
      scene: { location_id: "rooftop", place: "옥상", time: "낮", weather: "맑음", visual: "empty rooftop under a clear sky, waist-high railing, distant city lights" },
      client, budget: budget(), rootDir: dir
    });
    assert.notEqual(first.url, second.url);
    assert.equal(client.calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: 클라이언트 실패는 구조화 오류이고 파일을 쓰지 않는다", async () => {
  const dir = tmpRoot();
  try {
    const fail = { ok: false, error_code: "RATE_LIMITED", message: "한도", retryable: true };
    const client = fakeImageClient({ fail });
    const result = await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, "RATE_LIMITED");

    const sceneDir = path.join(dir, "data", "scenes", "demo");
    const exists = fs.existsSync(sceneDir) && fs.readdirSync(sceneDir).length > 0;
    assert.equal(exists, false, "실패했는데 파일이 남았다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: 이미지 생성을 예산에 기록한다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient();
    const b = budget();
    await resolveScene({ world, scene, client, budget: b, rootDir: dir });
    assert.ok(b.snapshot().used > 0, "이미지 비용이 예산에 반영되지 않았다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPrompt: 비어 있음 절을 포함하고 인물 이름은 넣지 않는다", () => {
  const worldWithProtagonist = { ...world, protagonist: { name: "한서린" } };
  const prompt = buildPrompt({ world: worldWithProtagonist, scene });
  assert.ok(prompt.includes("empty"), "비어 있음 절이 없다");
  assert.ok(!prompt.includes("한서린"), "인물 이름이 프롬프트에 들어갔다");
  assert.ok(prompt.length <= 2048);
  assert.ok(prompt.includes(scene.visual), "scene.visual이 프롬프트에 없다");
});

// --- Problem A: 프롬프트는 영어여야 한다 (플레이어 리포트 — 배경이 전부 "중국풍
// 짝퉁"처럼 나온다. 원인은 buildPrompt가 한국어 setting/tone/장면줄을 그대로 실어
// FLUX가 사실상 노이즈만 받았던 것) ---

test("buildPrompt: 결과에 한글이 전혀 없다 (demo 세계관)", () => {
  const prompt = buildPrompt({ world, scene });
  assert.ok(!/[가-힣]/.test(prompt), `한글이 섞였다: ${prompt}`);
});

test("buildPrompt: world.tone과 한국어 world.setting은 결과에 없다", () => {
  const prompt = buildPrompt({ world, scene });
  assert.ok(!prompt.includes(world.tone), "tone이 프롬프트에 샜다 — tone은 문체 지시이지 그림 재료가 아니다");
  assert.ok(!prompt.includes(world.setting), "한국어 setting이 프롬프트에 샜다");
  assert.ok(!prompt.includes(scene.place), "한국어 place가 프롬프트에 샜다");
  assert.ok(!prompt.includes(scene.time), "한국어 time이 프롬프트에 샜다");
  assert.ok(!prompt.includes(scene.weather), "한국어 weather가 프롬프트에 샜다");
});

test("buildPrompt: world.visual_style과 scene.visual을 재료로 쓴다", () => {
  const prompt = buildPrompt({ world, scene });
  assert.ok(prompt.includes(world.visual_style), "visual_style이 프롬프트에 없다");
  assert.ok(prompt.includes(scene.visual), "scene.visual이 프롬프트에 없다");
});

test("buildPrompt: visual_style이 길면 scene.visual은 그대로 두고 visual_style만 잘린다", () => {
  const longWorld = { world_id: "demo", visual_style: "muted style detail ".repeat(200) };
  const prompt = buildPrompt({ world: longWorld, scene });
  assert.ok(prompt.length <= 2048);
  assert.ok(prompt.includes(scene.visual), "scene.visual이 잘렸다 — 이번 턴 재료라 보호되어야 한다");
  assert.ok(prompt.includes("empty"), "비어 있음 절이 잘렸다");
  assert.ok(!/[가-힣]/.test(prompt), `한글이 섞였다: ${prompt}`);
});

test("resolveScene: scene이 없으면 INVALID_ARGUMENT다", async () => {
  const dir = tmpRoot();
  try {
    const result = await resolveScene({ world, scene: null, client: fakeImageClient(), budget: budget(), rootDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, "INVALID_ARGUMENT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: world_id가 없으면 INVALID_ARGUMENT다", async () => {
  const dir = tmpRoot();
  try {
    const result = await resolveScene({ world: {}, scene, client: fakeImageClient(), budget: budget(), rootDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, "INVALID_ARGUMENT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A4: visual이 없는 장면은 한국어로 대체 조립하지 않고 건너뛴다 ---

test("resolveScene: scene.visual이 없으면 클라이언트를 부르지 않고 INVALID_ARGUMENT로 건너뛴다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient();
    const sceneWithoutVisual = { place: "체육관 뒤편", time: "저녁", weather: "흐림" }; // visual 누락
    const result = await resolveScene({ world, scene: sceneWithoutVisual, client, budget: budget(), rootDir: dir });

    assert.equal(result.ok, false);
    assert.equal(result.error_code, "INVALID_ARGUMENT");
    assert.equal(client.calls, 0, "visual이 없는데 이미지 API를 불렀다");

    const sceneDir = path.join(dir, "data", "scenes", "demo");
    const exists = fs.existsSync(sceneDir) && fs.readdirSync(sceneDir).length > 0;
    assert.equal(exists, false, "생성을 건너뛰었는데 파일이 남았다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: visual이 빈 문자열이거나 공백뿐이어도 같은 경로로 건너뛴다", async () => {
  const dir = tmpRoot();
  try {
    for (const visual of ["", "   "]) {
      const client = fakeImageClient();
      const result = await resolveScene({
        world, scene: { place: "옥상", time: "낮", weather: "맑음", visual }, client, budget: budget(), rootDir: dir
      });
      assert.equal(result.ok, false);
      assert.equal(result.error_code, "INVALID_ARGUMENT");
      assert.equal(client.calls, 0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A3: 한글이 섞인 프롬프트는(narrator가 규칙을 어겨 visual에 한국어를 썼을 때도)
// 절대 전송하지 않는다 — 잘못된 이미지가 아무 이미지도 없는 것보다 나쁘다 ---

test("resolveScene: narrator가 visual에 한글을 섞어 써도 프롬프트를 전송하지 않고 INTERNAL로 멈춘다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient();
    const brokenScene = { place: "옥상", time: "낮", weather: "맑음", visual: "empty rooftop, 비 오는 밤" }; // 규칙 위반
    const result = await resolveScene({ world, scene: brokenScene, client, budget: budget(), rootDir: dir });

    assert.equal(result.ok, false);
    assert.equal(result.error_code, "INTERNAL");
    assert.equal(client.calls, 0, "한글 섞인 프롬프트를 실제로 전송했다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 실제 저장된 세계관으로: demo.json/lighthouse.json에 저자가 쓴 visual_style이
// 진짜로 영어이고, buildPrompt 결과가 두 세계관 모두에서 한글 없이 나오는지 확인한다
// (스펙 A5: 두 세계관 다 authored visual_style을 요구한다) ---

test("buildPrompt: demo.json의 visual_style로 조립한 프롬프트는 한글이 전혀 없다", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../data/worlds/demo.json", import.meta.url), "utf8"));
  assert.ok(raw.world.visual_style && raw.world.visual_style.length > 0, "demo.json에 visual_style이 없다");
  assert.ok(!/[가-힣]/.test(raw.world.visual_style), "demo.json의 visual_style에 한글이 섞였다");

  const prompt = buildPrompt({ world: raw.world, scene });
  assert.ok(!/[가-힣]/.test(prompt), `demo 프롬프트에 한글이 섞였다: ${prompt}`);
});

test("buildPrompt: lighthouse.json의 visual_style은 demo와 다른, 그 자체로 영어인 아트 디렉션이다", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../data/worlds/lighthouse.json", import.meta.url), "utf8"));
  assert.ok(raw.world.visual_style && raw.world.visual_style.length > 0, "lighthouse.json에 visual_style이 없다");
  assert.ok(!/[가-힣]/.test(raw.world.visual_style), "lighthouse.json의 visual_style에 한글이 섞였다");

  const demoRaw = JSON.parse(fs.readFileSync(new URL("../data/worlds/demo.json", import.meta.url), "utf8"));
  assert.notEqual(raw.world.visual_style, demoRaw.world.visual_style, "두 세계관의 아트 디렉션이 같으면 안 된다");

  const lighthouseScene = { place: "부두", time: "밤", weather: "폭풍", visual: "storm-lashed wooden pier, snow blowing sideways, a single oil lamp" };
  const prompt = buildPrompt({ world: raw.world, scene: lighthouseScene });
  assert.ok(!/[가-힣]/.test(prompt), `lighthouse 프롬프트에 한글이 섞였다: ${prompt}`);
});

// --- negative prompt: negative_prompt를 받는 모델(phoenix-1.0)에만 실어 보내고,
// 받지 않는 모델(flux-1-schnell, lucid-origin)에는 기존처럼 긍정 문구만 쓴다 ---

const FLUX = "@cf/black-forest-labs/flux-1-schnell";
const PHOENIX = "@cf/leonardo/phoenix-1.0";
const LUCID = "@cf/leonardo/lucid-origin";

test("NEGATIVE_PROMPT: 한글이 없고, 사람 관련 배제 항목을 담고 있다", () => {
  assert.ok(!/[가-힣]/.test(NEGATIVE_PROMPT), `한글이 섞였다: ${NEGATIVE_PROMPT}`);
  for (const term of ["people", "face", "hands", "text", "watermark"]) {
    assert.ok(NEGATIVE_PROMPT.includes(term), `NEGATIVE_PROMPT에 '${term}'이 없다`);
  }
});

test("resolveScene: negative_prompt를 받는 모델(phoenix-1.0)에는 negativePrompt를 실어 보낸다", async () => {
  const dir = tmpRoot();
  try {
    const captured = [];
    const client = fakeImageClient({ base64: JPEG_B64, onGenerate: (args) => captured.push(args), model: PHOENIX });
    const result = await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(result.ok, true);
    assert.equal(captured[0].negativePrompt, NEGATIVE_PROMPT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: negative_prompt가 없는 모델(flux-1-schnell)에는 negativePrompt를 보내지 않는다", async () => {
  const dir = tmpRoot();
  try {
    const captured = [];
    const client = fakeImageClient({ base64: JPEG_B64, onGenerate: (args) => captured.push(args), model: FLUX });
    await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(captured[0].negativePrompt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: negative_prompt가 없는 모델(lucid-origin)에도 negativePrompt를 보내지 않는다", async () => {
  const dir = tmpRoot();
  try {
    const captured = [];
    const client = fakeImageClient({ base64: JPEG_B64, onGenerate: (args) => captured.push(args), model: LUCID });
    await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(captured[0].negativePrompt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: model을 모르는 client(과거 스타일 페이크)에는 negativePrompt를 보내지 않는다 — 회귀 안전 폴백", async () => {
  const dir = tmpRoot();
  try {
    const captured = [];
    // model 필드를 아예 안 채운 페이크 — 기존(교체 전) 테스트들이 쓰던 모양 그대로.
    const client = fakeImageClient({ base64: JPEG_B64, onGenerate: (args) => captured.push(args) });
    await resolveScene({ world, scene, client, budget: budget(), rootDir: dir });
    assert.equal(captured[0].negativePrompt, undefined, "model을 모르는데 negative_prompt를 만들어 보냈다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: negative_prompt를 실제로 보내는 모델에서는 프롬프트 본문의 긍정형 '사람 없음' 문구를 뺀다", async () => {
  const dir = tmpRoot();
  try {
    const captured = [];
    const phoenixClient = fakeImageClient({ base64: JPEG_B64, onGenerate: (args) => captured.push(args), model: PHOENIX });
    await resolveScene({ world, scene, client: phoenixClient, budget: budget(), rootDir: dir });
    assert.ok(!captured[0].prompt.includes("no people"), "phoenix용 프롬프트에 긍정형 '사람 없음' 문구가 남아 있다 — negative_prompt와 중복이다");

    const dir2 = tmpRoot();
    try {
      const captured2 = [];
      const fluxClient = fakeImageClient({ base64: JPEG_B64, onGenerate: (args) => captured2.push(args), model: FLUX });
      await resolveScene({ world, scene, client: fluxClient, budget: budget(), rootDir: dir2 });
      assert.ok(captured2[0].prompt.includes("no people"), "negative_prompt가 없는 flux는 여전히 긍정형 문구가 있어야 한다(회귀 없음)");
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPrompt: omitEmptinessClause를 true로 주면 EMPTINESS_CLAUSE 문구가 빠지고, 기본값(false)이면 기존과 동일하다", () => {
  const withClause = buildPrompt({ world, scene });
  const withoutClause = buildPrompt({ world, scene, omitEmptinessClause: true });
  assert.ok(withClause.includes("no people"));
  assert.ok(!withoutClause.includes("no people"));
  assert.ok(withoutClause.includes(scene.visual), "omit 옵션이 scene.visual까지 지우면 안 된다");
  assert.ok(!/[가-힣]/.test(withoutClause));
});

test("resolveScene: client가 model을 모르면 예산 기록은 DEFAULT_IMAGE_MODEL 단가를 쓴다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient(); // model 없음
    const b = budget();
    await resolveScene({ world, scene, client, budget: b, rootDir: dir });
    const expected = budgetPkg.neuronsForImage({ model: DEFAULT_IMAGE_MODEL, tiles: 1, steps: 4 });
    assert.ok(Math.abs(b.snapshot().used - expected) < 0.0001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: client.model이 레지스트리에 있는 모델이면 그 모델 단가로 예산을 기록한다", async () => {
  const dir = tmpRoot();
  try {
    const client = fakeImageClient({ model: LUCID });
    const b = budget();
    await resolveScene({ world, scene, client, budget: b, rootDir: dir });
    const expected = budgetPkg.neuronsForImage({ model: LUCID, tiles: 1, steps: 4 });
    assert.ok(Math.abs(b.snapshot().used - expected) < 0.0001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveScene: model을 모르는 client가 넘겨받는 IMAGE_MODELS 등록 확인 — phoenix는 acceptsNegativePrompt다", () => {
  assert.ok(IMAGE_MODELS[PHOENIX].acceptsNegativePrompt);
  assert.ok(!IMAGE_MODELS[FLUX].acceptsNegativePrompt);
  assert.ok(!IMAGE_MODELS[LUCID].acceptsNegativePrompt);
});
