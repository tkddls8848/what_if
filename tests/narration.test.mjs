import assert from "node:assert/strict";
import test from "node:test";

const { parseNarration, createNarrationSplitter, parseScene, CHOICE_MARKER, SCENE_MARKER } =
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

// --- <장면> 블록 (M1 step 3a) ---

test("parseScene: 장소·시간·날씨를 파싱한다", () => {
  const raw = [
    "<장면>",
    "장소: 3학년 2반 교실",
    "시간: 밤",
    "날씨: 비",
    "</장면>"
  ].join("\n");
  assert.deepEqual(parseScene(raw), { place: "3학년 2반 교실", time: "밤", weather: "비", visual: "" });
});

test("parseScene: 필드 순서가 달라도 받는다", () => {
  const raw = ["<장면>", "날씨: 맑음", "장소: 옥상", "시간: 낮", "</장면>"].join("\n");
  assert.deepEqual(parseScene(raw), { place: "옥상", time: "낮", weather: "맑음", visual: "" });
});

test("parseScene: 닫는 태그가 없어도 동작한다", () => {
  const raw = ["<장면>", "장소: 교실", "시간: 밤"].join("\n");
  assert.deepEqual(parseScene(raw), { place: "교실", time: "밤", weather: "", visual: "" });
});

test("parseScene: 블록이 없으면 null이다(장면이 안 바뀌었다는 뜻)", () => {
  assert.equal(parseScene("그냥 서술만 있다."), null);
  assert.equal(parseScene(""), null);
  assert.equal(parseScene(null), null);
});

test("parseScene: 필드가 일부만 있어도 던지지 않고 나머지는 빈 문자열이다", () => {
  const raw = ["<장면>", "장소: 복도", "</장면>"].join("\n");
  assert.deepEqual(parseScene(raw), { place: "복도", time: "", weather: "", visual: "" });
});

test("parseScene: 알아볼 수 없는 내용이어도 던지지 않는다", () => {
  const raw = ["<장면>", "이것은 형식을 안 지킨 줄이다", "</장면>"].join("\n");
  assert.deepEqual(parseScene(raw), { place: "", time: "", weather: "", visual: "" });
});

// --- <장면>의 visual 줄 (Problem A: 이미지 프롬프트는 영어여야 한다) ---

test("parseScene: visual 줄을 영어 그대로 파싱한다", () => {
  const raw = [
    "<장면>",
    "장소: 3학년 2반 교실",
    "시간: 밤",
    "날씨: 비",
    "visual: empty Korean high school classroom at night, fluorescent light on rows of desks, rain streaking the windows",
    "</장면>"
  ].join("\n");
  assert.deepEqual(parseScene(raw), {
    place: "3학년 2반 교실",
    time: "밤",
    weather: "비",
    visual: "empty Korean high school classroom at night, fluorescent light on rows of desks, rain streaking the windows"
  });
});

test("parseScene: visual 줄이 순서 상관없이, 대소문자 상관없이 잡힌다", () => {
  const raw = ["<장면>", "Visual: wet rooftop railing under a grey sky", "장소: 옥상", "</장면>"].join("\n");
  assert.deepEqual(parseScene(raw), { place: "옥상", time: "", weather: "", visual: "wet rooftop railing under a grey sky" });
});

test("parseScene: visual 줄이 없으면(누락) 빈 문자열이지 예외가 아니다", () => {
  const raw = ["<장면>", "장소: 교실", "시간: 밤", "날씨: 비", "</장면>"].join("\n");
  const scene = parseScene(raw);
  assert.equal(scene.visual, "");
});

