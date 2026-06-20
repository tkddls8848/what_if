import { renderRoute, activateRoute, isCheckRoute } from "./view/router.js";
import { renderReader, renderFilterOptions } from "./view/reader.js";
import { renderGraph, renderInspector } from "./view/map.js";
import { renderTimeline } from "./view/timeline.js";
import { renderCharacters } from "./view/characters.js";
import { renderReview, renderCheckSummary, focusSelectionSegment } from "./view/review.js";
import { renderExport } from "./view/export.js";

export { activateRoute, isCheckRoute, focusSelectionSegment, renderExport };

export function renderAll() {
  renderRoute();
  renderReader();
  renderFilterOptions();
  renderGraph();
  renderInspector();
  renderTimeline();
  renderCharacters();
  renderReview();
  renderCheckSummary();
  renderExport();
}
