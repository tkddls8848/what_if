import assert from "node:assert/strict";
import test from "node:test";

import pipelinePkg from "../src/server/pipeline.js";
import promptsPkg from "../src/server/prompts.js";

const {
  splitScenes,
  splitLongText,
  verifyEvidence,
  EntityMerger,
  runScenePipeline,
  runSinglePipeline
} = pipelinePkg;
const { estimateTokens, fitsBudget, isAllowedRelation, PROMPT_VERSION } = promptsPkg;

const MINI_NOVEL = `복녀는 가난한 집에서 자랐다. 복녀는 남편을 따라 칠성문 밖 빈민굴로 왔다.

남편은 게을렀다. 복녀는 빈민굴에서 일을 찾아 나섰다.

왕 서방이 복녀를 불렀다. 복녀는 왕 서방의 밭으로 갔다.`;

// ── 장면 분할 ────────────────────────────────────────────────────────────────

test("splitScenes: 문단을 목표 길이로 묶고 segment 인덱스를 보존한다", () => {
  const scenes = splitScenes(MINI_NOVEL, { targetChars: 60 });
  assert.ok(scenes.length >= 2);
  assert.equal(scenes[0].index, 1);
  const allSegments = scenes.flatMap((scene) => scene.segment_indexes);
  assert.deepEqual(allSegments, [1, 2, 3]);
  for (const scene of scenes) {
    assert.ok(scene.text.length > 0);
  }
});

test("splitScenes: 아주 긴 단일 문단도 분할된다", () => {
  const longParagraph = "그는 걸었다. ".repeat(500);
  const scenes = splitScenes(longParagraph, { targetChars: 300 });
  assert.ok(scenes.length > 1);
  for (const scene of scenes) {
    assert.ok(scene.text.length <= 300 * 2 * 1.5 + 10);
  }
});

test("splitLongText: 문장 경계에서 자른다", () => {
  const text = "첫 문장이다. 둘째 문장이다. 셋째 문장이다.";
  const chunks = splitLongText(text, 15);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].includes("첫 문장"));
});

// ── 토큰 예산 ────────────────────────────────────────────────────────────────

test("estimateTokens: 한국어를 보수적으로 추정한다", () => {
  assert.ok(estimateTokens("가나다라마") >= 5);
  assert.ok(estimateTokens("abcde") <= 3);
});

test("fitsBudget: num_ctx의 60%를 초과하면 거부한다", () => {
  assert.equal(fitsBudget("짧은 프롬프트", 8192), true);
  const huge = "가".repeat(10000);
  assert.equal(fitsBudget(huge, 8192), false);
});

// ── evidence 검증·병합 ───────────────────────────────────────────────────────

test("verifyEvidence: 원문 인용은 통과, 변형·외부 인용은 거부", () => {
  const scene = "복녀는 남편을 따라 칠성문 밖 빈민굴로 왔다.";
  assert.equal(verifyEvidence("칠성문 밖 빈민굴", scene), true);
  assert.equal(verifyEvidence("복녀는  남편을", scene), true); // 공백 차이는 허용
  assert.equal(verifyEvidence("복녀가 서울로 갔다", scene), false);
  assert.equal(verifyEvidence("", scene), false);
});

test("EntityMerger: 이름 정규화 병합·별칭 누적·합의 confidence 상향", () => {
  const merger = new EntityMerger();
  merger.add({ name: "복녀", aliases: ["복녀는"], confidence: 0.6, evidence: "복녀는" }, 1);
  merger.add({ name: "복 녀", aliases: ["그녀"], confidence: 0.7, description: "가난한 집 딸" }, 2);
  merger.add({ name: "왕 서방", confidence: 0.5, evidence: "왕 서방이" }, 2);

  const merged = merger.finalize(new Set(["왕 서방"]));
  const boknyeo = merged.find((item) => item.name === "복녀");
  assert.ok(boknyeo);
  assert.equal(boknyeo.scene_count, 2);
  assert.equal(boknyeo.agreement, true); // 2개 장면 등장
  assert.ok(boknyeo.confidence > 0.7); // max(0.6,0.7)+0.1
  assert.ok(boknyeo.aliases.includes("그녀"));

  const wang = merged.find((item) => item.name === "왕 서방");
  assert.equal(wang.agreement, true); // 규칙 채널 합의
  assert.ok(wang.confidence > 0.5);
});

