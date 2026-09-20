/**
 * 서술과 선택지 가르기.
 *
 * 서술과 선택지를 한 호출에서 받는다. 나누면 턴당 Neurons가 1.5배가 되고, 선택지는
 * 방금 쓴 장면의 문맥이 가장 진할 때 나와야 좋다(스펙 4절).
 *
 * 경계는 한국어 제목이 아니라 태그다. `[선택지]` 같은 표기는 서술 본문에도 나올 수
 * 있지만 `<선택지>`는 나오지 않는다.
 *
 * 모델이 형식을 안 지키는 일은 반드시 생긴다. 그때 턴을 실패시키지 않고 선택지 없는
 * 턴으로 넘긴다 — 사용자는 자유 입력으로 계속할 수 있다.
 *
 * ## 장면 파싱은 여기 없다
 *
 * 예전에는 이 파일이 `<장면>` 블록도 함께 갈랐다 — 서술자가 산문 안에 장소·시간·
 * 날씨·visual을 직접 써 넣고, 그 블록의 유무가 "배경 이미지를 다시 그릴지"의
 * 신호였다. 그 배선은 창작 모델에게 산문과 분류를 동시에 시키는 것이라 구조적으로
 * 고장났고(블록 누락, 같은 장소의 다른 표기, visual에 한글 혼입), 판정은
 * `src/server/director.js`의 별도 호출로 옮겼다.
 *
 * 그래서 여기서는 **선택지만** 다룬다. 서술자의 출력 규칙(`core/memory.js`의
 * `OUTPUT_RULES`)에서도 장면 블록이 통째로 사라졌으므로 모델이 그걸 쓸 이유 자체가
 * 없다 — 환각으로 태그가 새는지는 실플레이에서 확인한다.
 */

export const CHOICE_MARKER = "<선택지>";
const CHOICE_CLOSE = "</선택지>";

/** `1. `, `1) `, `1 `, `- ` 를 모두 받는다. 모델의 번호 표기는 흔들린다. */
const CHOICE_LINE = /^\s*(?:\d+\s*[.)]?|[-*])\s+(.*)$/;

export function parseNarration(text) {
  const raw = typeof text === "string" ? text : "";
  const at = raw.indexOf(CHOICE_MARKER);
  if (at === -1) return { narration: raw.trim(), choices: [] };

  const narration = raw.slice(0, at).trim();
  let tail = raw.slice(at + CHOICE_MARKER.length);
  const close = tail.indexOf(CHOICE_CLOSE);
  if (close !== -1) tail = tail.slice(0, close);

  const choices = tail
    .split("\n")
    .map((line) => {
      const match = CHOICE_LINE.exec(line);
      return match ? match[1].trim() : "";
    })
    .filter(Boolean);

  return { narration, choices };
}

/**
 * 스트리밍용 분할기.
 *
 * `push()`는 화면에 내보내도 안전한 만큼만 돌려준다. 마커의 앞부분일 수 있는 꼬리는
 * 붙들고 있다가 마커가 아님이 확정되면 내보낸다. 그러지 않으면 사용자 화면에
 * `<선택지>`가 잠깐 나타났다 사라진다.
 *
 * `<선택지>`는 **컷**이다. 거기서부터 끝까지는 전부 선택지이므로, 만나는 순간
 * 영영 멈춘다.
 *
 * 붙들어 두는 길이(홀드백)는 마커 길이 - 1 = 4다 — 마커의 어떤 진부분집합이
 * 청크 경계에 걸쳐 오더라도 가리기에 충분하다.
 */
export function createNarrationSplitter() {
  let full = "";     // 지금까지 들어온 원문 전체(가공 없이) — finish()가 그대로 돌려준다
  let output = "";   // 화면에 내도 안전하다고 확정된 서술만 이어붙인 것
  let emitted = 0;   // output 중 이미 내보낸 만큼
  let pos = 0;       // full에서 "처리 완료"가 확정된 지점 — 이 앞은 다시 보지 않는다
  let cut = false;   // `<선택지>`를 만났다. 이후로는 아무것도 내보내지 않는다
  const HOLDBACK = CHOICE_MARKER.length - 1;

  function resolve() {
    if (cut) return;

    const at = full.indexOf(CHOICE_MARKER, pos);
    if (at !== -1) {
      output += full.slice(pos, at);
      pos = at;
      cut = true;
      return;
    }

    // 아직 마커가 안 왔다. 마커 길이보다 충분히 이전 문자는 마커의 시작일 수
    // 없으므로 그만큼은 지금 내보내도 안전하다.
    const safeFrontier = Math.max(pos, full.length - HOLDBACK);
    if (safeFrontier > pos) {
      output += full.slice(pos, safeFrontier);
      pos = safeFrontier;
    }
  }

  return {
    push(piece) {
      full += typeof piece === "string" ? piece : "";
      resolve();
      const delta = output.length > emitted ? output.slice(emitted) : "";
      emitted = output.length;
      return delta;
    },
    finish() {
      resolve();
      // 스트림이 끝났다 — 홀드백으로 붙들려 있던 꼬리는 이제 마커가 될 가능성이
      // 없으므로 전부 내보낸다. 이미 컷됐으면 더 낼 것이 없다.
      if (!cut && pos < full.length) {
        output += full.slice(pos);
        pos = full.length;
      }
      const delta = output.length > emitted ? output.slice(emitted) : "";
      emitted = output.length;
      return { delta, full };
    }
  };
}
