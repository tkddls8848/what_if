import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel, refreshNarrativeTime } from "../src/analyzer.js";
import { auditAnalysis, violationsFor } from "../src/core/audit.js";

function analyzeSample() {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  return analyzeNovel({ text, title: "감자", sample: { id: "gamja" } });
}

function codes(result) {
  return new Set(result.violations.map((violation) => violation.code));
}

test("analysis carries an audit report in diagnostics", () => {
  const analysis = analyzeSample();
  assert.ok(analysis.diagnostics.audit);
  assert.equal(
    analysis.diagnostics.audit.counts.total,
    analysis.diagnostics.audit.violations.length
  );
  assert.equal(analysis.diagnostics.audit.counts.scope, 0, "규칙 채널은 원문 offset을 벗어나면 안 된다");
  analysis.diagnostics.audit.violations.forEach((violation) => {
    assert.ok(["actor", "scope", "polarity", "state", "temporal"].includes(violation.code));
    assert.ok(["error", "warn"].includes(violation.severity));
    assert.ok(violation.message);
  });
});

test("detects an event whose participant has no mention in the segment (actor)", () => {
  const analysis = analyzeSample();
  const clean = analysis.events.find((event) =>
    !violationsFor(analysis.diagnostics.audit, "event", event.event_id).some((item) => item.code === "actor")
  );
  const ghostId = "char_ghost";
  clean.characters = [...clean.characters, ghostId];

  const result = auditAnalysis(analysis);
  const found = violationsFor(result, "event", clean.event_id).filter((item) => item.code === "actor");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "error");
});

test("detects evidence offsets outside the anchored segment (scope)", () => {
  const analysis = analyzeSample();
  const event = analysis.events[0];
  event.source_span = { char_start: event.source_span.char_start, char_end: event.source_span.char_end + 100000 };

  const result = auditAnalysis(analysis);
  const found = violationsFor(result, "event", event.event_id).filter((item) => item.code === "scope");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "error");
});

test("flags a positive action extracted from a negated sentence (polarity)", () => {
  const analysis = analyzeNovel({
    text: "복녀는 칠성문 밖으로 나가지 않았다.\n\n복녀는 칠성문 밖으로 나갔다.",
    title: "polarity",
    sample: { id: "custom" }
  });
  const polarity = analysis.diagnostics.audit.violations.filter((violation) => violation.code === "polarity");
  assert.ok(polarity.length >= 1);
  assert.ok(polarity.every((violation) => violation.severity === "warn"));
  assert.ok(polarity.every((violation) => violation.segment_index === 1), "부정문이 있는 첫 단락만 걸려야 한다");
});

test("detects a location that has not appeared yet (state)", () => {
  const analysis = analyzeSample();
  const state = analysis.states.find((item) => item.location_id);
  const location = analysis.locations.find((item) => item.location_id === state.location_id);
  location.valid_from = analysis.segments.length; // 문서 끝으로 밀어 미등장 상태로 만든다

  const result = auditAnalysis(analysis);
  const found = violationsFor(result, "state", state.state_id).filter((item) => item.code === "state");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /아직 등장하지 않은 장소/u);
});

test("detects inverted and overlapping intervals (temporal)", () => {
  const analysis = analyzeSample();
  const target = analysis.states.find((item) => item.valid_to !== null);
  target.valid_to = target.valid_from - 5;

  const relation = analysis.relations[0];
  relation.valid_to = relation.valid_from - 1;

  const result = auditAnalysis(analysis);
  assert.ok(violationsFor(result, "state", target.state_id).some((item) => item.code === "temporal"));
  assert.ok(violationsFor(result, "relation", relation.relation_id).some((item) => item.code === "temporal"));
});

test("rejected items are excluded from the audit", () => {
  const analysis = analyzeSample();
  const before = auditAnalysis(analysis).counts.total;
  analysis.events.forEach((event) => { event.status = "rejected"; });
  analysis.states.forEach((state) => { state.status = "rejected"; });
  const after = auditAnalysis(analysis);
  assert.ok(after.counts.total < before);
  assert.equal(after.counts.actor, 0);
  assert.equal(after.counts.polarity, 0);
});

test("refreshNarrativeTime re-derives intervals and audit after edits", () => {
  const analysis = analyzeSample();
  analysis.states.forEach((state) => { delete state.valid_from; delete state.valid_to; });
  analysis.characters.forEach((character) => { delete character.valid_from; });
  analysis.diagnostics.audit = null;

  refreshNarrativeTime(analysis);

  assert.ok(analysis.diagnostics.audit);
  assert.ok(analysis.states.every((state) => Number.isFinite(state.valid_from)));
  assert.ok(analysis.characters.every((character) => Number.isFinite(character.valid_from)));
  assert.ok(codes(analysis.diagnostics.audit).size > 0);
});
