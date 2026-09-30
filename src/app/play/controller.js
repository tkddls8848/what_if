import { updateGauges, renderLastChange, showJudgeNotice, showEnding, hideEnding } from './status-view.js';
import { createSession, normalizeSession, sessionMarkdown } from "../../core/session.js";
import { createPlayStore, downloadStory } from "../play-store.js";
import { isPlayableCard } from "../../core/card.js";

const store = createPlayStore();
const SCENE_KEY = "novel-if-play:scene";
const log = document.getElementById("log");
const choicesBox = document.getElementById("choices");
const form = document.getElementById("form");
const input = document.getElementById("input");
const meter = document.getElementById("meter");
const worldTitleEl = document.getElementById("worldTitle");
const worldSettingEl = document.getElementById("worldSetting");
const worldNameStaticEl = document.getElementById("worldNameStatic");
const worldPickerEl = document.getElementById("worldPicker");
const castListEl = document.getElementById("castList");

const sceneImgEl = document.getElementById("sceneImg");
const scenePlaceholderEl = document.getElementById("scenePlaceholder");

const stopBtn = document.getElementById("stopBtn");
const restartBtn = document.getElementById("restartBtn");

const playNotice = document.getElementById("playNotice");
let busy = true;
let ready = false;
let session = load();

function load() {
  try {
    const saved = store.active();
    if (saved) return saved;
  } catch (_error) { tell("저장된 이야기를 읽지 못했습니다. 내 이야기의 기록을 확인하세요."); }
  return createSession({ world_id: "demo" });
}

function save() {
  try { store.save(session); return true; }
  catch (_error) { tell("저장 공간이 부족하거나 브라우저 저장이 차단됐습니다. 이 창을 닫기 전에 이야기 내려받기로 보관하세요."); return false; }
}

function tell(message) { playNotice.textContent = message; playNotice.hidden = !message; }
function setBusy(value) {
  busy = value;
  input.disabled = value || !ready;
  form.querySelector("button").disabled = value || !ready;
  worldPickerEl.disabled = value;
  stopBtn.disabled = value;
  restartBtn.disabled = value;
  choicesBox.querySelectorAll("button").forEach((button) => { button.disabled = value || !ready; });
}

/** 배경 장면 이미지 URL은 session(서버 계약)의 일부가 아니라 화면 전용 상태라
 * 별도 키에 세션 id와 묶어 저장한다 — 세션 저장 값이 매 턴 서버 응답으로 통째로
 * 교체되기 때문에 session 객체 안에 넣으면 다음 턴에 사라진다. */
function loadSceneUrl(sessionId) {
  try {
    const saved = JSON.parse(localStorage.getItem(`${SCENE_KEY}:${sessionId}`) || "null");
    if (saved && saved.session_id === sessionId) return saved.url || null;
  } catch (_error) { /* 무시 */ }
  return null;
}

function saveSceneUrl(sessionId, url) {
  try { localStorage.setItem(`${SCENE_KEY}:${sessionId}`, JSON.stringify({ session_id: sessionId, url })); } catch (_error) { /* 배경은 다시 생성할 수 있다 */ }
}

/** 세계관 헤더와 캐스트 패널을 그린다. 목록이 아니라 상세 응답 하나로 채운다. */
function renderWorldHeader(world, cards) {
  worldTitleEl.textContent = world?.title || session.world_id;
  worldSettingEl.textContent = world?.setting || "";

  castListEl.replaceChildren();
  for (const card of cards || []) {
    const wrap = document.createElement("div");
    wrap.className = "castCard";

    const heading = document.createElement("strong");
    heading.textContent = card.aliases?.length
      ? `${card.canonical_name} (${card.aliases.join(", ")})`
      : card.canonical_name;
    wrap.append(heading);

    const lines = [];
    if (card.persona?.traits?.length) lines.push(`성격: ${card.persona.traits.join(", ")}`);
    if (card.speech?.first_person) {
      const endings = card.speech.endings?.length ? ` · 어미 ${card.speech.endings.join(", ")}` : "";
      lines.push(`말투: 1인칭 "${card.speech.first_person}"${endings}`);
    }
    for (const text of lines) {
      const p = document.createElement("p");
      p.textContent = text;
      wrap.append(p);
    }
    castListEl.append(wrap);
  }
}

