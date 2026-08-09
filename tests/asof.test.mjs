import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import {
  asOf,
  currentStateOf,
  factsAt,
  intervalOf,
  invalidations,
  isKnownAt,
  isTrueAt,
  lastSegmentIndex,
  resolveTime,
  segmentIndexOf
} from "../src/core/asof.js";

function analyzeSample() {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  return analyzeNovel({ text, title: "감자", sample: { id: "gamja" } });
}

function idsOf(scoped) {
  return {
    characters: new Set(scoped.characters.map((item) => item.character_id)),
    locations: new Set(scoped.locations.map((item) => item.location_id)),
    events: new Set(scoped.events.map((item) => item.event_id)),
    relations: new Set(scoped.relations.map((item) => item.relation_id))
  };
}

test("assigns narrative-time intervals to states, relations and entities", () => {
  const analysis = analyzeSample();

  assert.ok(analysis.states.length > 0);
  analysis.states.forEach((state) => {
    const { valid_from, valid_to } = intervalOf(state);
    assert.equal(valid_from, segmentIndexOf(analysis, state.segment_id));
    assert.ok(valid_from >= 1);
    if (valid_to !== null) assert.ok(valid_to >= valid_from);
  });

  analysis.relations.forEach((relation) => {
    const { valid_from } = intervalOf(relation);
    const indexes = relation.segment_ids.map((id) => segmentIndexOf(analysis, id)).filter((index) => index >= 1);
    assert.equal(valid_from, Math.min(...indexes));
  });

  analysis.characters.forEach((character) => {
    assert.equal(intervalOf(character).valid_from, segmentIndexOf(analysis, character.first_segment_id));
  });
});

test("state intervals of one character are contiguous and non-overlapping", () => {
  const analysis = analyzeSample();
  const byCharacter = new Map();
  analysis.states.forEach((state) => {
    const list = byCharacter.get(state.character_id) || [];
    list.push(state);
    byCharacter.set(state.character_id, list);
  });

  byCharacter.forEach((list) => {
    const ordered = list
      .map((state) => intervalOf(state))
      .sort((a, b) => a.valid_from - b.valid_from);
    ordered.forEach((interval, position) => {
      const next = ordered[position + 1];
      if (!next) {
        assert.equal(interval.valid_to, null, "마지막 구간만 열려 있어야 한다");
        return;
      }
      assert.notEqual(interval.valid_to, null, "마지막이 아닌 구간은 닫혀 있어야 한다");
      assert.ok(interval.valid_to < next.valid_from, "구간이 겹치면 안 된다");
    });
  });
});

test("asOf is monotone: later reading positions never reveal fewer facts", () => {
  const analysis = analyzeSample();
  const last = lastSegmentIndex(analysis);
  const checkpoints = [1, Math.floor(last / 4), Math.floor(last / 2), last];

  for (let i = 0; i < checkpoints.length - 1; i += 1) {
    const earlier = idsOf(asOf(analysis, checkpoints[i]));
    const later = idsOf(asOf(analysis, checkpoints[i + 1]));
    Object.keys(earlier).forEach((key) => {
      earlier[key].forEach((id) => {
        assert.ok(later[key].has(id), `${key} ${id}가 뒤 시점에서 사라졌다`);
      });
    });
  }
});

test("asOf never leaks a fact anchored after the reading position", () => {
  const analysis = analyzeSample();
  const last = lastSegmentIndex(analysis);

  [1, 5, Math.floor(last / 2), last].forEach((t) => {
    const scoped = asOf(analysis, t);
    scoped.segments.forEach((segment) => assert.ok(segment.index <= t));
    scoped.mentions.forEach((mention) => assert.ok(segmentIndexOf(analysis, mention.segment_id) <= t));
    scoped.events.forEach((event) => assert.ok(segmentIndexOf(analysis, event.segment_id) <= t));
    scoped.states.forEach((state) => assert.ok(segmentIndexOf(analysis, state.segment_id) <= t));
    scoped.characters.forEach((character) => assert.ok(isKnownAt(character, t)));
    scoped.locations.forEach((location) => assert.ok(isKnownAt(location, t)));
    scoped.relations.forEach((relation) => assert.ok(isKnownAt(relation, t)));
    scoped.audit.violations.forEach((violation) => assert.ok(violation.segment_index <= t));
  });
});

