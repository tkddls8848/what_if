import { state, els, STATUS } from "../context.js";
import { selectMapEvents } from "./selectors.js";
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

export function renderGraph() {
  const analysis = state.analysis;
  els.spaceGraph.innerHTML = "";
  if (!analysis) return;

  const mapEvents = selectMapEvents();
  const mapEdges = buildMapEdges(mapEvents);
  const nodes = buildVisibleGraphNodes(mapEdges);

  els.mapStats.textContent = `${nodes.length} nodes · ${mapEdges.length} edges`;

  if (!mapEdges.length || !nodes.length) {
    drawSvgText("현재 문단에 연결된 관계가 없습니다.", 490, 300, "graph-empty");
    return;
  }

  const positions = layoutGraphNodes(nodes);

  mapEdges.forEach((edge) => {
    const source = positions.get(`${edge.source_type}:${edge.source_id}`);
    const target = positions.get(`${edge.target_type}:${edge.target_id}`);
    if (!source || !target) return;
    const line = svgEl("line", {
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      class: `graph-edge ${edge.relation_type}`,
      "stroke-width": String(Math.min(5, 1.4 + edge.weight * 0.35))
    });
    const title = svgEl("title", {});
    title.textContent = edge.summaries.join("\n");
    line.appendChild(title);
    els.spaceGraph.appendChild(line);
  });

  nodes.forEach((node) => {
    const position = positions.get(node.id);
    const isSelected = state.selected?.kind === node.kind && state.selected?.id === node.rawId;
    const group = svgEl("g", {
      class: `graph-node-group ${node.kind} ${isSelected ? "selected" : ""}`,
      tabindex: "0"
    });
    const shapeAttrs = {
      cx: position.x,
      cy: position.y,
      r: node.kind === "event" ? 21 : 28,
      class: `graph-node ${node.kind} ${statusClass(node.status)}`
    };
    group.appendChild(svgEl("circle", shapeAttrs));
    const label = svgEl("text", { x: position.x, y: position.y + 46, class: "graph-label" });
    label.textContent = node.label;
    const caption = svgEl("text", { x: position.x, y: position.y + 62, class: "graph-caption" });
    caption.textContent = node.caption;
    group.append(label, caption);
    group.addEventListener("click", () => {
      state.selected = { kind: node.kind, id: node.rawId };
      renderAll();
    });
    els.spaceGraph.appendChild(group);
  });
}

function buildVisibleGraphNodes(edges) {
  const nodes = new Map();
  const add = (kind, rawId) => {
    const id = `${kind}:${rawId}`;
    if (nodes.has(id)) return;
    const entity = getEntity(kind, rawId);
    if (!entity || entity.status === STATUS.REJECTED) return;
    const label = entity.canonical_name || entity.name || eventTypeLabel(entity.type) || entity.summary || rawId;
    const caption = kind === "event"
      ? entity.event_id
      : kind === "character"
        ? entity.role || "인물"
        : entity.type || "장소";
    const coords = kind === "location" ? entity.narrative_coords : null;
    nodes.set(id, { id, kind, rawId, label, caption, status: entity.status, coords });
  };

  edges.forEach((edge) => {
    add(edge.source_type, edge.source_id);
    add(edge.target_type, edge.target_id);
  });

  return Array.from(nodes.values());
}

function buildMapEdges(events) {
  const edgeMap = new Map();
  const addEdge = (sourceType, sourceId, targetType, targetId, relationType, event) => {
    if (!sourceId || !targetId) return;
    const sourceKey = `${sourceType}:${sourceId}`;
    const targetKey = `${targetType}:${targetId}`;
    if (sourceKey === targetKey) return;
    const ordered = [sourceKey, targetKey].sort();
    const key = `${ordered[0]}|${ordered[1]}|${relationType}`;
    const [orderedSource, orderedTarget] = ordered;
    const [finalSourceType, finalSourceId] = orderedSource.split(":");
    const [finalTargetType, finalTargetId] = orderedTarget.split(":");

    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        edge_id: `map_edge_${edgeMap.size + 1}`,
        source_type: finalSourceType,
        source_id: finalSourceId,
        target_type: finalTargetType,
        target_id: finalTargetId,
        relation_type: relationType,
        event_ids: [],
        summaries: [],
        weight: 0
      });
    }

    const edge = edgeMap.get(key);
    edge.event_ids.push(event.event_id);
    edge.summaries.push(event.summary);
    edge.weight += 1;
  };

  events.forEach((event) => {
    const characterIds = event.characters.filter((id) => {
      const character = getEntity("character", id);
      return character && character.status !== STATUS.REJECTED;
    });
    const locationIds = event.locations.filter((id) => {
      const location = getEntity("location", id);
      return location && location.status !== STATUS.REJECTED;
    });

    for (let i = 0; i < characterIds.length; i += 1) {
      for (let j = i + 1; j < characterIds.length; j += 1) {
        addEdge("character", characterIds[i], "character", characterIds[j], "event_between", event);
      }
    }

    characterIds.forEach((characterId) => {
      locationIds.forEach((locationId) => {
        addEdge("character", characterId, "location", locationId, "event_at", event);
      });
    });
  });

  (state.analysis?.relations || [])
    .filter((relation) => relation.status !== STATUS.REJECTED)
    .filter((relation) => relation.segment_ids.some((segmentId) => isVisibleSegmentId(segmentId)))
    .filter((relation) =>
      (relation.source_type === "character" && relation.target_type === "character") ||
      (relation.source_type === "character" && relation.target_type === "location")
    )
    .forEach((relation) => {
      addEdge(relation.source_type, relation.source_id, relation.target_type, relation.target_id, relation.relation_type, {
        event_id: relation.event_ids[0] || relation.relation_id,
        summary: relation.label || relation.evidence || relation.relation_type
      });
    });

  return Array.from(edgeMap.values());
}

