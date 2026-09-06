import assert from "node:assert/strict";
import test from "node:test";

process.env.NOVEL_IF_CACHE = "0";
process.env.CF_ACCOUNT_ID = "acc-test";
process.env.CF_API_TOKEN = "tok-secret";

const serverModule = await import("../server.js");
const { app } = serverModule.default || serverModule;

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("GET /: 랜딩 페이지를 돌려주고, 분석기 마크업은 섞이지 않는다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("Novel IF"), "랜딩 페이지 제목이 없다");
    assert.ok(body.includes('href="/play"'), "/play 링크가 없다");
    assert.ok(body.includes('href="/analyze"'), "/analyze 링크가 없다");
    // index: false를 빼먹으면 정적 미들웨어가 index.html을 대신 내려준다 — 그 회귀를
    // 잡기 위한 핵심 단언이다.
    assert.ok(!body.includes("sampleSelect"), "분석기 마크업(index.html)이 '/'에서 나왔다");
  } finally {
    server.close();
  }
});

test("GET /analyze: 분석기 워크스페이스(index.html)를 돌려준다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/analyze`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("sampleSelect"), "분석기 마크업이 없다");
  } finally {
    server.close();
  }
});

test("GET /check: 분석기 워크스페이스(index.html)를 돌려준다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/check`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("sampleSelect"), "분석기 마크업이 없다");
  } finally {
    server.close();
  }
});

test("GET /play: 인터랙티브 소설 페이지를 돌려준다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/play`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("인터랙티브 소설"), "play.html 마크업이 없다");
  } finally {
    server.close();
  }
});

test("GET /play: 숫자 없는 게이지(관계/회복)와 결말 화면 마크업을 함께 돌려준다", async () => {
  const { server, port } = await listen();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/play`);
    assert.equal(response.status, 200);
    const body = await response.text();

    // 관계/회복 게이지 — 단계·문구 텍스트와 진행 바가 있어야 하고, 숫자를
    // 그대로 보여주는 요소(예: "48/100" 같은 리터럴)가 있으면 안 된다.
    assert.ok(body.includes('id="affectionState"'), "관계 게이지 상태 텍스트 요소가 없다");
    assert.ok(body.includes('id="recoveryState"'), "회복 게이지 상태 텍스트 요소가 없다");
    assert.ok(body.includes('id="affectionFill"') && body.includes('id="recoveryFill"'), "진행 바 요소가 없다");
    assert.ok(!/\d+\s*\/\s*100/.test(body), "게이지에 원시 숫자(x/100)가 마크업에 그대로 있다");

    // 트리거 안내(왜 게이지가 움직였는지)와 판정 불가 안내.
    assert.ok(body.includes('id="affectionNote"') && body.includes('id="recoveryNote"'), "트리거 안내 요소가 없다");
    assert.ok(body.includes('id="oppositeNote"'), "반대 방향 이동(의존) 안내 요소가 없다");
    assert.ok(body.includes('id="judgeNotice"'), "판정기 불가 안내 요소가 없다");

    // 장면 배경 이미지 자리 — 도착 전에도 자리를 미리 잡아야 한다.
    assert.ok(body.includes('id="scenePanel"') && body.includes('id="sceneImg"'), "장면 이미지 자리가 없다");

    // 2단 레이아웃 — 왼쪽 sticky 장면 패널 + 오른쪽 읽기 칸(main). 채팅 로그 안에 이미지를
    // 두던 옛 구조로 되돌아가면 안 된다는 회귀 가드다.
    assert.ok(body.includes('class="layout"'), "2단 레이아웃 컨테이너가 없다");
    assert.ok(body.includes('id="scenePlaceholder"'), "이미지가 없을 때 보여줄 장면 텍스트 자리가 없다");
    // scenePanel은 layout의 자식이고, log보다 마크업 순서상 앞서야 한다(모바일에서
    // 세로로 쌓일 때 장면 패널이 본문 위에 오도록).
    const layoutIdx = body.indexOf('class="layout"');
    const scenePanelIdx = body.indexOf('id="scenePanel"');
    const logIdx = body.indexOf('id="log"');
    assert.ok(layoutIdx !== -1 && layoutIdx < scenePanelIdx && scenePanelIdx < logIdx,
      "장면 패널이 layout 안에서 로그보다 먼저 오지 않는다");
    // 장면 패널은 로그(.scene 문단들)와 형제가 아니라 그 바깥의 별도 칸이어야 한다 —
    // "이미지를 텍스트 라인 안에 두지 말라"는 요구의 마크업 단언.
    assert.ok(!/id="log">\s*<div class="scenePanel"/.test(body), "장면 패널이 로그 안쪽에 있다");

    // 결말 화면과 조기 종료 컨트롤.
    assert.ok(body.includes('id="ending"'), "결말 화면 요소가 없다");
    assert.ok(body.includes("여기서 끝내기"), "조기 종료 컨트롤이 없다");
    assert.ok(body.includes("다시 시작하기"), "다시 시작 컨트롤이 없다");
  } finally {
    server.close();
  }
});
