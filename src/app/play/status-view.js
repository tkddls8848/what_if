import { stageFor, stageLabel, recoveryLabel, endingFor } from '../../core/sim.js';
const ENDING_TARGET = 60;

// 결말 화면용 문구. sim.js의 endingFor가 돌려주는 reason은 개발자용 진단 문구라
// "실패 화면처럼 읽히면 안 된다"는 요구에 맞춰 플레이어에게 보여줄 문구는 따로 쓴다.
// 특히 dependence는 경고나 채점이 아니라 담담한 관찰로 읽혀야 한다.
const ENDINGS = {
  together: {
    name: "함께 선다",
    line: "당신은 기대지 않고도 곁에 남았다. 함께한 이들도 그 옆에 그대로 있다."
  },
  standing_alone: {
    name: "혼자 설 수 있게 됐다",
    line: "곁에 있던 이는 이제 떠났을지도 모른다. 그래도 당신은 이제 두 발로 서 있다. 이것도 나쁜 결말이 아니다."
  },
  dependence: {
    name: "기대어 있다",
    line: "누군가는 여전히 곁에 있고, 당신은 아직 그 곁을 벗어나면 흔들린다. 나쁘다고 말할 수는 없다. 다만 혼자 서는 일은 아직 남아 있다."
  },
  winter: {
    name: "그대로, 겨울",
    line: "아무것도 크게 바뀌지 않은 채로 계절이 지나갔다. 다음 겨울은 다를 수도 있다."
  }
};

const affectionStateEl = document.getElementById("affectionState");
const affectionFillEl = document.getElementById("affectionFill");
const affectionBarEl = document.getElementById("affectionBar");
const affectionNoteEl = document.getElementById("affectionNote");
const recoveryStateEl = document.getElementById("recoveryState");
const recoveryFillEl = document.getElementById("recoveryFill");
const recoveryBarEl = document.getElementById("recoveryBar");
const recoveryNoteEl = document.getElementById("recoveryNote");
const oppositeNoteEl = document.getElementById("oppositeNote");
const judgeNoticeEl = document.getElementById("judgeNotice");

const controlsEl = document.getElementById("controls");
const stopBtn = document.getElementById("stopBtn");
const endingEl = document.getElementById("ending");
const endingNameEl = document.getElementById("endingName");
const endingLineEl = document.getElementById("endingLine");
const choicesBox = document.getElementById("choices");
const form = document.getElementById("form");
const noteTimers = { affection: null, recovery: null };
function primaryAffection(sim) {
  const characters = sim && sim.characters ? Object.values(sim.characters) : [];
  if (!characters.length) return 0;
  return Math.max(...characters.map((c) => Number(c.affection) || 0));
}

function updateGauges(session) {
  const sim = session.sim || { characters: {}, recovery: 0 };
  const affection = Math.max(0, Math.min(100, primaryAffection(sim)));
  const stage = stageFor(affection);
  const stageText = stageLabel(stage);
  affectionStateEl.textContent = stageText;
  affectionFillEl.style.width = `${affection}%`;
  affectionBarEl.setAttribute("aria-label", `관계 진행도: ${stageText}`);

  const recovery = Math.max(0, Math.min(100, Number(sim.recovery) || 0));
  const recoveryText = recoveryLabel(recovery);
  recoveryStateEl.textContent = recoveryText;
  recoveryFillEl.style.width = `${recovery}%`;
  recoveryBarEl.setAttribute("aria-label", `회복 진행도: ${recoveryText}`);
}

/** 트리거 문구를 잠깐 보여주고 스스로 사라지게 한다 — 조용한 안내이지 모달이 아니다. */
function flashNote(el, text, key) {
  if (noteTimers[key]) clearTimeout(noteTimers[key]);
  if (!text) {
    el.classList.remove("show");
    el.textContent = "";
    return;
  }
  el.textContent = text;
  el.classList.add("show");
  noteTimers[key] = setTimeout(() => el.classList.remove("show"), 6000);
}

/** 이번 턴에 실제로 맞은 트리거를 authored 문구 그대로 보여준다. 두 축이 반대로
 * 움직였으면(의존 신호) 조용히, 그러나 분명하게 알린다 — 이 시뮬레이션이 하는
 * 가장 중요한 말이기 때문에 자동으로 사라지지 않는다. */
function renderLastChange(lastChange) {
  if (!lastChange) {
    flashNote(affectionNoteEl, "", "affection");
    flashNote(recoveryNoteEl, "", "recovery");
    oppositeNoteEl.hidden = true;
    return;
  }
  const matched = lastChange.matched || { attraction: [], dislike: [], relief: [], strain: [] };
  const affectionLines = [
    ...(matched.attraction || []).map((t) => `+ ${t}`),
    ...(matched.dislike || []).map((t) => `− ${t}`)
  ];
  const recoveryLines = [
    ...(matched.relief || []).map((t) => `+ ${t}`),
    ...(matched.strain || []).map((t) => `− ${t}`)
  ];
  flashNote(affectionNoteEl, affectionLines.join("  ·  "), "affection");
  flashNote(recoveryNoteEl, recoveryLines.join("  ·  "), "recovery");

  const affDelta = Number(lastChange.affection_delta) || 0;
  const recDelta = Number(lastChange.recovery_delta) || 0;
  const opposite = (affDelta > 0 && recDelta < 0) || (affDelta < 0 && recDelta > 0);
  if (opposite) {
    oppositeNoteEl.textContent = affDelta > 0
      ? "관계는 가까워졌지만 회복은 오히려 멀어졌다 — 기대는 것과 나아지는 것은 다른 일이다."
      : "관계는 멀어졌지만 회복은 오히려 나아졌다 — 밀어내는 것이 늘 나쁜 것은 아니다.";
    oppositeNoteEl.hidden = false;
  } else {
    oppositeNoteEl.hidden = true;
  }
}

function showJudgeNotice(unavailable) {
  judgeNoticeEl.hidden = !unavailable;
}

function computeEnding(session) {
  return endingFor(session.sim, { affectionTarget: ENDING_TARGET, recoveryTarget: ENDING_TARGET });
}

function showEnding(session) {
  const result = computeEnding(session);
  const meta = ENDINGS[result.ending] || ENDINGS.winter;
  endingNameEl.textContent = meta.name;
  endingLineEl.textContent = meta.line;
  endingEl.hidden = false;
  choicesBox.hidden = true;
  controlsEl.hidden = false;
  stopBtn.hidden = true;
  form.hidden = true;
}

function hideEnding() {
  endingEl.hidden = true;
  choicesBox.hidden = false;
  controlsEl.hidden = false;
  stopBtn.hidden = false;
  form.hidden = false;
}


export { updateGauges, renderLastChange, showJudgeNotice, showEnding, hideEnding };
