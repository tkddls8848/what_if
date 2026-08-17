import { state, els, STATUS, STATUS_LABELS } from "../context.js";
import { statusButtons } from "../editing.js";
import { violationsFor } from "../../core/audit.js";
import {
  escapeAttr,
  escapeHtml,
  eventTypeLabel,
  getEntity,
  isVisibleSegmentId,
  kindLabel,
  nameOf,
  segmentOrder,
  statusClass,
  statusMatches
} from "../utils.js";

export function renderReview() {
  const analysis = state.analysis;
  if (!analysis) return;

  const segment = analysis.segments[state.currentSegment - 1];
  els.reviewSourceStats.textContent = segment ? `${segment.segment_id} · ${segment.scene_id}` : "현재 문단";
  els.reviewSource.innerHTML = segment ? renderHighlightedSegment(segment) : "";

  const items = [
    ...analysis.characters.map((item) => ({ kind: "character", id: item.character_id, item })),
    ...analysis.locations.map((item) => ({ kind: "location", id: item.location_id, item })),
    ...analysis.events.map((item) => ({ kind: "event", id: item.event_id, item }))
  ]
    .filter(({ item }) => statusMatches(item.status))
    .filter(({ item, kind }) => {
      const segmentId = kind === "event" ? item.segment_id : item.first_segment_id;
      return isVisibleSegmentId(segmentId);
    })
    .map((entry) => ({
      ...entry,
      order: segmentOrder(entry.kind === "event" ? entry.item.segment_id : entry.item.first_segment_id),
      violations: reviewViolations(analysis, entry.kind, entry.id)
    }))
    .sort(REVIEW_SORTS[state.reviewSort] || REVIEW_SORTS.reading);

  const pending = items.filter(({ item }) => item.status === STATUS.SUGGESTED).length;
  els.reviewStats.textContent = pending ? `${items.length}개 · 미확정 ${pending}` : `${items.length}개`;
  els.reviewList.innerHTML = items.length ? "" : `<div class="empty-state">검수할 항목이 없습니다.</div>`;

  items.forEach(({ kind, id, item, order, violations }) => {
    const row = document.createElement("article");
    row.className = `review-item ${statusClass(item.status)} ${state.selected?.kind === kind && state.selected?.id === id ? "selected" : ""}`;
    const title = item.canonical_name || item.name || item.summary;
    row.innerHTML = `
      <header>
        <button type="button" class="link-button" data-select-kind="${kind}" data-select-id="${id}">
          ${kindLabel(kind)} · ${escapeHtml(title)}
        </button>
        <span class="status-pill ${statusClass(item.status)}">${STATUS_LABELS[item.status]}</span>
      </header>
      <label class="field compact">
        ${kind === "event" ? "요약" : "이름"}
        <input data-edit-kind="${kind}" data-edit-id="${id}" data-edit-field="${kind === "event" ? "summary" : kind === "location" ? "name" : "canonical_name"}" value="${escapeAttr(title)}">
      </label>
      <div class="review-meta">
        <span title="원문에서 처음 드러나는 단락">${positionLabel(order)}</span>
        <span>${Math.round((item.confidence || 0) * 100)}%</span>
        <span>${item.method || "manual"}</span>
      </div>
      ${renderViolations(violations)}
      ${kind === "character" ? renderCharacterMergeControls(item) : ""}
      <div class="button-row">${statusButtons(kind, id)}</div>
    `;
    els.reviewList.appendChild(row);
  });
}

