#!/usr/bin/env node
/**
 * 미술감독(장면 판정) 골든셋 평가 — 설계 문서 10절의 M2.
 *
 * `scripts/eval_extraction.mjs`의 관례를 따른다: 골든셋을 읽고, 채널별로 돌리고,
 * 지표를 표로 찍고, 완료 기준 미달이면 exit code 1.
 *
 * 왜 이 스크립트가 따로 필요한가: 장면 판정을 서술자에서 떼어낸 덕에 **입력과
 * 정답이 고정된 오프라인 A/B**가 가능해졌다. 안 떼어냈으면 정확도를 재려고
 * 매번 70B로 산문을 생성해야 했고, 그건 느리고 비결정적이며 산문 프롬프트를
 * 고칠 때마다 결과가 달라져 회귀 측정이 사실상 불가능하다.
 *
 * 사용:
 *   node scripts/eval_scene_director.mjs                 # 실제 Jev 호출
 *   node scripts/eval_scene_director.mjs --threshold 0.5
 *   node scripts/eval_scene_director.mjs --out report.json
 *   node scripts/eval_scene_director.mjs --dry           # 호출 없이 골든셋만 점검
 *
 * **호출당 비용이 든다.** Jev는 Workers AI 무료 할당 밖이다(AI Gateway 통합
 * 과금). 골든셋 30건이면 한 번 돌릴 때 약 2만 입력 토큰이다.
 *
 * 완료 기준(설계 10절):
 *   전환 감지 recall    >= 0.90   놓치면 목표 2(이미지)가 직접 깨진다
 *   전환 감지 precision >= 0.85   과잉 감지는 돈과 깜빡임이다
 *   장소 정확도         >= 0.95   틀린 그림은 안 그린 것보다 나쁘다
 *   재방문 캐시 히트     == 1.00   구조적으로 보장되지만 측정으로 확인한다
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const { loadEnvFile } = require(path.join(ROOT, "src/server/env.js"));
loadEnvFile(path.join(ROOT, ".env"));

const { createJevClient } = require(path.join(ROOT, "src/llm/jev.js"));
const { directScene, DEFAULT_CONFIDENCE_THRESHOLD } = require(path.join(ROOT, "src/server/director.js"));
const { sceneHash } = require(path.join(ROOT, "src/server/scene.js"));
// Windows 절대 경로는 ESM import에 그대로 못 넣는다("c:" 를 프로토콜로 읽는다) —
// file:// URL로 바꿔서 넘긴다. src/core/는 ESM이라 require로는 못 읽는다.
const { normalizeWorld } = await import(pathToFileURL(path.join(ROOT, "src/core/card.js")).href);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const goldenPath = arg("golden", "tests/fixtures/golden/scene_director.golden.json");
const threshold = Number(arg("threshold", DEFAULT_CONFIDENCE_THRESHOLD));
const outPath = arg("out");
const dryRun = Boolean(arg("dry", false));

const golden = JSON.parse(fs.readFileSync(path.join(ROOT, goldenPath), "utf8"));

const worlds = new Map();
function worldFor(worldId) {
  if (!worlds.has(worldId)) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "worlds", `${worldId}.json`), "utf8"));
    worlds.set(worldId, normalizeWorld(raw.world));
  }
  return worlds.get(worldId);
}

/**
 * 골든셋 자체를 먼저 검사한다. 정답 id가 세계관의 닫힌 집합 안에 없으면 그건
 * 모델의 실패가 아니라 골든셋의 오타이고, 그걸 모델 점수로 적으면 측정이 거짓말이
 * 된다 — 돌리기 전에 멈춘다.
 */
function validateGolden() {
  const problems = [];
  for (const item of golden.cases) {
    const world = worldFor(item.world_id);
    const ids = world.stage.locations.map((l) => l.id);
    if (!ids.includes(item.location_id)) problems.push(`${item.id}: location_id '${item.location_id}'가 stage에 없다`);
    if (!world.stage.times.includes(item.time)) problems.push(`${item.id}: time '${item.time}'가 stage에 없다`);
    if (!world.stage.weathers.includes(item.weather)) problems.push(`${item.id}: weather '${item.weather}'가 stage에 없다`);
    if (item.previous_scene && !ids.includes(item.previous_scene.location_id)) {
      problems.push(`${item.id}: previous_scene.location_id '${item.previous_scene.location_id}'가 stage에 없다`);
    }
  }
  return problems;
}

/** 정답 changed는 직전 장면과 정답 세 축을 비교해 계산한다 — 두 곳에 적지 않는다. */
function expectedChanged(item) {
  const prev = item.previous_scene;
  if (!prev) return true;
  return !(prev.location_id === item.location_id && prev.time === item.time && prev.weather === item.weather);
}

