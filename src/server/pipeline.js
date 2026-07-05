"use strict";

/**
 * 장면 단위 map-reduce 추출 파이프라인.
 *
 * map: 장면별 (1) 인물·장소 → (2) 사건 프레임·상태 변화 소형 호출
 * reduce: 이름 정규화 병합 + evidence 원문 검증 + 합의 confidence 조정 + 관계 pass
 *
 * 출력 payload는 기존 단발 프롬프트와 같은 형태이므로 브라우저의
 * buildDynamicSeedLexicon / applyOllamaPayload를 그대로 통과한다.
 */

const { normalizeText, regexCandidateNames } = require("./morph");
const prompts = require("./prompts");

const DEFAULT_TARGET_CHARS = 2000;
const MAX_SCENES = 60;

// ── 장면 분할 ────────────────────────────────────────────────────────────────

function splitSegments(text) {
  const normalized = normalizeText(text);
  const segments = [];
  let cursor = 0;
  for (const part of normalized.split(/\n\s*\n/g)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const start = normalized.indexOf(trimmed, cursor);
    const charStart = start >= 0 ? start : cursor;
    segments.push({
      index: segments.length + 1,
      text: trimmed,
      char_start: charStart,
      char_end: charStart + trimmed.length
    });
    cursor = charStart + trimmed.length;
  }
  return { normalized, segments };
}

function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?…。]|다\.)\s+/u);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current.length + sentence.length + 1) > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  // 문장 분리로도 줄지 않으면 강제 절단
  return chunks.flatMap((chunk) =>
    chunk.length <= maxChars * 1.5
      ? [chunk]
      : Array.from({ length: Math.ceil(chunk.length / maxChars) }, (_v, i) =>
          chunk.slice(i * maxChars, (i + 1) * maxChars))
  );
}

/** 문단 세그먼트를 목표 길이의 장면으로 묶는다. 장면 수 상한 초과 시 목표 길이를 늘린다. */
function splitScenes(text, { targetChars = DEFAULT_TARGET_CHARS } = {}) {
  const { segments } = splitSegments(text);
  let target = targetChars;

  for (;;) {
    const scenes = [];
    let current = null;
    for (const segment of segments) {
      const pieces = splitLongText(segment.text, target * 2).map((piece, i, arr) => ({
        ...segment,
        text: piece,
        split_part: arr.length > 1 ? i + 1 : 0
      }));
      for (const piece of pieces) {
        if (!current || (current.text.length + piece.text.length + 2) > target) {
          current = { index: scenes.length + 1, segments: [], text: "" };
          scenes.push(current);
        }
        current.segments.push(piece);
        current.text = current.text ? `${current.text}\n\n${piece.text}` : piece.text;
      }
    }
    const filled = scenes.filter((scene) => scene.text.trim());
    if (filled.length <= MAX_SCENES || target >= 16000) {
      filled.forEach((scene, i) => {
        scene.index = i + 1;
        scene.segment_indexes = scene.segments.map((segment) => segment.index);
      });
      return filled;
    }
    target = Math.ceil(target * 1.8);
  }
}

// ── 병합 유틸 ────────────────────────────────────────────────────────────────

