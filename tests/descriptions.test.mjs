import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import { asOf } from "../src/core/asof.js";
import { VISUAL_DESCRIPTION_LEXICON } from "../src/config.js";
import { createLibrary } from "../mcp/library.js";
import { readAnalysis } from "../mcp/tools.js";

function analyzeSample(name, id) {
  const text = fs.readFileSync(new URL(`../texts/${name}`, import.meta.url), "utf8");
  return analyzeNovel({ text, title: id, sample: { id } });
}

function descriptionsOf(analysis, name) {
  return analysis.segments
    .flatMap((segment) => segment.description_spans || [])
    .filter((item) => item.entity_name === name);
}

test("description spans are exact source clauses with an empty image interface", () => {
  [analyzeSample("gamja.txt", "gamja"), analyzeSample("wings.txt", "wings")].forEach((analysis) => {
    const spans = analysis.segments.flatMap((segment) => segment.description_spans || []);
    assert.ok(spans.length > 0);
    spans.forEach((span) => {
      const segment = analysis.segments.find((item) => item.segment_id === span.segment_id);
      const localStart = span.char_start - segment.char_start;
      assert.equal(segment.text.slice(localStart, localStart + span.text.length), span.text);
      assert.equal(span.image, null);
      assert.ok(span.categories.length > 0);
      assert.ok(span.matched_terms.every((term) => span.text.includes(term)));
    });
  });
});

test("the collector requires the target to be the subject instead of scraping nearby mentions", () => {
  const analysis = analyzeNovel({
    text: [
      "복녀는 얼굴이 새빨갛게 되었다.",
      "남편은 아름다운 복녀를 불렀다."
    ].join("\n\n"),
    title: "짧은 묘사 픽스처",
    sample: { id: "gamja" }
  });
  const spans = descriptionsOf(analysis, "복녀");
  assert.deepEqual(spans.map((item) => item.text), ["복녀는 얼굴이 새빨갛게 되었다."]);
});

test("a short document still clears the document-relative evidence threshold", () => {
  const analysis = analyzeNovel({
    text: "복녀의 얼굴은 이뻐졌다.",
    title: "한 문단 픽스처",
    sample: { id: "gamja" }
  });
  assert.deepEqual(descriptionsOf(analysis, "복녀").map((item) => item.text), ["복녀의 얼굴은 이뻐졌다."]);
});

test("weak locative evidence needs more support as the document grows", () => {
  const sentence = "방안에서 침침하게 잔다.";
  const short = analyzeNovel({ text: sentence, title: "짧은 공간", sample: { id: "wings" } });
  const long = analyzeNovel({
    text: [sentence, ...Array.from({ length: 8 }, (_, index) => `아무 묘사 없는 문단 ${index + 1}.`)].join("\n\n"),
    title: "긴 공간",
    sample: { id: "wings" }
  });
  const count = (analysis) => analysis.segments.flatMap((segment) => segment.description_spans || []).length;
  assert.equal(count(short), 1);
  assert.equal(count(long), 0);
});

test("asOf hides future description spans by scoping their owning segments", () => {
  const analysis = analyzeNovel({
    text: [
      "복녀는 얼굴이 새빨갛게 되었다.",
      "복녀의 얼굴은 이뻐졌다."
    ].join("\n\n"),
    title: "시점 픽스처",
    sample: { id: "gamja" }
  });
  const early = asOf(analysis, 1).segments.flatMap((segment) => segment.description_spans || []);
  const full = asOf(analysis, 2).segments.flatMap((segment) => segment.description_spans || []);
  assert.equal(early.length, 1);
  assert.equal(full.length, 2);
  assert.ok(!early.some((item) => item.text.includes("이뻐졌다")));
});

test("the MCP analysis resource exposes only description spans inside asOf segments", () => {
  const library = createLibrary();
  const early = readAnalysis(library, { document_id: "gamja", as_of: 5 });
  const full = readAnalysis(library, { document_id: "gamja", as_of: 400 });
  const spans = (analysis) => analysis.segments.flatMap((segment) => segment.description_spans || []);
  assert.equal(spans(early).length, 0);
  assert.ok(spans(full).length > 0);
});

test("the visual lexicon has only the contracted appearance, clothing and space channels", () => {
  assert.deepEqual([...new Set(VISUAL_DESCRIPTION_LEXICON.map((entry) => entry.category))].sort(), ["appearance", "clothing", "space"]);
  VISUAL_DESCRIPTION_LEXICON.forEach((entry) => {
    assert.ok(entry.words.length > 0);
    assert.ok(entry.subject_terms.length > 0);
  });
});
