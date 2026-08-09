/**
 * @module app/view/whatif
 *
 * 분기(what-if) 화면.
 *
 * 흐름: 분기점 후보 선택 → 시드 구성(`core/whatif.js`) → 서버가 Ollama 호출 →
 * 정규화·원작 인용 검사 → `analysis.branches[]`에 추가.
 *
 * 화면 규칙:
 * - 생성물은 원작 사실과 시각적으로 구분한다. 근거가 없는 항목이기 때문이다.
 * - 원작 인용이 검출된 분기는 경고를 띄운다. 분기가 아니라 재현이기 때문이다.
 * - 3점 루브릭은 사람이 채점한다. 자동 점수를 매기지 않는다.
 */
import { state, els } from "../context.js";
import {
  BRANCH_RUBRIC,
  attachBranch,
  branchIssues,
  branchSeed,
  forkCandidates,
  normalizeBranch
} from "../../core/whatif.js";
import { escapeAttr, escapeHtml, eventTypeLabel } from "../utils.js";

const ui = {
  fork: null,
  premise: "",
  busy: false,
  message: ""
};

export function resetWhatIf() {
  ui.fork = null;
  ui.premise = "";
  ui.busy = false;
  ui.message = "";
}

export function renderWhatIf() {
  if (!els.whatifPanel) return;
  const analysis = state.analysis;
  if (!analysis) {
    els.whatifPanel.innerHTML = `<div class="empty-state">먼저 원문을 분석하세요.</div>`;
    return;
  }

  const candidates = forkCandidates(analysis, { limit: 12 });
  if (ui.fork === null && candidates.length) ui.fork = candidates[0].segment;

  els.whatifPanel.innerHTML = `
    <section class="whatif-controls">
      <p class="muted">
        분기 시점 이후의 원문은 모델에 전달되지 않습니다. 생성 결과는 원작 사실이 아니라
        <strong>제안</strong>이며, 원작 데이터를 바꾸지 않습니다.
      </p>
      <label class="field compact">
        분기점
        <select id="whatifFork">
          ${candidates.map((candidate) => `
            <option value="${candidate.segment}" ${candidate.segment === ui.fork ? "selected" : ""}>
              [${candidate.segment}] ${escapeHtml(eventTypeLabel(candidate.type))} · ${escapeHtml(candidate.summary.slice(0, 48))}
            </option>
          `).join("") || `<option value="">분기점 후보가 없습니다</option>`}
        </select>
      </label>
      <label class="field compact">
        전제 (비워두면 모델이 대안을 제안합니다)
        <input id="whatifPremise" type="text" value="${escapeAttr(ui.premise)}" placeholder="예: 복녀가 왕 서방의 제안을 거절했다면">
      </label>
      <div class="button-row">
        <button id="whatifRunBtn" type="button" class="primary" ${ui.busy || !candidates.length ? "disabled" : ""}>
          ${ui.busy ? "생성 중…" : "분기 생성"}
        </button>
        <button id="whatifSeedBtn" type="button" ${candidates.length ? "" : "disabled"}>시드 확인</button>
      </div>
      ${ui.message ? `<p class="whatif-message">${escapeHtml(ui.message)}</p>` : ""}
    </section>
    <section class="whatif-list">
      ${renderBranches(analysis)}
    </section>
  `;

  els.whatifPanel.querySelector("#whatifFork")?.addEventListener("change", (event) => {
    ui.fork = Number(event.target.value) || null;
  });
  els.whatifPanel.querySelector("#whatifPremise")?.addEventListener("input", (event) => {
    ui.premise = event.target.value;
  });
  els.whatifPanel.querySelector("#whatifRunBtn")?.addEventListener("click", () => generateBranches());
  els.whatifPanel.querySelector("#whatifSeedBtn")?.addEventListener("click", () => showSeed());
}