async function fetchWorldDetail(worldId) {
  const response = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`);
  if (!response.ok) throw new Error(`world detail fetch failed: ${response.status}`);
  return response.json();
}

async function fetchWorldsList() {
  const response = await fetch("/api/worlds");
  if (!response.ok) throw new Error(`worlds list fetch failed: ${response.status}`);
  const body = await response.json();
  return body.worlds || [];
}

/**
 * 세계관을 불러와 헤더/캐스트를 그린다. seedOpening이 참이면 세션의 opening을
 * 이 세계관의 저작된 오프닝으로 덮어쓴다 — 새 세션을 시작할 때만 쓴다. 진행 중인
 * 세션은 이미 자기 opening을 갖고 있으므로 덮어쓰지 않는다.
 *
 * card_ids도 여기서 채운다: 비어 있으면(새 세션이거나, 이 필드가 생기기 전에
 * 저장된 세션이거나) 이 세계관의 카드로 채운다. card_ids가 비어 있으면 서버의
 * 판정기가 판정할 대상이 없어 두 게이지가 영원히 0에 머무는 핵심 결함이 있었다 —
 * 여기서 항상 채워 둔다.
 */
async function loadWorldHeader(worldId, { seedOpening } = {}) {
  try {
    const detail = await fetchWorldDetail(worldId);
    renderWorldHeader(detail.world, detail.cards.filter(isPlayableCard));
    if (seedOpening) session.opening = detail.world.opening || "";
    if (!Array.isArray(session.card_ids) || session.card_ids.length === 0) {
      session.card_ids = (detail.cards || []).filter(isPlayableCard).map((card) => card.card_id).filter(Boolean);
    }
    ready = session.card_ids.length > 0;
    session = normalizeSession(session);
    if (!ready) tell("등장할 캐릭터가 없습니다. 캐릭터 검수에서 설정을 확인하세요.");
  } catch (_error) {
    // 세계관 API를 못 가져와도 화면은 살아 있어야 한다 — 최소한 id는 보여준다.
    worldTitleEl.textContent = session.world_id;
    worldSettingEl.textContent = "";
    castListEl.replaceChildren();
    ready = false;
    tell("세계관을 불러오지 못했습니다. 연결을 확인하고 새로고침하세요.");
  }
}

function renderOpening() {
  // 오프닝은 이야기의 첫 장면으로 읽혀야 한다. UI 안내처럼 보이지 않도록 일반
  // 서술과 같은 클래스를 쓰고, "> 입력" 접두어도 붙이지 않는다. 턴이 하나라도
  // 있으면 그 자리는 이미 실제 서술이 대신하므로 다시 넣지 않는다.
  if (!session.opening) return;
  const scene = document.createElement("p");
  scene.className = "scene";
  scene.textContent = session.opening;
  log.append(scene);
}

/** 등록된 캐릭터 중 최댓값을 관계 게이지에 쓴다 — endingFor가 card_id 없이 쓸 때와
 * 같은 규칙이라, 캐릭터가 하나뿐인 세계관에서도 여럿인 세계관에서도 자연스럽다. */
function setSceneImage(url) {
  if (!url) return;
  sceneImgEl.onload = () => sceneImgEl.classList.add("loaded");
  sceneImgEl.onerror = () => {
    sceneImgEl.hidden = true;
    sceneImgEl.classList.remove("loaded");
  };
  sceneImgEl.hidden = false;
  sceneImgEl.classList.remove("loaded");
  sceneImgEl.src = url;
  saveSceneUrl(session.session_id, url);
}

function restoreSceneImage() {
  const url = loadSceneUrl(session.session_id);
  if (url) {
    setSceneImage(url);
  } else {
    sceneImgEl.hidden = true;
    sceneImgEl.classList.remove("loaded");
    sceneImgEl.removeAttribute("src");
  }
}

/** 이미지가 없을 때(새 세션, 장면이 안 바뀜, 생성 실패) 패널이 빈 구멍처럼 보이지
 * 않도록 장소·시간·날씨를 텍스트로 채운다. 이미지가 도착해 덮으면 안 보이지만,
 * 이미지가 실패하거나 아직 없으면 계속 이 텍스트가 패널의 유일한 내용이 된다. */
function sceneDescriptor(scene) {
  if (!scene || (!scene.place && !scene.time && !scene.weather)) return "장면: 아직 정해지지 않음";
  return [scene.place, scene.time, scene.weather].filter(Boolean).join(" · ");
}

function updateScenePlaceholder() {
  scenePlaceholderEl.textContent = sceneDescriptor(session.current_scene);
}

function render() {
  log.replaceChildren();
  renderOpening();
  for (const turn of session.turns || []) {
    // 스트림이 글자 하나 오기 전에 끊긴 턴은 narration이 빈 문자열로 저장된다.
    // 그대로 그리면 새로고침할 때마다 사용자 입력 뒤에 영원히 빈 장면이 보인다.
    if (!turn.narration) continue;
    const you = document.createElement("p");
    you.className = "you";
    you.textContent = `> ${turn.user_input}`;
    log.append(you);
    const scene = document.createElement("p");
    scene.className = "scene";
    scene.textContent = turn.narration;
    log.append(scene);
    if (turn.truncated) {
      const cut = document.createElement("p");
      cut.className = "cut";
      cut.textContent = "도중에 끊긴 장면입니다.";
      log.append(cut);
    }
  }
  const last = (session.turns || [])[session.turns.length - 1];
  renderChoices(last ? last.choices : []);
  updateGauges(session);
  restoreSceneImage();
  updateScenePlaceholder();
  renderLastChange(null);
  showJudgeNotice(false);

  if (session.ended) {
    showEnding(session);
  } else {
    hideEnding();
  }
}

function renderChoices(choices) {
  choicesBox.replaceChildren();
  for (const choice of choices || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.disabled = busy || !ready;
    button.addEventListener("click", () => send(choice));
    choicesBox.append(button);
  }
}

async function refreshMeter() {
  try {
    const health = await fetch("/api/cf/health").then((r) => r.json());
    const providers = health.providers || [];
    const configured = health.configured || providers.some((provider) => provider.configured);
    meter.textContent = configured
      ? `오늘 서버 추정 잔량 ${Math.round(health.budget.remaining).toLocaleString()} Neurons`
      : "서술 연결 미설정";
    if (!configured) tell("이야기를 생성하려면 .env에 Cloudflare 또는 Gemini 키를 설정하세요. 세계관과 저장된 이야기는 먼저 살펴볼 수 있습니다.");
  } catch (_error) {
    meter.textContent = "";
  }
}

/** 다른 세계관으로 완전히 새 세션을 시작한다. 진행 중이던 턴은 버려진다. */
async function startNewSession(worldId) {
  if (busy || !save()) return;
  setBusy(true);
  session = createSession({ world_id: worldId });
  await loadWorldHeader(worldId, { seedOpening: true });
  save();
  render();
  setBusy(false);
  refreshMeter();
}

worldPickerEl.addEventListener("change", async () => {
  const nextId = worldPickerEl.value;
  if (!nextId || nextId === session.world_id) return;

  await startNewSession(nextId);
});

stopBtn.addEventListener("click", () => {
  if (busy) return;
  if (!confirm("지금까지의 이야기를 여기서 끝내시겠습니까?")) return;
  session.ended = true;
  save();
  showEnding(session);
});

restartBtn.addEventListener("click", async () => {
  await startNewSession(session.world_id);
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  downloadStory(`${session.world_id}.md`, sessionMarkdown(session), "text/markdown");
});

async function send(userInput) {
  if (busy || !ready || session.ended || !userInput.trim()) return;
  setBusy(true);
  let completed = false;
  renderChoices([]);

  const you = document.createElement("p");
  you.className = "you";
  you.textContent = `> ${userInput}`;
  log.append(you);

  const scene = document.createElement("p");
  scene.className = "scene pending";
  log.append(scene);
  scene.scrollIntoView({ block: "end" });

  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ session, user_input: userInput })
    });

    if (!response.ok) {
      // 스트림이 시작되기 전에 실패하면 본문은 SSE가 아니라 JSON 한 덩어리다.
      // 그대로 SSE 파서에 넣으면 프레임 경계가 없어 조용히 삼켜진다.
      const body = await response.json().catch(() => null);
      scene.className = "scene error";
      scene.textContent = body?.message || "요청이 실패했습니다.";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "narration") {
          scene.textContent += payload.delta;
          scene.scrollIntoView({ block: "end" });
        } else if (event === "scene") {
          // 배경 이미지는 서술이 다 흐른 몇 초 뒤에 온다 — 도착하면 그때 끼워
          // 넣을 뿐, 텍스트를 기다리게 하지 않는다.
          setSceneImage(payload.url);
        } else if (event === "done") {
          completed = true;
          scene.className = "scene";
          scene.textContent = payload.turn.narration;
          session = payload.session;
          save();
          renderChoices(payload.turn.choices);
          updateGauges(session);
          updateScenePlaceholder();
          renderLastChange(payload.last_change);
          showJudgeNotice(Boolean(payload.judge_unavailable));
          if (payload.truncated) {
            // 스트림이 도중에 끊긴 장면이다. 독자가 모르면 작가가 문장을 끊은 것으로 읽는다.
            const cutEl = document.createElement("p");
            cutEl.className = "cut";
            cutEl.textContent = "장면이 도중에 끊겼습니다. 이어서 입력하면 계속됩니다.";
            log.append(cutEl);
          }
          // budget_unknown이면 단가를 몰라 계량하지 못한 모델이었다는 뜻이다.
          // 숫자를 그대로 두면 실제로는 과금됐는데 화면은 그대로인 것처럼 보인다.
          meter.textContent = payload.budget_unknown
            ? (payload.provider === "gemini" ? "Gemini로 이어 쓰는 중 · Neuron 집계 제외" : "이번 장면의 Neuron 사용량 미확인")
            : `오늘 서버 추정 잔량 ${Math.round(payload.budget.remaining).toLocaleString()} Neurons`;
        } else if (event === "error") {
          scene.className = "scene error";
          scene.textContent = payload.message;
        }
      }
    }
    if (!completed) tell("연결이 끊겨 이번 행동을 저장하지 못했습니다. 입력을 확인하고 다시 보내세요.");
  } catch (error) {
    if (completed) tell("이야기는 저장됐지만 배경 연결이 끊겼습니다.");
    else {
      scene.className = "scene error";
      scene.textContent = "요청이 실패했습니다. 입력을 확인하고 다시 보내세요.";
    }
  } finally {
    setBusy(false);
    if (completed) input.value = "";
    else {
      input.value = userInput;
      renderChoices(session.turns.at(-1)?.choices || []);
    }
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (value) send(value);
});

async function init() {
  // 헤더부터 그린다 — 목록 API가 실패해도 최소한 지금 세계관은 보이게 한다.
  // 진행 중인 세션(턴이 이미 있는)의 opening은 덮어쓰지 않는다.
  await loadWorldHeader(session.world_id, { seedOpening: (session.turns || []).length === 0 });
  save();
  render();
  setBusy(false);

  try {
    const worlds = await fetchWorldsList();
    if (worlds.length > 1) {
      worldPickerEl.replaceChildren();
      for (const world of worlds) {
        const option = document.createElement("option");
        option.value = world.world_id;
        option.textContent = world.title || world.world_id;
        worldPickerEl.append(option);
      }
      worldPickerEl.value = session.world_id;
      worldPickerEl.hidden = false;
    } else if (worlds.length === 1) {
      // 세계관이 하나뿐이면 고를 게 없다 — 옵션 하나짜리 드롭다운 대신 이름만 보여준다.
      worldNameStaticEl.textContent = worlds[0].title || worlds[0].world_id;
      worldNameStaticEl.hidden = false;
    }
  } catch (_error) {
    /* 목록을 못 가져와도 위에서 이미 헤더는 그려졌다 */
  }
}

setBusy(true);
init();
refreshMeter();
