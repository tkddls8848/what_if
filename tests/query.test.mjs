/**
 * 조합 질의(`core/query.js`)가 지켜야 할 것.
 *
 * 두 축을 본다. **누출 없음** — 어떤 인자 조합으로도 `asOf()`가 정한 상한을 넘지
 * 못한다. **동치** — 화면 프리셋으로 재정의하기 전의 조건과 같은 사건 집합을 낸다.
 * 뒤쪽이 없으면 지도에서 노드가 사라져도 원인을 찾을 수 없다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import { asOf, lastSegmentIndex, segmentIndexOf } from "../src/core/asof.js";
import { queryScenes } from "../src/core/query.js";

function analyzeSample() {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  return analyzeNovel({ text, title: "감자", sample: { id: "gamja" } });
}

function indexesOf(analysis, events) {
  return events.map((event) => segmentIndexOf(analysis, event.segment_id));
}

function idsOf(events) {
  return events.map((event) => event.event_id).sort();
}

test("no combination of filters returns events past the as-of bound", () => {
  const analysis = analyzeSample();
  const at = 40;

  const probes = [
    { at },
    { at, types: ["movement"] },
    { at, characters: analysis.characters.map((item) => item.character_id).slice(0, 1) },
    { at, locations: analysis.locations.map((item) => item.location_id).slice(0, 2) },
    { at, from: 1, to: lastSegmentIndex(analysis) }
  ];

  probes.forEach((options) => {
    const result = queryScenes(analysis, options);
    assert.ok(result.window.to <= at, `window.to=${result.window.to} > at=${at}`);
    indexesOf(analysis, result.events).forEach((index) => {
      assert.ok(index >= 1 && index <= at, `segment ${index} leaked past ${at}`);
    });
  });
});

test("an explicit upper bound is clamped to the as-of gate", () => {
  const analysis = analyzeSample();
  const last = lastSegmentIndex(analysis);
  const at = 30;

  const result = queryScenes(analysis, { at, to: last });
  assert.equal(result.window.gate, at);
  assert.equal(result.window.to, at);
  assert.ok(result.events.length > 0);
});

test("the timeline preset returns the same events as the scoped analysis it replaces", () => {
  const analysis = analyzeSample();
  const at = 60;

  const scoped = asOf(analysis, at, { statuses: "active" });
  const result = queryScenes(analysis, { at });

  assert.ok(result.events.length > 0);
  assert.deepEqual(idsOf(result.events), idsOf(scoped.events));
});

test("the map preset narrows to exactly one segment", () => {
  const analysis = analyzeSample();
  const at = lastSegmentIndex(analysis);
  const target = segmentIndexOf(analysis, analysis.events[0].segment_id);

  const result = queryScenes(analysis, { at, from: target, to: target });

  assert.ok(result.events.length > 0);
  assert.deepEqual(result.window, { from: target, to: target, gate: at });
  indexesOf(analysis, result.events).forEach((index) => assert.equal(index, target));
});

test("characters combine with AND so two names mean co-occurrence", () => {
  const analysis = analyzeSample();
  const at = lastSegmentIndex(analysis);
  const pair = analysis.events.find((event) => (event.characters || []).length >= 2)?.characters.slice(0, 2);
  assert.ok(pair, "두 인물이 함께 참여한 사건이 하나는 있어야 한다");

  const both = queryScenes(analysis, { at, characters: pair });
  const single = queryScenes(analysis, { at, characters: [pair[0]] });

  assert.ok(both.events.length > 0);
  assert.ok(both.events.length <= single.events.length);
  both.events.forEach((event) => {
    pair.forEach((id) => assert.ok(event.characters.includes(id)));
  });
});

test("locations combine with OR", () => {
  const analysis = analyzeSample();
  const at = lastSegmentIndex(analysis);
  const ids = [...new Set(analysis.events.flatMap((event) => event.locations || []))].slice(0, 2);
  assert.equal(ids.length, 2);

  const either = queryScenes(analysis, { at, locations: ids });
  const first = queryScenes(analysis, { at, locations: [ids[0]] });
  const second = queryScenes(analysis, { at, locations: [ids[1]] });

  assert.ok(either.events.length >= Math.max(first.events.length, second.events.length));
  either.events.forEach((event) => {
    assert.ok(event.locations.some((id) => ids.includes(id)));
  });
});

test("event types filter the result", () => {
  const analysis = analyzeSample();
  const at = lastSegmentIndex(analysis);
  const type = analysis.events[0].type;

  const result = queryScenes(analysis, { at, types: [type] });

  assert.ok(result.events.length > 0);
  result.events.forEach((event) => assert.equal(event.type, type));
});

test("every returned event carries evidence anchored inside the window", () => {
  const analysis = analyzeSample();
  const at = 50;

  const result = queryScenes(analysis, { at });

  assert.equal(result.evidence.length, result.events.length);
  const eventIds = new Set(result.events.map((event) => event.event_id));
  result.evidence.forEach((entry) => {
    assert.ok(eventIds.has(entry.event_id));
    assert.ok(entry.quote.length > 0);
    assert.ok(entry.segment_index >= 1 && entry.segment_index <= at);
    assert.ok(analysis.segments.some((segment) => segment.segment_id === entry.segment_id));
  });
});

test("returned characters and locations stay inside what is known at t", () => {
  const analysis = analyzeSample();
  const at = 30;

  const scoped = asOf(analysis, at, { statuses: "active" });
  const result = queryScenes(analysis, { at });
  const knownCharacters = new Set(scoped.characters.map((item) => item.character_id));
  const knownLocations = new Set(scoped.locations.map((item) => item.location_id));

  assert.ok(result.characters.length > 0);
  result.characters.forEach((item) => assert.ok(knownCharacters.has(item.character_id)));
  result.locations.forEach((item) => assert.ok(knownLocations.has(item.location_id)));
});

test("an inverted window returns nothing instead of falling back to the full range", () => {
  const analysis = analyzeSample();

  const result = queryScenes(analysis, { at: 40, from: 30, to: 10 });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.characters, []);
});

test("spoilerSafe false lifts the gate to the whole document", () => {
  const analysis = analyzeSample();

  const gated = queryScenes(analysis, { at: 5 });
  const full = queryScenes(analysis, { at: 5, spoilerSafe: false });

  assert.equal(full.window.gate, lastSegmentIndex(analysis));
  assert.ok(full.events.length > gated.events.length);
});
