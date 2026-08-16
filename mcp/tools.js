/**
 * @module mcp/tools
 *
 * MCP 도구의 순수 구현. 전송 계층(stdio·JSON-RPC)과 분리되어 있어 노드 테스트에서
 * 그대로 호출할 수 있다. `mcp/server.js`는 이 함수들을 감싸기만 한다.
 *
 * 계약 (테스트로 강제):
 * 1. 사실을 돌려주는 도구는 `as_of`가 없으면 거부한다. 기본값으로 문서 전체를
 *    주지 않는다 — 기본값이 곧 스포일러다.
 * 2. 모든 사실에는 원문 근거(`evidence`)와 `confidence`·`status`가 붙는다.
 *    근거를 만들 수 없는 항목은 응답에서 제거한다.
 * 3. 쓰기 도구는 없다. 검수·수정은 웹 화면에서만 한다.
 *
 * BOUNDARY NOTE — 어댑터 전용: 시점 판정은 `core/asof.js`, 근거 되짚기는
 * `core/evidence.js`가 한다. 여기서 다시 구현하지 않는다.
 */
import { asOf, currentStateOf, isKnownAt, lastSegmentIndex, resolveTime, segmentIndexOf } from "../src/core/asof.js";
import { evidenceOf, findFact } from "../src/core/evidence.js";
import { branchSeed, forkCandidates } from "../src/core/whatif.js";
import { isRedistributable } from "./library.js";

export class ToolError extends Error {}

function requireAsOf(analysis, value) {
  if (value === undefined || value === null || value === "") {
    throw new ToolError("as_of(현재 독서 위치, segment 번호)가 필요합니다. 지정하지 않으면 아직 읽지 않은 내용이 노출됩니다.");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    throw new ToolError(`as_of는 1 이상의 segment 번호여야 합니다. 받은 값: ${value}`);
  }
  return resolveTime(analysis, number, true);
}

function requireDocument(library, documentId) {
  const entry = library.get(documentId);
  if (!entry) {
    const known = library.documents().map((item) => item.document_id).join(", ") || "(없음)";
    throw new ToolError(`document_id '${documentId}'를 찾을 수 없습니다. 사용 가능한 작품: ${known}`);
  }
  return entry;
}

/** 사실 하나를 근거와 함께 포장한다. 근거가 없으면 null → 호출부가 버린다. */
function withEvidence(analysis, fact, factType, extra = {}) {
  const evidence = evidenceOf(analysis, fact, factType);
  if (!evidence) return null;
  return {
    ...extra,
    status: fact.status,
    confidence: fact.confidence ?? null,
    method: fact.method || "",
    evidence
  };
}

/* ------------------------------------------------------------------ */

export function listWorks(library) {
  return {
    library_dir: library.dir,
    works: library.documents().map((meta) => {
      const entry = library.get(meta.document_id);
      return {
        document_id: meta.document_id,
        title: meta.title,
        author: meta.author,
        year: meta.year,
        rights: meta.rights,
        source_url: meta.source_url,
        redistributable: isRedistributable(meta),
        segments: entry ? lastSegmentIndex(entry.analysis) : 0,
        characters: entry ? entry.analysis.characters.length : 0
      };
    })
  };
}