function renderCharacterMergeControls(character) {
  const analysis = state.analysis;
  if (character.merge_record) {
    const target = analysis.characters.find((item) => item.character_id === character.merge_record.target_id);
    return `
      <div class="character-merge-controls">
        <span><strong>${escapeHtml(character.canonical_name)}</strong> → ${escapeHtml(target?.canonical_name || character.merge_record.target_id)}</span>
        <button type="button" data-split-character="${escapeAttr(character.character_id)}">분리</button>
      </div>
    `;
  }

  const mergedSources = analysis.characters.filter((item) => item.merge_record?.target_id === character.character_id);
  const splitButtons = mergedSources.map((source) => `
    <button type="button" data-split-character="${escapeAttr(source.character_id)}">${escapeHtml(source.canonical_name)} 분리</button>
  `).join("");
  if (mergedSources.length) {
    return `
      <div class="character-merge-controls">
        <span>합친 인물</span>
        <div class="button-row">${splitButtons}</div>
        <small>이 인물을 다시 병합하려면 먼저 합친 인물을 분리하세요.</small>
      </div>
    `;
  }

  const targets = analysis.characters
    .filter((item) => item.character_id !== character.character_id)
    .filter((item) => item.status !== STATUS.REJECTED && !item.merge_record)
    .filter((item) => isVisibleSegmentId(item.first_segment_id));
  return `
    <div class="character-merge-controls">
      <label>
        병합 대상
        <select data-merge-target="${escapeAttr(character.character_id)}" ${targets.length ? "" : "disabled"}>
          ${targets.map((target) => `<option value="${escapeAttr(target.character_id)}">${escapeHtml(target.canonical_name)}</option>`).join("") || `<option>대상 없음</option>`}
        </select>
      </label>
      <button type="button" data-merge-character="${escapeAttr(character.character_id)}" ${targets.length ? "" : "disabled"}>선택 인물로 병합</button>
      <small>자동 병합하지 않습니다. 원문을 확인한 사람이 직접 확정합니다.</small>
    </div>
  `;
}

const VIOLATION_LABELS = {
  actor: "행위자",
  scope: "근거 범위",
  polarity: "부정문",
  state: "상태 모순",
  temporal: "시간 순서"
};

/**
 * 검수 항목 하나에 걸린 제약 위반.
 *
 * 감사 결과는 사건·언급·상태·관계에 붙는다. 인물/장소 행에는 직접 걸리는 위반이
 * 없으므로, 그 인물의 상태 레코드나 그 장소를 가리키는 상태의 위반을 끌어와
 * 검수자가 한 행에서 원인을 볼 수 있게 한다.
 */
function reviewViolations(analysis, kind, id) {
  const audit = analysis.diagnostics?.audit;
  if (!audit) return [];
  if (kind === "event") return violationsFor(audit, "event", id);

  const stateIds = new Set(
    analysis.states
      .filter((item) => (kind === "character" ? item.character_id === id : item.location_id === id))
      .map((item) => item.state_id)
  );
  return (audit.violations || []).filter((violation) =>
    violation.target_type === "state" && stateIds.has(violation.target_id)
  );
}

function errorRank(violations) {
  return violations.some((violation) => violation.severity === "error") ? 0 : 1;
}

/**
 * 검수 목록 정렬.
 *
 * 기본값은 **독자가 읽은 차례**다. "추출기가 자신 없어 하는 것부터"(`audit`)는 도구를
 * 정비하는 순서라서, 같은 작업이 오류 사냥으로만 보인다. 읽은 차례로 놓으면 그 작업이
 * "이 단락에서 새로 알게 된 것을 확정한다"가 된다. 오류 사냥도 여전히 필요하므로
 * 예전 순서를 지우지 않고 보조 모드로 남긴다.
 *
 * 정렬은 표시층이다. **무엇이 목록에 들어가는지는 건드리지 않는다** — `/check`가
 * 시점 제한을 끄는 것은 설계이고(`doc/README.md` 6절), 여기서 `order`는 가리는 기준이
 * 아니라 늘어놓는 기준으로만 쓰인다.
 *
 * `order`는 인물·장소에서 `valid_from`과 같은 값이다(`core/asof.js`가 첫 등장 단락
 * index로 채운다). 사건에는 `valid_from`이 없으므로 두 종류를 한 축에 세우려면
 * segment index를 써야 한다.
 */
const REVIEW_SORTS = {
  reading: (a, b) =>
    a.order - b.order ||
    errorRank(a.violations) - errorRank(b.violations) ||
    (a.item.confidence || 0) - (b.item.confidence || 0),
  audit: (a, b) =>
    errorRank(a.violations) - errorRank(b.violations) ||
    (a.item.confidence || 0) - (b.item.confidence || 0)
};

