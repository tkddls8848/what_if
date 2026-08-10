#!/usr/bin/env node
/**
 * @module mcp/server
 *
 * Novel IF Reader의 **읽기 전용** MCP 서버 (stdio).
 *
 * 목적: 화면을 하나도 만들지 않고 "N번 단락까지 읽었다"를 전제로 한 질의를 열어주는
 * 것. 에이전트가 곧 대화형 리더가 된다.
 *
 * 안전 규칙 (`mcp/tools.js`가 강제, `tests/mcp_tools.test.mjs`가 검증):
 * - 사실 조회 도구는 `as_of` 없이는 거부한다. 기본값이 곧 스포일러다.
 * - 모든 사실에 원문 근거·신뢰도·검수 상태가 붙는다.
 * - 쓰기 도구 없음. 확정·수정은 웹 검수 화면에서만 한다.
 * - 원문 단락 전체는 공개도메인 표기가 있는 작품에만 제공한다.
 *
 * 실행:
 *   node mcp/server.js
 *   NOVEL_IF_LIBRARY=/path/to/texts node mcp/server.js
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLibrary } from "./library.js";
import {
  ToolError,
  annotationsAsOf,
  arcSummary,
  evidenceForFact,
  graphAsOf,
  listWorks,
  readAnalysis,
  readSegment,
  stateAsOf,
  timelineAsOf,
  whatifSeed,
  whoIs
} from "./tools.js";

const library = createLibrary();

const server = new McpServer(
  { name: "novel-if-reader", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

const documentId = z.string().describe("작품 id. list_works로 확인한다.");
const asOfArg = z.number().int().min(1)
  .describe("현재 독서 위치(segment 번호). 필수 — 지정하지 않으면 아직 읽지 않은 내용이 노출된다.");

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
  const message = error instanceof ToolError ? error.message : `내부 오류: ${error.message}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

function tool(name, config, run) {
  server.registerTool(
    name,
    { ...config, annotations: { readOnlyHint: true, openWorldHint: false, ...(config.annotations || {}) } },
    (args) => {
      try {
        return ok(run(args));
      } catch (error) {
        return fail(error);
      }
    }
  );
}

tool("list_works", {
  title: "작품 목록",
  description: "분석 가능한 작품과 각 작품의 segment 수를 돌려준다. 다른 도구의 as_of 상한을 여기서 확인한다. 유일하게 as_of가 필요 없는 도구다.",
  inputSchema: {}
}, () => listWorks(library));

tool("state_as_of", {
  title: "시점별 인물 상태",
  description: "특정 독서 시점에서 한 인물의 심리·신체 상태, 현재 위치, 알려진 사실을 원문 근거와 함께 돌려준다.",
  inputSchema: {
    document_id: documentId,
    character: z.string().describe("인물의 정규명 또는 별칭"),
    as_of: asOfArg
  }
}, (args) => stateAsOf(library, args));

tool("who_is", {
  title: "인물 조회",
  description: "특정 시점까지 밝혀진 인물의 정규명·별칭·역할과 그때까지의 관계를 돌려준다. 그 시점에 아직 등장하지 않은 인물은 답하지 않는다.",
  inputSchema: {
    document_id: documentId,
    name: z.string().describe("찾을 인물 이름"),
    as_of: asOfArg
  }
}, (args) => whoIs(library, args));

tool("timeline_as_of", {
  title: "시점까지의 사건",
  description: "독서 위치까지의 사건을 단락 순서로 돌려준다. event_type으로 사건 유형을 좁힐 수 있다.",
  inputSchema: {
    document_id: documentId,
    as_of: asOfArg,
    event_type: z.enum(["all", "appearance", "movement", "conversation", "perception", "conflict", "realization", "stasis", "symbolic", "background"])
      .optional()
      .describe("사건 유형 필터. 생략하면 전체")
  }
}, (args) => timelineAsOf(library, args));

tool("graph_as_of", {
  title: "시점별 관계 그래프",
  description: "독서 위치까지의 인물·장소·사건 노드와 관계 엣지를 돌려준다. 웹 화면의 Graph 내보내기와 같은 계약이다.",
  inputSchema: { document_id: documentId, as_of: asOfArg }
}, (args) => graphAsOf(library, args));

tool("annotations_as_of", {
  title: "시점까지의 시대 주석",
  description: "독서 위치까지 등장한 시대 용어와 그 외부 출처 링크를 돌려준다. 역사 서술을 생성하지 않고 링크만 준다 — 맥락이 필요하면 링크를 직접 읽어라. note는 사람이 검수에서 채운 것만 들어 있고 비어 있을 수 있다.",
  inputSchema: {
    document_id: documentId,
    as_of: asOfArg,
    category: z.enum(["all", "modern_institution", "money", "class_reproduction", "document", "mobility", "erasure"])
      .optional()
      .describe("주석 갈래 필터. 생략하면 전체")
  }
}, (args) => annotationsAsOf(library, args));

tool("evidence_for", {
  title: "근거 되짚기",
  description: "사실 id(event_/char_/loc_/state_/rel_/mention_)로 원문 인용, 단락 번호, 신뢰도, 검수 상태, 제약 위반을 돌려준다. 어떤 주장이든 이 도구로 원문까지 되짚을 수 있어야 한다.",
  inputSchema: { document_id: documentId, fact_id: z.string().describe("예: event_012, char_003") }
}, (args) => evidenceForFact(library, args));

tool("arc_summary", {
  title: "시점까지의 서사 집계",
  description: "독서 위치까지의 사건 유형 분포와 인물별 현재 상태를 집계한다. 원문을 재서술하거나 새로 생성하지 않는다.",
  inputSchema: { document_id: documentId, as_of: asOfArg }
}, (args) => arcSummary(library, args));

tool("whatif_seed", {
  title: "분기 시드",
  description: "'그때 다르게 했다면'을 쓰기 위한 분기 시점 스냅샷과 분기점 후보를 돌려준다. 반환값에는 as_of 이후의 내용이 없으므로, 이 시드만으로 대안 전개를 쓴다. 이후 전개를 알고 있어도 사용하지 않는다.",
  inputSchema: { document_id: documentId, as_of: asOfArg }
}, (args) => whatifSeed(library, args));

tool("read_segment", {
  title: "원문 단락 읽기",
  description: "지정한 단락의 원문을 돌려준다. 공개도메인 표기가 있는 작품에만 허용된다.",
  inputSchema: { document_id: documentId, segment: z.number().int().min(1).describe("단락 번호") }
}, (args) => readSegment(library, args));

/* ------------------------------- 리소스 ------------------------------- */

