/**
 * @module core/whatif
 *
 * "그때 다른 선택을 했다면" — 반사실 분기.
 *
 * 설계 출처: WHAT-IF(arXiv 2412.10582, *Writing a Hero's Alternate Timeline through
 * Interactive Fiction*)는 선형 서사에서 분기점을 뽑아 대안 경로를 만들고, 분기 트리를
 * 그래프로 보관해 일관성을 유지한다. 그 논문의 1단계(plot graph 확보)는 이 앱이 이미
 * 갖고 있으므로, 여기서는 2단계 이후만 구현한다.
 *
 * 이 모듈의 두 가지 원칙:
 *
 * 1. **지식 경계 강제.** 분기 시드는 `asOf(fork)` 스냅샷뿐이고 분기 시점 이후의
 *    원문·사건은 프롬프트에 들어가지 않는다. 모델이 원작 결말을 베낄 재료 자체를
 *    주지 않는 것이 유일하게 확실한 방법이다. 생성 후에는 `detectCanonLeak`으로
 *    실제로 베끼지 않았는지 검사한다.
 * 2. **산문이 아니라 구조를 만든다.** 분기 결과는 문장이 아니라 기존 계약과 같은
 *    모양의 사건 프레임과 상태 변화다. 그래야 structured outputs로 강제할 수 있고,
 *    검증도 계약 검사로 가능하다. 산문화는 이 모듈의 일이 아니다.
 *
 * 생성된 사실은 원작 사실과 섞이지 않는다. `origin: "generated"`이고 원문 근거가
 * 없으며 `analysis.branches[]`에만 산다. 원작 컬렉션은 건드리지 않는다.
 *
 * BOUNDARY NOTE: DOM·네트워크 의존 없음. Ollama 호출은 서버가 하고, 이 모듈은
 * 그 전후(시드 구성·정규화·검증)만 맡는다.
 */
import { asOf, currentStateOf, isKnownAt, lastSegmentIndex, resolveTime, segmentIndexOf } from "./asof.js";
import { evidenceOf } from "./evidence.js";

/** 원작 줄기의 branch_id. 생성된 분기는 모두 이것을 부모로 갖는다. */
const CANON_BRANCH_ID = "canon";

/** 분기점이 될 만한 사건 유형. 인물이 선택할 여지가 있는 순간들. */
const FORK_EVENT_TYPES = new Set(["conflict", "realization", "conversation", "movement"]);
const STRONG_FORK_TYPES = new Set(["conflict", "realization"]);

/** 표절 판정에 쓰는 연속 일치 길이. 이보다 짧으면 우연한 상투구다. */
const LEAK_NGRAM = 12;

/* ------------------------------------------------------------------ */
/* 1. 분기점 후보                                                       */
/* ------------------------------------------------------------------ */

/**
 * 분기점 후보를 점수순으로 돌려준다. **자동 선택하지 않는다** — 어디서 갈라질지는
 * 사람이 정한다. 자동 확정 금지 원칙과 같은 이유다.
 */
export function forkCandidates(analysis, { limit = 12, before = null } = {}) {
  const ceiling = before === null ? lastSegmentIndex(analysis) : resolveTime(analysis, before, true);

  return (analysis.events || [])
    .filter((event) => event.status !== "rejected")
    .filter((event) => FORK_EVENT_TYPES.has(event.type))
    .map((event) => {
      const segment = segmentIndexOf(analysis, event.segment_id);
      return { event, segment, score: forkScore(analysis, event) };
    })
    .filter((entry) => entry.segment >= 1 && entry.segment <= ceiling)
    .sort((a, b) => b.score - a.score || a.segment - b.segment)
    .slice(0, limit)
    .map((entry) => ({
      event_id: entry.event.event_id,
      segment: entry.segment,
      type: entry.event.type,
      summary: entry.event.summary,
      characters: entry.event.characters.map((id) => characterName(analysis, id)),
      score: entry.score,
      evidence: evidenceOf(analysis, entry.event, "event")
    }));
}

function forkScore(analysis, event) {
  let score = STRONG_FORK_TYPES.has(event.type) ? 3 : 1;
  score += Math.min(2, (event.characters || []).length);
  if ((event.locations || []).length) score += 1;
  const causesStateChange = (analysis.states || []).some((state) =>
    (state.source_event_ids || []).includes(event.event_id));
  if (causesStateChange) score += 2;
  score += Number(event.confidence || 0);
  return Number(score.toFixed(3));
}

/* ------------------------------------------------------------------ */
/* 2. 분기 시드                                                         */
/* ------------------------------------------------------------------ */

/**
 * 분기 시점의 세계 상태 스냅샷. **이 객체가 모델이 보는 전부다.**
 * 분기 시점 이후의 원문·사건·상태는 한 글자도 들어가지 않는다.
 */
