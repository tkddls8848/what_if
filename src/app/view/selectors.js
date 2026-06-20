import { state } from "../context.js";
import { isCurrentSegmentId, isVisibleSegmentId, segmentOrder, statusMatches } from "../utils.js";

export function selectMapEvents() {
  if (!state.analysis) return [];
  return state.analysis.events
    .filter((event) => statusMatches(event.status))
    .filter((event) => isCurrentSegmentId(event.segment_id))
    .filter((event) => state.filters.eventType === "all" || event.type === state.filters.eventType)
    .filter((event) => {
      if (state.filters.entity === "all") return true;
      const [kind, id] = state.filters.entity.split(":");
      if (kind === "character") return event.characters.includes(id);
      if (kind === "location") return event.locations.includes(id);
      return true;
    });
}

export function selectVisibleEvents() {
  if (!state.analysis) return [];
  return state.analysis.events
    .filter((event) => statusMatches(event.status))
    .filter((event) => isVisibleSegmentId(event.segment_id))
    .filter((event) => state.filters.eventType === "all" || event.type === state.filters.eventType)
    .filter((event) => {
      if (state.filters.entity === "all") return true;
      const [kind, id] = state.filters.entity.split(":");
      if (kind === "character") return event.characters.includes(id);
      if (kind === "location") return event.locations.includes(id);
      return true;
    })
    .sort((a, b) => segmentOrder(a.segment_id) - segmentOrder(b.segment_id) || a.sentence_index - b.sentence_index);
}

export function selectScopedAnalysis() {
  const analysis = state.analysis;
  const segmentIds = new Set(analysis.segments.filter((segment) => isVisibleSegmentId(segment.segment_id)).map((segment) => segment.segment_id));
  return {
    document: analysis.document,
    scope: state.spoilerSafe ? { mode: "reader_position", current_segment: state.currentSegment } : { mode: "full_document" },
    segments: analysis.segments.filter((segment) => segmentIds.has(segment.segment_id)),
    scenes: analysis.scenes.filter((scene) => segmentIds.has(scene.start_segment_id) || segmentIds.has(scene.end_segment_id)),
    mentions: analysis.mentions.filter((mention) => segmentIds.has(mention.segment_id) && statusMatches(mention.status)),
    characters: analysis.characters.filter((character) => statusMatches(character.status) && isVisibleSegmentId(character.first_segment_id)),
    locations: analysis.locations.filter((location) => statusMatches(location.status) && isVisibleSegmentId(location.first_segment_id)),
    events: analysis.events.filter((event) => segmentIds.has(event.segment_id) && statusMatches(event.status)),
    states: analysis.states.filter((item) => segmentIds.has(item.segment_id) && statusMatches(item.status)),
    relations: analysis.relations.filter((relation) => relation.segment_ids.some((segmentId) => segmentIds.has(segmentId)) && statusMatches(relation.status)),
    diagnostics: analysis.diagnostics
  };
}
