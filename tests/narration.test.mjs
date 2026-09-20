import assert from "node:assert/strict";
import test from "node:test";

const { parseNarration, createNarrationSplitter, CHOICE_MARKER } =
  await import("../src/core/narration.js");

test("parseNarration: 마커 앞은 서술, 뒤의 번호 목록은 선택지다", () => {
  const raw = [
    "복도 끝에서 발소리가 멈췄다.",
    "",
    "<선택지>",
    "1. 아무 말 없이 옆에 선다",
    "2. \"혼자 두면 또 무리할 거잖아\"",
    "3. 돌아서서 그대로 나간다",
    "</선택지>"
  ].join("\n");

  const { narration, choices } = parseNarration(raw);
  assert.equal(narration, "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(choices, [
    "아무 말 없이 옆에 선다",
    "\"혼자 두면 또 무리할 거잖아\"",
    "돌아서서 그대로 나간다"
  ]);
});

test("parseNarration: 닫는 태그가 없어도 동작한다", () => {
  const { narration, choices } = parseNarration("서술.\n<선택지>\n1. 가\n2. 나\n3. 다");
  assert.equal(narration, "서술.");
  assert.deepEqual(choices, ["가", "나", "다"]);
});

test("parseNarration: 마커가 아예 없으면 전부 서술이고 선택지는 빈 배열이다", () => {
  // 모델이 형식을 안 지키는 일은 반드시 생긴다. 그때 턴을 실패시키지 않는다.
  const { narration, choices } = parseNarration("그냥 서술만 있다.");
  assert.equal(narration, "그냥 서술만 있다.");
  assert.deepEqual(choices, []);
});

test("parseNarration: 번호 표기가 흔들려도 받는다", () => {
  const { choices } = parseNarration("s\n<선택지>\n1) 가\n2. 나\n- 다\n3 라");
  assert.deepEqual(choices, ["가", "나", "다", "라"]);
});

test("parseNarration: 빈 입력은 빈 결과다", () => {
  assert.deepEqual(parseNarration(""), { narration: "", choices: [] });
  assert.deepEqual(parseNarration(null), { narration: "", choices: [] });
});

test("splitter: 마커 앞까지만 내보내고 마커부터는 삼킨다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("복도 끝에서 ");
  out += splitter.push("발소리가 멈췄다.\n\n");
  out += splitter.push("<선택지>\n1. 가\n");
  out += splitter.push("2. 나\n3. 다\n");
  const { delta, full } = splitter.finish();
  out += delta;

  assert.equal(out, "복도 끝에서 발소리가 멈췄다.\n\n");
  assert.ok(full.includes(CHOICE_MARKER));
  assert.deepEqual(parseNarration(full).choices, ["가", "나", "다"]);
});

test("splitter: 마커가 조각으로 쪼개져 와도 화면에 새지 않는다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술.");
  out += splitter.push("<선");   // 마커의 앞부분일 수 있으므로 붙들어야 한다
  // 이 시점에 "서술.<선"의 꼬리는 아직 붙들려 있다. 확정된 것은 마커의 일부일 수
  // 없는 앞부분뿐이며, 중요한 것은 "<"가 화면으로 새지 않았다는 것이다.
  assert.ok(!out.includes("<"), "마커 조각이 샜다: " + JSON.stringify(out));
  assert.ok("서술.".startsWith(out), "내보낸 것이 서술의 접두사가 아니다: " + JSON.stringify(out));
  out += splitter.push("택지>\n1. 가\n2. 나\n3. 다");
  out += splitter.finish().delta;
  assert.equal(out, "서술.");
});

test("splitter: 마커를 닮았지만 아닌 꼬리는 결국 내보낸다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술 <선택");
  out += splitter.push("의 여지가 없다.");
  out += splitter.finish().delta;
  assert.equal(out, "서술 <선택의 여지가 없다.");
});

