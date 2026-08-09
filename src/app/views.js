import { renderRoute, activateRoute, isCheckRoute } from "./view/router.js";
import { renderReader, renderFilterOptions } from "./view/reader.js";
import { renderGraph, renderInspector } from "./view/map.js";
import { renderTimeline } from "./view/timeline.js";
import { renderCharacters } from "./view/characters.js";
import { renderReview, renderCheckSummary, focusSelectionSegment } from "./view/review.js";
import { renderExport, downloadExport } from "./view/export.js";
import { renderWhatIf, resetWhatIf, handleWhatIfAction, handleRubricInput } from "./view/whatif.js";

export {
  activateRoute,
  isCheckRoute,
  focusSelectionSegment,
  renderExport,
  downloadExport,
  resetWhatIf,
  handleWhatIfAction,
  handleRubricInput
};

export function renderAll() {
  renderRoute();
  renderReader();
  renderFilterOptions();
  renderGraph();
  renderInspector();
  renderTimeline();
  renderCharacters();
  renderWhatIf();
  renderReview();
  renderCheckSummary();
  renderExport();
}
