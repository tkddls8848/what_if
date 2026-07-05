"use strict";

/**
 * 장면 단위 파이프라인의 프롬프트·JSON Schema·토큰 예산.
 *
 * 원칙:
 * - 한 호출 = 한 작업 = 한 장면. 스키마는 좁게 유지한다.
 * - structured outputs(JSON Schema를 format으로 전달)로 디코딩을 강제한다.
 * - 프롬프트는 num_ctx의 BUDGET_RATIO 이하가 되도록 구성 시점에 검사한다.
 */

// 프롬프트·스키마가 바뀌면 올린다 (캐시 키에 포함).
const PROMPT_VERSION = "scene-v1";

const NUM_CTX = 8192;
const BUDGET_RATIO = 0.6;

// 허용 관계 화이트리스트 (기존 단발 프롬프트와 동일 계약)
const RELATION_WHITELIST = {
  "character->character": [
    "knows", "family_of", "ally_of", "enemy_of", "protects", "threatens", "depends_on",
    "suspects", "loves", "hides_from", "changes_attitude_to", "speaks_to"
  ],
  "character->event": ["participates_in", "caused", "witnessed", "affected_by", "investigated", "escaped_from"],
  "event->event": ["caused_by", "leads_to", "happens_before", "happens_after", "reveals", "contradicts"],
  "character->location": ["appears_in", "located_at", "came_from", "went_to", "trapped_at", "owns"],
  "event->location": ["takes_place_at"]
};

const CONFIDENCE_ENUM = ["explicit", "inferred", "weak"];

/**
 * 대략적 토큰 추정 (로컬 모델 tokenizer에 따라 다르므로 보수적으로).
 * 한글·CJK ≈ 1.1 토큰/자, 그 외 ≈ 0.35 토큰/자.
 */
function estimateTokens(text) {
  const value = String(text || "");
  let cjk = 0;
  for (const ch of value) {
    if (/[가-힣ㄱ-ㆎ一-鿿]/.test(ch)) cjk += 1;
  }
  const other = value.length - cjk;
  return Math.ceil(cjk * 1.1 + other * 0.35);
}

function promptBudgetTokens(numCtx = NUM_CTX) {
  return Math.floor(numCtx * BUDGET_RATIO);
}

function fitsBudget(promptText, numCtx = NUM_CTX) {
  return estimateTokens(promptText) <= promptBudgetTokens(numCtx);
}

// ── JSON Schema (Ollama structured outputs) ─────────────────────────────────

const ENTITY_ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    evidence: { type: "string" },
    confidence: { type: "number" }
  },
  required: ["name", "evidence"]
};

const SCENE_ENTITIES_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: { ...ENTITY_ITEM_SCHEMA, properties: { ...ENTITY_ITEM_SCHEMA.properties, role: { type: "string" } } }
    },
    locations: {
      type: "array",
      items: { ...ENTITY_ITEM_SCHEMA, properties: { ...ENTITY_ITEM_SCHEMA.properties, type: { type: "string" } } }
    }
  },
  required: ["characters", "locations"]
};

const SCENE_EVENTS_SCHEMA = {
  type: "object",
  properties: {
    event_frames: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["appearance", "movement", "conversation", "perception", "conflict", "realization", "stasis", "symbolic", "background"]
          },
          summary: { type: "string" },
          who: { type: "array", items: { type: "string" } },
          where: { type: "array", items: { type: "string" } },
          what_happened: { type: "string" },
          result: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["type", "summary", "evidence"]
      }
    },
    state_changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string" },
          trigger_event: { type: "string" },
          before: {
            type: "object",
            properties: {
              location: { type: "string" },
              mental_state: { type: "string" },
              physical_state: { type: "string" },
              knowledge: { type: "array", items: { type: "string" } }
            }
          },
          after: {
            type: "object",
            properties: {
              location: { type: "string" },
              mental_state: { type: "string" },
              physical_state: { type: "string" },
              knowledge: { type: "array", items: { type: "string" } }
            }
          },
          evidence: { type: "string" },
          confidence: { type: "string", enum: CONFIDENCE_ENUM }
        },
        required: ["character", "evidence"]
      }
    }
  },
  required: ["event_frames", "state_changes"]
};

const RELATIONS_SCHEMA = {
  type: "object",
  properties: {
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          source_type: { type: "string", enum: ["character", "event", "location"] },
          target: { type: "string" },
          target_type: { type: "string", enum: ["character", "event", "location"] },
          type: { type: "string" },
          label: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "string", enum: CONFIDENCE_ENUM }
        },
        required: ["source", "source_type", "target", "target_type", "type", "evidence"]
      }
    }
  },
  required: ["relationships"]
};

