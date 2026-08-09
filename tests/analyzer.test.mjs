import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";

function analyzeExternal(text) {
  return analyzeNovel({
    text,
    title: "external",
    sample: { id: "custom" }
  });
}

function analyzeSample(name, id) {
  const text = fs.readFileSync(new URL(`../texts/${name}`, import.meta.url), "utf8");
  return analyzeNovel({ text, title: id, sample: { id } });
}

function mentionTexts(analysis, kind, name) {
  const list = kind === "character" ? analysis.characters : analysis.locations;
  const entity = list.find((item) => (item.canonical_name || item.name) === name);
  if (!entity) return [];
  const id = entity.character_id || entity.location_id;
  return analysis.mentions.filter((mention) => mention.entity_id === id).map((mention) => mention.text);
}

test("keeps Korean entity heads and rejects modifiers or common nouns", () => {
  const text = fs.readFileSync(new URL("./fixtures/entity-boundaries.txt", import.meta.url), "utf8");
  const result = analyzeExternal(text);
  const characters = result.characters.map((item) => item.canonical_name);
  const locations = result.locations.map((item) => item.name);

  assert.ok(characters.includes("마나님"));
  assert.ok(locations.includes("전찻길"));
  assert.ok(locations.includes("집"));
  assert.ok(!characters.includes("모양"));
  assert.ok(!characters.includes("조밥"));
  assert.ok(!locations.includes("불길"));
  assert.ok(!locations.some((name) => /\s/u.test(name)));
});

test("does not create sentence fragments when a bundled sample is loaded as external text", () => {
  const text = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
  const result = analyzeExternal(text);
  const characters = result.characters.map((item) => item.canonical_name);
  const locations = result.locations.map((item) => item.name);

  assert.ok(characters.includes("복녀"));
  assert.ok(characters.includes("남편"));
  assert.ok(locations.includes("칠성문"));
  assert.ok(locations.includes("빈민굴"));
  assert.deepEqual(
    characters.filter((name) => ["얼굴", "머리", "활극", "바구니", "소리", "모양", "조밥"].includes(name)),
    []
  );
  assert.deepEqual(
    locations.filter((name) => /\s/u.test(name) || ["왕 서방", "징역", "들어가게", "불길"].includes(name)),
    []
  );
});

test("a trailing Korean particle does not hide a mention", () => {
  const analysis = analyzeSample("gamja.txt", "gamja");

  // `복녀도`는 `복녀` + 조사 `도`다. 조사를 허용하지 않으면 이 언급이 통째로 사라진다.
  assert.ok(mentionTexts(analysis, "character", "복녀").includes("복녀도"));
  // 별칭에 열거되지 않은 조사형도 잡혀야 한다 — 열거로 때우면 언제나 빠지는 게 생긴다.
  assert.ok(mentionTexts(analysis, "location", "채마 밭").includes("채마 밭에"));
});

test("an alias inside a longer Korean word is not a mention", () => {
  const analysis = analyzeExternal([
    "복녀는 마당에 서 있었다.",
    "",
    "복녀들이 몰려왔고 복녀자와 복녀라도 함께였다.",
    "",
    "감독관은 감독과 달랐다."
  ].join("\n"));

  const texts = mentionTexts(analysis, "character", "복녀");
  assert.ok(texts.length > 0, "정상적인 언급은 잡혀야 한다");
  // `들`·`자`·`라도`는 조사가 아니므로 단어 내부 매칭이다. 하나라도 잡히면 오탐이다.
  assert.deepEqual(texts.filter((text) => /^복녀(?:들|자|라도)/u.test(text)), []);
  assert.ok(!mentionTexts(analysis, "character", "감독").some((text) => text.startsWith("감독관")));
});

test("mention and event channels agree on who is in a segment", () => {
  // 두 채널이 다른 규칙을 쓰면 사건은 인물을 참여자로 넣는데 그 단락에 언급은 없는
  // 상태가 된다. 그게 `actor` 제약 위반이며, 계약 위반이므로 0이어야 한다.
  ["gamja.txt::gamja", "wings.txt::wings"].forEach((entry) => {
    const [file, id] = entry.split("::");
    const analysis = analyzeSample(file, id);
    const counts = analysis.diagnostics.audit.counts;
    assert.equal(counts.actor, 0, `${id}: 언급 없는 사건 참여자가 ${counts.actor}건 있다`);
    assert.equal(counts.error, 0, `${id}: error 등급 제약 위반이 ${counts.error}건 있다`);
  });
});
