// Analysis: segments. See doc/CODE_MAP.md for the call path.
import { makeId, summarizeText } from "./helpers.js";

const MAX_SEGMENT_CHARS = 1000;
const MAX_DISPLAY_SCENES = 12;

function splitParagraphWithOffsets(text, maxChars = MAX_SEGMENT_CHARS) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/u.test(text[cursor] || "")) cursor += 1;
    if (cursor >= text.length) break;

    const remaining = text.length - cursor;
    let end = remaining <= maxChars ? text.length : cursor + maxChars;
    if (end < text.length) {
      const window = text.slice(cursor, end + 1);
      const minBoundary = Math.floor(maxChars * 0.55);
      const boundaryPattern = /[.!?…。](?:["'’”」』》)]*)\s+/gu;
      let match;
      let sentenceEnd = -1;
      while ((match = boundaryPattern.exec(window))) {
        const candidate = match.index + match[0].trimEnd().length;
        if (candidate >= minBoundary && candidate <= maxChars) sentenceEnd = candidate;
      }
      if (sentenceEnd > 0) {
        end = cursor + sentenceEnd;
      } else {
        const whitespace = window.slice(0, maxChars + 1).search(/\s+\S*$/u);
        if (whitespace >= minBoundary) end = cursor + whitespace;
      }
    }

    const raw = text.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = cursor + leading;
    const trimmedEnd = end - trailing;
    if (trimmedEnd > start) {
      chunks.push({ text: text.slice(start, trimmedEnd), start, end: trimmedEnd });
    }
    cursor = Math.max(end, cursor + 1);
  }
  return chunks;
}

function buildSegments(text, documentId) {
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean);
  let cursor = 0;
  const segments = [];
  paragraphs.forEach((paragraph) => {
    const charStart = text.indexOf(paragraph, cursor);
    splitParagraphWithOffsets(paragraph).forEach((piece) => {
      const index = segments.length;
      segments.push({
        segment_id: makeId("seg", index),
        document_id: documentId,
        index: index + 1,
        scene_id: "",
        text: piece.text,
        char_start: charStart + piece.start,
        char_end: charStart + piece.end,
        description_spans: []
      });
    });
    cursor = charStart + paragraph.length;
  });
  return segments;
}

/**
 * EPUB처럼 실제 챕터 경계를 아는 입력은 그 경계를 Scene으로 쓴다. 균등 분할은
 * "사건 순서 탐색용 임시 단위"라는 한계를 문서에 명시해 왔는데, 챕터를 알 수 있을 때
 * 굳이 그 근사를 쓸 이유가 없다.
 */
function buildChapterScenes(segments, documentId, chapters) {
  const scenes = [];
  chapters.forEach((chapter, index) => {
    const chapterSegments = segments.filter((segment) =>
      segment.char_start >= chapter.char_start && segment.char_start < chapter.char_end);
    if (!chapterSegments.length) return;

    const sceneId = makeId("scene", scenes.length);
    chapterSegments.forEach((segment) => { segment.scene_id = sceneId; });
    scenes.push({
      scene_id: sceneId,
      document_id: documentId,
      index: scenes.length + 1,
      title: chapter.title || `Chapter ${index + 1}`,
      start_segment_id: chapterSegments[0].segment_id,
      end_segment_id: chapterSegments[chapterSegments.length - 1].segment_id,
      source_ref: chapter.source_ref || null,
      summary: summarizeText(chapterSegments.map((segment) => segment.text).join(" "), 110)
    });
  });

  // 챕터 밖으로 밀려난 segment가 있으면 마지막 scene에 붙여 고아를 만들지 않는다.
  const orphan = segments.filter((segment) => !segment.scene_id);
  if (orphan.length && scenes.length) {
    orphan.forEach((segment) => { segment.scene_id = scenes[scenes.length - 1].scene_id; });
    scenes[scenes.length - 1].end_segment_id = orphan[orphan.length - 1].segment_id;
  }
  return scenes.length ? scenes : buildScenes(segments, documentId);
}

function buildScenes(segments, documentId, chapters = null) {
  if (chapters?.length) return buildChapterScenes(segments, documentId, chapters);
  const sceneSize = Math.max(1, Math.ceil(segments.length / Math.min(MAX_DISPLAY_SCENES, Math.max(1, segments.length))));
  const scenes = [];
  segments.forEach((segment, index) => {
    const sceneIndex = Math.floor(index / sceneSize);
    const sceneId = makeId("scene", sceneIndex);
    segment.scene_id = sceneId;
    if (!scenes[sceneIndex]) {
      scenes[sceneIndex] = {
        scene_id: sceneId,
        document_id: documentId,
        index: sceneIndex + 1,
        title: `Scene ${sceneIndex + 1}`,
        start_segment_id: segment.segment_id,
        end_segment_id: segment.segment_id,
        summary: ""
      };
    }
    scenes[sceneIndex].end_segment_id = segment.segment_id;
  });

  scenes.forEach((scene) => {
    const sceneSegments = segments.filter((segment) => segment.scene_id === scene.scene_id);
    scene.summary = summarizeText(sceneSegments.map((segment) => segment.text).join(" "), 110);
  });

  return scenes;
}

export { buildSegments, buildScenes };
