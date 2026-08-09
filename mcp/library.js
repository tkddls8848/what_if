/**
 * @module mcp/library
 *
 * MCP 어댑터가 읽는 작품 라이브러리.
 *
 * BOUNDARY NOTE — 어댑터 전용:
 * 이 디렉터리는 **분석하지 않는다.** 한국어 사전·정규식·엔티티 판정은 여기 오면
 * 안 되고, 전부 `src/analyzer.js`와 `src/core/*`에 있어야 한다. 규칙이 두 벌이 되면
 * 웹 화면과 에이전트의 답이 갈라지고, 그때부터 어느 쪽도 신뢰할 수 없다.
 * `tests/mcp_tools.test.mjs`가 이 규칙을 검사한다.
 *
 * 라이브러리 위치는 `NOVEL_IF_LIBRARY`(기본 `texts/`)다. `*.txt`가 작품 하나이며,
 * 같은 이름의 `*.meta.json`이 있으면 제목·저자·권리 정보를 덮어쓴다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SAMPLE_TEXTS } from "../src/config.js";
import { analyzeNovel } from "../src/analyzer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIBRARY = path.resolve(HERE, "..", "texts");

/** 원문 리소스를 통째로 내줘도 되는 권리 표기. 그 외에는 근거 인용만 허용한다. */
const REDISTRIBUTABLE = /^public-domain/u;

function libraryDir() {
  return process.env.NOVEL_IF_LIBRARY ? path.resolve(process.env.NOVEL_IF_LIBRARY) : DEFAULT_LIBRARY;
}

export function createLibrary({ dir = libraryDir() } = {}) {
  const cache = new Map();

  function documents() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".txt"))
      .map((name) => describe(dir, name))
      .sort((a, b) => a.document_id.localeCompare(b.document_id));
  }

  function get(documentId) {
    const meta = documents().find((item) => item.document_id === documentId);
    if (!meta) return null;
    const stat = fs.statSync(meta.path);
    const key = `${meta.document_id}:${stat.mtimeMs}:${stat.size}`;
    const cached = cache.get(meta.document_id);
    if (cached?.key === key) return cached.entry;

    const text = fs.readFileSync(meta.path, "utf8");
    const analysis = analyzeNovel({
      text,
      title: meta.title,
      source: "mcp-library",
      sample: {
        id: meta.document_id,
        author: meta.author,
        year: meta.year,
        source_url: meta.source_url,
        rights: meta.rights
      }
    });
    const entry = { meta, analysis };
    cache.set(meta.document_id, { key, entry });
    return entry;
  }

  return { dir, documents, get };
}

export function isRedistributable(meta) {
  return REDISTRIBUTABLE.test(String(meta?.rights || ""));
}

function describe(dir, fileName) {
  const documentId = fileName.replace(/\.txt$/iu, "");
  const bundled = SAMPLE_TEXTS.find((sample) => sample.id === documentId);
  const sidecar = readSidecar(path.join(dir, `${documentId}.meta.json`));

  return {
    document_id: documentId,
    path: path.join(dir, fileName),
    title: sidecar.title || bundled?.title || documentId,
    author: sidecar.author || bundled?.author || "",
    year: sidecar.year || bundled?.year || "",
    source_url: sidecar.source_url || bundled?.source_url || "",
    rights: sidecar.rights || bundled?.rights || "unknown"
  };
}

function readSidecar(metaPath) {
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return {};
  }
}