// ── 프롬프트 ─────────────────────────────────────────────────────────────────

function castBlock(cast) {
  if (!cast || !cast.length) return "(아직 확인된 인물 없음)";
  return cast
    .slice(0, 24)
    .map((item) => `- ${item.name}${item.aliases?.length ? ` (별칭: ${item.aliases.slice(0, 4).join(", ")})` : ""}`)
    .join("\n");
}

function sceneEntitiesPrompt({ sceneText, sceneIndex, sceneTotal, cast }) {
  return `너는 한국어 소설의 한 장면에서 인물과 장소만 추출하는 로컬 추출기다. 외부 지식 없이 아래 장면 원문만 근거로 JSON만 반환하라.

이 장면은 전체 ${sceneTotal}개 장면 중 ${sceneIndex}번째다.

지금까지 앞 장면에서 확인된 인물 목록:
${castBlock(cast)}

규칙:
- 이 장면 원문에 실제로 등장하는 인물·장소만 추출한다.
- 위 목록의 인물이 다시 등장하면 반드시 같은 name을 그대로 재사용한다 (새 이름을 만들지 않는다).
- 대명사(그, 그녀, 나)는 위 목록의 인물로 확실히 연결될 때만 해당 인물의 mention으로 취급하고, 불확실하면 무시한다.
- evidence는 이 장면 원문에서 그대로 복사한 짧은 구절이어야 한다 (변형 금지).
- 일반 명사(마음, 모양, 소리 등)를 인물로 만들지 않는다.
- 근거가 없는 항목은 만들지 않는다. 없으면 빈 배열을 반환한다.

장면 원문:
${sceneText}`;
}

function sceneEventsPrompt({ sceneText, sceneIndex, sceneTotal, cast, sceneEntities }) {
  const names = (sceneEntities?.characters || []).map((item) => item.name).slice(0, 16).join(", ") || "(없음)";
  const places = (sceneEntities?.locations || []).map((item) => item.name).slice(0, 12).join(", ") || "(없음)";
  return `너는 한국어 소설의 한 장면에서 사건 프레임과 인물 상태 변화만 추출하는 로컬 추출기다. 외부 지식 없이 아래 장면 원문만 근거로 JSON만 반환하라.

이 장면은 전체 ${sceneTotal}개 장면 중 ${sceneIndex}번째다.

이 장면의 인물: ${names}
이 장면의 장소: ${places}
앞 장면까지 확인된 인물 목록:
${castBlock(cast)}

규칙:
- event_frames: 이 장면에서 실제로 일어난 일을 5W1H로 요약한다. who/where에는 위 인물·장소 이름만 사용한다.
- state_changes: 사건으로 인한 인물의 위치·심리·신체·지식 변화만 기록한다. character는 위 인물 이름만 사용한다.
- evidence는 이 장면 원문에서 그대로 복사한 짧은 구절이어야 한다 (변형 금지).
- 암시된 항목은 confidence를 "inferred" 또는 "weak"으로 낮춘다.
- 근거가 없으면 만들지 않는다. 없으면 빈 배열을 반환한다.

장면 원문:
${sceneText}`;
}

function relationsPrompt({ cast, locations, eventFrames }) {
  const castJson = JSON.stringify(
    (cast || []).slice(0, 24).map((item) => ({ name: item.name, aliases: (item.aliases || []).slice(0, 4) }))
  );
  const locationJson = JSON.stringify((locations || []).slice(0, 20).map((item) => item.name));
  const frameJson = JSON.stringify(
    (eventFrames || []).slice(0, 40).map((frame) => ({
      id: frame.id,
      type: frame.type,
      summary: String(frame.summary || "").slice(0, 80),
      who: frame.who || [],
      where: frame.where || []
    }))
  );
  const allowed = Object.entries(RELATION_WHITELIST)
    .map(([pair, types]) => `- ${pair}: ${types.join(", ")}`)
    .join("\n");

  return `너는 한국어 소설에서 추출된 인물·장소·사건 요약을 보고 노드 간 관계만 판정하는 로컬 추출기다. 아래 목록만 근거로 JSON만 반환하라.

인물 목록: ${castJson}
장소 목록: ${locationJson}
사건 프레임 목록: ${frameJson}

규칙:
- source/target에는 위 목록의 이름 또는 사건 id만 사용한다.
- 관계 type은 아래 허용 스키마 안에서만 만든다.
- evidence에는 근거가 되는 사건 프레임의 summary 또는 id를 적는다.
- 목록에서 확인되지 않는 관계는 만들지 않는다. 암시 수준이면 confidence를 "inferred"나 "weak"으로 낮춘다.

허용 관계 스키마:
${allowed}`;
}

