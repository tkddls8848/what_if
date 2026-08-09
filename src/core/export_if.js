/**
 * @module core/export_if
 *
 * 분기 결과를 인터랙티브 픽션 포맷으로 내보낸다.
 *
 * 자체 플레이어를 만들지 않는다. ink(inkle)와 Twee(Twine)는 이미 컴파일러·에디터·
 * 배포 경로를 갖고 있으므로, 그 생태계에 얹는 쪽이 언제나 싸다.
 *
 * **내보내는 것은 원문이 아니라 추출된 사건 요약과 생성된 분기다.** 원문을 통째로
 * 재배포하지 않으므로 권리 문제를 피하고 파일 크기도 작다. 원문이 필요하면
 * 리더 화면이나 `read_segment`를 쓴다.
 *
 * BOUNDARY NOTE: DOM 의존 없음. 시점 판정은 `core/asof.js`에 위임한다.
 */
import { asOf, lastSegmentIndex, resolveTime, segmentIndexOf } from "./asof.js";

/* ------------------------------------------------------------------ */
/* 공통 뼈대                                                            */
/* ------------------------------------------------------------------ */

/**
 * 원작 사건을 단락 단위 beat으로 묶고, 분기가 걸린 beat을 표시한다.
 * ink와 Twee가 같은 뼈대를 공유하므로 두 출력이 갈라지지 않는다.
 */
export function buildBeats(analysis, { branches = analysis.branches || [], spoilerSafe = false, at = null } = {}) {
  const time = resolveTime(analysis, at ?? lastSegmentIndex(analysis), spoilerSafe);
  const scoped = asOf(analysis, time, { spoilerSafe });

  const bySegment = new Map();
  scoped.events.forEach((event) => {
    const index = segmentIndexOf(analysis, event.segment_id);
    if (index < 1) return;
    const list = bySegment.get(index) || [];
    list.push(event);
    bySegment.set(index, list);
  });

  const usableBranches = branches.filter((branch) => branch.fork_segment <= time && branch.events?.length);
  const forkSegments = new Set(usableBranches.map((branch) => branch.fork_segment));
  // 분기가 걸린 단락은 사건이 없더라도 beat이 있어야 선택지를 놓을 수 있다.
  forkSegments.forEach((index) => {
    if (!bySegment.has(index)) bySegment.set(index, []);
  });

  const beats = [...bySegment.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({
      segment: index,
      lines: (bySegment.get(index) || [])
        .sort((a, b) => (a.sentence_index || 0) - (b.sentence_index || 0))
        .map((event) => event.summary)
        .filter(Boolean),
      branches: usableBranches.filter((branch) => branch.fork_segment === index)
    }));

  return { time, beats, branches: usableBranches, document: analysis.document || {} };
}

/* ------------------------------------------------------------------ */
/* ink                                                                  */
/* ------------------------------------------------------------------ */

