import {
  DEFAULT_SAMPLE_ID,
  CUSTOM_SAMPLE_ID,
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_MODEL_PRIORITY,
  SAMPLE_TEXTS,
  SNAPSHOT_KEY,
  STATUS,
  EVENT_LABELS,
  STATUS_LABELS
} from "../config.js";

export {
  DEFAULT_SAMPLE_ID,
  CUSTOM_SAMPLE_ID,
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_MODEL_PRIORITY,
  SAMPLE_TEXTS,
  SNAPSHOT_KEY,
  STATUS,
  EVENT_LABELS,
  STATUS_LABELS
};

export const state = {
  analysis: null,
  currentSampleId: DEFAULT_SAMPLE_ID,
  uploadedDocument: null,
  currentSegment: 1,
  spoilerSafe: true,
  selected: null,
  exportFormat: "json",
  filters: {
    eventType: "all",
    status: "active",
    entity: "all"
  }
};

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => Array.from(document.querySelectorAll(selector));

export const els = {
  appWorkspace: $("#appWorkspace"),
  checkWorkspace: $("#checkWorkspace"),
  checkSummary: $("#checkSummary"),
  routeLinks: $$("[data-route-link]"),
  sourceText: $("#sourceText"),
  sampleSelect: $("#sampleSelect"),
  uploadTextBtn: $("#uploadTextBtn"),
  textFileInput: $("#textFileInput"),
  analyzerMode: $("#analyzerMode"),
  ollamaModel: $("#ollamaModel"),
  generateSeedBtn: $("#generateSeedBtn"),
  analyzeBtn: $("#analyzeBtn"),
  saveSnapshotBtn: $("#saveSnapshotBtn"),
  loadSnapshotBtn: $("#loadSnapshotBtn"),
  readerStats: $("#readerStats"),
  readerPosition: $("#readerPosition"),
  readerPositionLabel: $("#readerPositionLabel"),
  spoilerToggle: $("#spoilerToggle"),
  segmentList: $("#segmentList"),
  eventTypeFilter: $("#eventTypeFilter"),
  statusFilter: $("#statusFilter"),
  entityFilter: $("#entityFilter"),
  spaceGraph: $("#spaceGraph"),
  mapStats: $("#mapStats"),
  inspectorBody: $("#inspectorBody"),
  clearSelectionBtn: $("#clearSelectionBtn"),
  timelineList: $("#timelineList"),
  characterCards: $("#characterCards"),
  reviewSourceStats: $("#reviewSourceStats"),
  reviewSource: $("#reviewSource"),
  reviewStats: $("#reviewStats"),
  reviewList: $("#reviewList"),
  rebuildBtn: $("#rebuildBtn"),
  addManualEventBtn: $("#addManualEventBtn"),
  exportOutput: $("#exportOutput"),
  copyExportBtn: $("#copyExportBtn")
};