export function branchSeed(analysis, forkSegment, { recentEvents = 8 } = {}) {
  const at = resolveTime(analysis, forkSegment, true);
  if (at < 1) throw new Error("분기 시점(segment 번호)이 필요합니다.");
  const scoped = asOf(analysis, at);

  const characters = scoped.characters.map((character) => {
    const state = currentStateOf(analysis, character.character_id, at);
    const location = state?.location_id
      ? scoped.locations.find((item) => item.location_id === state.location_id)
      : null;
    return {
      name: character.canonical_name,
      aliases: (character.aliases || []).slice(0, 4),
      role: character.role || "",
      mental_state: state?.mental_state || "",
      physical_state: state?.physical_state || "",
      location: location?.name || "",
      known_facts: (state?.known_facts || []).slice(-3)
    };
  });

  const recent = scoped.events
    .slice()
    .sort((a, b) => segmentIndexOf(analysis, a.segment_id) - segmentIndexOf(analysis, b.segment_id))
    .slice(-recentEvents)
    .map((event) => ({
      segment: segmentIndexOf(analysis, event.segment_id),
      type: event.type,
      summary: event.summary,
      characters: event.characters.map((id) => characterName(analysis, id))
    }));

  return {
    document: { title: analysis.document?.title || "", author: analysis.document?.author || "" },
    fork_segment: at,
    characters,
    locations: scoped.locations.map((location) => ({ name: location.name, type: location.type || "" })),
    relations: scoped.relations
      .filter((relation) => relation.source_type === "character" && relation.target_type === "location")
      .slice(0, 20)
      .map((relation) => ({
        source: characterName(analysis, relation.source_id),
        relation: relation.relation_type,
        target: locationName(analysis, relation.target_id)
      })),
    recent_events: recent
  };
}

/* ------------------------------------------------------------------ */
/* 3. 분기 정규화                                                       */
/* ------------------------------------------------------------------ */

/**
 * 모델 출력을 `branches[]` 계약으로 정규화한다. 원문 근거가 없는 생성물이므로
 * `origin: "generated"`, `status: "suggested"`로 고정하고 원작 사실과 섞지 않는다.
 */
export function normalizeBranch(analysis, payload, { forkSegment, premise, model, forkEventId = "", index = 0 } = {}) {
  const at = resolveTime(analysis, forkSegment, true);
  const branchId = makeBranchId(analysis, index);
  const knownCharacters = new Set(
    (analysis.characters || [])
      .filter((character) => isKnownAt(character, at))
      .map((character) => character.canonical_name)
  );

  const events = listOf(payload?.events).map((item, position) => ({
    event_id: `${branchId}_event_${String(position + 1).padStart(3, "0")}`,
    branch_id: branchId,
    order: position + 1,
    type: normalizeEventType(item?.type),
    summary: cleanText(item?.summary, 240),
    characters: listOf(item?.characters).map((name) => cleanText(name, 40)).filter((name) => knownCharacters.has(name)),
    locations: listOf(item?.locations).map((name) => cleanText(name, 40)),
    origin: "generated",
    status: "suggested",
    confidence: clamp01(item?.confidence, 0.5),
    method: `whatif:${model || "unknown"}`
  })).filter((event) => event.summary);

  const states = listOf(payload?.state_changes).map((item, position) => ({
    state_id: `${branchId}_state_${String(position + 1).padStart(3, "0")}`,
    branch_id: branchId,
    character: cleanText(item?.character, 40),
    mental_state: cleanText(item?.mental_state, 60),
    physical_state: cleanText(item?.physical_state, 60),
    location: cleanText(item?.location, 60),
    // 모델은 자기가 만든 사건의 순번(1부터)만 알려준다. 내부 id 생성은 우리 몫이다.
    after_event_id: events[Math.min(Math.max(Number(item?.after_event_order) || events.length, 1), events.length) - 1]?.event_id || "",
    origin: "generated",
    status: "suggested"
  })).filter((state) => knownCharacters.has(state.character));

  const branch = {
    branch_id: branchId,
    parent_branch_id: CANON_BRANCH_ID,
    fork_segment: at,
    fork_event_id: forkEventId,
    premise: cleanText(premise, 200),
    model: model || "",
    created_at: new Date().toISOString(),
    status: "suggested",
    events,
    states,
    diagnostics: {}
  };

  branch.diagnostics.canon_leak = detectCanonLeak(analysis, branch);
  branch.diagnostics.unknown_characters = listOf(payload?.events)
    .flatMap((item) => listOf(item?.characters))
    .map((name) => cleanText(name, 40))
    .filter((name) => name && !knownCharacters.has(name));
  return branch;
}

export function attachBranch(analysis, branch) {
  analysis.branches = analysis.branches || [];
  analysis.branches.push(branch);
  return analysis;
}

