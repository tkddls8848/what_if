import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { analyzeNovel, buildDynamicSeedLexicon, applyOllamaPayload } from "../src/analyzer.js";

const GAMJA = fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8");
const PAYLOAD = JSON.parse(
  fs.readFileSync(new URL("./fixtures/ollama_gamja_payload.json", import.meta.url), "utf8")
);

function analyzeWithFixturePayload() {
  // 브라우저 controller.analyzeWithDynamicSeed와 같은 순서를 재현한다
  const input = {
    text: GAMJA,
    title: "감자",
    sample: { id: "custom" },
    seedLexicon: buildDynamicSeedLexicon(PAYLOAD, "qwen3.5:4b"),
    engine: "ollama-dynamic-seed-ko-adapter"
  };
  const analysis = analyzeNovel(input);
  applyOllamaPayload(analysis, PAYLOAD, "qwen3.5:4b");
  return analysis;
}

test("fixture payload가 동적 seed와 병합 경로를 통과한다", () => {
  const analysis = analyzeWithFixturePayload();

  const characters = analysis.characters.map((item) => item.canonical_name);
  assert.ok(characters.includes("복녀"));
  assert.ok(characters.includes("남편"));
  assert.ok(characters.includes("왕 서방"));

  const locations = analysis.locations.map((item) => item.name);
  assert.ok(locations.includes("칠성문"));
  assert.ok(locations.includes("빈민굴"));

  // 병합 완료 표시
  assert.equal(analysis.diagnostics.ollama.applied, true);
  assert.equal(analysis.diagnostics.ollama.model, "qwen3.5:4b");
});

test("병합된 엔티티는 원문 mention에 앵커된다", () => {
  const analysis = analyzeWithFixturePayload();
  const boknyeo = analysis.characters.find((item) => item.canonical_name === "복녀");
  assert.ok(boknyeo);
  assert.ok(boknyeo.mentions.length > 0, "복녀 mention이 원문에 앵커되어야 한다");

  const mention = analysis.mentions.find((item) => item.mention_id === boknyeo.mentions[0]);
  assert.ok(mention);
  assert.ok(mention.segment_id, "mention은 segment에 연결된다");
});

test("LLM 병합 후에도 오탐 금지 회귀 기준을 유지한다", () => {
  const analysis = analyzeWithFixturePayload();
  const characters = analysis.characters.map((item) => item.canonical_name);
  const locations = analysis.locations.map((item) => item.name);

  assert.deepEqual(
    characters.filter((name) => ["얼굴", "머리", "활극", "바구니", "소리", "모양", "조밥"].includes(name)),
    []
  );
  assert.deepEqual(
    locations.filter((name) => /\s/u.test(name) || ["징역", "들어가게", "불길"].includes(name)),
    []
  );
});

test("LLM 항목은 확정이 아니라 suggested 상태로 진입한다", () => {
  const analysis = analyzeWithFixturePayload();
  const wang = analysis.characters.find((item) => item.canonical_name === "왕 서방");
  assert.ok(wang);
  assert.equal(wang.status, "suggested");
});

test("존재하지 않는 인물 payload는 mention 앵커 실패로 남지 않아야 한다", () => {
  const junkPayload = {
    ...PAYLOAD,
    characters: [
      ...PAYLOAD.characters,
      { name: "홍길동", aliases: [], role: "허구", description: "원문에 없음", evidence: "원문에 없는 문장", confidence: 0.9 }
    ]
  };
  const input = {
    text: GAMJA,
    title: "감자",
    sample: { id: "custom" },
    seedLexicon: buildDynamicSeedLexicon(junkPayload, "m4b"),
    engine: "ollama-dynamic-seed-ko-adapter"
  };
  const analysis = analyzeNovel(input);
  applyOllamaPayload(analysis, junkPayload, "m4b");

  const ghost = analysis.characters.find((item) => item.canonical_name === "홍길동");
  // 앵커링 게이트: 원문 mention이 없는 인물은 mention 0개(또는 미생성)여야 한다
  if (ghost) {
    assert.equal(ghost.mentions.length, 0);
  }
});