function layoutGraphNodes(nodes) {
  const positions = new Map();
  const center = { x: 490, y: 300 };
  const groups = {
    character: nodes.filter((node) => node.kind === "character"),
    event: nodes.filter((node) => node.kind === "event"),
    location: nodes.filter((node) => node.kind === "location")
  };

  groups.location.forEach((node, index) => {
    if (node.coords) {
      positions.set(node.id, { ...node.coords });
      return;
    }
    const angle = (Math.PI * 2 * index) / Math.max(1, groups.location.length) + Math.PI / 8;
    positions.set(node.id, { x: center.x + Math.cos(angle) * 285, y: center.y + Math.sin(angle) * 185 });
  });

  groups.character.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, groups.character.length) - Math.PI / 2;
    positions.set(node.id, { x: center.x + Math.cos(angle) * 190, y: center.y + Math.sin(angle) * 130 });
  });

  groups.event.forEach((node, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    positions.set(node.id, { x: 235 + column * 125, y: 85 + row * 74 });
  });

  if (nodes.length === 1) positions.set(nodes[0].id, center);
  return positions;
}

export function renderInspector() {
  const analysis = state.analysis;
  if (!analysis || !state.selected) {
    els.inspectorBody.innerHTML = `
      <p class="muted">그래프 노드나 검수 항목을 선택하면 원문 근거와 연결 정보를 볼 수 있습니다.</p>
      ${renderMapEventPanel()}
    `;
    return;
  }

  const entity = getEntity(state.selected.kind, state.selected.id);
  if (!entity) {
    els.inspectorBody.innerHTML = `<p class="muted">선택한 항목을 찾을 수 없습니다.</p>`;
    return;
  }

  const title = entity.canonical_name || entity.name || entity.summary;
  const status = entity.status || STATUS.SUGGESTED;
  const mentions = state.selected.kind === "event"
    ? []
    : analysis.mentions.filter((mention) =>
        mention.entity_type === state.selected.kind &&
        mention.entity_id === state.selected.id &&
        mention.status !== STATUS.REJECTED &&
        isVisibleSegmentId(mention.segment_id)
      );
  const relatedEvents = analysis.events.filter((event) =>
    event.status !== STATUS.REJECTED &&
    isVisibleSegmentId(event.segment_id) &&
    (
      event.event_id === state.selected.id ||
      event.characters.includes(state.selected.id) ||
      event.locations.includes(state.selected.id)
    )
  ).slice(-8);

  els.inspectorBody.innerHTML = `
    <div class="status-row">
      <span class="status-pill ${statusClass(status)}">${STATUS_LABELS[status] || status}</span>
      <span>${Math.round((entity.confidence || 0) * 100)}%</span>
    </div>
    <label class="field">
      이름/요약
      <input data-edit-kind="${state.selected.kind}" data-edit-id="${state.selected.id}" data-edit-field="${state.selected.kind === "event" ? "summary" : state.selected.kind === "location" ? "name" : "canonical_name"}" value="${escapeAttr(title)}">
    </label>
    <label class="field">
      설명
      <textarea data-edit-kind="${state.selected.kind}" data-edit-id="${state.selected.id}" data-edit-field="description">${escapeHtml(entity.description || "")}</textarea>
    </label>
    <div class="button-row">
      ${statusButtons(state.selected.kind, state.selected.id)}
    </div>
    <h3>근거</h3>
    ${renderEvidenceList(state.selected.kind === "event" ? [entity] : mentions)}
    <h3>관련 사건</h3>
    ${relatedEvents.length ? relatedEvents.map((event) => renderMiniEvent(event)).join("") : `<p class="muted">관련 사건 없음</p>`}
    ${renderMapEventPanel(state.selected)}
  `;
}

function renderMapEventPanel(selection = null) {
  const events = selectMapEvents().filter((event) => {
    if (!selection) return event.characters.length || event.locations.length;
    if (selection.kind === "character") return event.characters.includes(selection.id);
    if (selection.kind === "location") return event.locations.includes(selection.id);
    if (selection.kind === "event") return event.event_id === selection.id;
    return true;
  });

  const title = selection ? "선택 항목의 현재 사건" : "현재 시점 사건";
  if (!events.length) {
    return `
      <section class="inspector-events">
        <h3>${title}</h3>
        <p class="muted">현재 문단에 연결된 사건이 없습니다.</p>
      </section>
    `;
  }

  return `
    <section class="inspector-events">
      <h3>${title}</h3>
      ${events.map((event) => `
        <article class="inspector-event">
          <div class="tag-row">
            <span class="tag event">${eventTypeLabel(event.type)}</span>
            ${event.characters.map((id) => `<span class="tag">${escapeHtml(nameOf("character", id))}</span>`).join("")}
            ${event.locations.map((id) => `<span class="tag">${escapeHtml(nameOf("location", id))}</span>`).join("")}
          </div>
          <p>${escapeHtml(event.summary)}</p>
          <blockquote>${escapeHtml(sourceTextForSpan(event.source_span))}</blockquote>
        </article>
      `).join("")}
    </section>
  `;
}