/** URI에 as_of를 박아 넣어야 읽힌다 — 리소스도 시점 없이는 열리지 않는다. */
const completeDocumentId = {
  document_id: (value) => library.documents()
    .map((item) => item.document_id)
    .filter((id) => id.startsWith(value))
};

server.registerResource(
  "analysis",
  new ResourceTemplate("novel://{document_id}/analysis/{as_of}", { list: undefined, complete: completeDocumentId }),
  {
    title: "시점 적용 분석 결과",
    description: "독서 위치까지 잘라낸 분석 JSON. 웹 화면의 JSON 내보내기와 같은 계약이다.",
    mimeType: "application/json"
  },
  (uri, { document_id, as_of }) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(readAnalysis(library, { document_id, as_of }), null, 2)
    }]
  })
);

server.registerResource(
  "segment",
  new ResourceTemplate("novel://{document_id}/segment/{segment}", { list: undefined, complete: completeDocumentId }),
  {
    title: "원문 단락",
    description: "지정 단락의 원문. 공개도메인 표기가 있는 작품만 제공한다.",
    mimeType: "text/plain"
  },
  (uri, { document_id, segment }) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/plain",
      text: readSegment(library, { document_id, segment }).text
    }]
  })
);

/* ------------------------------- 프롬프트 ------------------------------ */

server.registerPrompt(
  "spoiler-safe-question",
  {
    title: "스포일러 없는 질문",
    description: "현재 독서 위치를 고정하고, 근거 있는 사실만으로 답하게 한다.",
    argsSchema: {
      document_id: z.string(),
      as_of: z.string().describe("현재 독서 위치(segment 번호)"),
      question: z.string()
    }
  },
  ({ document_id, as_of, question }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `작품 '${document_id}'를 ${as_of}번 단락까지 읽은 독자의 질문에 답한다.`,
          "",
          "규칙:",
          `1. 모든 도구 호출에 as_of=${as_of}를 넣는다. 이 값을 늘리지 않는다.`,
          "2. 주장마다 evidence의 원문 인용과 단락 번호를 함께 적는다.",
          "3. 근거가 없으면 추측하지 말고 '그 시점까지 근거 없음'이라고 답한다.",
          "4. 이후 전개를 암시하지 않는다. 작품에 대한 사전 지식을 쓰지 않는다.",
          "",
          `질문: ${question}`
        ].join("\n")
      }
    }]
  })
);

server.registerPrompt(
  "character-interview",
  {
    title: "인물 인터뷰",
    description: "지정 인물이 그 시점까지 자신이 아는 것만으로 답하게 한다(지식 경계 강제).",
    argsSchema: {
      document_id: z.string(),
      character: z.string(),
      as_of: z.string().describe("인물이 놓인 시점(segment 번호)")
    }
  },
  ({ document_id, character, as_of }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `'${document_id}'의 인물 ${character}로서, ${as_of}번 단락 시점에 답한다.`,
          "",
          `먼저 state_as_of와 who_is를 as_of=${as_of}로 호출해 그 시점의 상태·관계·알려진 사실을 확인한다.`,
          "그 결과에 없는 것은 모른다고 답한다. 이후 사건을 알고 있는 것처럼 말하지 않는다.",
          "작품의 결말이나 평론에서 얻은 지식을 쓰지 않는다.",
          "답변 끝에 '내가 아는 근거' 목록으로 인용한 단락 번호를 적는다."
        ].join("\n")
      }
    }]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