test("isAllowedRelation: 화이트리스트 밖 관계를 거부한다", () => {
  assert.equal(isAllowedRelation("character", "character", "loves"), true);
  assert.equal(isAllowedRelation("character", "event", "participates_in"), true);
  assert.equal(isAllowedRelation("character", "character", "teleports_to"), false);
  assert.equal(isAllowedRelation("location", "character", "owns"), false);
});

// ── 파이프라인 실행 (scripted fake client) ───────────────────────────────────

function scriptedClient(handler) {
  let calls = 0;
  return {
    async generateJson(args) {
      const index = calls;
      calls += 1;
      return handler(args, index);
    },
    get calls() { return calls; }
  };
}

function entitiesFor(sceneText) {
  const characters = [];
  if (sceneText.includes("복녀")) characters.push({ name: "복녀", aliases: [], role: "주인공", evidence: "복녀는", confidence: 0.8 });
  if (sceneText.includes("남편")) characters.push({ name: "남편", aliases: [], role: "", evidence: "남편", confidence: 0.7 });
  if (sceneText.includes("왕 서방")) characters.push({ name: "왕 서방", aliases: [], role: "", evidence: "왕 서방이", confidence: 0.7 });
  const locations = [];
  if (sceneText.includes("빈민굴")) locations.push({ name: "빈민굴", aliases: [], type: "slum", evidence: "빈민굴", confidence: 0.8 });
  return { characters, locations };
}

test("runScenePipeline: 장면별 추출을 병합하고 진단을 남긴다", async () => {
  const progress = [];
  const client = scriptedClient((args) => {
    const isEntities = args.prompt.includes("인물과 장소만 추출");
    const isEvents = args.prompt.includes("사건 프레임과 인물 상태 변화만");
    const isRelations = args.prompt.includes("노드 간 관계만 판정");
    if (isEntities) {
      const sceneText = args.prompt.split("장면 원문:\n")[1];
      return { ok: true, data: entitiesFor(sceneText), prompt_eval_count: 500, eval_count: 60 };
    }
    if (isEvents) {
      const sceneText = args.prompt.split("장면 원문:\n")[1];
      const frames = [];
      const changes = [];
      if (sceneText.includes("빈민굴로 왔다")) {
        frames.push({ type: "movement", summary: "복녀가 빈민굴로 이주", who: ["복녀", "남편"], where: ["빈민굴"], evidence: "빈민굴로 왔다", confidence: 0.8 });
        changes.push({
          character: "복녀",
          trigger_event: "이주",
          before: { location: "고향", mental_state: "평온" },
          after: { location: "빈민굴", mental_state: "불안" },
          evidence: "빈민굴로 왔다",
          confidence: "explicit"
        });
      }
      return { ok: true, data: { event_frames: frames, state_changes: changes }, prompt_eval_count: 400, eval_count: 40 };
    }
    if (isRelations) {
      return {
        ok: true,
        data: {
          relationships: [
            { source: "복녀", source_type: "character", target: "남편", target_type: "character", type: "family_of", evidence: "frame_001", confidence: "explicit" },
            { source: "복녀", source_type: "character", target: "달나라", target_type: "location", type: "flies_to", evidence: "x", confidence: "weak" }
          ]
        },
        prompt_eval_count: 300,
        eval_count: 30
      };
    }
    throw new Error(`unexpected prompt: ${args.prompt.slice(0, 60)}`);
  });

  const result = await runScenePipeline({
    text: MINI_NOVEL,
    model: "qwen3.5:4b",
    client,
    targetChars: 60,
    onProgress: (p) => progress.push(p)
  });

  assert.ok(result.payload, JSON.stringify(result.error || {}));
  const names = result.payload.characters.map((item) => item.name);
  assert.ok(names.includes("복녀"));
  assert.ok(names.includes("남편"));
  assert.ok(result.payload.locations.some((item) => item.name === "빈민굴"));

  // 상태 변화가 장면 segment에 앵커된다
  const change = result.payload.state_changes[0];
  assert.equal(change.character, "복녀");
  assert.ok(Array.isArray(change.segment_indexes) && change.segment_indexes.length > 0);
  assert.equal(change.after.location, "빈민굴");

  // 상태 사전 seed가 상태 변화에서 역추출된다
  const mentalStates = result.payload.mental_states.map((item) => item.state);
  assert.ok(mentalStates.includes("불안"));

  // 관계: 화이트리스트 밖(type=flies_to)은 걸러진다
  assert.equal(result.payload.relationships.length, 1);
  assert.equal(result.payload.relationships[0].type, "family_of");

  // 진단
  assert.equal(result.diagnostics.mode, "scene");
  assert.equal(result.diagnostics.prompt_version, PROMPT_VERSION);
  assert.ok(result.diagnostics.scenes_total >= 2);
  assert.equal(result.diagnostics.scenes_failed.length, 0);
  assert.ok(result.diagnostics.prompt_eval_total > 0);
  assert.ok(progress.some((p) => p.stage === "scene"));
  assert.ok(progress.some((p) => p.stage === "relations"));
});

