import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import { asOf } from "../src/core/asof.js";
import { evidenceOf, findFact } from "../src/core/evidence.js";
import { PERIOD_TERM_CATEGORIES, PERIOD_TERM_LEXICON } from "../src/config.js";
import { createLibrary } from "../mcp/library.js";
import { ToolError, annotationsAsOf } from "../mcp/tools.js";

function analyzeSample(name, id) {
  const text = fs.readFileSync(new URL(`../texts/${name}`, import.meta.url), "utf8");
  return analyzeNovel({ text, title: id, sample: { id } });
}

test("an annotation anchor really points at the term in the source text", () => {
  ["gamja.txt::gamja", "wings.txt::wings"].forEach((entry) => {
    const [file, id] = entry.split("::");
    const analysis = analyzeSample(file, id);
    assert.ok(analysis.annotations.length > 0, `${id}: 주석이 하나도 없다`);

    analysis.annotations.forEach((annotation) => {
      const segment = analysis.segments.find((item) => item.segment_id === annotation.segment_id);
      const start = annotation.char_start - segment.char_start;
      const quoted = segment.text.slice(start, start + (annotation.char_end - annotation.char_start));
      assert.equal(quoted, annotation.text, `${id}/${annotation.annotation_id}: 앵커가 원문과 어긋난다`);
    });
    assert.equal(analysis.diagnostics.audit.counts.reference, 0, `${id}: reference 위반이 있다`);
  });
});

test("the rule channel never writes historical prose", () => {
  // 이 기능의 계약이다. 4B 로컬 모델이 쓴 역사 서술은 검증할 방법이 없으므로
  // 자동 채널은 링크만 걸고 `note`는 사람 몫으로 비워 둔다.
  const analysis = analyzeSample("wings.txt", "wings");
  analysis.annotations.forEach((annotation) => {
    assert.equal(annotation.note, "", `${annotation.term}: 자동 채널이 서술을 만들었다`);
    assert.ok(annotation.references.length > 0, `${annotation.term}: 출처 링크가 없다`);
  });
});

test("every reference link is https and on the allowlisted hosts", () => {
  PERIOD_TERM_LEXICON.forEach((entry) => {
    assert.ok(entry.aliases?.length, `${entry.term}: 별칭이 없다`);
    assert.ok(PERIOD_TERM_CATEGORIES[entry.category], `${entry.term}: 알 수 없는 갈래 '${entry.category}'`);
    assert.ok(entry.references.length, `${entry.term}: 출처가 없다`);
    entry.references.forEach((reference) => {
      const url = new URL(reference.url);
      assert.equal(url.protocol, "https:", `${entry.term}: https가 아니다`);
      assert.match(url.hostname, /(?:wikipedia|wikisource)\.org$/u, `${entry.term}: 허용 밖 호스트 ${url.hostname}`);
    });
  });
});

test("annotations obey the reading position like every other fact", () => {
  const analysis = analyzeSample("wings.txt", "wings");
  const first = analysis.annotations[0];
  const before = asOf(analysis, Math.max(1, first.valid_from - 1));
  const after = asOf(analysis, first.valid_from);

  assert.ok(!before.annotations.some((item) => item.annotation_id === first.annotation_id),
    "아직 읽지 않은 단락의 주석이 보인다 — 그 자체가 누출이다");
  assert.ok(after.annotations.some((item) => item.annotation_id === first.annotation_id));
});

test("an annotation is reachable by fact id and quotes the source", () => {
  const analysis = analyzeSample("gamja.txt", "gamja");
  const target = analysis.annotations[0];
  const found = findFact(analysis, target.annotation_id);

  assert.equal(found?.fact_type, "annotation");
  const evidence = evidenceOf(analysis, found.fact, found.fact_type);
  assert.ok(evidence.quote.includes(target.text));
});

test("annotations_as_of refuses without as_of and hides later terms", () => {
  const library = createLibrary();
  assert.throws(() => annotationsAsOf(library, { document_id: "wings" }), ToolError);

  const full = annotationsAsOf(library, { document_id: "wings", as_of: 400 });
  const early = annotationsAsOf(library, { document_id: "wings", as_of: 5 });
  assert.ok(full.count > early.count);
  full.annotations.forEach((item) => {
    assert.ok(item.evidence, `${item.term}: 근거 없이 나갔다`);
    assert.ok(item.references.length, `${item.term}: 링크 없이 나갔다`);
  });

  const filtered = annotationsAsOf(library, { document_id: "wings", as_of: 400, category: "modern_institution" });
  assert.ok(filtered.count > 0 && filtered.count < full.count);
  assert.deepEqual([...new Set(filtered.annotations.map((item) => item.category))], ["modern_institution"]);
});
