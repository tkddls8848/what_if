#!/usr/bin/env node
/**
 * as-of 질의 평가.
 *
 * `scripts/eval_extraction.mjs`가 "무엇을 뽑았는가"(precision/recall)를 재는 반면,
 * 이 스크립트는 **"그 시점에 답할 수 있는가, 그리고 미래를 흘리지 않는가"**를 잰다.
 * 추출 지표가 올라도 누출이 생기면 순손실이므로 둘을 함께 봐야 한다.
 *
 * LLM을 쓰지 않는다. 채점은 전부 결정적이다.
 *
 *   node scripts/eval_asof_qa.mjs
 *   node scripts/eval_asof_qa.mjs --json
 */
import fs from "node:fs";

import { createLibrary } from "../mcp/library.js";
import {
  ToolError,
  graphAsOf,
  stateAsOf,
  timelineAsOf,
  whatifSeed,
  whoIs
} from "../mcp/tools.js";
import { segmentIndexOf } from "../src/core/asof.js";

const asJson = process.argv.includes("--json");
const fixture = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/qa/asof.qa.json", import.meta.url), "utf8"));
const library = createLibrary();

const ASKS = {
  who_is: (args) => whoIs(library, args),
  state_as_of: (args) => stateAsOf(library, args),
  timeline_as_of: (args) => timelineAsOf(library, args),
  graph_as_of: (args) => graphAsOf(library, args),
  whatif_seed: (args) => whatifSeed(library, args)
};

const results = fixture.cases.map(runCase);
const expectedRefused = results.filter((row) => row.expect === "refused").length;
const summary = {
  total: results.length,
  answerable_correct: results.filter((row) => row.expected_ok).length,
  expected_refused: expectedRefused,
  refusal_ratio: results.length ? Number((expectedRefused / results.length).toFixed(3)) : 0,
  ground_truth_errors: results.reduce((sum, row) => sum + row.ground_truth_errors.length, 0),
  leaks: results.reduce((sum, row) => sum + row.leaks.length, 0),
  failed: results.filter((row) => !row.pass).length
};

if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
  process.exit(summary.failed ? 1 : 0);
}

console.log("as-of 질의 평가\n");
results.forEach((row) => {
  const mark = row.pass ? "OK  " : "FAIL";
  console.log(`[${mark}] ${row.id} (${row.document_id} @${row.as_of}, ${row.ask}) — 기대: ${row.expect}, 실제: ${row.actual}`);
  if (!row.pass) console.log(`        ${row.reason}`);
  row.ground_truth_errors.forEach((error) => console.log(`        근거 오류: ${error}`));
  row.leaks.forEach((leak) => console.log(`        누출: ${leak}`));
});

console.log(
  `\n항목 ${summary.total} · 기대 일치 ${summary.answerable_correct}` +
  ` · 거부 기대 ${summary.expected_refused}/${summary.total} (${formatPercent(summary.refusal_ratio)})` +
  ` · 근거 오류 ${summary.ground_truth_errors} · 누출 ${summary.leaks} · 실패 ${summary.failed}`
);
if (summary.leaks) console.log("누출이 하나라도 있으면 회귀다. 시점 판정을 먼저 고친다.");
process.exit(summary.failed ? 1 : 0);

/* ------------------------------------------------------------------ */

function runCase(item) {
  const ask = ASKS[item.ask];
  const row = {
    id: item.id,
    document_id: item.document_id,
    as_of: item.as_of,
    ask: item.ask,
    expect: item.expect,
    actual: "",
    leaks: [],
    ground_truth_errors: validateGroundTruth(item),
    pass: false,
    expected_ok: false,
    reason: item.reason || ""
  };

  if (!ask) {
    row.actual = "unknown_ask";
    row.reason = `평가 스크립트가 모르는 질의 유형: ${item.ask}`;
    return row;
  }

  let payload = null;
  try {
    payload = ask({ document_id: item.document_id, as_of: item.as_of, ...(item.args || {}) });
    row.actual = "answerable";
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    row.actual = "refused";
    row.reason = item.reason ? `${item.reason} (도구 응답: ${error.message})` : error.message;
  }

  row.expected_ok = row.actual === item.expect;
  if (payload) row.leaks = findLeaks(item, payload);
  row.pass = row.expected_ok && row.ground_truth_errors.length === 0 && row.leaks.length === 0;
  return row;
}