/** 기존 단발 프롬프트 (mode=single 비교용 — server.js에서 이동, 내용 동일). */
function singleShotPrompt(text, morphContext) {
  const clipped = text.slice(0, 22000);
  const contextJson = JSON.stringify(morphContext, null, 2).slice(0, 12000);
  return `너는 로컬에서 실행되는 한국어 소설 지식그래프 추출기다. 외부 API나 외부 지식은 절대 사용하지 말고, 아래 원문과 전처리 컨텍스트만 근거로 JSON만 반환하라.

목표:
1. 작품 안에서 확인되는 인물, 장소, 사건 분류, 감정/신체 상태 seed를 추출한다.
2. 사건을 바로 관계 triple로 만들지 말고 먼저 5W1H 사건 프레임으로 펼친다.
3. 그 사건 프레임과 기존 노드 후보를 기준으로 노드 간 관계를 추출한다.
4. 사건으로 인한 인물 상태 변화를 별도로 추출한다.

중요 규칙:
- 원문 근거가 없는 항목은 만들지 않는다.
- evidence는 원문에서 그대로 찾을 수 있는 짧은 구절이어야 한다.
- 암시된 관계는 버리지 말고 confidence를 "inferred" 또는 "weak"으로 낮춰 표시한다.
- characters, locations, event_frames의 이름을 relationships와 state_changes에서 재사용한다.
- 관계는 아래 허용 스키마 안에서만 만든다.
- JSON 이외의 설명 문장을 출력하지 않는다.

허용 관계 스키마:
- character -> character: knows, family_of, ally_of, enemy_of, protects, threatens, depends_on, suspects, loves, hides_from, changes_attitude_to, speaks_to
- character -> event: participates_in, caused, witnessed, affected_by, investigated, escaped_from
- event -> event: caused_by, leads_to, happens_before, happens_after, reveals, contradicts
- character -> location: appears_in, located_at, came_from, went_to, trapped_at, owns
- event -> location: takes_place_at

반환 형식:
{
  "characters": [
    {"name": "", "aliases": [], "role": "", "description": "", "evidence": "", "confidence": 0.7}
  ],
  "locations": [
    {"name": "", "aliases": [], "type": "inferred", "description": "", "evidence": "", "confidence": 0.7}
  ],
  "event_types": [
    {"type": "movement", "label": "이동", "words": [], "description": ""}
  ],
  "mental_states": [
    {"state": "", "words": [], "description": ""}
  ],
  "physical_states": [
    {"state": "", "words": [], "description": ""}
  ],
  "event_frames": [
    {
      "id": "frame_001",
      "type": "background",
      "label": "배경",
      "summary": "",
      "who": [],
      "where": [],
      "when": "",
      "what_happened": "",
      "why_relevant": "",
      "result": "",
      "evidence": "",
      "confidence": 0.7
    }
  ],
  "relationships": [
    {
      "source": "",
      "source_type": "character",
      "target": "",
      "target_type": "event",
      "type": "participates_in",
      "label": "",
      "evidence": "",
      "confidence": "explicit"
    }
  ],
  "state_changes": [
    {
      "character": "",
      "trigger_event": "",
      "before": {"location": "", "mental_state": "", "physical_state": "", "knowledge": []},
      "after": {"location": "", "mental_state": "", "physical_state": "", "knowledge": []},
      "evidence": "",
      "confidence": "explicit"
    }
  ],
  "events": []
}

전처리 컨텍스트:
${contextJson}

원문:
${clipped}`;
}

function isAllowedRelation(sourceType, targetType, type) {
  const key = `${sourceType}->${targetType}`;
  return Boolean(RELATION_WHITELIST[key]?.includes(type));
}

module.exports = {
  PROMPT_VERSION,
  NUM_CTX,
  BUDGET_RATIO,
  CONFIDENCE_ENUM,
  RELATION_WHITELIST,
  SCENE_ENTITIES_SCHEMA,
  SCENE_EVENTS_SCHEMA,
  RELATIONS_SCHEMA,
  estimateTokens,
  promptBudgetTokens,
  fitsBudget,
  sceneEntitiesPrompt,
  sceneEventsPrompt,
  relationsPrompt,
  singleShotPrompt,
  isAllowedRelation
};
