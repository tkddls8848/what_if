import assert from "node:assert/strict";
import test from "node:test";

import { analyzeNovel } from "../src/analyzer.js";
import { epubToDocument, htmlToText, parseEpub } from "../src/core/epub.js";
import { normalizeSourceText } from "../src/core/text.js";

/* ---------------------- 최소 ZIP 작성기 (테스트 전용) ---------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** files: [{ name, content, store }] → EPUB(zip) ArrayBuffer */
async function makeZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const raw = encoder.encode(file.content);
    const data = file.store ? raw : await deflateRaw(raw);
    const name = encoder.encode(file.name);
    const method = file.store ? 0 : 8;

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc32(raw), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    offset += local.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  [...locals, ...central, eocd].forEach((chunk) => { out.set(chunk, cursor); cursor += chunk.length; });
  return out.buffer;
}

/* ------------------------------ 픽스처 ------------------------------ */

const CHAPTER_ONE = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>무시</title><style>p{color:red}</style></head>
<body><h1>첫째 장</h1>
<p>복녀는 가난한 집에서 자랐다.</p>
<p>복녀는 남편을 따라 칠성문 밖 빈민굴로  왔다.<br/>그곳은 어두웠다.</p>
<p>&lt;표시&gt; &amp; &#48373;녀</p>
</body></html>`;

const CHAPTER_TWO = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head></head>
<body><h2>둘째 장</h2>
<p>왕 서방이 복녀를 불렀다.</p>
<p>복녀는 왕 서방의 밭으로 갔다.</p>
</body></html>`;

function epubFiles({ withRights = true } = {}) {
  return [
    { name: "mimetype", content: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      content: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    },
    {
      name: "OEBPS/content.opf",
      content: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>감자</dc:title>
          <dc:creator>김동인</dc:creator>
          <dc:language>ko</dc:language>
          ${withRights ? "<dc:rights>public-domain-old-70</dc:rights>" : ""}
        </metadata>
        <manifest>
          <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
          <item id="css" href="style.css" media-type="text/css"/>
        </manifest>
        <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
      </package>`
    },
    { name: "OEBPS/ch1.xhtml", content: CHAPTER_ONE },
    { name: "OEBPS/ch2.xhtml", content: CHAPTER_TWO },
    { name: "OEBPS/style.css", content: "p{}" }
  ];
}

/* ------------------------------- 테스트 ------------------------------- */

test("htmlToText strips markup and decodes entities", () => {
  const text = htmlToText(CHAPTER_ONE);
  assert.ok(text.includes("복녀는 가난한 집에서 자랐다."));
  assert.ok(text.includes("<표시> & 복녀"), "엔티티가 해석되어야 한다");
  assert.ok(!text.includes("color:red"), "style이 남으면 안 된다");
  // 태그는 엔티티 해석 **전에** 제거되므로 &lt;표시&gt;는 살아남고 <p>는 사라진다.
  assert.ok(!/<\/?(p|br|h[1-6]|div|body|html)\b/iu.test(text), "태그가 남으면 안 된다");
  assert.ok(!/\n{3,}/u.test(text));
  assert.ok(text.includes("빈민굴로 왔다"), "연속 공백은 하나로 접힌다");
});

test("parses spine order, metadata and chapter titles", async () => {
  const parsed = await parseEpub(await makeZip(epubFiles()));

  assert.equal(parsed.metadata.title, "감자");
  assert.equal(parsed.metadata.author, "김동인");
  assert.equal(parsed.metadata.language, "ko");
  assert.equal(parsed.metadata.rights, "public-domain-old-70");

  assert.equal(parsed.chapters.length, 2, "CSS는 spine에 없으므로 제외된다");
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["첫째 장", "둘째 장"]);
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.spine_index), [0, 1]);
  assert.ok(parsed.chapters[0].text.includes("복녀"));
});

test("chapter offsets survive the analyzer's own normalization", async () => {
  const parsed = await parseEpub(await makeZip(epubFiles()));
  const document = epubToDocument(parsed);

  // 분석기가 다시 정규화해도 텍스트가 변하지 않아야 offset이 유효하다.
  assert.equal(normalizeSourceText(document.text), document.text);

  document.chapters.forEach((chapter, index) => {
    const slice = document.text.slice(chapter.char_start, chapter.char_end);
    assert.equal(slice, normalizeSourceText(parsed.chapters[index].text));
    assert.ok(slice.startsWith(chapter.title));
  });
  assert.equal(document.chapters[0].char_end < document.chapters[1].char_start, true);
});

test("analyzeNovel uses real chapter boundaries as scenes", async () => {
  const parsed = await parseEpub(await makeZip(epubFiles()));
  const document = epubToDocument(parsed);
  const analysis = analyzeNovel({
    text: document.text,
    chapters: document.chapters,
    title: document.title,
    sample: { id: "custom", author: document.author, rights: document.rights }
  });

  assert.equal(analysis.scenes.length, 2);
  assert.deepEqual(analysis.scenes.map((scene) => scene.title), ["첫째 장", "둘째 장"]);
  assert.deepEqual(analysis.scenes.map((scene) => scene.source_ref.spine_index), [0, 1]);

  // 모든 segment가 자기 챕터의 scene에 속해야 한다.
  analysis.segments.forEach((segment) => {
    const scene = analysis.scenes.find((item) => item.scene_id === segment.scene_id);
    assert.ok(scene, `${segment.segment_id}에 scene이 없다`);
    const chapter = document.chapters[scene.source_ref.spine_index];
    assert.ok(segment.char_start >= chapter.char_start && segment.char_start < chapter.char_end);
  });

  // 챕터가 없으면 기존 균등 분할로 돌아간다.
  const fallback = analyzeNovel({ text: document.text, title: document.title, sample: { id: "custom" } });
  assert.ok(fallback.scenes.every((scene) => /^Scene \d+$/u.test(scene.title)));
});

test("rejects files that are not EPUB", async () => {
  const notZip = new TextEncoder().encode("이건 그냥 텍스트 파일입니다.".repeat(10)).buffer;
  await assert.rejects(() => parseEpub(notZip), /EPUB이 아닙니다/u);

  const zipWithoutContainer = await makeZip([{ name: "readme.txt", content: "안녕" }]);
  await assert.rejects(() => parseEpub(zipWithoutContainer), /container\.xml/u);
});