export function toInk(analysis, options = {}) {
  const { beats, branches, document } = buildBeats(analysis, options);
  const lines = [
    `// ${document.title || "Untitled"}${document.author ? ` — ${document.author}` : ""}`,
    "// Novel IF Reader what-if export",
    "// 원문이 아니라 추출된 사건 요약과 생성된 분기입니다.",
    ""
  ];

  if (!beats.length) {
    lines.push("아직 내보낼 사건이 없습니다.", "-> END", "");
    return lines.join("\n");
  }

  lines.push(`-> ${beatKnot(beats[0].segment)}`, "");

  beats.forEach((beat, position) => {
    const next = beats[position + 1];
    lines.push(`=== ${beatKnot(beat.segment)} ===`);
    lines.push(`# segment: ${beat.segment}`);
    beat.lines.forEach((text) => lines.push(inkLine(text)));

    if (beat.branches.length) {
      if (next) lines.push(`* [원작대로] -> ${beatKnot(next.segment)}`);
      beat.branches.forEach((branch) => {
        lines.push(`* [${inkChoiceLabel(branch.premise || "다른 선택")}] -> ${branchKnot(branch.branch_id)}`);
      });
      if (!next) lines.push("* [여기서 멈춘다] -> END");
    } else {
      lines.push(next ? `-> ${beatKnot(next.segment)}` : "-> END");
    }
    lines.push("");
  });

  branches.forEach((branch) => {
    lines.push(`=== ${branchKnot(branch.branch_id)} ===`);
    lines.push(`# branch: ${branch.branch_id}`);
    lines.push(`# fork_segment: ${branch.fork_segment}`);
    lines.push(inkLine(`[분기] ${branch.premise || ""}`.trim()));
    branch.events.forEach((event) => lines.push(inkLine(event.summary)));
    branch.states.forEach((state) => {
      lines.push(inkLine(`${state.character}: ${[state.mental_state, state.physical_state, state.location].filter(Boolean).join(" / ")}`));
    });
    lines.push("-> END", "");
  });

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Twee (Twine 3)                                                       */
/* ------------------------------------------------------------------ */

export function toTwee(analysis, options = {}) {
  const { beats, branches, document } = buildBeats(analysis, options);
  const title = document.title || "Untitled";
  const start = beats.length ? beatPassage(beats[0].segment) : "Start";

  const out = [
    ":: StoryTitle",
    title,
    "",
    ":: StoryData",
    JSON.stringify({
      ifid: stableIfid(`${title}::${document.author || ""}`),
      format: "Harlowe",
      "format-version": "3.3.9",
      start
    }, null, 2),
    ""
  ];

  if (!beats.length) {
    out.push(":: Start", "아직 내보낼 사건이 없습니다.", "");
    return out.join("\n");
  }

  beats.forEach((beat, position) => {
    const next = beats[position + 1];
    out.push(`:: ${beatPassage(beat.segment)} [canon]`);
    beat.lines.forEach((text) => out.push(tweeLine(text)));
    if (!beat.lines.length) out.push("(이 단락에는 추출된 사건이 없습니다.)");
    out.push("");
    if (beat.branches.length) {
      if (next) out.push(`[[원작대로->${beatPassage(next.segment)}]]`);
      beat.branches.forEach((branch) => {
        out.push(`[[${tweeLinkLabel(branch.premise || "다른 선택")}->${branchPassage(branch.branch_id)}]]`);
      });
    } else if (next) {
      out.push(`[[다음->${beatPassage(next.segment)}]]`);
    }
    out.push("");
  });

  branches.forEach((branch) => {
    out.push(`:: ${branchPassage(branch.branch_id)} [whatif]`);
    out.push(tweeLine(`''분기:'' ${branch.premise || ""}`.trim()));
    out.push(`(fork segment ${branch.fork_segment})`, "");
    branch.events.forEach((event) => out.push(tweeLine(event.summary)));
    if (branch.states.length) {
      out.push("");
      branch.states.forEach((state) => {
        out.push(tweeLine(`${state.character}: ${[state.mental_state, state.physical_state, state.location].filter(Boolean).join(" / ")}`));
      });
    }
    out.push("");
  });

  return out.join("\n");
}

/* ------------------------------------------------------------------ */

function beatKnot(segment) {
  return `beat_${segment}`;
}

function branchKnot(branchId) {
  return String(branchId).replace(/[^A-Za-z0-9_]/gu, "_");
}

function beatPassage(segment) {
  return `Beat ${segment}`;
}

function branchPassage(branchId) {
  return `Branch ${String(branchId).replace(/[^A-Za-z0-9_ ]/gu, " ")}`.trim();
}

/**
 * ink 본문 한 줄. ink에서 `{}`는 보간, `|`는 대안 텍스트, 줄머리의 `*+-=~/<`는
 * 구문이므로 제거한다. 한국어 서술문에서는 실질적 손실이 없다.
 */
function inkLine(text) {
  const cleaned = String(text || "")
    .replace(/[{}|]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[*+\-=~/<>]+\s*/u, "");
  return cleaned || "…";
}

function inkChoiceLabel(text) {
  return inkLine(text).replace(/[[\]]/gu, "").slice(0, 80) || "다른 선택";
}

function tweeLine(text) {
  return String(text || "").replace(/\s+/gu, " ").trim().replace(/^::/u, "∷") || "…";
}

function tweeLinkLabel(text) {
  return String(text || "")
    .replace(/[[\]<>|]/gu, "")
    .replace(/->/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80) || "다른 선택";
}

/** 같은 작품이면 같은 IFID가 나오게 한다. 재내보내기마다 값이 바뀌면 diff가 무의미해진다. */
function stableIfid(seed) {
  const hex = [];
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  for (let i = 0; i < 4; i += 1) {
    h1 = Math.imul(h1 ^ (h1 >>> 15), 0x2545f491) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x9e3779b1) >>> 0;
    hex.push(h1.toString(16).padStart(8, "0"), h2.toString(16).padStart(8, "0"));
  }
  const flat = hex.join("").slice(0, 32).toUpperCase();
  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20, 32)}`;
}
