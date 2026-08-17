import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLibrary, isRedistributable } from "../mcp/library.js";
import {
  ToolError,
  arcSummary,
  evidenceForFact,
  graphAsOf,
  listWorks,
  readSegment,
  stateAsOf,
  timelineAsOf,
  whatifSeed,
  whoIs
} from "../mcp/tools.js";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const library = createLibrary();

function firstCharacterName(documentId, at) {
  const { analysis } = library.get(documentId);
  return analysis.characters.find((character) => character.valid_from <= at).canonical_name;
}

test("list_works reports every bundled work with its segment range", () => {
  const result = listWorks(library);
  const ids = result.works.map((work) => work.document_id);
  assert.ok(ids.includes("wings"));
  assert.ok(ids.includes("gamja"));
  result.works.forEach((work) => {
    assert.ok(work.segments > 0, `${work.document_id}의 segment 수가 필요하다`);
    assert.equal(typeof work.redistributable, "boolean");
  });
});

test("fact tools refuse to answer without as_of", () => {
  assert.throws(() => stateAsOf(library, { document_id: "gamja", character: "복녀" }), ToolError);
  assert.throws(() => whoIs(library, { document_id: "gamja", name: "복녀" }), ToolError);
  assert.throws(() => timelineAsOf(library, { document_id: "gamja" }), ToolError);
  assert.throws(() => graphAsOf(library, { document_id: "gamja" }), ToolError);
  assert.throws(() => arcSummary(library, { document_id: "gamja" }), ToolError);
  assert.throws(() => evidenceForFact(library, { document_id: "gamja", fact_id: "event_001" }), ToolError);

  assert.throws(() => timelineAsOf(library, { document_id: "gamja", as_of: 0 }), ToolError);
  assert.throws(() => timelineAsOf(library, { document_id: "gamja", as_of: "무제한" }), ToolError);
});

test("unknown document ids fail with the available list", () => {
  assert.throws(
    () => timelineAsOf(library, { document_id: "no-such-work", as_of: 3 }),
    (error) => error instanceof ToolError && /gamja/u.test(error.message)
  );
});

test("timeline_as_of never returns an event past the reading position", () => {
  const { analysis } = library.get("gamja");
  [1, 10, 40].forEach((at) => {
    const result = timelineAsOf(library, { document_id: "gamja", as_of: at });
    assert.equal(result.as_of, at);
    result.events.forEach((event) => {
      assert.ok(event.segment <= at, `단락 ${event.segment}이 시점 ${at}을 넘었다`);
      assert.ok(event.evidence.quote.length > 0, "근거 인용이 비어 있다");
      assert.ok(event.evidence.segment_index <= at);
    });
    assert.ok(result.events.length <= analysis.events.length);
  });
});

test("every returned fact carries evidence, status and confidence", () => {
  const at = 40;
  const name = firstCharacterName("gamja", at);

  const state = stateAsOf(library, { document_id: "gamja", character: name, as_of: at });
  if (state.known) {
    assert.ok(state.known.evidence.quote);
    assert.ok(state.known.status);
  }

  const who = whoIs(library, { document_id: "gamja", name, as_of: at });
  assert.ok(who.character.evidence.quote);
  who.relations.forEach((relation) => {
    assert.ok(relation.evidence.quote);
    assert.ok(relation.status);
    assert.ok(relation.valid_from <= at);
  });
});

test("who_is refuses a character that has not appeared yet", () => {
  const { analysis } = library.get("gamja");
  const late = [...analysis.characters].sort((a, b) => b.valid_from - a.valid_from)[0];
  assert.ok(late.valid_from > 1, "뒤늦게 등장하는 인물이 필요하다");

  assert.throws(
    () => whoIs(library, { document_id: "gamja", name: late.canonical_name, as_of: late.valid_from - 1 }),
    (error) => error instanceof ToolError && /아직 등장하지 않았습니다/u.test(error.message)
  );

  const allowed = whoIs(library, { document_id: "gamja", name: late.canonical_name, as_of: late.valid_from });
  assert.equal(allowed.character.canonical_name, late.canonical_name);
});

test("evidence_for quotes text that really exists in the segment", () => {
  const { analysis } = library.get("gamja");
  const event = analysis.events[5];
  const result = evidenceForFact(library, {
    document_id: "gamja",
    fact_id: event.event_id,
    as_of: analysis.segments.find((item) => item.segment_id === event.segment_id).index
  });

  const segment = analysis.segments.find((item) => item.segment_id === result.evidence.segment_id);
  const normalized = segment.text.replace(/\s+/gu, " ");
  assert.ok(normalized.includes(result.evidence.quote.replace(/…$/u, "")), "인용이 원문에 없다");
  assert.equal(result.fact_type, "event");
  assert.ok(Array.isArray(result.audit));
});

test("evidence_for rejects unknown fact ids", () => {
  assert.throws(() => evidenceForFact(library, { document_id: "gamja", fact_id: "event_99999", as_of: 10 }), ToolError);
  assert.throws(() => evidenceForFact(library, { document_id: "gamja", fact_id: "nonsense", as_of: 10 }), ToolError);
});

test("evidence_for rejects facts from after as_of", () => {
  const { analysis } = library.get("gamja");
  const futureEvent = analysis.events.find((event) => {
    const segment = analysis.segments.find((item) => item.segment_id === event.segment_id);
    return segment?.index > 1;
  });
  assert.ok(futureEvent, "첫 단락 뒤의 사건이 필요하다");
  assert.throws(
    () => evidenceForFact(library, { document_id: "gamja", fact_id: futureEvent.event_id, as_of: 1 }),
    ToolError
  );
});