function positionLabel(order) {
  return order ? `P${String(order).padStart(3, "0")}` : "—";
}

function renderViolations(violations) {
  if (!violations?.length) return "";
  const badges = violations.slice(0, 4).map((violation) => `
    <span class="audit-badge ${violation.severity}" title="${escapeAttr(violation.message)}">
      ${VIOLATION_LABELS[violation.code] || violation.code}
    </span>
  `).join("");
  return `<div class="audit-row">${badges}${violations.length > 4 ? `<span class="audit-badge more">+${violations.length - 4}</span>` : ""}</div>`;
}

function segmentIdForEntity(kind, id) {
  const entity = getEntity(kind, id);
  if (!entity) return "";
  return kind === "event" ? entity.segment_id : entity.first_segment_id;
}

export function focusSelectionSegment(kind, id) {
  const segmentId = segmentIdForEntity(kind, id);
  const order = segmentOrder(segmentId);
  if (order) state.currentSegment = order;
}

export function renderCheckSummary() {
  if (!els.checkSummary) return;
  const analysis = state.analysis;
  if (!analysis) {
    els.checkSummary.innerHTML = "";
    return;
  }
  const reviewables = [
    ...analysis.characters,
    ...analysis.locations,
    ...analysis.events
  ];
  const counts = {
    total: reviewables.length,
    suggested: reviewables.filter((item) => item.status === STATUS.SUGGESTED).length,
    confirmed: reviewables.filter((item) => item.status === STATUS.CONFIRMED).length,
    edited: reviewables.filter((item) => item.status === STATUS.EDITED).length,
    rejected: reviewables.filter((item) => item.status === STATUS.REJECTED).length
  };
  const audit = analysis.diagnostics?.audit?.counts || { error: 0, warn: 0 };
  els.checkSummary.innerHTML = `
    <div><strong>${counts.total}</strong><span>전체</span></div>
    <div><strong>${counts.suggested}</strong><span>제안</span></div>
    <div><strong>${counts.confirmed}</strong><span>확정</span></div>
    <div><strong>${counts.edited}</strong><span>수정</span></div>
    <div><strong>${counts.rejected}</strong><span>제외</span></div>
    <div class="audit-count error"><strong>${audit.error || 0}</strong><span>제약 위반</span></div>
    <div class="audit-count warn"><strong>${audit.warn || 0}</strong><span>확인 필요</span></div>
  `;
}

function renderHighlightedSegment(segment) {
  const analysis = state.analysis;
  const localMarks = [];

  analysis.mentions
    .filter((mention) => mention.segment_id === segment.segment_id && mention.status !== STATUS.REJECTED)
    .forEach((mention) => {
      localMarks.push({
        start: mention.char_start - segment.char_start,
        end: mention.char_end - segment.char_start,
        className: mention.entity_type,
        label: nameOf(mention.entity_type, mention.entity_id)
      });
    });

  analysis.events
    .filter((event) => event.segment_id === segment.segment_id && event.status !== STATUS.REJECTED)
    .forEach((event) => {
      localMarks.push({
        start: event.source_span.char_start - segment.char_start,
        end: event.source_span.char_end - segment.char_start,
        className: "event",
        label: eventTypeLabel(event.type)
      });
    });

  localMarks.sort((a, b) => a.start - b.start || b.end - a.end);
  const safeMarks = [];
  localMarks.forEach((mark) => {
    if (safeMarks.some((existing) => mark.start < existing.end && mark.end > existing.start)) return;
    safeMarks.push(mark);
  });

  let cursor = 0;
  let html = "";
  safeMarks.forEach((mark) => {
    html += escapeHtml(segment.text.slice(cursor, mark.start));
    html += `<mark class="${mark.className}" title="${escapeAttr(mark.label)}">${escapeHtml(segment.text.slice(mark.start, mark.end))}</mark>`;
    cursor = mark.end;
  });
  html += escapeHtml(segment.text.slice(cursor));
  return `<p>${html}</p>`;
}
