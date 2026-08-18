import { state, els } from "../context.js";
import { recapAt } from "../../core/recap.js";
import { escapeHtml, eventTypeLabel } from "../utils.js";

/**
 * 읽은 데까지의 요약. 오래 쉬었다 돌아왔을 때 "누가 지금 어떤 상태인가"를 한 번에 본다.
 *
 * 판정과 집계는 `core/recap.js`가 한다. 여기서는 그리기만 하고, 없는 값은 만들지
 * 않는다 — 상태가 비어 있으면 비어 있는 채로 둔다.
 */
export function renderRecap() {
  if (!els.recapPanel) return;
  const analysis = state.analysis;
  if (!analysis) {
    els.recapPanel.innerHTML = `<div class="empty-state">문서 없음</div>`;
    return;
  }

  const recap = recapAt(analysis, state.currentSegment, { spoilerSafe: state.spoilerSafe });
  const types = Object.entries(recap.event_type_counts).sort((a, b) => b[1] - a[1]);

  els.recapPanel.innerHTML = `
    <p class="recap-progress">${recap.progress.segment} / ${recap.progress.of} 단락까지 읽음</p>
    ${types.length
      ? `<ul class="recap-types">${types
          .map(([type, count]) => `<li><span>${escapeHtml(eventTypeLabel(type))}</span><b>${count}</b></li>`)
          .join("")}</ul>`
      : `<div class="empty-state">아직 사건이 없습니다.</div>`}
    ${recap.characters.length
      ? `<ul class="recap-characters">${recap.characters.map(renderCharacter).join("")}</ul>`
      : `<div class="empty-state">아직 등장한 인물이 없습니다.</div>`}
    <p class="recap-note">${escapeHtml(recap.note)}</p>
  `;
}

function renderCharacter(character) {
  const status = [character.current_mental_state, character.current_physical_state]
    .filter(Boolean)
    .join(" · ");
  return `
    <li>
      <b>${escapeHtml(character.name)}</b>
      <span class="recap-meta">P${character.first_seen_segment}부터 · 상태 ${character.state_records}회</span>
      ${status ? `<span class="recap-state">${escapeHtml(status)}</span>` : ""}
    </li>
  `;
}
