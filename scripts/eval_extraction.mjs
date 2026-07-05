#!/usr/bin/env node
/**
 * 추출 품질 평가 스크립트 (골든셋 기반 precision/recall).
 *
 * 채널:
 *  - rule            : 브라우저 규칙 분석기만 (LLM 없음, 항상 실행 가능)
 *  - rule+fixture    : 녹화된 LLM payload fixture를 병합한 결과 (LLM 없음)
 *  - rule+live:MODEL : --live MODEL 지정 시 실제 Ollama 장면 파이프라인 실행
 *
 * 사용:
 *  node scripts/eval_extraction.mjs
 *  node scripts/eval_extraction.mjs --live qwen3.5:4b --out report.json
 *
 * 주의: 골든셋은 완전한 정답이 아니라 자체 기준선이다. acceptable 목록에 없는
 * 유효한 추출이 있으면 precision이 실제보다 낮게 나올 수 있다 (하한선).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeNovel, buildDynamicSeedLexicon, applyOllamaPayload } from "../src/analyzer.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const textPath = arg("text", "texts/gamja.txt");
const goldenPath = arg("golden", "tests/fixtures/golden/gamja.golden.json");
const payloadPath = arg("payload", "tests/fixtures/ollama_gamja_payload.json");
const liveModel = arg("live");
const outPath = arg("out");

const text = fs.readFileSync(path.join(ROOT, textPath), "utf8");
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, goldenPath), "utf8"));

function normalize(name) {
  return String(name || "").replace(/\s+/g, "").toLowerCase();
}

function scoreChannel(extractedNames, spec) {
  const extracted = [...new Set(extractedNames.map(normalize).filter(Boolean))];
  const requiredGroups = spec.required.map((item) => new Set([item.name, ...(item.aliases || [])].map(normalize)));
  const acceptable = new Set([...(spec.acceptable || []).map(normalize)]);
  const banned = new Set([...(spec.banned || []).map(normalize)]);
  requiredGroups.forEach((group) => group.forEach((name) => acceptable.add(name)));

  const foundRequired = requiredGroups.filter((group) => extracted.some((name) => group.has(name)));
  const correct = extracted.filter((name) => acceptable.has(name));
  const bannedHits = extracted.filter((name) => banned.has(name));

  const recall = requiredGroups.length ? foundRequired.length / requiredGroups.length : 1;
  const precision = extracted.length ? correct.length / extracted.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    extracted_total: extracted.length,
    required_found: foundRequired.length,
    required_total: requiredGroups.length,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    banned_hits: bannedHits,
    missing: requiredGroups
      .filter((group) => !extracted.some((name) => group.has(name)))
      .map((group) => [...group][0]),
    unexpected: extracted.filter((name) => !acceptable.has(name)).slice(0, 15)
  };
}

function evaluate(analysis) {
  const active = (items) => items.filter((item) => item.status !== "rejected");
  return {
    characters: scoreChannel(active(analysis.characters).map((item) => item.canonical_name), golden.characters),
    locations: scoreChannel(active(analysis.locations).map((item) => item.name), golden.locations)
  };
}

function analyzeRuleOnly() {
  return analyzeNovel({ text, title: "eval", sample: { id: "custom" } });
}

function analyzeWithPayload(payload, model) {
  const input = {
    text,
    title: "eval",
    sample: { id: "custom" },
    seedLexicon: buildDynamicSeedLexicon(payload, model),
    engine: "ollama-dynamic-seed-ko-adapter"
  };
  const analysis = analyzeNovel(input);
  applyOllamaPayload(analysis, payload, model);
  return analysis;
}

async function runLive(model) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { createOllamaClient } = require("../src/server/ollama_client.js");
  const pipeline = require("../src/server/pipeline.js");

  const client = createOllamaClient({
    baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 300000
  });
  process.stderr.write(`[live] ${model} 장면 파이프라인 실행 중...\n`);
  const result = await pipeline.runScenePipeline({
    text,
    model,
    client,
    onProgress: (p) => process.stderr.write(`[live] ${p.stage} ${p.scene}/${p.total}\n`)
  });
  if (result.error) {
    process.stderr.write(`[live] 실패: ${result.error.error_code} ${result.error.message}\n`);
    return null;
  }
  return { analysis: analyzeWithPayload(result.payload, model), diagnostics: result.diagnostics };
}

const report = {
  generated_at: new Date().toISOString(),
  text: textPath,
  golden: goldenPath,
  channels: {}
};

report.channels.rule = evaluate(analyzeRuleOnly());

if (payloadPath) {
  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, payloadPath), "utf8"));
  report.channels["rule+fixture"] = evaluate(analyzeWithPayload(payload, "fixture"));
}

if (liveModel && liveModel !== true) {
  const live = await runLive(liveModel);
  if (live) {
    report.channels[`rule+live:${liveModel}`] = evaluate(live.analysis);
    report.channels[`rule+live:${liveModel}`].pipeline_diagnostics = {
      scenes_total: live.diagnostics.scenes_total,
      scenes_failed: live.diagnostics.scenes_failed.length,
      prompt_eval_total: live.diagnostics.prompt_eval_total,
      calls: live.diagnostics.calls
    };
  }
}

// 출력
const pad = (value, width) => String(value).padEnd(width);
console.log(`\n골든셋 평가: ${golden.document}`);
console.log("(precision은 acceptable 목록 기준 하한선이다)\n");
for (const [channel, result] of Object.entries(report.channels)) {
  console.log(`■ ${channel}`);
  for (const kind of ["characters", "locations"]) {
    const r = result[kind];
    console.log(
      `  ${pad(kind, 11)} P=${r.precision} R=${r.recall} F1=${r.f1}` +
      ` (필수 ${r.required_found}/${r.required_total}, 추출 ${r.extracted_total})`
    );
    if (r.missing.length) console.log(`    누락: ${r.missing.join(", ")}`);
    if (r.banned_hits.length) console.log(`    ⚠ 오탐(banned): ${r.banned_hits.join(", ")}`);
  }
  console.log("");
}

for (const [channel, result] of Object.entries(report.channels)) {
  const bans = [...result.characters.banned_hits, ...result.locations.banned_hits];
  if (bans.length) {
    console.error(`[FAIL] ${channel} 채널에서 금지 오탐 발견: ${bans.join(", ")}`);
    process.exitCode = 1;
  }
}

if (outPath && outPath !== true) {
  fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(report, null, 2), "utf8");
  console.log(`리포트 저장: ${outPath}`);
}