test("graph_as_of edges only reference nodes already revealed", () => {
  const at = 30;
  const result = graphAsOf(library, { document_id: "gamja", as_of: at });
  const nodeIds = new Set(result.nodes.map((node) => node.id));
  result.edges.forEach((edge) => {
    assert.ok(nodeIds.has(edge.source), `${edge.source} 노드가 범위 밖이다`);
    assert.ok(nodeIds.has(edge.target), `${edge.target} 노드가 범위 밖이다`);
  });
});

test("arc_summary aggregates without regenerating prose", () => {
  const result = arcSummary(library, { document_id: "gamja", as_of: 30 });
  assert.equal(result.progress.segment, 30);
  assert.ok(result.progress.of > 30);
  assert.ok(Object.keys(result.event_type_counts).length > 0);
  result.characters.forEach((character) => assert.ok(character.first_seen_segment <= 30));
});

test("raw segments are served only for public-domain works", () => {
  const bundled = readSegment(library, { document_id: "gamja", segment: 1 });
  assert.ok(bundled.text.length > 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-rights-"));
  fs.copyFileSync(path.join(REPO, "texts", "gamja.txt"), path.join(dir, "private_work.txt"));
  const restricted = createLibrary({ dir });

  assert.equal(isRedistributable(restricted.documents()[0]), false);
  assert.throws(
    () => readSegment(restricted, { document_id: "private_work", segment: 1 }),
    (error) => error instanceof ToolError && /권리 표기/u.test(error.message)
  );
  assert.throws(
    () => evidenceForFact(restricted, { document_id: "private_work", fact_id: "seg_001", as_of: 1 }),
    ToolError
  );
  // 원문 배포는 막아도 사실 조회와 근거 인용은 계속 동작해야 한다.
  const timeline = timelineAsOf(restricted, { document_id: "private_work", as_of: 5 });
  assert.ok(timeline.events.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("meta sidecar overrides title and rights", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-meta-"));
  fs.copyFileSync(path.join(REPO, "texts", "gamja.txt"), path.join(dir, "work.txt"));
  fs.writeFileSync(path.join(dir, "work.meta.json"), JSON.stringify({
    title: "다른 제목", author: "누군가", rights: "public-domain-old-70"
  }), "utf8");

  const custom = createLibrary({ dir });
  const [meta] = custom.documents();
  assert.equal(meta.title, "다른 제목");
  assert.equal(isRedistributable(meta), true);
  assert.ok(readSegment(custom, { document_id: "work", segment: 1 }).text.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("document_id never escapes the library directory", () => {
  // get()이 document_id로 경로를 조합하므로 구분자가 들어오면 라이브러리 밖을 읽을 수 있다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-traversal-"));
  fs.copyFileSync(path.join(REPO, "texts", "gamja.txt"), path.join(dir, "inside.txt"));
  fs.writeFileSync(path.join(path.dirname(dir), "outside.txt"), "라이브러리 밖 파일", "utf8");
  const restricted = createLibrary({ dir });

  ["../outside", "..\outside", "inside/../../outside", "..", "."].forEach((id) => {
    assert.equal(restricted.get(id), null, `${id}가 라이브러리 밖을 읽었다`);
  });
  assert.ok(restricted.get("inside"), "정상 document_id는 그대로 동작해야 한다");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(dir), "outside.txt"), { force: true });
});

test("whatif_seed exposes nothing from after the fork", () => {
  const at = 20;
  const { analysis } = library.get("gamja");
  const result = whatifSeed(library, { document_id: "gamja", as_of: at });
  const serialized = JSON.stringify(result);

  assert.equal(result.fork_segment, at);
  assert.ok(result.candidates.length > 0);
  result.candidates.forEach((candidate) => assert.ok(candidate.segment <= at));
  result.seed.recent_events.forEach((event) => assert.ok(event.segment <= at));

  analysis.segments
    .filter((segment) => segment.index > at)
    .forEach((segment) => {
      const sentence = segment.text.replace(/\s+/gu, " ").trim().slice(0, 20);
      if (sentence.length >= 12) assert.ok(!serialized.includes(sentence), `단락 ${segment.index}이 시드에 있다`);
    });

  assert.throws(() => whatifSeed(library, { document_id: "gamja" }), ToolError);
});

test("mcp/ stays an adapter: no analysis rules live here", () => {
  const files = fs.readdirSync(path.join(REPO, "mcp")).filter((name) => name.endsWith(".js"));
  assert.ok(files.length >= 3);

  files.forEach((name) => {
    const source = fs.readFileSync(path.join(REPO, "mcp", name), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//gu, "");
    assert.ok(!code.includes("가-힣"), `${name}에 한국어 문자 클래스가 있다 — 분석 규칙은 src/에만 둔다`);
    assert.ok(!/LEXICON|_SEEDS\b/u.test(code), `${name}에 사전 정의가 있다 — src/config.js로 옮긴다`);
  });

  const adapters = ["library.js", "tools.js"].map((name) =>
    fs.readFileSync(path.join(REPO, "mcp", name), "utf8"));
  assert.ok(adapters[0].includes('from "../src/analyzer.js"'), "라이브러리는 분석기를 재사용해야 한다");
  assert.ok(adapters[1].includes('from "../src/core/asof.js"'), "도구는 asOf를 재사용해야 한다");
});