function normalizeNameKey(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function cleanShort(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function listOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function clampNumber(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(0.95, Math.max(0.1, num));
}

/** evidence가 장면 원문에 실제로 존재하는지(공백 정규화 후 부분 문자열) 확인한다. */
function verifyEvidence(evidence, sceneText) {
  const quote = normalizeText(evidence).replace(/\s+/g, "");
  if (!quote || quote.length < 4) return false;
  const haystack = normalizeText(sceneText).replace(/\s+/g, "");
  return haystack.includes(quote.slice(0, 120));
}

function demoteConfidence(item) {
  if (typeof item.confidence === "number") {
    item.confidence = Math.max(0.1, item.confidence - 0.25);
  } else {
    item.confidence = "weak";
  }
  return item;
}

class EntityMerger {
  constructor() {
    this.byKey = new Map();
  }

  add(item, sceneIndex) {
    const name = cleanShort(item.name, 40);
    const key = normalizeNameKey(name);
    if (!key) return;
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = {
        name,
        aliases: new Set(),
        descriptions: [],
        evidence: cleanShort(item.evidence, 160),
        confidence: clampNumber(item.confidence, 0.6),
        role: cleanShort(item.role, 40),
        type: cleanShort(item.type, 30),
        scenes: new Set()
      };
      this.byKey.set(key, entry);
    }
    listOf(item.aliases).forEach((alias) => entry.aliases.add(cleanShort(alias, 30)));
    if (item.description) entry.descriptions.push(cleanShort(item.description, 160));
    entry.confidence = Math.max(entry.confidence, clampNumber(item.confidence, 0.6));
    if (!entry.evidence && item.evidence) entry.evidence = cleanShort(item.evidence, 160);
    if (!entry.role && item.role) entry.role = cleanShort(item.role, 40);
    entry.scenes.add(sceneIndex);
  }

  has(name) {
    return this.byKey.has(normalizeNameKey(name));
  }

  /** 2개 장면 이상 등장 또는 규칙 채널 합의 시 confidence를 올린다. */
  finalize(agreementNames) {
    return Array.from(this.byKey.values()).map((entry) => {
      const agreed = entry.scenes.size >= 2 || agreementNames.has(entry.name);
      const confidence = Math.min(0.95, entry.confidence + (agreed ? 0.1 : 0));
      const longest = entry.descriptions.sort((a, b) => b.length - a.length)[0] || "";
      return {
        name: entry.name,
        aliases: Array.from(entry.aliases).filter((alias) => alias && alias !== entry.name).slice(0, 8),
        description: longest,
        evidence: entry.evidence,
        confidence,
        role: entry.role,
        type: entry.type,
        scene_count: entry.scenes.size,
        agreement: agreed
      };
    });
  }
}

// ── 파이프라인 실행 ──────────────────────────────────────────────────────────

async function callWithParseRetry(client, args) {
  let result = await client.generateJson(args);
  if (!result.ok && result.error_code === "PARSE_FAILED") {
    result = await client.generateJson(args);
  }
  return result;
}

/**
 * 장면 단위 파이프라인.
 * @returns {{ payload, diagnostics }}  전 장면 실패 시 { error } 반환.
 */
async function runScenePipeline({
  text,
  model,
  client,
  numCtx = prompts.NUM_CTX,
  targetChars = DEFAULT_TARGET_CHARS,
  onProgress = () => {}
} = {}) {
  const scenes = splitScenes(text, { targetChars });
  const regexAgreement = regexCandidateNames(text);

  const characterMerger = new EntityMerger();
  const locationMerger = new EntityMerger();
  const eventFrames = [];
  const stateChanges = [];
  const mentalWords = new Map();
  const physicalWords = new Map();
  const diagnostics = {
    mode: "scene",
    prompt_version: prompts.PROMPT_VERSION,
    model,
    num_ctx: numCtx,
    scenes_total: scenes.length,
    scenes_failed: [],
    calls: 0,
    prompt_eval_total: 0,
    eval_total: 0,
    budget_tokens: prompts.promptBudgetTokens(numCtx),
    evidence_demoted: 0
  };

  const track = (result) => {
    diagnostics.calls += 1;
    diagnostics.prompt_eval_total += result.prompt_eval_count || 0;
    diagnostics.eval_total += result.eval_count || 0;
  };

  const rollingCast = () =>
    characterMerger.finalize(regexAgreement.characters)
      .filter((item) => item.scene_count >= 2 || regexAgreement.characters.has(item.name))
      .map((item) => ({ name: item.name, aliases: item.aliases }));

  for (const scene of scenes) {
    const cast = rollingCast();
    onProgress({ stage: "scene", scene: scene.index, total: scenes.length });

    const entitiesPrompt = prompts.sceneEntitiesPrompt({
      sceneText: scene.text,
      sceneIndex: scene.index,
      sceneTotal: scenes.length,
      cast
    });
    if (!prompts.fitsBudget(entitiesPrompt, numCtx)) {
      diagnostics.scenes_failed.push({ scene: scene.index, error_code: "BUDGET_EXCEEDED" });
      continue;
    }

    const entitiesResult = await callWithParseRetry(client, {
      model, prompt: entitiesPrompt, format: prompts.SCENE_ENTITIES_SCHEMA, numCtx
    });
    track(entitiesResult);
    if (!entitiesResult.ok) {
      diagnostics.scenes_failed.push({ scene: scene.index, step: "entities", error_code: entitiesResult.error_code });
      // 연결 실패·타임아웃은 다음 장면도 같은 결과일 가능성이 높으므로 전체 중단
      if (entitiesResult.error_code === "CONNECTION_FAILED" || entitiesResult.error_code === "TIMEOUT") {
        if (!characterMerger.byKey.size) return { error: entitiesResult };
      }
      continue;
    }

    const sceneEntities = { characters: [], locations: [] };
    for (const item of entitiesResult.data.characters || []) {
      const verified = verifyEvidence(item.evidence, scene.text);
      if (!verified) { demoteConfidence(item); diagnostics.evidence_demoted += 1; }
      characterMerger.add(item, scene.index);
      sceneEntities.characters.push(item);
    }
    for (const item of entitiesResult.data.locations || []) {
      const verified = verifyEvidence(item.evidence, scene.text);
      if (!verified) { demoteConfidence(item); diagnostics.evidence_demoted += 1; }
      locationMerger.add(item, scene.index);
      sceneEntities.locations.push(item);
    }

    const eventsPrompt = prompts.sceneEventsPrompt({
      sceneText: scene.text,
      sceneIndex: scene.index,
      sceneTotal: scenes.length,
      cast,
      sceneEntities
    });
    if (!prompts.fitsBudget(eventsPrompt, numCtx)) {
      diagnostics.scenes_failed.push({ scene: scene.index, step: "events", error_code: "BUDGET_EXCEEDED" });
      continue;
    }
    const eventsResult = await callWithParseRetry(client, {
      model, prompt: eventsPrompt, format: prompts.SCENE_EVENTS_SCHEMA, numCtx
    });
    track(eventsResult);
    if (!eventsResult.ok) {
      diagnostics.scenes_failed.push({ scene: scene.index, step: "events", error_code: eventsResult.error_code });
      continue;
    }

    for (const frame of eventsResult.data.event_frames || []) {
      if (!verifyEvidence(frame.evidence, scene.text)) {
        demoteConfidence(frame);
        diagnostics.evidence_demoted += 1;
      }
      eventFrames.push({
        id: `frame_${String(eventFrames.length + 1).padStart(3, "0")}`,
        type: frame.type || "background",
        label: frame.label || "",
        summary: cleanShort(frame.summary, 160),
        who: listOf(frame.who).map((name) => cleanShort(name, 40)),
        where: listOf(frame.where).map((name) => cleanShort(name, 40)),
        when: "",
        what_happened: cleanShort(frame.what_happened, 160),
        why_relevant: "",
        result: cleanShort(frame.result, 160),
        evidence: cleanShort(frame.evidence, 160),
        confidence: clampNumber(frame.confidence, 0.6),
        scene_index: scene.index,
        segment_indexes: scene.segment_indexes
      });
    }
    for (const change of eventsResult.data.state_changes || []) {
      if (!change.character) continue;
      if (!verifyEvidence(change.evidence, scene.text)) {
        demoteConfidence(change);
        diagnostics.evidence_demoted += 1;
      }
      const record = {
        character: cleanShort(change.character, 40),
        trigger_event: cleanShort(change.trigger_event, 120),
        before: change.before || {},
        after: change.after || {},
        evidence: cleanShort(change.evidence, 160),
        confidence: prompts.CONFIDENCE_ENUM.includes(change.confidence) ? change.confidence : "inferred",
        scene_index: scene.index,
        segment_indexes: scene.segment_indexes
      };
      stateChanges.push(record);
      for (const [store, key] of [[mentalWords, "mental_state"], [physicalWords, "physical_state"]]) {
        for (const side of ["before", "after"]) {
          const word = cleanShort(record[side]?.[key], 24);
          if (word) store.set(word, (store.get(word) || 0) + 1);
        }
      }
    }
  }

  const characters = characterMerger.finalize(regexAgreement.characters);
  const locations = locationMerger.finalize(regexAgreement.locations);

  if (!characters.length && !eventFrames.length) {
    const failure = diagnostics.scenes_failed[0];
    return {
      error: {
        ok: false,
        error_code: failure?.error_code || "EMPTY_RESULT",
        message: "모든 장면에서 추출에 실패했거나 결과가 비었습니다.",
        retryable: true
      },
      diagnostics
    };
  }

  // 관계 pass: 원문 대신 병합된 cast·사건 프레임 요약을 입력으로 사용
  let relationships = [];
  if (characters.length && eventFrames.length) {
    onProgress({ stage: "relations", scene: scenes.length, total: scenes.length });
    const relPrompt = prompts.relationsPrompt({
      cast: characters,
      locations,
      eventFrames
    });
    if (prompts.fitsBudget(relPrompt, numCtx)) {
      const relResult = await callWithParseRetry(client, {
        model, prompt: relPrompt, format: prompts.RELATIONS_SCHEMA, numCtx
      });
      track(relResult);
      if (relResult.ok) {
        relationships = (relResult.data.relationships || [])
          .filter((rel) => prompts.isAllowedRelation(rel.source_type, rel.target_type, rel.type))
          .map((rel) => ({
            source: cleanShort(rel.source, 60),
            source_type: rel.source_type,
            target: cleanShort(rel.target, 60),
            target_type: rel.target_type,
            type: rel.type,
            label: cleanShort(rel.label, 60),
            evidence: cleanShort(rel.evidence, 160),
            confidence: prompts.CONFIDENCE_ENUM.includes(rel.confidence) ? rel.confidence : "inferred"
          }));
      } else {
        diagnostics.relations_error = relResult.error_code;
      }
    } else {
      diagnostics.relations_error = "BUDGET_EXCEEDED";
    }
  }

  const toStateSeed = (store) =>
    Array.from(store.entries()).map(([state, count]) => ({
      state,
      words: [state],
      description: `장면 상태 변화에서 ${count}회 관찰됨`
    }));

  const payload = {
    characters: characters.map((item) => ({
      name: item.name,
      aliases: item.aliases,
      role: item.role || "인물 후보",
      description: item.description,
      evidence: item.evidence,
      confidence: item.confidence
    })),
    locations: locations.map((item) => ({
      name: item.name,
      aliases: item.aliases,
      type: item.type || "inferred",
      description: item.description,
      evidence: item.evidence,
      confidence: item.confidence
    })),
    event_types: [],
    mental_states: toStateSeed(mentalWords),
    physical_states: toStateSeed(physicalWords),
    event_frames: eventFrames,
    relationships,
    state_changes: stateChanges,
    events: []
  };

  return { payload, diagnostics };
}

/** 기존 단발 호출 (mode=single 비교용). */
async function runSinglePipeline({ text, model, client, morphContext, numCtx = prompts.NUM_CTX } = {}) {
  const prompt = prompts.singleShotPrompt(text, morphContext);
  const estimated = prompts.estimateTokens(prompt);
  const result = await callWithParseRetry(client, { model, prompt, format: "json", numCtx });
  const diagnostics = {
    mode: "single",
    prompt_version: prompts.PROMPT_VERSION,
    model,
    num_ctx: numCtx,
    estimated_prompt_tokens: estimated,
    truncation_risk: estimated > numCtx,
    prompt_eval_total: result.prompt_eval_count || 0,
    eval_total: result.eval_count || 0,
    calls: 1
  };
  if (!result.ok) return { error: result, diagnostics };
  return { payload: result.data, diagnostics };
}

module.exports = {
  DEFAULT_TARGET_CHARS,
  splitSegments,
  splitScenes,
  splitLongText,
  normalizeNameKey,
  verifyEvidence,
  EntityMerger,
  runScenePipeline,
  runSinglePipeline
};