test("spoilerSafe:false equals the whole document regardless of position", () => {
  const analysis = analyzeSample();
  const full = asOf(analysis, 1, { spoilerSafe: false });
  const end = asOf(analysis, lastSegmentIndex(analysis));

  assert.equal(full.scope.mode, "full_document");
  assert.equal(full.events.length, end.events.length);
  assert.equal(full.characters.length, end.characters.length);
  assert.equal(full.relations.length, end.relations.length);
});

test("asOf keeps the export contract shape", () => {
  const analysis = analyzeSample();
  const scoped = asOf(analysis, 10);
  ["document", "scope", "segments", "scenes", "mentions", "characters", "locations", "events", "states", "relations", "diagnostics"]
    .forEach((key) => assert.ok(key in scoped, `${key}가 계약에서 사라졌다`));
  assert.equal(scoped.scope.mode, "reader_position");
  assert.equal(scoped.scope.current_segment, 10);
});

test("KNOWN and TRUE are different predicates", () => {
  const fact = { valid_from: 3, valid_to: 7 };

  assert.equal(isKnownAt(fact, 2), false);
  assert.equal(isTrueAt(fact, 2), false);

  assert.equal(isKnownAt(fact, 5), true);
  assert.equal(isTrueAt(fact, 5), true);

  // 구간이 닫힌 뒤에도 독자는 그 사실을 안다. 다만 더 이상 유효하지 않다.
  assert.equal(isKnownAt(fact, 9), true);
  assert.equal(isTrueAt(fact, 9), false);

  // 좌표 없는 사실은 어떤 시점에도 보이지 않는다.
  assert.equal(isKnownAt({ valid_from: 0 }, 100), false);
  assert.equal(isTrueAt({ valid_from: 0 }, 100), false);
});

test("factsAt and currentStateOf resolve the state valid at a moment", () => {
  const analysis = analyzeSample();
  const character = analysis.characters[0];
  const states = analysis.states.filter((state) => state.character_id === character.character_id);
  assert.ok(states.length > 1, "구간 검증을 위해 상태가 둘 이상 필요하다");

  const first = states[0];
  const at = intervalOf(first).valid_from;
  const current = currentStateOf(analysis, character.character_id, at);
  assert.equal(current.state_id, first.state_id);

  const facts = factsAt(analysis, at);
  assert.ok(facts.states.every((state) => isTrueAt(state, at)));
  assert.ok(facts.states.some((state) => state.state_id === first.state_id));

  // 다음 구간으로 넘어가면 다른 레코드가 유효해진다.
  const second = states[1];
  const later = currentStateOf(analysis, character.character_id, intervalOf(second).valid_from);
  assert.equal(later.state_id, second.state_id);
});

test("invalidations report which event replaced a fact", () => {
  const analysis = analyzeSample();
  const rows = invalidations(analysis);
  assert.ok(rows.length > 0);
  rows.forEach((row) => {
    assert.ok(row.at >= 2);
    assert.ok(row.invalidated_by);
    assert.equal(row.fact_type, "state");
  });
  const sorted = rows.map((row) => row.at);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b));
});

test("resolveTime clamps to the document range", () => {
  const analysis = analyzeSample();
  const last = lastSegmentIndex(analysis);
  assert.equal(resolveTime(analysis, 0), 0);
  assert.equal(resolveTime(analysis, last + 500), last);
  assert.equal(resolveTime(analysis, 3), 3);
  assert.equal(resolveTime(analysis, 3, false), last);
  assert.equal(resolveTime(analysis, "not a number"), last);
});
