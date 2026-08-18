import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import { asOf, lastSegmentIndex } from "../src/core/asof.js";
import { recapAt } from "../src/core/recap.js";
import { createLibrary } from "../mcp/library.js";
import { arcSummary } from "../mcp/tools.js";

function analyzeSample() {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  return analyzeNovel({ text, title: "감자", sample: { id: "gamja" } });
}

test("recap counts exactly the events as_of let through", () => {
  const analysis = analyzeSample();
  const at = 30;
  const recap = recapAt(analysis, at);
  const scoped = asOf(analysis, at);

  const total = Object.values(recap.event_type_counts).reduce((sum, count) => sum + count, 0);
  assert.equal(total, scoped.events.length);
  assert.equal(recap.progress.segment, at);
  assert.equal(recap.progress.of, lastSegmentIndex(analysis));
});

test("recap leaks nothing past the reading position", () => {
  const analysis = analyzeSample();
  const at = 20;
  const recap = recapAt(analysis, at);

  recap.characters.forEach((character) => {
    assert.ok(character.first_seen_segment <= at, `${character.name} first seen at ${character.first_seen_segment}`);
  });

  const later = recapAt(analysis, lastSegmentIndex(analysis));
  assert.ok(later.characters.length >= recap.characters.length);
});

test("recap upper bound is clamped to the document", () => {
  const analysis = analyzeSample();
  const last = lastSegmentIndex(analysis);
  assert.equal(recapAt(analysis, last + 500).progress.segment, last);
  assert.equal(recapAt(analysis, 1).progress.segment, 1);
});

test("spoilerSafe false opens the whole document", () => {
  const analysis = analyzeSample();
  const open = recapAt(analysis, 5, { spoilerSafe: false });
  assert.equal(open.progress.segment, lastSegmentIndex(analysis));
});

test("mcp arc_summary stays the same aggregate as the core recap", () => {
  const analysis = analyzeSample();
  const fromTool = arcSummary(createLibrary(), { document_id: "gamja", as_of: 30 });
  const fromCore = recapAt(analysis, 30);

  assert.equal(fromTool.document_id, "gamja");
  assert.deepEqual(fromTool.event_type_counts, fromCore.event_type_counts);
  assert.deepEqual(fromTool.progress, fromCore.progress);
  assert.deepEqual(
    fromTool.characters.map((item) => item.name),
    fromCore.characters.map((item) => item.name)
  );
});

test("recap does not regenerate prose", () => {
  const analysis = analyzeSample();
  const recap = recapAt(analysis, 40);
  const serialized = JSON.stringify({ ...recap, note: "" });
  analysis.segments.slice(0, 40).forEach((segment) => {
    const head = segment.text.slice(0, 24);
    assert.ok(!serialized.includes(head), `recap echoed source text: ${head}`);
  });
});
