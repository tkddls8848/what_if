/**
 * MCP 서버의 배선 검증: 실제 stdio 전송으로 서버를 띄우고 도구·리소스·프롬프트가
 * 규약대로 노출되는지 확인한다. `mcp_tools.test.mjs`가 계산을, 이 파일이 전송을 맡는다.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.resolve(fileURLToPath(new URL("../mcp/server.js", import.meta.url)));

async function withClient(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", SERVER]
  });
  const client = new Client({ name: "novel-if-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function payloadOf(result) {
  assert.ok(!result.isError, `도구 호출이 실패했다: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test("exposes read-only tools, resources and prompts over stdio", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "arc_summary", "evidence_for", "graph_as_of", "list_works",
      "read_segment", "state_as_of", "timeline_as_of", "whatif_seed", "who_is"
    ]);

    tools.forEach((tool) => {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}은 읽기 전용이어야 한다`);
      assert.ok(tool.description, `${tool.name}에 설명이 없다`);
    });
    // 쓰기 도구가 하나라도 생기면 이 단언이 먼저 깨진다.
    assert.ok(!names.some((name) => /create|update|delete|write|confirm|reject/u.test(name)));

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["character-interview", "spoiler-safe-question"]);
  });
});

test("as_of is a required argument in the published tool schemas", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const factTools = ["state_as_of", "who_is", "timeline_as_of", "graph_as_of", "arc_summary", "whatif_seed"];
    factTools.forEach((name) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool.inputSchema.required.includes("as_of"), `${name}의 as_of가 선택 인자다`);
    });
    const listWorks = tools.find((item) => item.name === "list_works");
    assert.ok(!(listWorks.inputSchema.required || []).includes("as_of"));
  });
});

test("answers a spoiler-scoped question end to end", async () => {
  await withClient(async (client) => {
    const works = payloadOf(await client.callTool({ name: "list_works", arguments: {} }));
    const gamja = works.works.find((work) => work.document_id === "gamja");
    assert.ok(gamja.segments > 10);

    const timeline = payloadOf(await client.callTool({
      name: "timeline_as_of",
      arguments: { document_id: "gamja", as_of: 12 }
    }));
    assert.ok(timeline.events.length > 0);
    timeline.events.forEach((event) => assert.ok(event.segment <= 12));

    const evidence = payloadOf(await client.callTool({
      name: "evidence_for",
      arguments: { document_id: "gamja", fact_id: timeline.events[0].event_id }
    }));
    assert.ok(evidence.evidence.quote.length > 0);
  });
});

test("refuses a fact call that omits as_of", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "timeline_as_of",
      arguments: { document_id: "gamja" }
    });
    assert.ok(result.isError, "as_of 없는 호출이 통과했다");
  });
});

test("serves the scoped analysis resource", async () => {
  await withClient(async (client) => {
    const result = await client.readResource({ uri: "novel://gamja/analysis/8" });
    const analysis = JSON.parse(result.contents[0].text);
    assert.equal(analysis.scope.current_segment, 8);
    analysis.segments.forEach((segment) => assert.ok(segment.index <= 8));
  });
});

test("prompts pin the reading position into their instructions", async () => {
  await withClient(async (client) => {
    const prompt = await client.getPrompt({
      name: "spoiler-safe-question",
      arguments: { document_id: "gamja", as_of: "12", question: "복녀는 지금 어떤 상태인가?" }
    });
    const text = prompt.messages[0].content.text;
    assert.match(text, /as_of=12/u);
    assert.match(text, /근거 없음/u);
  });
});