function renderBranches(analysis) {
  const branches = analysis.branches || [];
  if (!branches.length) {
    return `<div class="empty-state">아직 생성한 분기가 없습니다.</div>`;
  }
  return branches.map((branch) => {
    const issues = branchIssues(analysis, branch);
    const leaked = branch.diagnostics?.canon_leak?.length;
    return `
      <article class="branch-card ${leaked ? "leaked" : ""}">
        <header>
          <div>
            <span class="tag generated">생성</span>
            <strong>${escapeHtml(branch.premise || branch.branch_id)}</strong>
          </div>
          <span class="muted">${branch.fork_segment}번 단락에서 분기 · ${escapeHtml(branch.model || "")}</span>
        </header>
        ${issues.length ? `<ul class="branch-issues">${issues.map((issue) =>
          `<li class="${issue.code === "canon_leak" ? "error" : "warn"}">${escapeHtml(issue.message)}</li>`).join("")}</ul>` : ""}
        <ol class="branch-events">
          ${branch.events.map((event) => `
            <li>
              <span class="tag event">${escapeHtml(eventTypeLabel(event.type))}</span>
              ${escapeHtml(event.summary)}
              ${event.characters.length ? `<span class="muted">${escapeHtml(event.characters.join(", "))}</span>` : ""}
            </li>
          `).join("")}
        </ol>
        ${branch.states.length ? `<ul class="branch-states">${branch.states.map((item) =>
          `<li>${escapeHtml(item.character)}: ${escapeHtml([item.mental_state, item.physical_state, item.location].filter(Boolean).join(" / "))}</li>`).join("")}</ul>` : ""}
        <div class="branch-rubric">
          ${BRANCH_RUBRIC.map((row) => `
            <label title="${escapeAttr(row.question)}">
              ${escapeHtml(row.label)}
              <select data-rubric-branch="${escapeAttr(branch.branch_id)}" data-rubric-key="${row.key}">
                ${[0, 1, 2, 3].map((score) => `
                  <option value="${score}" ${(branch.rubric?.[row.key] ?? 0) === score ? "selected" : ""}>${score}</option>
                `).join("")}
              </select>
            </label>
          `).join("")}
          <button type="button" data-branch-remove="${escapeAttr(branch.branch_id)}">삭제</button>
        </div>
      </article>
    `;
  }).join("");
}

async function generateBranches() {
  const analysis = state.analysis;
  if (!analysis || !ui.fork) return;

  ui.busy = true;
  ui.message = "";
  renderWhatIf();

  try {
    const seed = branchSeed(analysis, ui.fork);
    const response = await fetch("/api/whatif", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seed,
        premise: ui.premise.trim(),
        count: 2,
        model: els.ollamaModel?.value || ""
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      ui.message = payload.message || "분기 생성에 실패했습니다.";
      return;
    }

    const forkEventId = forkCandidates(analysis, { limit: 12 })
      .find((candidate) => candidate.segment === ui.fork)?.event_id || "";

    (payload.alternatives || []).forEach((alternative, index) => {
      const branch = normalizeBranch(analysis, alternative.payload, {
        forkSegment: ui.fork,
        premise: alternative.premise,
        model: payload.model,
        forkEventId,
        index
      });
      attachBranch(analysis, branch);
    });

    const leaked = (analysis.branches || []).filter((branch) => branch.diagnostics?.canon_leak?.length).length;
    ui.message = leaked
      ? `분기 ${payload.alternatives.length}개 생성. 그중 ${leaked}개는 원작 내용을 인용했습니다 — 확인하세요.`
      : `분기 ${payload.alternatives.length}개를 생성했습니다.`;
  } catch (error) {
    ui.message = `분기 생성 실패: ${error.message}`;
  } finally {
    ui.busy = false;
    renderWhatIf();
  }
}

function showSeed() {
  if (!state.analysis || !ui.fork) return;
  const seed = branchSeed(state.analysis, ui.fork);
  els.exportOutput.value = JSON.stringify(seed, null, 2);
  ui.message = "시드를 내보내기 창에 표시했습니다. 여기에 분기 이후 원문이 없는지 확인하세요.";
  renderWhatIf();
}

/** 컨트롤러의 전역 클릭·입력 위임에서 호출한다. */
export function handleWhatIfAction(target) {
  const analysis = state.analysis;
  if (!analysis) return false;

  const remove = target.closest("[data-branch-remove]");
  if (remove) {
    analysis.branches = (analysis.branches || []).filter((branch) => branch.branch_id !== remove.dataset.branchRemove);
    renderWhatIf();
    return true;
  }
  return false;
}

export function handleRubricInput(target) {
  const branchId = target.dataset.rubricBranch;
  const key = target.dataset.rubricKey;
  if (!branchId || !key) return false;
  const branch = (state.analysis?.branches || []).find((item) => item.branch_id === branchId);
  if (!branch) return false;
  branch.rubric = { ...(branch.rubric || {}), [key]: Number(target.value) || 0 };
  return true;
}