/** 사람이 적은 최초 공개 단락과 짧은 인용이 실제 원문에 있는지 검사한다. */
function validateGroundTruth(item) {
  const records = item.ground_truth;
  if (!Array.isArray(records) || records.length === 0) return ["ground_truth가 비어 있음"];

  const entry = library.get(item.document_id);
  if (!entry) return [`document_id '${item.document_id}'의 원문을 찾을 수 없음`];

  const errors = [];
  records.forEach((record, index) => {
    const prefix = `ground_truth[${index}]`;
    const first = Number(record.first_revealed_segment);
    if (!Number.isInteger(first) || first < 1) {
      errors.push(`${prefix}.first_revealed_segment가 1 이상의 정수가 아님`);
      return;
    }
    const segment = entry.analysis.segments.find((candidate) => candidate.index === first);
    if (!segment) {
      errors.push(`${prefix}가 가리키는 ${first}번 단락이 없음`);
      return;
    }
    const quote = String(record.quote || "").trim();
    if (!quote) {
      errors.push(`${prefix}.quote가 비어 있음`);
    } else if (!segment.text.includes(quote)) {
      errors.push(`${prefix}.quote가 원문 ${first}번 단락에 없음: ${quote}`);
    }
  });

  if (item.expect === "refused") {
    records.forEach((record, index) => {
      if (Number(record.first_revealed_segment) <= Number(item.as_of)) {
        errors.push(`ground_truth[${index}]의 최초 공개가 as_of보다 뒤가 아니므로 거부 근거가 될 수 없음`);
      }
    });
  }
  return errors;
}

function formatPercent(ratio) {
  return `${Number((ratio * 100).toFixed(1))}%`;
}

/** 시점을 넘어선 사실이 응답에 섞였는지 본다. 기대 일치와 별개로 항상 검사한다. */
function findLeaks(item, payload) {
  const { analysis } = library.get(item.document_id);
  const at = item.as_of;
  const leaks = [];

  // 금지 목록은 **엔티티 이름**으로만 대조한다. 이미 읽은 단락의 사건 요약에 같은
  // 낱말이 들어 있는 것은 누출이 아니다 — 독자가 이미 읽은 문장이기 때문이다.
  const exposedNames = new Set([
    ...(payload.nodes || [])
      .filter((node) => node.type === "character" || node.type === "location")
      .map((node) => node.label),
    ...(payload.seed?.characters || []).map((character) => character.name),
    ...(payload.seed?.locations || []).map((location) => location.name),
    payload.character?.canonical_name,
    payload.known?.location
  ].filter(Boolean));

  (item.forbidden_labels || []).forEach((label) => {
    if (exposedNames.has(label)) leaks.push(`아직 등장하지 않은 엔티티가 응답에 있음: ${label}`);
  });

  (payload.events || []).forEach((event) => {
    if (Number(event.segment) > at) leaks.push(`사건 ${event.event_id}이 단락 ${event.segment}(> ${at})`);
  });
  (payload.nodes || []).forEach((node) => {
    const [type, id] = String(node.id).split(":");
    const first = firstSegmentOf(analysis, type, id);
    if (first > at) leaks.push(`노드 ${node.label}의 첫 등장이 ${first}(> ${at})`);
  });
  (payload.relations || []).forEach((relation) => {
    if (Number(relation.valid_from) > at) leaks.push(`관계 ${relation.relation_type}의 시작이 ${relation.valid_from}(> ${at})`);
  });
  (payload.seed?.recent_events || []).forEach((event) => {
    if (Number(event.segment) > at) leaks.push(`시드 사건이 단락 ${event.segment}(> ${at})`);
  });
  (payload.candidates || []).forEach((candidate) => {
    if (Number(candidate.segment) > at) leaks.push(`분기점 후보가 단락 ${candidate.segment}(> ${at})`);
  });

  const evidence = payload.known?.evidence || payload.character?.evidence;
  if (evidence && Number(evidence.segment_index) > at) {
    leaks.push(`근거 단락이 ${evidence.segment_index}(> ${at})`);
  }
  return leaks;
}

function firstSegmentOf(analysis, type, id) {
  if (type === "character") {
    return analysis.characters.find((item) => item.character_id === id)?.valid_from || 0;
  }
  if (type === "location") {
    return analysis.locations.find((item) => item.location_id === id)?.valid_from || 0;
  }
  if (type === "event") {
    const event = analysis.events.find((item) => item.event_id === id);
    return event ? segmentIndexOf(analysis, event.segment_id) : 0;
  }
  return 0;
}