const problems = validateGolden();
if (problems.length) {
  console.error("골든셋이 세계관과 어긋난다 — 고치고 다시 돌려라:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`골든셋 점검 통과: ${golden.cases.length}건 (${[...new Set(golden.cases.map((c) => c.world_id))].join(", ")})`);

if (dryRun) {
  const changed = golden.cases.filter(expectedChanged).length;
  console.log(`전환 ${changed}건 / 유지 ${golden.cases.length - changed}건. --dry라 호출하지 않는다.`);
  process.exit(0);
}

const client = createJevClient({
  accountId: process.env.CF_ACCOUNT_ID,
  apiToken: process.env.CF_API_TOKEN,
  apiBase: process.env.CF_API_BASE,
  gatewayId: process.env.CF_GATEWAY_ID,
  aigToken: process.env.CF_AIG_TOKEN,
  timeoutMs: Number(process.env.JEV_TIMEOUT_MS) || 30000
});

if (!client.isConfigured()) {
  console.error("CF_ACCOUNT_ID와 CF_API_TOKEN이 필요하다 (.env 참고).");
  process.exit(1);
}
console.log(`판정기: ${client.model}${client.gatewayId ? ` (gateway: ${client.gatewayId})` : " (직접 경로)"} · 임계 ${threshold}\n`);

const rows = [];
let inputTokens = 0;
let outputTokens = 0;
let callFailures = 0;

for (const item of golden.cases) {
  const world = worldFor(item.world_id);
  const result = await directScene({
    world,
    previousScene: item.previous_scene || null,
    narration: item.narration,
    client,
    threshold
  });

  if (!result.ok) {
    callFailures += 1;
    rows.push({ id: item.id, error: result.error_code, message: result.message });
    console.error(`  ${item.id}: 호출 실패 ${result.error_code} — ${result.message}`);
    continue;
  }

  if (result.usage) {
    inputTokens += result.usage.input_tokens;
    outputTokens += result.usage.output_tokens;
  }

  const answers = result.answers || {};
  rows.push({
    id: item.id,
    world_id: item.world_id,
    expected: { location_id: item.location_id, time: item.time, weather: item.weather, changed: expectedChanged(item) },
    got: {
      location_id: result.scene ? result.scene.location_id : null,
      time: result.scene ? result.scene.time : null,
      weather: result.scene ? result.scene.weather : null,
      changed: result.changed,
      low_confidence: result.low_confidence
    },
    // 임계를 다시 잡을 때 필요한 것은 판정 결과가 아니라 **원래 확신도**다.
    confidence: {
      place: answers.place ? answers.place.confidence : null,
      time: answers.time ? answers.time.confidence : null,
      weather: answers.weather ? answers.weather.confidence : null
    },
    raw_choice: {
      place: answers.place ? answers.place.choice : null,
      time: answers.time ? answers.time.choice : null,
      weather: answers.weather ? answers.weather.choice : null
    }
  });
}

const scored = rows.filter((r) => !r.error);

// --- 전환 감지 ---
const tp = scored.filter((r) => r.expected.changed && r.got.changed).length;
const fp = scored.filter((r) => !r.expected.changed && r.got.changed).length;
const fn = scored.filter((r) => r.expected.changed && !r.got.changed).length;
const changeRecall = tp + fn ? tp / (tp + fn) : 1;
const changePrecision = tp + fp ? tp / (tp + fp) : 1;

/**
 * 장소 정확도는 **그림을 실제로 바꾼 턴**에서만 잰다. 유지한 턴에는 그린 그림이
 * 없으므로 틀릴 장소도 없다 — 거기까지 분모에 넣으면 "안 그려서 맞았다"가
 * 정확도를 부풀린다. 이 지표가 답하려는 질문은 "그렸을 때 제대로 된 데를
 * 그렸는가"다("틀린 그림은 안 그린 것보다 나쁘다").
 */
const drawn = scored.filter((r) => r.got.changed);
const placeCorrect = drawn.filter((r) => r.got.location_id === r.expected.location_id).length;
const placeAccuracy = drawn.length ? placeCorrect / drawn.length : 1;

// 참고 지표 — 유지한 턴까지 포함해 "세 축을 다 맞혔는가"를 본다.
const allAxesCorrect = scored.filter((r) =>
  r.raw_choice.place === r.expected.location_id &&
  r.raw_choice.time === r.expected.time &&
  r.raw_choice.weather === r.expected.weather
).length;

/**
 * 재방문 캐시 히트. 같은 (world, location_id, time, weather)가 골든셋에 두 번
 * 이상 나올 때, 판정이 그때마다 같은 해시를 내는지 본다. 구조적으로 보장되지만
 * (닫힌 집합 id를 해싱하므로) 고장 2번이 정말 사라졌는지는 측정으로 확인한다.
 */
const hashByExpected = new Map();
let revisits = 0;
let revisitHits = 0;
for (const r of drawn) {
  const key = `${r.world_id}\u0000${r.expected.location_id}\u0000${r.expected.time}\u0000${r.expected.weather}`;
  const got = sceneHash({
    worldId: r.world_id,
    scene: { location_id: r.got.location_id, time: r.got.time, weather: r.got.weather }
  });
  if (hashByExpected.has(key)) {
    revisits += 1;
    if (hashByExpected.get(key) === got) revisitHits += 1;
  } else {
    hashByExpected.set(key, got);
  }
}
const cacheHitRate = revisits ? revisitHits / revisits : 1;

const round = (n) => Number(n.toFixed(3));
const report = {
  golden: golden.name,
  created: golden.created,
  model: client.model,
  gateway: client.gatewayId,
  threshold,
  cases: golden.cases.length,
  call_failures: callFailures,
  metrics: {
    change_recall: round(changeRecall),
    change_precision: round(changePrecision),
    place_accuracy: round(placeAccuracy),
    cache_hit_rate: round(cacheHitRate),
    all_axes_accuracy: round(scored.length ? allAxesCorrect / scored.length : 1)
  },
  counts: { tp, fp, fn, drawn: drawn.length, revisits },
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  rows
};

// --- 출력 ---
const GATES = [
  ["전환 감지 recall", report.metrics.change_recall, 0.9, "놓치면 목표 2(이미지)가 직접 깨진다"],
  ["전환 감지 precision", report.metrics.change_precision, 0.85, "과잉 감지는 돈과 깜빡임이다"],
  ["장소 정확도", report.metrics.place_accuracy, 0.95, "틀린 그림은 안 그린 것보다 나쁘다"],
  ["재방문 캐시 히트", report.metrics.cache_hit_rate, 1, "고장 2의 해소 확인"]
];

console.log(`\n■ 골든셋 ${golden.cases.length}건 · 임계 ${threshold}`);
if (callFailures) console.log(`  ⚠ 호출 실패 ${callFailures}건 — 아래 지표는 나머지 ${scored.length}건 기준이다`);
console.log("");
let failed = false;
for (const [label, value, gate, why] of GATES) {
  const pass = value >= gate;
  if (!pass) failed = true;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label.padEnd(20)} ${String(value).padEnd(6)} (기준 ${gate}) — ${why}`);
}
console.log(`\n  참고  세 축 모두 정답      ${report.metrics.all_axes_accuracy}`);
console.log(`  참고  전환 TP=${tp} FP=${fp} FN=${fn} · 그린 턴 ${drawn.length} · 재방문 ${revisits}`);
console.log(`  참고  토큰 input=${inputTokens} output=${outputTokens}`);

const misses = scored.filter((r) =>
  r.expected.changed !== r.got.changed || (r.got.changed && r.got.location_id !== r.expected.location_id)
);
if (misses.length) {
  console.log("\n  틀린 항목:");
  for (const r of misses) {
    const c = r.confidence;
    console.log(
      `    ${r.id.padEnd(14)} 정답 ${r.expected.location_id}/${r.expected.time}/${r.expected.weather}` +
      ` changed=${r.expected.changed}` +
      `\n      ${"".padEnd(14)} 판정 ${r.raw_choice.place}/${r.raw_choice.time}/${r.raw_choice.weather}` +
      ` changed=${r.got.changed} conf=${c.place}/${c.time}/${c.weather}`
    );
  }
}

// 신뢰도 분포 — 임계를 다시 잡을 때 쓴다(설계 13절 열린 질문 2).
for (const axis of ["place", "time", "weather"]) {
  const values = scored.map((r) => r.confidence[axis]).filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!values.length) continue;
  const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  console.log(`\n  ${axis} 신뢰도 분포: min=${values[0]} p25=${at(0.25)} 중앙=${at(0.5)} p75=${at(0.75)} max=${values[values.length - 1]}`);
}

if (outPath && outPath !== true) {
  // 절대 경로도 받는다 — path.join(ROOT, ...)만 쓰면 절대 경로가 ROOT 뒤에 붙어
  // 존재하지 않는 곳을 가리킨다.
  const target = path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath);
  fs.writeFileSync(target, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n리포트 저장: ${target}`);
}

if (callFailures) {
  console.error("\n[FAIL] 판정 호출이 실패한 항목이 있다 — 지표를 신뢰할 수 없다.");
  process.exitCode = 1;
} else if (failed) {
  console.error("\n[FAIL] 완료 기준 미달 — 설계 10절의 후퇴안 판단이 필요하다.");
  process.exitCode = 1;
} else {
  console.log("\n[OK] 네 지표 모두 기준 통과.");
}
