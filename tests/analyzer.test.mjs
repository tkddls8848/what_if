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

test("dynamic locations recover spaced proper names and merge generic fragments as aliases", () => {
  const analysis = analyzeExternal(fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8"));
  const locations = analysis.locations.map((item) => item.name);

  // 변경 전 스냅샷: 집 · 칠성문 · 빈민굴 · 우리집 · 전주집 · 솔밭 · 밭 · 길 · 공동묘지
  assert.deepEqual(locations, ["집", "칠성문", "평양", "빈민굴", "솔밭", "밭", "길", "공동묘지"]);
  assert.ok(mentionTexts(analysis, "location", "평양").some((text) => text.startsWith("평양 성")));
  assert.ok(mentionTexts(analysis, "location", "집").includes("우리집에"));
  assert.ok(mentionTexts(analysis, "location", "집").includes("우리집으로"));
  assert.ok(mentionTexts(analysis, "location", "집").includes("전주집에는"));
  assert.ok(mentionTexts(analysis, "location", "밭").some((text) => text.startsWith("채마 밭")));
});

test("a one-segment proper location survives the document-relative seed threshold", () => {
  const short = analyzeExternal("복녀는 평양 성 안으로 들어왔다.");
  assert.ok(short.locations.some((location) => location.name === "평양"));
});

test("a surname separated by a space stays attached to its title", () => {
  // 토큰이 `[가-힣]+`이라 공백을 넘지 못한다. 되붙이지 않으면 「감자」의 필수 인물
  // `왕 서방`이 통째로 빠지고, 사람을 가르지 못하는 칭호 `서방`이 대신 인물이 된다.
  const characters = analyzeExternal(fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8"))
    .characters.map((item) => item.canonical_name);

  assert.ok(characters.includes("왕 서방"));
  assert.ok(!characters.includes("서방"), "칭호 단독은 같은 등장을 나눠 가지면 안 된다");
});

test("collective references and dialogue-only pronouns are not characters", () => {
  const characters = analyzeExternal(fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8"))
    .characters.map((item) => item.canonical_name);

  // `부처`(=부부)·`여인들`·`중국인들`은 무리이지 한 사람이 아니다.
  assert.deepEqual(characters.filter((name) => ["부처", "여인들", "중국인들", "그들"].includes(name)), []);
  // 「감자」는 3인칭이다. `나`는 대사 안에서만 쓰이므로 서술자가 아니다.
  assert.ok(!characters.includes("나"));
  // 근거가 1회뿐인 친족·직함 보통명사도 인물이 아니다.
  assert.deepEqual(characters.filter((name) => ["아버지", "노인", "장인"].includes(name)), []);
});

test("a first-person narrator is still recovered from narration", () => {
  // 위 규칙이 서술자까지 지우면 안 된다. 「날개」는 서술부에만 `나`가 54회 나온다.
  const characters = analyzeExternal(fs.readFileSync(new URL("../texts/wings.txt", import.meta.url), "utf8"))
    .characters.map((item) => item.canonical_name);

  assert.ok(characters.includes("나"));
  assert.ok(characters.includes("아내"));
});

test("a trailing Korean particle does not hide a mention", () => {
  const analysis = analyzeSample("gamja.txt", "gamja");

  // `복녀도`는 `복녀` + 조사 `도`다. 조사를 허용하지 않으면 이 언급이 통째로 사라진다.
  assert.ok(mentionTexts(analysis, "character", "복녀").includes("복녀도"));
  // 별칭에 열거되지 않은 조사형도 잡혀야 한다 — 열거로 때우면 언제나 빠지는 게 생긴다.
  assert.ok(mentionTexts(analysis, "location", "채마 밭").includes("채마 밭에"));
});

test("stacked particles and single-syllable names survive without enumerated aliases", () => {
  // 별칭에서 조사형 열거를 뺄 때 드러난 두 구멍이다. 열거가 죽은 무게로만 보였지만
  // 실제로는 이 둘을 떠받치고 있었다. 규칙으로 옮겼으므로 규칙이 지켜지는지 본다.
  const wings = analyzeSample("wings.txt", "wings");
  // `에게`+`는`처럼 겹친 조사는 결합형이 목록에 있어야 통째로 잡힌다.
  assert.ok(mentionTexts(wings, "character", "아내").includes("아내에게는"));

  // 한 글자 이름은 별칭 최소 길이(2)에 걸려 맨몸으로는 매칭에 쓰이지 못한다.
  const gamja = analyzeExternal(fs.readFileSync(new URL("../texts/gamja.txt", import.meta.url), "utf8"));
  assert.ok(gamja.locations.map((item) => item.name).includes("집"));
  assert.ok(mentionTexts(gamja, "location", "집").some((text) => text.startsWith("집")));
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