test("runScenePipeline: 원문에 없는 evidence는 confidence가 강등된다", async () => {
  const client = scriptedClient((args) => {
    if (args.prompt.includes("인물과 장소만 추출")) {
      return {
        ok: true,
        data: {
          characters: [{ name: "복녀", evidence: "완전히 지어낸 인용문입니다", confidence: 0.9 }],
          locations: []
        }
      };
    }
    return { ok: true, data: { event_frames: [], state_changes: [] } };
  });
  const result = await runScenePipeline({ text: MINI_NOVEL, model: "m4b", client, targetChars: 8000 });
  assert.ok(result.payload);
  assert.ok(result.diagnostics.evidence_demoted > 0);
  // 0.9에서 강등(-0.25) 후 합의(+0.1) — 원래 0.9보다 낮아야 한다
  assert.ok(result.payload.characters[0].confidence < 0.9);
});

test("runScenePipeline: 일부 장면 실패는 전체 실패가 아니다", async () => {
  let entityCalls = 0;
  const client = scriptedClient((args) => {
    if (args.prompt.includes("인물과 장소만 추출")) {
      entityCalls += 1;
      // 두 번째 장면은 재시도(1회)까지 연속 실패시킨다
      if (entityCalls === 2 || entityCalls === 3) {
        return { ok: false, error_code: "PARSE_FAILED", message: "parse", retryable: true };
      }
      const sceneText = args.prompt.split("장면 원문:\n")[1];
      return { ok: true, data: entitiesFor(sceneText) };
    }
    if (args.prompt.includes("사건 프레임")) {
      return { ok: true, data: { event_frames: [], state_changes: [] } };
    }
    return { ok: true, data: { relationships: [] } };
  });

  const result = await runScenePipeline({ text: MINI_NOVEL, model: "m4b", client, targetChars: 60 });
  assert.ok(result.payload);
  assert.ok(result.diagnostics.scenes_failed.length >= 1);
  assert.equal(result.diagnostics.scenes_failed[0].error_code, "PARSE_FAILED");
  assert.ok(result.payload.characters.length > 0);
});

test("runScenePipeline: 첫 장면부터 연결 실패면 구조화 오류를 반환한다", async () => {
  const client = scriptedClient(() => ({
    ok: false,
    error_code: "CONNECTION_FAILED",
    message: "Ollama에 연결할 수 없습니다",
    retryable: true
  }));
  const result = await runScenePipeline({ text: MINI_NOVEL, model: "m4b", client, targetChars: 60 });
  assert.ok(result.error);
  assert.equal(result.error.error_code, "CONNECTION_FAILED");
});

test("runScenePipeline: PARSE_FAILED는 1회 재시도한다", async () => {
  let attempts = 0;
  const client = scriptedClient((args) => {
    if (args.prompt.includes("인물과 장소만 추출")) {
      attempts += 1;
      if (attempts === 1) return { ok: false, error_code: "PARSE_FAILED", message: "p", retryable: true };
      return { ok: true, data: entitiesFor(args.prompt) };
    }
    return { ok: true, data: { event_frames: [], state_changes: [] } };
  });
  const result = await runScenePipeline({ text: "복녀는 남편과 걸었다.", model: "m4b", client, targetChars: 8000 });
  assert.ok(result.payload);
  assert.ok(attempts >= 2);
  assert.equal(result.diagnostics.scenes_failed.length, 0);
});

// ── 단발 모드 (legacy) ───────────────────────────────────────────────────────

test("runSinglePipeline: 절단 위험을 진단으로 보고한다", async () => {
  const longText = "가".repeat(21000);
  const client = scriptedClient(() => ({
    ok: true,
    data: { characters: [] },
    prompt_eval_count: 8192,
    eval_count: 10
  }));
  const result = await runSinglePipeline({ text: longText, model: "m4b", client, morphContext: { analyzer: "regex-fallback" } });
  assert.ok(result.payload);
  assert.equal(result.diagnostics.mode, "single");
  assert.equal(result.diagnostics.truncation_risk, true);
  assert.ok(result.diagnostics.estimated_prompt_tokens > 8192);
});
