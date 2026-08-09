/**
 * @module core/audit
 *
 * 추출 결과의 제약 위반 점검(constraint auditing).
 *
 * 출처: Narrative Knowledge Weaver(arXiv 2606.05724)가 장문 서사 QA에서 검색 결과를
 * actor / scope / polarity / state / temporal 다섯 축으로 감사한다. 같은 다섯 축을
 * 이 앱의 데이터 계약 위에서 **기계적으로 검사 가능한 규칙**으로 좁혀 구현한다.
 *
 * 원칙:
 * - 이 모듈은 아무것도 고치지 않는다. 판정만 하고 `/check` 화면과 진단에 노출한다.
 *   자동 확정 금지 원칙과 같은 이유로, 자동 수정도 하지 않는다.
 * - `error`는 데이터 계약 위반(근거가 실제로 어긋남), `warn`은 휴리스틱 의심이다.
 *   warn을 error로 승격하지 말 것 — 한국어 부정문 판정은 확정적이지 않다.
 *
 * BOUNDARY NOTE: DOM·전역 상태 의존 없음. `core/asof.js`에만 의존한다.
 */
import { STATUS } from "../config.js";
import { intervalOf, segmentIndexOf } from "./asof.js";

/** 부정 종결·부정 보조용언. 한국어 부정은 문말에 오므로 span 내부 검사로 충분하지 않을 수 있다. */
const NEGATION_RE = /(지\s*않|지\s*못하|지\s*아니|하지\s*마|없었|없다|없으|없이|아니었|아니다|아닌|못했|못한|안\s)/u;
/** 부정문에서 추출되면 의심스러운 "실제로 일어난 행동" 유형. */
const POSITIVE_ACTION_TYPES = new Set(["movement", "conversation", "conflict", "appearance"]);

const ACTIVE = (item) => item?.status !== STATUS.REJECTED;

export function auditAnalysis(analysis) {
  if (!analysis?.segments?.length) return { counts: emptyCounts(), violations: [] };

  const violations = [
    ...auditActor(analysis),
    ...auditScope(analysis),
    ...auditPolarity(analysis),
    ...auditState(analysis),
    ...auditTemporal(analysis)
  ].sort((a, b) => a.segment_index - b.segment_index || a.code.localeCompare(b.code));

  return { counts: countBy(violations), violations };
}

/** 특정 대상에 걸린 위반만 뽑는다. 검수 화면의 배지에 쓴다. */
export function violationsFor(audit, targetType, targetId) {
  return (audit?.violations || []).filter(
    (violation) => violation.target_type === targetType && violation.target_id === targetId
  );
}

/* ------------------------------------------------------------------ */
/* actor — 사건 참여 인물이 그 단락에 실제로 언급되었는가                 */
/* ------------------------------------------------------------------ */

function auditActor(analysis) {
  const mentionKeys = new Set(
    (analysis.mentions || [])
      .filter((mention) => mention.entity_type === "character" && ACTIVE(mention))
      .map((mention) => `${mention.segment_id}::${mention.entity_id}`)
  );
  const nameOf = characterNameLookup(analysis);

  return (analysis.events || [])
    .filter(ACTIVE)
    .flatMap((event) => {
      const missing = (event.characters || []).filter(
        (characterId) => !mentionKeys.has(`${event.segment_id}::${characterId}`)
      );
      if (!missing.length) return [];
      return [violation({
        code: "actor",
        severity: "error",
        target_type: "event",
        target_id: event.event_id,
        segment_index: segmentIndexOf(analysis, event.segment_id),
        message: `참여 인물 ${missing.map(nameOf).join(", ")}의 언급이 이 단락에 없습니다.`
      })];
    });
}

/* ------------------------------------------------------------------ */
/* scope — 근거 offset이 자기 단락 범위 안에 있는가                       */
/* ------------------------------------------------------------------ */

