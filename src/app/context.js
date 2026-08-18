import {
  DEFAULT_SAMPLE_ID,
  CUSTOM_SAMPLE_ID,
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_MODEL_PRIORITY,
  SAMPLE_TEXTS,
  SNAPSHOT_KEY,
  STATUS,
  EVENT_LABELS,
  STATUS_LABELS,
  PERIOD_TERM_CATEGORIES
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
  STATUS_LABELS,
  PERIOD_TERM_CATEGORIES
};

export const state = {
  analysis: null,
  currentSampleId: DEFAULT_SAMPLE_ID,
  uploadedDocument: null,
  currentSegment: 1,
  spoilerSafe: true,
  selected: null,
  exportFormat: "json",
  // 검수 목록 정렬. 기본은 독자가 읽은 차례이고, 도구 정비 순서(위반·신뢰도)는
  // `audit`으로 남겨 둔다. 무엇이 목록에 들어가는지는 바꾸지 않는다 — 순서만이다.
  reviewSort: "reading",
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
  importWikiBtn: $("#importWikiBtn"),
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
  recapPanel: $("#recapPanel"),
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
  reviewSort: $("#reviewSort"),
  reviewSourceStats: $("#reviewSourceStats"),
  reviewSource: $("#reviewSource"),
  reviewStats: $("#reviewStats"),
  reviewList: $("#reviewList"),
  rebuildBtn: $("#rebuildBtn"),
  addManualEventBtn: $("#addManualEventBtn"),
  whatifPanel: $("#whatifPanel"),
  exportOutput: $("#exportOutput"),
  copyExportBtn: $("#copyExportBtn"),
  downloadExportBtn: $("#downloadExportBtn")
};
