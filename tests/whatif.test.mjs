import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import { lastSegmentIndex, segmentIndexOf } from "../src/core/asof.js";
import {
  BRANCH_RUBRIC,
  attachBranch,
  branchIssues,
  branchSeed,
  detectCanonLeak,
  forkCandidates,
  normalizeBranch
} from "../src/core/whatif.js";
import { buildBeats, toInk, toTwee } from "../src/core/export_if.js";

function analyzeSample() {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  return analyzeNovel({ text, title: "감자", sample: { id: "gamja" } });
}

function branchPayload(analysis, at) {
  const names = analysis.characters.filter((item) => item.valid_from <= at).map((item) => item.canonical_name);
  return {
    events: [
      { type: "conflict", summary: "그는 제안을 거절하고 돌아섰다.", characters: [names[0]], confidence: 0.6 },
      { type: "movement", summary: "두 사람은 서로 다른 길로 갈라졌다.", characters: names.slice(0, 2) }
    ],
    state_changes: [
      { character: names[0], mental_state: "결심", physical_state: "이동 중", after_event_order: 2 }
    ]
  };
}

test("fork candidates are ranked decision points inside the read range", () => {
  const analysis = analyzeSample();
  const candidates = forkCandidates(analysis, { limit: 10, before: 40 });

  assert.ok(candidates.length > 0);
  candidates.forEach((candidate) => {
    assert.ok(candidate.segment >= 1 && candidate.segment <= 40);
    assert.ok(candidate.summary);
    assert.ok(candidate.evidence.quote, "분기점 후보도 원문 근거를 가져야 한다");
  });
  const scores = candidates.map((candidate) => candidate.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("branch seed contains nothing from after the fork", () => {
  const analysis = analyzeSample();
  const at = 20;
  const seed = branchSeed(analysis, at);
  const serialized = JSON.stringify(seed);

  assert.equal(seed.fork_segment, at);
  seed.recent_events.forEach((event) => assert.ok(event.segment <= at));

  // 분기 이후 단락의 문장이 시드에 한 조각도 들어가면 안 된다.
  analysis.segments
    .filter((segment) => segment.index > at)
    .forEach((segment) => {
      const sentence = segment.text.replace(/\s+/gu, " ").trim().slice(0, 20);
      if (sentence.length >= 12) assert.ok(!serialized.includes(sentence), `단락 ${segment.index} 내용이 시드에 있다`);
    });

  // 뒤늦게 등장하는 인물도 들어가면 안 된다.
  const lateNames = analysis.characters.filter((item) => item.valid_from > at).map((item) => item.canonical_name);
  lateNames.forEach((name) => {
    assert.ok(!seed.characters.some((character) => character.name === name), `${name}은 아직 등장하지 않았다`);
  });
});

test("normalizeBranch keeps generated facts separate from canon", () => {
  const analysis = analyzeSample();
  const at = 20;
  const before = JSON.stringify({ events: analysis.events, states: analysis.states });

  const branch = normalizeBranch(analysis, branchPayload(analysis, at), {
    forkSegment: at, premise: "거절했다면", model: "test:4b"
  });
  attachBranch(analysis, branch);

  assert.equal(branch.parent_branch_id, "canon");
  assert.equal(branch.fork_segment, at);
  assert.equal(branch.status, "suggested");
  branch.events.forEach((event) => {
    assert.equal(event.origin, "generated");
    assert.equal(event.status, "suggested");
    assert.equal(event.branch_id, branch.branch_id);
    assert.ok(!("source_span" in event), "생성물에 원문 근거가 있으면 안 된다");
  });
  assert.equal(branch.states[0].after_event_id, branch.events[1].event_id);

  // 원작 컬렉션은 그대로여야 한다.
  assert.equal(JSON.stringify({ events: analysis.events, states: analysis.states }), before);
  assert.equal(analysis.branches.length, 1);
});

test("characters unknown at the fork are dropped and reported", () => {
  const analysis = analyzeSample();
  const at = 20;
  const late = analysis.characters.find((item) => item.valid_from > at);
  assert.ok(late, "뒤늦게 등장하는 인물이 필요하다");

  const branch = normalizeBranch(analysis, {
    events: [{ type: "conversation", summary: "둘이 마주쳤다.", characters: [late.canonical_name, "없는사람"] }],
    state_changes: [{ character: late.canonical_name, mental_state: "불안" }]
  }, { forkSegment: at, premise: "만약", model: "test:4b" });

  assert.deepEqual(branch.events[0].characters, []);
  assert.deepEqual(branch.states, []);
  assert.ok(branch.diagnostics.unknown_characters.includes(late.canonical_name));
  assert.ok(branchIssues(analysis, branch).some((issue) => issue.code === "unknown_character"));
});

test("detects a branch that copies canon text from after the fork", () => {
  const analysis = analyzeSample();
  const at = 20;
  const future = analysis.segments.find((segment) => segment.index > at && segment.text.length > 40);
  const stolen = future.text.replace(/\s+/gu, " ").trim().slice(0, 40);

  const leaky = normalizeBranch(analysis, {
    events: [{ type: "background", summary: stolen, characters: [] }],
    state_changes: []
  }, { forkSegment: at, premise: "표절", model: "test:4b" });

  assert.ok(leaky.diagnostics.canon_leak.length > 0, "원작 인용을 잡지 못했다");
  assert.equal(leaky.diagnostics.canon_leak[0].kind, "segment");
  assert.ok(leaky.diagnostics.canon_leak[0].at > at);
  assert.ok(branchIssues(analysis, leaky).some((issue) => issue.code === "canon_leak"));

  const clean = normalizeBranch(analysis, branchPayload(analysis, at), {
    forkSegment: at, premise: "정상", model: "test:4b"
  });
  assert.deepEqual(clean.diagnostics.canon_leak, []);
});

test("canon leak check also catches copied canon event summaries", () => {
  const analysis = analyzeSample();
  const at = 20;
  const futureEvent = analysis.events.find((event) =>
    segmentIndexOf(analysis, event.segment_id) > at && event.summary.length > 20);

  const branch = {
    fork_segment: at,
    events: [{ event_id: "x", summary: futureEvent.summary }]
  };
  const leaks = detectCanonLeak(analysis, branch);
  assert.ok(leaks.length > 0);
});

test("ink export compiles a canon spine with branch choices", () => {
  const analysis = analyzeSample();
  const at = 20;
  const branch = normalizeBranch(analysis, branchPayload(analysis, at), {
    forkSegment: at, premise: "거절했다면", model: "test:4b"
  });
  attachBranch(analysis, branch);

  const ink = toInk(analysis);
  assert.match(ink, /^\/\/ 감자/u);
  assert.match(ink, /=== beat_\d+ ===/u);
  assert.match(ink, new RegExp(`=== ${branch.branch_id} ===`, "u"));
  assert.match(ink, /\* \[원작대로\] -> beat_\d+/u);
  assert.match(ink, /\* \[거절했다면\] -> branch_001/u);
  assert.match(ink, /-> END/u);

  // 모든 -> 목적지가 실제 knot으로 존재해야 컴파일된다.
  const knots = new Set([...ink.matchAll(/^=== (\w+) ===$/gmu)].map((match) => match[1]));
  [...ink.matchAll(/-> (\w+)/gu)].map((match) => match[1])
    .filter((target) => target !== "END")
    .forEach((target) => assert.ok(knots.has(target), `${target} knot이 없다`));

  // ink 문법을 깨는 문자가 본문에 남으면 안 된다.
  ink.split("\n")
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("===") && !line.startsWith("#") && !line.startsWith("*") && !line.startsWith("->"))
    .forEach((line) => assert.ok(!/[{}|]/u.test(line), `ink 본문에 특수문자: ${line}`));
});

test("twee export produces a valid passage graph", () => {
  const analysis = analyzeSample();
  const at = 20;
  attachBranch(analysis, normalizeBranch(analysis, branchPayload(analysis, at), {
    forkSegment: at, premise: "거절했다면", model: "test:4b"
  }));

  const twee = toTwee(analysis);
  assert.match(twee, /^:: StoryTitle\n감자/u);

  const dataBlock = twee.split(":: StoryData\n")[1].split("\n\n")[0];
  const meta = JSON.parse(dataBlock);
  assert.match(meta.ifid, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u);

  const passages = new Set([...twee.matchAll(/^:: ([^[\n]+?)(?: \[[^\]]*\])?$/gmu)].map((match) => match[1].trim()));
  assert.ok(passages.has(meta.start), "시작 패시지가 없다");
  [...twee.matchAll(/\[\[[^\]]*?->([^\]]+)\]\]/gu)].map((match) => match[1].trim())
    .forEach((target) => assert.ok(passages.has(target), `${target} 패시지가 없다`));
});

test("ifid is stable across exports", () => {
  const analysis = analyzeSample();
  const first = toTwee(analysis);
  const second = toTwee(analyzeSample());
  const ifidOf = (text) => JSON.parse(text.split(":: StoryData\n")[1].split("\n\n")[0]).ifid;
  assert.equal(ifidOf(first), ifidOf(second));
});

test("export respects the reading position", () => {
  const analysis = analyzeSample();
  const at = 15;
  const scoped = buildBeats(analysis, { spoilerSafe: true, at });
  scoped.beats.forEach((beat) => assert.ok(beat.segment <= at));

  const full = buildBeats(analysis, { spoilerSafe: false });
  assert.ok(full.beats.length > scoped.beats.length);
  assert.equal(full.time, lastSegmentIndex(analysis));
});

test("the rubric is defined for humans, not scored automatically", () => {
  assert.equal(BRANCH_RUBRIC.length, 3);
  BRANCH_RUBRIC.forEach((row) => {
    assert.ok(row.key && row.label && row.question);
  });
});
