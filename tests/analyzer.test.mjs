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
