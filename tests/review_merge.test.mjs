import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => []
};

const { analyzeNovel } = await import("../src/analyzer.js");
const { applyCharacterMerge, undoCharacterMerge } = await import("../src/app/editing.js");

function analyzeGamja() {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  return analyzeNovel({ text, title: "감자", sample: { id: "custom" } });
}

function characterNamed(analysis, name) {
  return analysis.characters.find((character) => character.canonical_name === name);
}

function mentionsOf(analysis, characterId) {
  return analysis.mentions.filter((mention) =>
    mention.entity_type === "character" && mention.entity_id === characterId
  );
}

function referencesOf(analysis, characterId) {
  return {
    events: analysis.events.filter((event) => event.characters.includes(characterId)).length,
    states: analysis.states.filter((state) => state.character_id === characterId).length,
    relations: analysis.relations.filter((relation) =>
      relation.source_id === characterId || relation.target_id === characterId
    ).length
  };
}

test("여편네를 복녀로 병합하면 mention과 서사 시간이 실제 데이터 기준으로 갱신된다", () => {
  const analysis = analyzeGamja();
  const source = characterNamed(analysis, "여편네");
  const target = characterNamed(analysis, "복녀");

  assert.ok(source && target);
  assert.deepEqual(
    {
      source: [source.first_segment_id, source.valid_from, mentionsOf(analysis, source.character_id).length],
      target: [target.first_segment_id, target.valid_from, mentionsOf(analysis, target.character_id).length]
    },
    {
      source: ["seg_017", 17, 2],
      target: ["seg_001", 1, 49]
    }
  );
  assert.equal(source.status, "suggested", "자동 추출 단계에서는 별도 suggested 인물이어야 한다");

  const movedMentionIds = new Set(source.mentions);
  // 병합 경로가 기존 파생값을 신뢰하지 않고 mention에서 다시 계산하는지 함께 고정한다.
  target.first_segment_id = "seg_017";
  target.valid_from = 17;
  const merged = applyCharacterMerge(analysis, source.character_id, target.character_id);

  assert.ok(merged);
  assert.deepEqual(
    {
      source: [source.first_segment_id, source.valid_from, mentionsOf(analysis, source.character_id).length],
      target: [target.first_segment_id, target.valid_from, mentionsOf(analysis, target.character_id).length]
    },
    {
      source: ["", 0, 0],
      target: ["seg_001", 1, 51]
    }
  );
  assert.ok(
    analysis.mentions.filter((mention) => movedMentionIds.has(mention.mention_id))
      .every((mention) => mention.entity_id === target.character_id),
    "여편네 mention이 모두 복녀로 이동해야 한다"
  );
  assert.equal(source.status, "rejected");
  assert.equal(target.status, "edited");
  assert.deepEqual(referencesOf(analysis, source.character_id), { events: 0, states: 0, relations: 0 });
  assert.deepEqual(referencesOf(analysis, target.character_id), { events: 58, states: 41, relations: 63 });
  assert.ok(analysis.diagnostics.audit, "refreshNarrativeTime이 감사 결과도 갱신해야 한다");
});

test("분리는 여편네 병합의 mention·사건 참조·서사 시간을 되돌린다", () => {
  const analysis = analyzeGamja();
  const source = characterNamed(analysis, "여편네");
  const target = characterNamed(analysis, "복녀");
  const originalEvents = analysis.events.map((event) => ({
    event_id: event.event_id,
    characters: [...event.characters],
    state_hint_characters: (event.state_hints || []).map((hint) => hint.character_id)
  }));

  applyCharacterMerge(analysis, source.character_id, target.character_id);
  const split = undoCharacterMerge(analysis, source.character_id);

  assert.ok(split);
  assert.deepEqual(
    {
      source: [source.first_segment_id, source.valid_from, mentionsOf(analysis, source.character_id).length],
      target: [target.first_segment_id, target.valid_from, mentionsOf(analysis, target.character_id).length]
    },
    {
      source: ["seg_017", 17, 2],
      target: ["seg_001", 1, 49]
    }
  );
  assert.equal(source.status, "suggested");
  assert.equal(target.status, "suggested");
  assert.deepEqual(referencesOf(analysis, source.character_id), { events: 2, states: 2, relations: 2 });
  assert.deepEqual(
    analysis.events.map((event) => ({
      event_id: event.event_id,
      characters: [...event.characters],
      state_hint_characters: (event.state_hints || []).map((hint) => hint.character_id)
    })),
    originalEvents
  );
  assert.equal(source.merge_record, undefined);
  assert.equal(source.merged_into, undefined);
});
