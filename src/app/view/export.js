import { state, els, STATUS_LABELS } from "../context.js";
import { selectScopedAnalysis } from "./selectors.js";
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

export function renderExport() {
  if (!state.analysis) {
    els.exportOutput.value = "";
    return;
  }
  if (state.exportFormat === "csv") {
    els.exportOutput.value = toCsv(selectScopedAnalysis());
  } else if (state.exportFormat === "markdown") {
    els.exportOutput.value = toMarkdown(selectScopedAnalysis());
  } else if (state.exportFormat === "timelinejs") {
    els.exportOutput.value = JSON.stringify(toTimelineJs(selectScopedAnalysis()), null, 2);
  } else if (state.exportFormat === "graph") {
    els.exportOutput.value = JSON.stringify(toGraphJson(selectScopedAnalysis()), null, 2);
  } else {
    els.exportOutput.value = JSON.stringify(selectScopedAnalysis(), null, 2);
  }
}

function toCsv(payload) {
  const rows = [["event_id", "segment_id", "type", "status", "confidence", "characters", "locations", "summary", "source"]];
  payload.events.forEach((event) => {
    rows.push([
      event.event_id,
      event.segment_id,
      event.type,
      event.status,
      event.confidence,
      event.characters.map((id) => nameOf("character", id)).join("|"),
      event.locations.map((id) => nameOf("location", id)).join("|"),
      event.summary,
      sourceTextForSpan(event.source_span)
    ]);
  });
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function toMarkdown(payload) {
  const lines = [`# ${payload.document.title}`, "", `Scope: ${payload.scope.mode}`, "", "## Characters", ""];
  payload.characters.forEach((character) => {
    lines.push(`- **${character.canonical_name}** (${STATUS_LABELS[character.status]}): ${character.description || ""}`);
  });
  lines.push("", "## Locations", "");
  payload.locations.forEach((location) => {
    lines.push(`- **${location.name}** (${location.type}): ${location.description || ""}`);
  });
  lines.push("", "## Events", "");
  payload.events.forEach((event) => {
    lines.push(`- **${event.event_id}** [${eventTypeLabel(event.type)}] ${event.summary}`);
  });
  return lines.join("\n");
}

function toTimelineJs(payload) {
  return {
    title: {
      text: {
        headline: payload.document.title,
        text: "Novel IF Reader export"
      }
    },
    events: payload.events.map((event) => {
      const segment = state.analysis.segments.find((item) => item.segment_id === event.segment_id);
      return {
        start_date: { year: "1", month: "1", day: String(segment?.index || 1) },
        text: {
          headline: `${event.event_id} · ${eventTypeLabel(event.type)}`,
          text: `${escapeHtml(event.summary)}<br><small>${escapeHtml(sourceTextForSpan(event.source_span))}</small>`
        },
        group: eventTypeLabel(event.type)
      };
    })
  };
}

function toGraphJson(payload) {
  const nodes = [
    ...payload.characters.map((character) => ({ id: `character:${character.character_id}`, type: "character", label: character.canonical_name, status: character.status })),
    ...payload.locations.map((location) => ({ id: `location:${location.location_id}`, type: "location", label: location.name, status: location.status })),
    ...payload.events.map((event) => ({ id: `event:${event.event_id}`, type: "event", label: event.summary, status: event.status }))
  ];
  const edges = payload.relations.map((relation) => ({
    id: relation.relation_id,
    source: `${relation.source_type}:${relation.source_id}`,
    target: `${relation.target_type}:${relation.target_id}`,
    type: relation.relation_type,
    weight: relation.weight
  }));
  return { nodes, edges };
}