export function stateAsOf(library, { document_id, character, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const target = findCharacter(analysis, character, at);

  const state = currentStateOf(analysis, target.character_id, at);
  const locations = analysis.locations;
  const location = state?.location_id ? locations.find((item) => item.location_id === state.location_id) : null;

  return {
    document_id,
    as_of: at,
    character: target.canonical_name,
    known: state
      ? {
          mental_state: state.mental_state,
          physical_state: state.physical_state,
          location: location && isKnownAt(location, at) ? location.name : "",
          known_facts: state.known_facts || [],
          valid_from: state.valid_from,
          valid_to: state.valid_to,
          ...withEvidence(analysis, state, "state")
        }
      : null,
    note: state ? "" : `${target.canonical_name}에 대해 ${at}번 단락까지 기록된 상태가 없습니다.`
  };
}

export function whoIs(library, { document_id, name, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const target = findCharacter(analysis, name, at);

  const relations = analysis.relations
    .filter((relation) => isKnownAt(relation, at))
    .filter((relation) =>
      (relation.source_type === "character" && relation.source_id === target.character_id) ||
      (relation.target_type === "character" && relation.target_id === target.character_id))
    .map((relation) => withEvidence(analysis, relation, "relation", {
      relation_type: relation.relation_type,
      source: labelOf(analysis, relation.source_type, relation.source_id),
      target: labelOf(analysis, relation.target_type, relation.target_id),
      weight: relation.weight,
      valid_from: relation.valid_from
    }))
    .filter(Boolean);

  return {
    document_id,
    as_of: at,
    character: {
      canonical_name: target.canonical_name,
      aliases: target.aliases || [],
      role: target.role || "",
      description: target.description || "",
      first_seen_segment: target.valid_from,
      ...withEvidence(analysis, target, "character")
    },
    relations
  };
}

export function timelineAsOf(library, { document_id, as_of, event_type }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const scoped = asOf(analysis, at);

  const events = scoped.events
    .filter((event) => !event_type || event_type === "all" || event.type === event_type)
    .sort((a, b) => segmentIndexOf(analysis, a.segment_id) - segmentIndexOf(analysis, b.segment_id) ||
      (a.sentence_index || 0) - (b.sentence_index || 0))
    .map((event) => withEvidence(analysis, event, "event", {
      event_id: event.event_id,
      segment: segmentIndexOf(analysis, event.segment_id),
      type: event.type,
      summary: event.summary,
      characters: event.characters.map((id) => labelOf(analysis, "character", id)),
      locations: event.locations.map((id) => labelOf(analysis, "location", id))
    }))
    .filter(Boolean);

  return { document_id, as_of: at, count: events.length, events };
}

export function graphAsOf(library, { document_id, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const scoped = asOf(analysis, at);

  return {
    document_id,
    as_of: at,
    nodes: [
      ...scoped.characters.map((item) => ({ id: `character:${item.character_id}`, type: "character", label: item.canonical_name, status: item.status })),
      ...scoped.locations.map((item) => ({ id: `location:${item.location_id}`, type: "location", label: item.name, status: item.status })),
      ...scoped.events.map((item) => ({ id: `event:${item.event_id}`, type: "event", label: item.summary, status: item.status }))
    ],
    edges: scoped.relations.map((relation) => ({
      id: relation.relation_id,
      source: `${relation.source_type}:${relation.source_id}`,
      target: `${relation.target_type}:${relation.target_id}`,
      type: relation.relation_type,
      weight: relation.weight,
      valid_from: relation.valid_from,
      valid_to: relation.valid_to
    }))
  };
}

/**
 * 시점까지 읽은 범위의 시대 주석.
 *
 * 이 도구는 **링크만** 돌려준다. 역사 서술을 지어내지 않는 것이 계약이다 — `note`는
 * 사람이 검수에서 채운 것만 담기고, 비어 있으면 비어 있는 채로 나간다. 에이전트가
 * 맥락을 설명하고 싶으면 링크를 직접 읽어야 한다.
 */
export function annotationsAsOf(library, { document_id, as_of, category }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const scoped = asOf(analysis, at);

  const annotations = scoped.annotations
    .filter((item) => !category || category === "all" || item.category === category)
    .sort((a, b) => segmentIndexOf(analysis, a.segment_id) - segmentIndexOf(analysis, b.segment_id))
    .map((item) => withEvidence(analysis, item, "annotation", {
      annotation_id: item.annotation_id,
      segment: segmentIndexOf(analysis, item.segment_id),
      term: item.term,
      category: item.category,
      era: item.era,
      note: item.note || "",
      references: item.references
    }))
    .filter(Boolean);

  return { document_id, as_of: at, count: annotations.length, annotations };
}

export function evidenceForFact(library, { document_id, fact_id, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const scoped = asOf(analysis, at);
  const found = findFact(scoped, fact_id);
  if (!found) throw new ToolError(`fact_id '${fact_id}'를 찾을 수 없습니다.`);

  const packed = withEvidence(scoped, found.fact, found.fact_type, { fact_id, fact_type: found.fact_type });
  if (!packed) throw new ToolError(`fact_id '${fact_id}'에 연결된 원문 근거가 없습니다.`);

  const audit = (scoped.audit?.violations || [])
    .filter((violation) => violation.target_id === fact_id)
    .map((violation) => ({ code: violation.code, severity: violation.severity, message: violation.message }));

  return { document_id, as_of: at, ...packed, audit };
}

export function arcSummary(library, { document_id, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  const scoped = asOf(analysis, at);

  const eventTypes = {};
  scoped.events.forEach((event) => { eventTypes[event.type] = (eventTypes[event.type] || 0) + 1; });

  const characters = scoped.characters.map((character) => {
    const state = currentStateOf(analysis, character.character_id, at);
    const transitions = analysis.states
      .filter((item) => item.character_id === character.character_id && isKnownAt(item, at))
      .length;
    return {
      name: character.canonical_name,
      first_seen_segment: character.valid_from,
      state_records: transitions,
      current_mental_state: state?.mental_state || "",
      current_physical_state: state?.physical_state || ""
    };
  });

  return {
    document_id,
    as_of: at,
    progress: { segment: at, of: lastSegmentIndex(analysis) },
    event_type_counts: eventTypes,
    characters,
    audit: scoped.audit.counts,
    note: "이 요약은 추출된 사실의 집계다. 원문을 재서술하거나 생성하지 않는다."
  };
}

/**
 * 분기 시드. 반환값에는 `as_of` 이후의 어떤 내용도 들어가지 않으므로, 이 결과만으로
 * 반사실 전개를 쓰면 원작 결말을 베낄 재료가 없다.
 */
export function whatifSeed(library, { document_id, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  return {
    document_id,
    fork_segment: at,
    candidates: forkCandidates(analysis, { limit: 8, before: at }),
    seed: branchSeed(analysis, at),
    note: "이 시드에는 분기 시점 이후의 원문·사건이 없습니다. 이후 전개를 알고 있더라도 쓰지 마세요."
  };
}

export function readSegment(library, { document_id, segment }) {
  const { meta, analysis } = requireDocument(library, document_id);
  if (!isRedistributable(meta)) {
    throw new ToolError(`'${meta.title}'의 권리 표기가 '${meta.rights}'이므로 원문 단락을 제공하지 않습니다. 사실 조회 도구의 근거 인용은 사용할 수 있습니다.`);
  }
  const index = Number(segment);
  const found = analysis.segments.find((item) => item.index === index);
  if (!found) throw new ToolError(`segment ${segment}이(가) 없습니다. 범위: 1~${lastSegmentIndex(analysis)}`);
  return { document_id, segment: index, text: found.text };
}

export function readAnalysis(library, { document_id, as_of }) {
  const { analysis } = requireDocument(library, document_id);
  const at = requireAsOf(analysis, as_of);
  return asOf(analysis, at);
}

/* ------------------------------------------------------------------ */

function findCharacter(analysis, name, at) {
  const needle = normalize(name);
  if (!needle) throw new ToolError("인물 이름이 필요합니다.");

  const candidates = analysis.characters.filter((character) => isKnownAt(character, at));
  const match = candidates.find((character) =>
    normalize(character.canonical_name) === needle ||
    (character.aliases || []).some((alias) => normalize(alias) === needle)) ||
    candidates.find((character) => normalize(character.canonical_name).includes(needle));

  if (match) return match;

  const later = analysis.characters.find((character) =>
    normalize(character.canonical_name) === needle ||
    (character.aliases || []).some((alias) => normalize(alias) === needle));
  if (later) {
    throw new ToolError(`'${name}'은(는) ${at}번 단락까지 아직 등장하지 않았습니다. 이 시점에서는 답할 수 없습니다.`);
  }
  throw new ToolError(`'${name}'을(를) 찾을 수 없습니다. ${at}번 단락까지 등장한 인물: ${candidates.map((item) => item.canonical_name).join(", ") || "(없음)"}`);
}

function labelOf(analysis, type, id) {
  if (type === "character") return analysis.characters.find((item) => item.character_id === id)?.canonical_name || id;
  if (type === "location") return analysis.locations.find((item) => item.location_id === id)?.name || id;
  if (type === "event") return analysis.events.find((item) => item.event_id === id)?.summary || id;
  return id;
}

function normalize(value) {
  return String(value || "").replace(/\s+/gu, "").trim().toLowerCase();
}
