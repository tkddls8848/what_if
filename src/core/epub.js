/**
 * @module core/epub
 *
 * 의존성 없는 최소 EPUB 리더.
 *
 * TXT 단일 입력은 제품의 상한선이다. EPUB은 사실상 표준 입력이고, 무엇보다
 * **실제 챕터 경계**를 알려준다 — 지금까지 Scene은 "약 12등분"이라는 근사였는데
 * EPUB에서는 근사할 이유가 없다.
 *
 * 왜 라이브러리를 쓰지 않는가: 이 저장소는 빌드 단계가 없고 브라우저가 ES module을
 * 그대로 로드한다. 번들러 없이 npm 패키지를 브라우저에 넣으려면 빌드가 생기고,
 * 그러면 "빌드 없음"이라는 구조적 장점이 사라진다. ZIP 해제는 표준
 * `DecompressionStream("deflate-raw")`로 충분하다(Node 18+, 최신 브라우저 공통).
 *
 * 한계 (문서화된 비목표):
 * - ZIP64, 암호화, 이미지·CSS는 다루지 않는다. 본문 텍스트만 읽는다.
 * - EPUB CFI를 만들지 않는다. XHTML DOM 경로를 재현하지 않으면 가짜 CFI가 되므로,
 *   `source_ref`로 spine 순번과 href만 남긴다. 챕터 수준 위치 지정이다.
 *
 * BOUNDARY NOTE: DOM·Node API 의존 없음. 입력은 ArrayBuffer, 출력은 평범한 객체다.
 */
import { PARAGRAPH_SEPARATOR, normalizeSourceText } from "./text.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_COMMENT = 0xffff;

/* ------------------------------------------------------------------ */
/* ZIP                                                                  */
/* ------------------------------------------------------------------ */

/** 중앙 디렉터리를 읽어 { name -> entry } 맵을 만든다. 압축 해제는 필요할 때만 한다. */
function readZipIndex(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) throw new Error("EPUB이 아닙니다: ZIP 중앙 디렉터리를 찾을 수 없습니다.");

  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let i = 0; i < total; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, bytes, view };
}

async function readZipEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;

  const { view, bytes } = zip;
  const local = entry.localOffset;
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const start = local + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return decodeUtf8(raw);
  if (entry.method !== 8) throw new Error(`지원하지 않는 ZIP 압축 방식(${entry.method}): ${name}`);
  return decodeUtf8(await inflateRaw(raw));
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("이 런타임에는 DecompressionStream이 없습니다. EPUB을 읽을 수 없습니다.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEocd(view, length) {
  const min = Math.max(0, length - MAX_COMMENT - 22);
  for (let i = length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

/* ------------------------------------------------------------------ */
/* EPUB                                                                 */
/* ------------------------------------------------------------------ */

/**
 * EPUB → { metadata, chapters }.
 * chapters는 spine 순서이며 각 항목은 정규화된 본문 텍스트를 갖는다.
 */
export async function parseEpub(arrayBuffer) {
  const zip = readZipIndex(arrayBuffer);

  const container = await readZipEntry(zip, "META-INF/container.xml");
  if (!container) throw new Error("EPUB이 아닙니다: META-INF/container.xml이 없습니다.");
  const opfPath = attribute(container.match(/<rootfile\b[^>]*>/u)?.[0] || "", "full-path");
  if (!opfPath) throw new Error("EPUB 구조 오류: rootfile 경로가 없습니다.");

  const opf = await readZipEntry(zip, opfPath);
  if (!opf) throw new Error(`EPUB 구조 오류: ${opfPath}를 읽을 수 없습니다.`);
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const manifest = new Map();
  for (const tag of opf.match(/<item\b[^>]*\/?>/gu) || []) {
    const id = attribute(tag, "id");
    const href = attribute(tag, "href");
    if (id && href) manifest.set(id, { href: resolvePath(baseDir, href), mediaType: attribute(tag, "media-type") });
  }

  const spine = (opf.match(/<itemref\b[^>]*\/?>/gu) || [])
    .map((tag) => attribute(tag, "idref"))
    .map((id) => manifest.get(id))
    .filter((item) => item && /xhtml|html/u.test(item.mediaType || "xhtml"));

  const chapters = [];
  for (const [index, item] of spine.entries()) {
    const raw = await readZipEntry(zip, item.href);
    if (!raw) continue;
    const text = htmlToText(raw);
    if (!text) continue;
    chapters.push({
      spine_index: index,
      href: item.href,
      title: headingOf(raw) || fileTitle(item.href),
      text
    });
  }

  return {
    metadata: {
      title: firstTag(opf, "dc:title") || firstTag(opf, "title") || "",
      author: firstTag(opf, "dc:creator") || "",
      language: firstTag(opf, "dc:language") || "ko",
      rights: firstTag(opf, "dc:rights") || "",
      source_url: firstTag(opf, "dc:source") || ""
    },
    chapters
  };
}

/**
 * 분석기에 넘길 형태로 변환한다. 챕터 offset은 **정규화된 최종 텍스트 기준**이며,
 * `normalizeSourceText`가 멱등이므로 분석기가 다시 정규화해도 어긋나지 않는다.
 */
export function epubToDocument(parsed) {
  const chapters = [];
  let cursor = 0;
  const parts = [];

  parsed.chapters.forEach((chapter) => {
    const text = normalizeSourceText(chapter.text);
    if (!text) return;
    if (parts.length) cursor += PARAGRAPH_SEPARATOR.length;
    chapters.push({
      title: chapter.title,
      char_start: cursor,
      char_end: cursor + text.length,
      source_ref: { spine_index: chapter.spine_index, href: chapter.href }
    });
    cursor += text.length;
    parts.push(text);
  });

  return {
    title: parsed.metadata.title,
    author: parsed.metadata.author,
    language: parsed.metadata.language,
    rights: parsed.metadata.rights,
    source_url: parsed.metadata.source_url,
    text: parts.join(PARAGRAPH_SEPARATOR),
    chapters
  };
}

/* ------------------------------------------------------------------ */

const BLOCK_END = /<\/(p|div|h[1-6]|li|blockquote|section|article|tr)\s*>/giu;
const BREAK = /<br\s*\/?>/giu;

export function htmlToText(html) {
  const body = html.replace(/<head\b[\s\S]*?<\/head>/giu, "");
  return normalizeSourceText(
    body
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, "")
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replace(BREAK, "\n")
      .replace(BLOCK_END, "\n\n")
      .replace(/<[^>]+>/gu, "")
      .replace(/&nbsp;/giu, " ")
      .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&lt;/giu, "<")
      .replace(/&gt;/giu, ">")
      .replace(/&quot;/giu, '"')
      .replace(/&#39;|&apos;/giu, "'")
      .replace(/&amp;/giu, "&")
  ).replace(/\n{3,}/gu, "\n\n");
}

function headingOf(html) {
  const match = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu);
  return match ? normalizeSourceText(match[1].replace(/<[^>]+>/gu, "")).slice(0, 80) : "";
}

function fileTitle(href) {
  return href.split("/").pop().replace(/\.[^.]+$/u, "");
}

function firstTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "iu"));
  return match ? normalizeSourceText(match[1].replace(/<[^>]+>/gu, "")) : "";
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "iu"));
  return match ? match[1] : "";
}

function resolvePath(baseDir, href) {
  const joined = `${baseDir}${href}`.replace(/\\/gu, "/");
  const out = [];
  joined.split("/").forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") out.pop();
    else out.push(part);
  });
  return out.join("/");
}