test("splitter: 마커가 끝내 오지 않으면 finish가 남은 것을 전부 내보낸다", () => {
  const splitter = createNarrationSplitter();
  let out = splitter.push("서술만 있다.");
  const { delta, full } = splitter.finish();
  out += delta;
  assert.equal(out, "서술만 있다.");
  assert.equal(full, "서술만 있다.");
});

// --- 장면 마커는 더 이상 없다 (미술감독 분리) ---
//
// 예전에는 서술자가 산문 안에 `<장면>` 블록을 써 넣었고 이 파일이 그걸 갈랐다.
// 그 판정은 src/server/director.js의 별도 호출로 옮겼으므로(tests/director.test.mjs),
// 여기서는 그 흔적이 **정말로 없어졌는지**와, 없어진 뒤에도 선택지 가르기가
// 그대로인지만 확인한다.

test("narration.js는 장면 파싱 심볼을 더 이상 내보내지 않는다", async () => {
  const mod = await import("../src/core/narration.js");
  for (const name of ["parseScene", "SCENE_MARKER", "cutSceneBlock"]) {
    assert.equal(mod[name], undefined, `${name}이 아직 남아 있다`);
  }
});

test("parseNarration: 서술자가 환각으로 <장면> 블록을 뱉으면 서술에 그대로 남는다", () => {
  // 걷어내지 않는 것이 의도다 — 출력 규칙에서 블록이 통째로 사라졌으므로 모델이
  // 그걸 쓸 이유가 없고, 그래도 샌다면 프롬프트가 잘못됐다는 신호로 눈에 띄어야
  // 한다. 조용히 지우면 그 신호가 사라진다(설계 8절의 판단).
  const raw = ["서술.", "<장면>", "장소: 교실", "</장면>"].join("\n");
  const { narration, choices } = parseNarration(raw);
  assert.ok(narration.includes("<장면>"), "장면 블록이 조용히 지워졌다");
  assert.deepEqual(choices, []);
});

test("parseNarration: 장면 블록이 섞여 있어도 선택지는 정확히 갈라진다", () => {
  const raw = [
    "복도 끝에서 발소리가 멈췄다.",
    "<장면>",
    "장소: 3학년 2반 교실",
    "</장면>",
    "<선택지>",
    "1. 가",
    "2. 나",
    "3. 다",
    "</선택지>"
  ].join("\n");
  const { choices } = parseNarration(raw);
  assert.deepEqual(choices, ["가", "나", "다"]);
});

test("splitter: <장면>은 더 이상 특별하지 않다 — 그냥 서술로 흐른다", () => {
  // 컷은 <선택지> 하나뿐이다. 장면 블록을 숨기는 상태 기계가 사라졌으므로,
  // 모델이 그걸 뱉으면 화면에 그대로 보인다(위 parseNarration 테스트와 같은 이유).
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("<장면>\n장소: 교실\n</장면>서술 본문. ");
  out += splitter.push("이어지는 서술.\n\n<선택지>\n1. 가\n2. 나\n3. 다\n</선택지>");
  const { delta, full } = splitter.finish();
  out += delta;

  assert.ok(out.includes("서술 본문. 이어지는 서술."), "서술이 사라졌다: " + JSON.stringify(out));
  assert.ok(!out.includes(CHOICE_MARKER), "선택지 마커가 샜다");
  assert.ok(full.includes(CHOICE_MARKER), "full은 원문을 그대로 담아야 parseNarration이 동작한다");
  assert.deepEqual(parseNarration(full).choices, ["가", "나", "다"]);
});

test("splitter: 선택지 마커를 만나면 그 뒤로는 무엇이 와도 흐르지 않는다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술.\n\n<선택지>\n1. 가\n2. 나\n3. 다\n</선택지>");
  out += splitter.push("이건 나오면 안 된다");
  out += splitter.finish().delta;

  assert.equal(out, "서술.\n\n");
});

test("splitter: 마커를 닮았지만 아닌 텍스트는 결국 내보낸다", () => {
  const splitter = createNarrationSplitter();
  let out = splitter.push("이 장면은 인상적이다.");
  out += splitter.finish().delta;
  assert.equal(out, "이 장면은 인상적이다.");
});
