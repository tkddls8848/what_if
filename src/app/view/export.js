import { state, els, STATUS_LABELS } from "../context.js";
import { selectScopedAnalysis } from "./selectors.js";
import { toInk, toTwee } from "../../core/export_if.js";
import {
  csvCell,
  currentScopeTime,
  currentSpoilerSafe,
  escapeHtml,
  eventTypeLabel,
  nameOf,
  sourceTextForSpan
} from "../utils.js";

/** 형식별 파일 확장자와 MIME. 다운로드 이름을 만들 때 쓴다. */
const FORMAT_FILES = {
  json: { ext: "json", mime: "application/json" },
  csv: { ext: "csv", mime: "text/csv" },
  markdown: { ext: "md", mime: "text/markdown" },
  timelinejs: { ext: "timeline.json", mime: "application/json" },
  graph: { ext: "graph.json", mime: "application/json" },
  ink: { ext: "ink", mime: "text/plain" },
  twee: { ext: "twee", mime: "text/plain" }
};

export function renderExport() {
  if (!state.analysis) {
    els.exportOutput.value = "";
    return;
  }
  els.exportOutput.value = buildExport(state.exportFormat);
}

function buildExport(format) {
  // ink/Twee는 분기를 포함하므로 시점 범위를 직접 넘긴다. 나머지는 기존 scope를 쓴다.
  if (format === "ink") {
    return toInk(state.analysis, { spoilerSafe: currentSpoilerSafe(), at: currentScopeTime() });
  }
  if (format === "twee") {
    return toTwee(state.analysis, { spoilerSafe: currentSpoilerSafe(), at: currentScopeTime() });
  }
  if (format === "csv") return toCsv(selectScopedAnalysis());
  if (format === "markdown") return toMarkdown(selectScopedAnalysis());
  if (format === "timelinejs") return JSON.stringify(toTimelineJs(selectScopedAnalysis()), null, 2);
  if (format === "graph") return JSON.stringify(toGraphJson(selectScopedAnalysis()), null, 2);
  return JSON.stringify(selectScopedAnalysis(), null, 2);
}

/**
 * 현재 내보내기 결과를 파일로 저장한다. 지금까지는 클립보드 복사만 있었지만,
 * ink/Twee는 컴파일러에 넣어야 하므로 파일이 필요하다.
 */
export function downloadExport() {
  if (!state.analysis) return;
  const format = state.exportFormat || "json";
  const file = FORMAT_FILES[format] || FORMAT_FILES.json;
  const name = safeFileName(state.analysis.document?.title || "novel-if");
  const blob = new Blob([els.exportOutput.value || buildExport(format)], { type: `${file.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.${file.ext}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value) {
  return String(value).replace(/[\\/:*?"<>|]/gu, "_").replace(/\s+/gu, "_").slice(0, 60) || "novel-if";
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