/* ------------------------------------------------------------------ */
/* 4. 원작 인용 검사                                                     */
/* ------------------------------------------------------------------ */

/**
 * 분기 시점 **이후**의 원작 문장이나 사건 요약을 그대로 가져오지 않았는지 검사한다.
 * 시드에 미래를 넣지 않았으므로 정상이라면 비어 있어야 하고, 비어 있지 않다면
 * 모델이 사전 지식으로 원작을 재현한 것이다.
 */
export function detectCanonLeak(analysis, branch) {
  const fork = Number(branch.fork_segment) || 0;
  const futureSegments = (analysis.segments || []).filter((segment) => segment.index > fork);
  const futureEvents = (analysis.events || [])
    .filter((event) => segmentIndexOf(analysis, event.segment_id) > fork);
  const leaks = [];

  branch.events.forEach((event) => {
    const needle = normalizeForMatch(event.summary);
    if (needle.length < LEAK_NGRAM) return;

    for (const segment of futureSegments) {
      const hay = normalizeForMatch(segment.text);
      const hit = longestSharedRun(needle, hay, LEAK_NGRAM);
      if (hit) {
        leaks.push({ event_id: event.event_id, kind: "segment", at: segment.index, quote: hit });
        return;
      }
    }
    for (const canon of futureEvents) {
      const hay = normalizeForMatch(canon.summary);
      const hit = longestSharedRun(needle, hay, LEAK_NGRAM);
      if (hit) {
        leaks.push({ event_id: event.event_id, kind: "event", at: segmentIndexOf(analysis, canon.segment_id), quote: hit });
        return;
      }
    }
  });

  return leaks;
}

/** 두 문자열이 공유하는 `min`자 이상 연속 구간 중 첫 번째. 없으면 빈 문자열. */
function longestSharedRun(needle, hay, min) {
  if (!needle || !hay) return "";
  for (let start = 0; start + min <= needle.length; start += 1) {
    let end = start + min;
    let found = "";
    while (end <= needle.length && hay.includes(needle.slice(start, end))) {
      found = needle.slice(start, end);
      end += 1;
    }
    if (found) return found;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* 5. 평가 루브릭                                                       */
/* ------------------------------------------------------------------ */

/**
 * 사람이 채점하는 3점 루브릭의 정의. 자동 채점하지 않는다 —
 * 서사 품질은 계약 검사로 판정할 수 없다.
 */
export const BRANCH_RUBRIC = [
  { key: "theme", label: "주제 일관성", question: "원작의 주제·인물 성격과 어긋나지 않는가" },
  { key: "state", label: "상태 정합성", question: "분기 시점의 상태·관계·위치를 지키는가" },
  { key: "structure", label: "구조 완결성", question: "행동 → 결과가 이어지고 도중에 끊기지 않는가" }
];

/** 사람 판단이 필요 없는 부분만 자동 판정한다. */
export function branchIssues(analysis, branch) {
  const issues = [];
  if (!branch.events.length) issues.push({ code: "empty", message: "생성된 사건이 없습니다." });
  if (branch.diagnostics?.canon_leak?.length) {
    issues.push({
      code: "canon_leak",
      message: `분기 이후 원작 내용을 ${branch.diagnostics.canon_leak.length}건 인용했습니다. 분기로 볼 수 없습니다.`
    });
  }
  if (branch.diagnostics?.unknown_characters?.length) {
    issues.push({
      code: "unknown_character",
      message: `분기 시점에 등장하지 않은 인물이 포함되어 제거되었습니다: ${[...new Set(branch.diagnostics.unknown_characters)].join(", ")}`
    });
  }
  if (branch.events.some((event) => !event.characters.length)) {
    issues.push({ code: "no_actor", message: "행위자가 없는 사건이 있습니다." });
  }
  return issues;
}

/* ------------------------------------------------------------------ */

function makeBranchId(analysis, index) {
  const used = new Set((analysis.branches || []).map((branch) => branch.branch_id));
  let n = (analysis.branches?.length || 0) + index + 1;
  let id = `branch_${String(n).padStart(3, "0")}`;
  while (used.has(id)) {
    n += 1;
    id = `branch_${String(n).padStart(3, "0")}`;
  }
  return id;
}

function characterName(analysis, id) {
  return (analysis.characters || []).find((item) => item.character_id === id)?.canonical_name || id;
}

function locationName(analysis, id) {
  return (analysis.locations || []).find((item) => item.location_id === id)?.name || id;
}

function normalizeEventType(value) {
  const allowed = ["appearance", "movement", "conversation", "perception", "conflict", "realization", "stasis", "symbolic", "background"];
  return allowed.includes(value) ? value : "background";
}

function normalizeForMatch(value) {
  return String(value || "").replace(/[\s.,!?"'“”‘’·…\-—()]/gu, "");
}

function cleanText(value, max) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}