function auditScope(analysis) {
  const segmentById = new Map((analysis.segments || []).map((segment) => [segment.segment_id, segment]));
  const out = [];

  (analysis.events || []).filter(ACTIVE).forEach((event) => {
    const segment = segmentById.get(event.segment_id);
    if (!segment) {
      out.push(violation({
        code: "scope",
        severity: "error",
        target_type: "event",
        target_id: event.event_id,
        segment_index: 0,
        message: "사건이 존재하지 않는 단락을 참조합니다."
      }));
      return;
    }
    const span = event.source_span;
    if (!span || !Number.isFinite(span.char_start) || !Number.isFinite(span.char_end)) {
      out.push(violation({
        code: "scope",
        severity: "error",
        target_type: "event",
        target_id: event.event_id,
        segment_index: segment.index,
        message: "사건에 원문 근거 범위가 없습니다."
      }));
      return;
    }
    if (span.char_start < segment.char_start || span.char_end > segment.char_end || span.char_start > span.char_end) {
      out.push(violation({
        code: "scope",
        severity: "error",
        target_type: "event",
        target_id: event.event_id,
        segment_index: segment.index,
        message: `근거 범위(${span.char_start}~${span.char_end})가 단락 범위(${segment.char_start}~${segment.char_end}) 밖입니다.`
      }));
    }
  });

  (analysis.mentions || []).filter(ACTIVE).forEach((mention) => {
    const segment = segmentById.get(mention.segment_id);
    if (!segment) return;
    if (mention.char_start < segment.char_start || mention.char_end > segment.char_end) {
      out.push(violation({
        code: "scope",
        severity: "error",
        target_type: "mention",
        target_id: mention.mention_id,
        segment_index: segment.index,
        message: `언급 범위가 단락 밖을 가리킵니다: ${mention.text}`
      }));
    }
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* polarity — 부정문에서 "일어난 사건"을 뽑지 않았는가                    */
/* ------------------------------------------------------------------ */

function auditPolarity(analysis) {
  const segmentById = new Map((analysis.segments || []).map((segment) => [segment.segment_id, segment]));

  return (analysis.events || [])
    .filter(ACTIVE)
    .filter((event) => POSITIVE_ACTION_TYPES.has(event.type))
    .flatMap((event) => {
      const text = spanText(segmentById.get(event.segment_id), event.source_span);
      if (!text || !NEGATION_RE.test(text)) return [];
      return [violation({
        code: "polarity",
        severity: "warn",
        target_type: "event",
        target_id: event.event_id,
        segment_index: segmentIndexOf(analysis, event.segment_id),
        message: "부정 표현이 있는 문장에서 실제 행동 사건을 추출했습니다. 반대 의미인지 확인이 필요합니다."
      })];
    });
}

/* ------------------------------------------------------------------ */
/* state — 같은 시점에 모순된 상태가 있는가                              */
/* ------------------------------------------------------------------ */

function auditState(analysis) {
  const out = [];
  const seen = new Map();
  const locationById = new Map((analysis.locations || []).map((location) => [location.location_id, location]));
  const nameOf = characterNameLookup(analysis);

  (analysis.states || []).filter(ACTIVE).forEach((state) => {
    const key = `${state.character_id}::${state.segment_id}`;
    const previous = seen.get(key);
    if (previous && (previous.mental_state !== state.mental_state || previous.location_id !== state.location_id)) {
      out.push(violation({
        code: "state",
        severity: "error",
        target_type: "state",
        target_id: state.state_id,
        segment_index: segmentIndexOf(analysis, state.segment_id),
        message: `${nameOf(state.character_id)}의 상태가 같은 단락에서 서로 다르게 기록되었습니다.`
      }));
    }
    seen.set(key, state);

    if (!state.location_id) return;
    const location = locationById.get(state.location_id);
    const stateIndex = segmentIndexOf(analysis, state.segment_id);
    if (!location) {
      out.push(violation({
        code: "state",
        severity: "error",
        target_type: "state",
        target_id: state.state_id,
        segment_index: stateIndex,
        message: "존재하지 않는 장소를 현재 위치로 가리킵니다."
      }));
      return;
    }
    const { valid_from } = intervalOf(location);
    if (valid_from >= 1 && stateIndex >= 1 && valid_from > stateIndex) {
      out.push(violation({
        code: "state",
        severity: "error",
        target_type: "state",
        target_id: state.state_id,
        segment_index: stateIndex,
        message: `아직 등장하지 않은 장소(${location.name})를 현재 위치로 가리킵니다.`
      }));
    }
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* temporal — 구간이 시간 순서를 지키는가                                */
/* ------------------------------------------------------------------ */

function auditTemporal(analysis) {
  const out = [];
  const characterById = new Map((analysis.characters || []).map((character) => [character.character_id, character]));
  const nameOf = characterNameLookup(analysis);

  const byCharacter = new Map();
  (analysis.states || []).filter(ACTIVE).forEach((state) => {
    const list = byCharacter.get(state.character_id) || [];
    list.push(state);
    byCharacter.set(state.character_id, list);
  });

  byCharacter.forEach((list, characterId) => {
    const character = characterById.get(characterId);
    const ordered = list
      .map((state) => ({ state, interval: intervalOf(state) }))
      .sort((a, b) => a.interval.valid_from - b.interval.valid_from);

    ordered.forEach((entry, position) => {
      const { valid_from, valid_to } = entry.interval;
      if (valid_to !== null && valid_to < valid_from) {
        out.push(violation({
          code: "temporal",
          severity: "error",
          target_type: "state",
          target_id: entry.state.state_id,
          segment_index: valid_from,
          message: `상태 구간이 뒤집혔습니다(${valid_from}~${valid_to}).`
        }));
      }
      const next = ordered[position + 1];
      if (next && valid_to !== null && next.interval.valid_from <= valid_to) {
        out.push(violation({
          code: "temporal",
          severity: "error",
          target_type: "state",
          target_id: entry.state.state_id,
          segment_index: valid_from,
          message: `${nameOf(characterId)}의 상태 구간이 다음 구간과 겹칩니다.`
        }));
      }
      const characterFrom = character ? intervalOf(character).valid_from : 0;
      if (characterFrom >= 1 && valid_from >= 1 && valid_from < characterFrom) {
        out.push(violation({
          code: "temporal",
          severity: "error",
          target_type: "state",
          target_id: entry.state.state_id,
          segment_index: valid_from,
          message: `${nameOf(characterId)}의 첫 등장(${characterFrom})보다 앞선 상태입니다.`
        }));
      }
    });
  });

  (analysis.relations || []).filter(ACTIVE).forEach((relation) => {
    const { valid_from, valid_to } = intervalOf(relation);
    if (valid_to !== null && valid_from >= 1 && valid_to < valid_from) {
      out.push(violation({
        code: "temporal",
        severity: "error",
        target_type: "relation",
        target_id: relation.relation_id,
        segment_index: valid_from,
        message: `관계 구간이 뒤집혔습니다(${valid_from}~${valid_to}).`
      }));
    }
  });

  return out;
}

/* ------------------------------------------------------------------ */

function characterNameLookup(analysis) {
  const byId = new Map((analysis.characters || []).map((character) => [character.character_id, character.canonical_name]));
  return (characterId) => byId.get(characterId) || characterId;
}

function spanText(segment, span) {
  if (!segment || !span) return "";
  const start = Math.max(0, span.char_start - segment.char_start);
  const end = Math.min(segment.text.length, span.char_end - segment.char_start);
  if (end <= start) return "";
  return segment.text.slice(start, end);
}

function violation(input) {
  return {
    code: input.code,
    severity: input.severity,
    target_type: input.target_type,
    target_id: input.target_id,
    segment_index: Number(input.segment_index) || 0,
    message: input.message
  };
}

function emptyCounts() {
  return { total: 0, error: 0, warn: 0, actor: 0, scope: 0, polarity: 0, state: 0, temporal: 0 };
}

function countBy(violations) {
  const counts = emptyCounts();
  violations.forEach((item) => {
    counts.total += 1;
    counts[item.severity] += 1;
    counts[item.code] += 1;
  });
  return counts;
}
