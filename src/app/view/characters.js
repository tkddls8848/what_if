import { state, els, STATUS, STATUS_LABELS } from "../context.js";
import { statusButtons } from "../editing.js";
import {
  csvCell,
  drawSvgText,
  escapeAttr,
  escapeHtml,
  eventTypeLabel,
  getEntity,
  isCurrentSegmentId,
  isVisibleSegmentId,
  kindLabel,
  latestStateForCharacter,
  matchesEntityFilter,
  nameOf,
  segmentOrder,
  sourceTextForSpan,
  statusClass,
  statusMatches,
  svgEl,
  unique
} from "../utils.js";

export function renderCharacters() {
  const analysis = state.analysis;
  els.characterCards.innerHTML = "";
  if (!analysis) return;

  const characters = analysis.characters
    .filter((character) => statusMatches(character.status))
    .filter((character) => isVisibleSegmentId(character.first_segment_id))
    .filter((character) => matchesEntityFilter("character", character.character_id));

  if (!characters.length) {
    els.characterCards.innerHTML = `<div class="empty-state">현재 범위에 표시할 인물이 없습니다.</div>`;
    return;
  }

  characters.forEach((character) => {
    const characterState = latestStateForCharacter(character.character_id);
    const locationName = characterState?.location_id ? nameOf("location", characterState.location_id) : "미정";
    const history = characterStateHistory(character.character_id);
    const relations = characterRelationSummary(character.character_id);
    const path = characterSpatialPath(character.character_id);
    const density = characterAppearanceDensity(character.character_id);
    const events = characterEvents(character.character_id).slice(-6);
    const card = document.createElement("article");
    card.className = `character-card ${statusClass(character.status)}`;
    card.innerHTML = `
      <header>
        <h3>${escapeHtml(character.canonical_name)}</h3>
        <button type="button" data-select-kind="character" data-select-id="${character.character_id}">현재 위치에서 강조</button>
      </header>
      <div class="tag-row">
        <span class="tag">${escapeHtml(character.role || "인물")}</span>
        <span class="status-pill ${statusClass(character.status)}">${STATUS_LABELS[character.status]}</span>
        <span class="tag confidence">${Math.round(character.confidence * 100)}%</span>
      </div>
      <p>${escapeHtml(character.description || "")}</p>
      <dl class="state-list">
        <div><dt>현재 장소</dt><dd>${escapeHtml(locationName)}</dd></div>
        <div><dt>심리 상태</dt><dd>${escapeHtml(characterState?.mental_state || "미정")}</dd></div>
        <div><dt>신체 상태</dt><dd>${escapeHtml(characterState?.physical_state || "미정")}</dd></div>
      </dl>
      <section class="density-section">
        <h4>등장 밀도</h4>
        ${renderDensityBars(density)}
      </section>
      <h4>알려진 사실</h4>
      <ul class="fact-list">
        ${(characterState?.known_facts || []).map((fact) => `<li>${escapeHtml(fact)}</li>`).join("") || `<li class="muted">현재 위치까지 확인된 사실 없음</li>`}
      </ul>
      <details class="character-details">
        <summary>확장 보기</summary>

        <section>
          <h4>상태 변화 타임라인</h4>
          ${renderCharacterStateTimeline(history)}
        </section>

        <section>
          <h4>관계 변화</h4>
          ${renderCharacterRelations(relations)}
        </section>

        <section>
          <h4>공간 궤적</h4>
          ${renderSpatialPath(path)}
        </section>

        <section>
          <h4>Alias / 검수</h4>
          <label class="field compact">
            별칭
            <input data-edit-kind="character" data-edit-id="${character.character_id}" data-edit-field="aliases_csv" value="${escapeAttr((character.aliases || []).join(", "))}">
          </label>
          <div class="alias-list">
            ${(character.aliases || []).map((alias) => `<span class="tag">${escapeHtml(alias)}</span>`).join("")}
          </div>
          <div class="button-row">${statusButtons("character", character.character_id)}</div>
        </section>

        <section>
          <h4>최근 사건</h4>
          ${events.length ? events.map((event) => renderCharacterEventItem(event)).join("") : `<p class="muted">현재 위치까지 연결된 사건 없음</p>`}
        </section>
      </details>
    `;
    els.characterCards.appendChild(card);
  });
}