test("parseNarration: 장면 블록이 선택지보다 먼저 와도 서술과 선택지에서 걷어낸다", () => {
  const raw = [
    "복도 끝에서 발소리가 멈췄다.",
    "<장면>",
    "장소: 3학년 2반 교실",
    "시간: 밤",
    "날씨: 비",
    "</장면>",
    "<선택지>",
    "1. 가",
    "2. 나",
    "3. 다",
    "</선택지>"
  ].join("\n");
  const { narration, choices } = parseNarration(raw);
  assert.equal(narration, "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(choices, ["가", "나", "다"]);
  assert.ok(!narration.includes("장소"), "장면 블록이 서술에 남았다");
});

test("parseNarration: 장면 블록이 선택지보다 나중에 와도 서술과 선택지에서 걷어낸다", () => {
  const raw = [
    "복도 끝에서 발소리가 멈췄다.",
    "<선택지>",
    "1. 가",
    "2. 나",
    "3. 다",
    "</선택지>",
    "<장면>",
    "장소: 옥상",
    "</장면>"
  ].join("\n");
  const { narration, choices } = parseNarration(raw);
  assert.equal(narration, "복도 끝에서 발소리가 멈췄다.");
  assert.deepEqual(choices, ["가", "나", "다"]);
});

test("parseNarration: 장면 블록만 있고 선택지가 없어도 서술에서 걷어낸다", () => {
  const raw = ["서술.", "<장면>", "장소: 교실", "</장면>"].join("\n");
  const { narration, choices } = parseNarration(raw);
  assert.equal(narration, "서술.");
  assert.deepEqual(choices, []);
});

// <장면>은 <선택지>와 성격이 다르다: <선택지>는 만나는 순간 영원히 멈추는 "컷"이지만,
// <장면>은 그 구간만 잘라내는 "잘라내기"다 — 실제 narrator 출력이 서술보다 장면
// 블록을 먼저 내는 모양이라(맨 앞에 <장면>...</장면>, 그 다음이 진짜 서술), 장면을
// 첫 마커로 보고 거기서 멈춰버리면 뒤따르는 진짜 서술을 통째로 삼킨다(회귀 결함).
// 아래는 그 결함의 재현 케이스(1번)와, 요구된 나머지 경우들을 chunk 경계를 일부러
// 어색한 자리에 두고 확인한다.

test("splitter: 장면 블록이 맨 앞에 와도 그 뒤 서술은 정상적으로 흐른다(회귀 가드)", () => {
  // 이 청크 분할은 narrator가 실제로 만드는 모양과 같다 — <장면>이 맨 앞, 그
  // 다음에 진짜 서술, 맨 끝에 선택지. 과거 결함에서는 이 경우 out이 통째로 ""였다.
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("<장면>\n장소: 3학년 2반 교실\n시간: 밤\n");
  out += splitter.push("날씨: 비\n</장면>\n형광등이 한 번 깜박였다. ");
  out += splitter.push("해린은 창가에 앉아 있었다.\n\n<선택지>\n1. 옆에 앉는다\n2. 나\n3. 다\n</선택지>");
  out += splitter.finish().delta;

  // </장면> 바로 뒤의 "\n"은 실제로 스트림에 있던 문자이므로(장면 블록과 서술을
  // 가르는 개행) 지워지지 않고 그대로 흐른다 — 요지는 뒤이은 진짜 서술이 통째로
  // 사라지지 않는다는 것이다(과거 결함은 out이 아예 ""였다).
  assert.equal(out, "\n형광등이 한 번 깜박였다. 해린은 창가에 앉아 있었다.\n\n");
  assert.ok(!out.includes(SCENE_MARKER) && !out.includes(CHOICE_MARKER) && !out.includes("장소"));
});

test("splitter: 장면 블록이 중간에 껴도 앞뒤 서술 모두 흐르고 블록만 빠진다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("복도 끝에서 발소리가 멈췄다. ");
  out += splitter.push("<장면>\n장소: 교실\n");
  out += splitter.push("</장면>형광등이 다시 켜졌다.\n\n<선택지>\n1. 가\n2. 나\n3. 다\n</선택지>");
  out += splitter.finish().delta;

  assert.equal(out, "복도 끝에서 발소리가 멈췄다. 형광등이 다시 켜졌다.\n\n");
});

test("splitter: <장면> 여는 마커가 조각으로 쪼개져 와도 새지 않는다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술.");
  out += splitter.push("<장"); // "<장면>"의 앞부분일 수 있으므로 붙들어야 한다
  assert.ok(!out.includes("<"), "마커 조각이 샜다: " + JSON.stringify(out));
  assert.ok("서술.".startsWith(out), "내보낸 것이 서술의 접두사가 아니다: " + JSON.stringify(out));
  out += splitter.push("면>\n장소: 교실\n");
  out += splitter.push("</장면>그 뒤 서술.");
  out += splitter.finish().delta;
  assert.equal(out, "서술.그 뒤 서술.");
});

test("splitter: </장면> 닫는 마커가 조각으로 쪼개져 와도 새지 않고 뒤 서술이 흐른다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("<장면>\n장소: 교실\n</장");
  // 닫는 마커가 아직 안 왔다 — 장면 안이므로 이 시점엔 아무것도 나오면 안 된다.
  assert.equal(out, "");
  out += splitter.push("면>다음 서술이 이어진다.");
  out += splitter.finish().delta;
  assert.equal(out, "다음 서술이 이어진다.");
});

test("splitter: 장면 블록이 끝내 닫히지 않으면 그 뒤(있다면)까지 통째로 버린다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술 시작. ");
  out += splitter.push("<장면>\n장소: 교실\n시간: 밤\n"); // 닫는 태그 없이 스트림이 끝난다
  out += splitter.finish().delta;

  assert.equal(out, "서술 시작. ");
  assert.ok(!out.includes(SCENE_MARKER));
});

test("splitter: 장면이 먼저, 선택지가 나중이면 둘 다 숨고 finish의 full은 그대로다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("<장면>\n장소: 교실\n</장면>서술 본문이다.\n\n");
  out += splitter.push("<선택지>\n1. 가\n2. 나\n3. 다\n</선택지>");
  const { delta, full } = splitter.finish();
  out += delta;

  assert.equal(out, "서술 본문이다.\n\n");
  assert.ok(full.includes(SCENE_MARKER) && full.includes(CHOICE_MARKER), "full은 원문을 그대로 담아야 parseNarration/parseScene이 동작한다");
  assert.deepEqual(parseNarration(full).choices, ["가", "나", "다"]);
  assert.deepEqual(parseScene(full), { place: "교실", time: "", weather: "", visual: "" });
});

test("splitter: 선택지가 먼저 오면 그 뒤에 오는 </장면>이 다시 흐름을 살리지 못한다", () => {
  const splitter = createNarrationSplitter();
  let out = "";
  out += splitter.push("서술.\n\n<선택지>\n1. 가\n2. 나\n3. 다\n</선택지>");
  // 컷 이후에 장면 마커를 닮은 텍스트가 더 온다 — 되살아나면 안 된다.
  out += splitter.push("<장면>\n장소: 이건 나오면 안 된다\n</장면>");
  out += splitter.finish().delta;

  assert.equal(out, "서술.\n\n");
});

test("splitter: <장면>을 닮았지만 아닌 텍스트는 결국 내보낸다", () => {
  const splitter = createNarrationSplitter();
  let out = splitter.push("이 장면은 인상적이다.");
  out += splitter.finish().delta;
  assert.equal(out, "이 장면은 인상적이다.");
});
