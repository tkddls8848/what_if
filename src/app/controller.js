import {
  DEFAULT_SAMPLE_ID,
  CUSTOM_SAMPLE_ID,
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_MODEL_PRIORITY,
  SAMPLE_TEXTS,
  SNAPSHOT_KEY,
  STATUS,
  state,
  els,
  $
} from "./context.js";
import {
  analyzeNovel,
  buildDynamicSeedLexicon,
  applyOllamaPayload,
  buildCharacterStates,
  buildRelations
} from "../analyzer.js";
import {
  renderAll,
  activateRoute,
  renderExport,
  focusSelectionSegment,
  isCheckRoute
} from "./views.js";
import { addManualEvent, setAnnotationStatus, editEntity } from "./editing.js";
import {
  activateTab,
  detectTitle,
  escapeAttr,
  escapeHtml,
  flashButton,
  focusSegment,
  titleFromFileName,
  unique
} from "./utils.js";

export async function initApp() {
  bindEvents();
  await refreshOllamaModelOptions();
  await loadSample(DEFAULT_SAMPLE_ID);
}

async function loadText(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (_error) {
    return "";
  }
}

async function refreshOllamaModelOptions() {
  const fallbackOptions = OLLAMA_MODEL_PRIORITY.map((model) => ({ name: model, installed: false }));
  try {
    const response = await fetch("/api/ollama/models");
    if (!response.ok) {
      renderOllamaModelOptions(fallbackOptions, DEFAULT_OLLAMA_MODEL);
      return;
    }
    const payload = await response.json();
    const installed = (payload.models || []).map((model) => model.name);
    const suggestions = unique([...installed, ...OLLAMA_MODEL_PRIORITY]).map((name) => ({
      name,
      installed: installed.includes(name)
    }));
    const preferred = OLLAMA_MODEL_PRIORITY.find((model) => installed.includes(model)) || installed[0] || DEFAULT_OLLAMA_MODEL;
    renderOllamaModelOptions(suggestions, preferred);
  } catch (_error) {
    renderOllamaModelOptions(fallbackOptions, els.ollamaModel.value || DEFAULT_OLLAMA_MODEL);
  }
}