function characterEvents(characterId) {
  return state.analysis.events
    .filter((event) => event.status !== STATUS.REJECTED)
    .filter((event) => isVisibleSegmentId(event.segment_id))
    .filter((event) => event.characters.includes(characterId))
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id) || a.sentence_index - b.sentence_index);
}

function characterStateHistory(characterId) {
  const history = state.analysis.states
    .filter((item) => item.character_id === characterId && item.status !== STATUS.REJECTED)
    .filter((item) => isVisibleSegmentId(item.segment_id))
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id));

  const compact = [];
  history.forEach((item) => {
    const previous = compact[compact.length - 1];
    if (
      previous &&
      previous.mental_state === item.mental_state &&
      previous.physical_state === item.physical_state &&
      previous.location_id === item.location_id
    ) {
      return;
    }
    compact.push(item);
  });
  return compact;
}

function characterRelationSummary(characterId) {
  const relationMap = new Map();
  const ensureRelation = (otherId) => {
    if (!relationMap.has(otherId)) {
      relationMap.set(otherId, {
        character_id: otherId,
        labels: new Map(),
        latest_segment_id: "",
        latest_summary: "",
        count: 0
      });
    }
    return relationMap.get(otherId);
  };

  characterEvents(characterId).forEach((event) => {
    event.characters
      .filter((id) => id !== characterId)
      .forEach((otherId) => {
        const relation = ensureRelation(otherId);
        const label = relationLabelForEvent(event.type);
        relation.labels.set(label, (relation.labels.get(label) || 0) + 1);
        relation.latest_segment_id = event.segment_id;
        relation.latest_summary = event.summary;
        relation.count += 1;
      });
  });

  (state.analysis?.relations || [])
    .filter((relation) => relation.status !== STATUS.REJECTED)
    .filter((relation) => relation.source_type === "character" && relation.target_type === "character")
    .filter((relation) => relation.source_id === characterId || relation.target_id === characterId)
    .filter((relation) => relation.segment_ids.some((segmentId) => isVisibleSegmentId(segmentId)))
    .forEach((relationRecord) => {
      const otherId = relationRecord.source_id === characterId ? relationRecord.target_id : relationRecord.source_id;
      const relation = ensureRelation(otherId);
      const label = relationRecord.label || relationTypeLabel(relationRecord.relation_type);
      relation.labels.set(label, (relation.labels.get(label) || 0) + relationRecord.weight);
      relation.latest_segment_id = relationRecord.segment_ids[relationRecord.segment_ids.length - 1] || relation.latest_segment_id;
      relation.latest_summary = relationRecord.evidence || relation.latest_summary || label;
      relation.count += relationRecord.weight;
    });

  return Array.from(relationMap.values()).sort((a, b) => b.count - a.count);
}

function relationLabelForEvent(type) {
  if (type === "conflict") return "갈등";
  if (type === "conversation") return "대화";
  if (type === "movement") return "동행/이동";
  if (type === "perception") return "관찰";
  if (type === "realization") return "인식 변화";
  return eventTypeLabel(type) || "연결";
}

function relationTypeLabel(type) {
  const labels = {
    knows: "알고 있음",
    family_of: "가족",
    ally_of: "협력",
    enemy_of: "대립",
    protects: "보호",
    threatens: "위협",
    depends_on: "의존",
    suspects: "의심",
    loves: "애정",
    hides_from: "회피/은폐",
    changes_attitude_to: "태도 변화",
    speaks_to: "대화"
  };
  return labels[type] || type || "관계";
}

function characterSpatialPath(characterId) {
  const path = [];
  characterStateHistory(characterId).forEach((item) => {
    if (!item.location_id) return;
    const previous = path[path.length - 1];
    if (previous?.location_id === item.location_id) return;
    path.push({
      location_id: item.location_id,
      segment_id: item.segment_id,
      label: nameOf("location", item.location_id)
    });
  });
  return path;
}

function characterAppearanceDensity(characterId) {
  const buckets = state.analysis.scenes.map((scene) => ({
    scene_id: scene.scene_id,
    label: scene.title,
    count: 0
  }));
  const sceneIndexBySegment = new Map(state.analysis.segments.map((segment) => [segment.segment_id, segment.scene_id]));

  state.analysis.mentions
    .filter((mention) => mention.entity_type === "character")
    .filter((mention) => mention.entity_id === characterId)
    .filter((mention) => mention.status !== STATUS.REJECTED)
    .filter((mention) => isVisibleSegmentId(mention.segment_id))
    .forEach((mention) => {
      const sceneId = sceneIndexBySegment.get(mention.segment_id);
      const bucket = buckets.find((item) => item.scene_id === sceneId);
      if (bucket) bucket.count += 1;
    });

  characterEvents(characterId).forEach((event) => {
    const sceneId = sceneIndexBySegment.get(event.segment_id);
    const bucket = buckets.find((item) => item.scene_id === sceneId);
    if (bucket) bucket.count += 1;
  });

  return buckets;
}

function renderDensityBars(buckets) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return `
    <div class="density-bars" aria-label="등장 밀도">
      ${buckets.map((bucket) => `
        <span
          class="density-bar ${bucket.count ? "active" : ""}"
          style="height:${Math.max(8, Math.round((bucket.count / max) * 34))}px"
          title="${escapeAttr(bucket.label)}: ${bucket.count}"
        ></span>
      `).join("")}
    </div>
  `;
}

function renderCharacterStateTimeline(history) {
  if (!history.length) return `<p class="muted">현재 위치까지 상태 변화 없음</p>`;
  return `
    <ol class="character-timeline">
      ${history.slice(-8).map((item) => `
        <li>
          <button type="button" class="link-button" data-focus-segment="${escapeAttr(item.segment_id)}">${escapeHtml(segmentLabel(item.segment_id))}</button>
          <span>${escapeHtml(item.mental_state || "미정")}</span>
          ${item.location_id ? `<small>${escapeHtml(nameOf("location", item.location_id))}</small>` : ""}
        </li>
      `).join("")}
    </ol>
  `;
}

function renderCharacterRelations(relations) {
  if (!relations.length) return `<p class="muted">현재 위치까지 다른 인물과의 관계 변화 없음</p>`;
  return `
    <div class="relation-list">
      ${relations.map((relation) => {
        const labels = Array.from(relation.labels.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([label, count]) => `${label}${count > 1 ? ` ${count}` : ""}`)
          .join(" · ");
        return `
          <article class="relation-item">
            <strong>${escapeHtml(nameOf("character", relation.character_id))}</strong>
            <span>${escapeHtml(labels)}</span>
            <button type="button" class="link-button" data-focus-segment="${escapeAttr(relation.latest_segment_id)}">${escapeHtml(segmentLabel(relation.latest_segment_id))}</button>
            <p>${escapeHtml(relation.latest_summary)}</p>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderSpatialPath(path) {
  if (!path.length) return `<p class="muted">현재 위치까지 장소 궤적 없음</p>`;
  return `
    <div class="spatial-path">
      ${path.map((item) => `
        <button type="button" class="path-node" data-focus-segment="${escapeAttr(item.segment_id)}">
          ${escapeHtml(item.label)}
        </button>
      `).join(`<span class="path-arrow">→</span>`)}
    </div>
  `;
}

function renderCharacterEventItem(event) {
  return `
    <article class="character-event-item">
      <div class="tag-row">
        <span class="tag event">${eventTypeLabel(event.type)}</span>
        <button type="button" class="link-button" data-focus-segment="${escapeAttr(event.segment_id)}">${escapeHtml(segmentLabel(event.segment_id))}</button>
      </div>
      <p>${escapeHtml(event.summary)}</p>
    </article>
  `;
}

function segmentLabel(segmentId) {
  const order = segmentOrder(segmentId);
  return order ? `P${String(order).padStart(3, "0")}` : segmentId;
}