function renderOllamaModelOptions(models, selectedModel) {
  const options = models.length ? models : OLLAMA_MODEL_PRIORITY.map((name) => ({ name, installed: false }));
  els.ollamaModel.innerHTML = options
    .map((model) => {
      const label = model.installed ? `${model.name} (설치됨)` : model.name;
      return `<option value="${escapeAttr(model.name)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  els.ollamaModel.value = options.some((model) => model.name === selectedModel)
    ? selectedModel
    : options[0].name;
}

function bindEvents() {
  els.routeLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      activateRoute(link.dataset.routeLink);
    });
  });

  window.addEventListener("popstate", () => {
    renderAll();
  });

  els.sampleSelect.addEventListener("change", async (event) => {
    if (event.target.value === CUSTOM_SAMPLE_ID && state.uploadedDocument) {
      state.currentSampleId = CUSTOM_SAMPLE_ID;
      state.currentSegment = 1;
      runAnalysis();
      return;
    }
    await loadSample(event.target.value);
  });

  els.uploadTextBtn.addEventListener("click", () => {
    els.textFileInput.click();
  });

  els.textFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadUploadedText(file);
    event.target.value = "";
  });

  els.analyzeBtn.addEventListener("click", async () => {
    state.currentSegment = 1;
    await runAnalysis();
  });

  els.generateSeedBtn.addEventListener("click", async () => {
    state.currentSegment = 1;
    await runAnalysis({ forceDynamicSeed: true, triggerButton: els.generateSeedBtn });
  });

  els.saveSnapshotBtn.addEventListener("click", () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      analysis: state.analysis,
      sourceText: els.sourceText.value,
      currentSampleId: state.currentSampleId,
      uploadedDocument: state.uploadedDocument
    }));
    flashButton(els.saveSnapshotBtn, "저장됨");
  });

  els.loadSnapshotBtn.addEventListener("click", () => {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return flashButton(els.loadSnapshotBtn, "없음");
    const snapshot = JSON.parse(raw);
    els.sourceText.value = snapshot.sourceText || "";
    state.uploadedDocument = snapshot.uploadedDocument || null;
    if (state.uploadedDocument) ensureCustomSampleOption(state.uploadedDocument.title);
    state.currentSampleId = snapshot.currentSampleId || snapshot.analysis?.document?.sample_id || DEFAULT_SAMPLE_ID;
    els.sampleSelect.value = state.currentSampleId;
    state.analysis = snapshot.analysis || null;
    state.currentSegment = 1;
    renderAll();
    flashButton(els.loadSnapshotBtn, "복원됨");
  });

  els.readerPosition.addEventListener("input", (event) => {
    state.currentSegment = Number(event.target.value);
    renderAll();
  });

  els.spoilerToggle.addEventListener("change", (event) => {
    state.spoilerSafe = event.target.checked;
    renderAll();
  });

  els.eventTypeFilter.addEventListener("change", (event) => {
    state.filters.eventType = event.target.value;
    renderAll();
  });

  els.statusFilter.addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    renderAll();
  });

  els.entityFilter.addEventListener("change", (event) => {
    state.filters.entity = event.target.value;
    renderAll();
  });

  els.clearSelectionBtn.addEventListener("click", () => {
    state.selected = null;
    renderAll();
  });

  els.rebuildBtn.addEventListener("click", () => {
    if (!state.analysis) return;
    state.analysis.states = buildCharacterStates(state.analysis);
    state.analysis.relations = buildRelations(state.analysis);
    renderAll();
  });

  els.addManualEventBtn.addEventListener("click", () => {
    addManualEvent();
  });

  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      activateTab(tab.dataset.tab);
      return;
    }

    const statusButton = event.target.closest("[data-status-action]");
    if (statusButton) {
      setAnnotationStatus(statusButton.dataset.kind, statusButton.dataset.id, statusButton.dataset.statusAction);
      return;
    }

    const selectButton = event.target.closest("[data-select-kind]");
    if (selectButton) {
      state.selected = { kind: selectButton.dataset.selectKind, id: selectButton.dataset.selectId };
      if (isCheckRoute() || selectButton.closest(".review-item")) {
        focusSelectionSegment(state.selected.kind, state.selected.id);
      }
      renderAll();
    }

    const exportButton = event.target.closest("[data-export-format]");
    if (exportButton) {
      state.exportFormat = exportButton.dataset.exportFormat;
      $("[data-export-format].active")?.classList.remove("active");
      exportButton.classList.add("active");
      renderExport();
      return;
    }

    const focusButton = event.target.closest("[data-focus-segment]");
    if (focusButton) {
      focusSegment(focusButton.dataset.focusSegment);
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const { editKind, editId, editField } = target.dataset;
    if (!editKind || !editId || !editField) return;
    editEntity(editKind, editId, editField, target.value);
  });

  els.copyExportBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.exportOutput.value);
    } catch (_error) {
      els.exportOutput.select();
      document.execCommand("copy");
    }
    flashButton(els.copyExportBtn, "복사됨");
  });
}

// Clears analysis-derived workspace state so switching documents never leaves the
// previous file's entities, selection or filters lingering in the UI.
function resetWorkspaceState() {
  state.analysis = null;
  state.selected = null;
  state.currentSegment = 1;
  state.filters = { eventType: "all", status: "active", entity: "all" };
}

async function loadSample(sampleId) {
  resetWorkspaceState();
  if (sampleId === CUSTOM_SAMPLE_ID && state.uploadedDocument) {
    state.currentSampleId = CUSTOM_SAMPLE_ID;
    els.sampleSelect.value = CUSTOM_SAMPLE_ID;
    state.currentSegment = 1;
    await runAnalysis();
    return;
  }
  const sample = getSample(sampleId);
  state.currentSampleId = sample.id;
  els.sampleSelect.value = sample.id;
  els.sourceText.value = await loadText(sample.url);
  state.currentSegment = 1;
  await runAnalysis();
}

async function loadUploadedText(file) {
  if (!file) return;
  const text = await file.text();
  const title = titleFromFileName(file.name) || detectTitle(text);
  resetWorkspaceState();
  renderAll(); // blank the workspace immediately so the previous file's results never linger while the new analysis (e.g. Ollama seed) runs
  state.uploadedDocument = {
    id: CUSTOM_SAMPLE_ID,
    title,
    author: "",
    year: "",
    url: `upload:${file.name}`,
    source_url: "",
    rights: "user-provided"
  };
  ensureCustomSampleOption(title);
  state.currentSampleId = CUSTOM_SAMPLE_ID;
  els.sampleSelect.value = CUSTOM_SAMPLE_ID;
  els.sourceText.value = text;
  state.currentSegment = 1;
  await runAnalysis();
}

function ensureCustomSampleOption(title) {
  let option = els.sampleSelect.querySelector(`option[value="${CUSTOM_SAMPLE_ID}"]`);
  if (!option) {
    option = document.createElement("option");
    option.value = CUSTOM_SAMPLE_ID;
    els.sampleSelect.appendChild(option);
  }
  option.textContent = `업로드: ${title || "직접 입력"}`;
}

function getSample(sampleId) {
  if (sampleId === CUSTOM_SAMPLE_ID && state.uploadedDocument) return state.uploadedDocument;
  return SAMPLE_TEXTS.find((sample) => sample.id === sampleId) || SAMPLE_TEXTS[0];
}

async function runAnalysis(options = {}) {
  const sample = getSample(state.currentSampleId);
  const input = {
    title: sample.title || detectTitle(els.sourceText.value),
    language: "ko",
    source: sample.url,
    sample,
    text: els.sourceText.value
  };

  if (options.forceDynamicSeed || els.analyzerMode.value === "ollama") {
    state.analysis = await analyzeWithDynamicSeed(input, options.triggerButton || els.analyzeBtn);
  } else {
    state.analysis = analyzeNovel(input);
  }

  state.currentSegment = Math.min(state.currentSegment, state.analysis.segments.length || 1);
  focusFirstConnectedSegmentIfCurrentMapIsEmpty();
  renderAll();
}

function focusFirstConnectedSegmentIfCurrentMapIsEmpty() {
  const analysis = state.analysis;
  if (!analysis) return;
  const currentSegment = analysis.segments[state.currentSegment - 1];
  const hasCurrentConnections = analysis.events.some((event) =>
    event.segment_id === currentSegment?.segment_id &&
    event.status !== STATUS.REJECTED &&
    (event.characters.length || event.locations.length)
  );
  if (hasCurrentConnections) return;
  const firstConnectedEvent = analysis.events.find((event) =>
    event.status !== STATUS.REJECTED &&
    (event.characters.length || event.locations.length)
  );
  if (!firstConnectedEvent) return;
  const segment = analysis.segments.find((item) => item.segment_id === firstConnectedEvent.segment_id);
  if (segment) state.currentSegment = segment.index;
}

async function analyzeWithDynamicSeed(input, triggerButton) {
  const originalLabel = triggerButton.textContent;
  triggerButton.disabled = true;
  triggerButton.classList.add("is-loading");
  triggerButton.textContent = "Seed 생성 중";
  let ollamaPayload = null;
  let ollamaError = "";

  try {
    const result = await requestOllamaAnalysis(input.text, els.ollamaModel.value.trim());
    ollamaPayload = result.analysis;
    input.seedLexicon = buildDynamicSeedLexicon(ollamaPayload, result.model);
    input.engine = "ollama-dynamic-seed-ko-adapter";
    triggerButton.textContent = "분석 중";
  } catch (error) {
    ollamaError = `Ollama seed 생성 실패: ${error.message || error}`;
    input.engine = "pattern-only-ko-adapter";
  } finally {
    triggerButton.disabled = false;
    triggerButton.classList.remove("is-loading");
    triggerButton.textContent = originalLabel;
  }

  let analysis = analyzeNovel(input);
  if (input.seedLexicon && !analysis.characters.length) {
    const fallbackInput = { ...input };
    delete fallbackInput.seedLexicon;
    fallbackInput.engine = "pattern-fallback-after-empty-dynamic-seed";
    analysis = analyzeNovel(fallbackInput);
    analysis.diagnostics.warnings.push("Ollama 동적 seed에서 원문 mention을 찾지 못해 규칙 기반 fallback으로 다시 분석했습니다.");
  }
  if (ollamaPayload) applyOllamaPayload(analysis, ollamaPayload, input.seedLexicon.model);
  if (ollamaError) analysis.diagnostics.warnings.push(ollamaError);
  return analysis;
}

async function requestOllamaAnalysis(text, model) {
  const response = await fetch("/api/analyze/ollama", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, model })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Ollama analysis failed");
  return { model: payload.model || model, analysis: payload.analysis || {} };
}

initApp();
