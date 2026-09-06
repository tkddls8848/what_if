/**
 * 서술과 선택지, 그리고 장면 묘사 가르기.
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
 * 장면이 바뀌었을 때만 `<장면>` 블록이 하나 더 붙는다(배경 이미지를 다시 그릴지
 * 판단하는 신호 — src/server/scene.js가 소비한다). 출력 순서는 "서술 → (있다면)
 * 장면 → 선택지"이지만, 모델이 순서를 지키지 않는 일도 생기므로 parseNarration은
 * 두 블록이 어느 순서로 오든 선택지를 정확히 골라내고 둘 다 서술에서 걷어낸다.
 */

export const CHOICE_MARKER = "<선택지>";
const CHOICE_CLOSE = "</선택지>";

export const SCENE_MARKER = "<장면>";
const SCENE_CLOSE = "</장면>";

/** `1. `, `1) `, `1 `, `- ` 를 모두 받는다. 모델의 번호 표기는 흔들린다. */
const CHOICE_LINE = /^\s*(?:\d+\s*[.)]?|[-*])\s+(.*)$/;

/** `장소:`, `시간 :`, `날씨:` 등 콜론 앞뒤 공백이 흔들려도 받는다. */
const SCENE_LINE = /^\s*(장소|시간|날씨)\s*[:：]\s*(.*)\s*$/;
const SCENE_FIELD_KEY = { 장소: "place", 시간: "time", 날씨: "weather" };

/**
 * `visual:` 줄 — 배경 이미지 프롬프트의 재료. 다른 세 필드(장소·시간·날씨)는
 * 한국어로 남아 화면 라벨과 캐시 키(src/server/scene.js의 sceneHash)로 쓰이지만,
 * 이 필드만은 **영어**여야 한다: 배경 이미지 모델(flux-1-schnell)은 영어 캡션으로
 * 학습되어 있어 한국어를 사실상 노이즈로 취급한다 — 플레이어가 신고한 "모든
 * 배경이 중국풍 짝퉁 같다"는 결함의 근원이 바로 여기(예전에는 한국어 setting/tone을
 * 그대로 프롬프트에 넣었다)였다. 값이 영어인지는 여기서 강제하지 않는다(모델이
 * 규칙을 어기는 일은 항상 있다) — 대신 src/server/scene.js의 resolveScene이
 * 조립된 프롬프트에 한글이 남아 있으면 이미지를 보내지 않고 구조화 오류로 멈춘다.
 */
const VISUAL_LINE = /^\s*visual\s*[:：]\s*(.*)\s*$/i;

/**
 * 텍스트에서 `<장면>...</장면>`을 통째로 잘라낸다(닫는 태그가 없으면 문자열
 * 끝까지). parseNarration이 서술 본문에서 장면 블록을 걷어내는 데 쓴다 — 장면
 * 블록이 선택지 블록보다 먼저 오든 나중에 오든 이 함수 하나로 처리된다.
 */
function cutSceneBlock(raw) {
  const at = raw.indexOf(SCENE_MARKER);
  if (at === -1) return raw;
  const rest = raw.slice(at + SCENE_MARKER.length);
  const close = rest.indexOf(SCENE_CLOSE);
  const end = close === -1 ? raw.length : at + SCENE_MARKER.length + close + SCENE_CLOSE.length;
  return raw.slice(0, at) + raw.slice(end);
}

/**
 * `<장면>` 블록을 파싱한다. 블록 자체가 없으면(장면이 안 바뀌었으면) null —
 * "장면이 안 바뀌었다"와 "장면이 있는데 다 비어 있다"는 다르므로 후자는 필드가
 * 빈 문자열인 객체를 돌려준다. 필드 순서·누락·닫는 태그 누락 모두 허용한다.
 */
export function parseScene(text) {
  const raw = typeof text === "string" ? text : "";
  const at = raw.indexOf(SCENE_MARKER);
  if (at === -1) return null;

  let tail = raw.slice(at + SCENE_MARKER.length);
  const close = tail.indexOf(SCENE_CLOSE);
  if (close !== -1) tail = tail.slice(0, close);

  // visual은 missing → 빈 문자열. 다른 세 필드와 같은 관용(누락은 예외가 아니라
  // 빈 값)이다 — never throw.
  const scene = { place: "", time: "", weather: "", visual: "" };
  for (const line of tail.split("\n")) {
    const match = SCENE_LINE.exec(line);
    if (match) {
      const key = SCENE_FIELD_KEY[match[1]];
      if (key) scene[key] = match[2].trim();
      continue;
    }
    const visualMatch = VISUAL_LINE.exec(line);
    if (visualMatch) scene.visual = visualMatch[1].trim();
  }
  return scene;
}

export function parseNarration(text) {
  const raw = typeof text === "string" ? text : "";
  const withoutScene = cutSceneBlock(raw);
  const at = withoutScene.indexOf(CHOICE_MARKER);
  if (at === -1) return { narration: withoutScene.trim(), choices: [] };

  const narration = withoutScene.slice(0, at).trim();
  let tail = withoutScene.slice(at + CHOICE_MARKER.length);
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
 * 두 마커는 성격이 다르다 — 이 구분이 이 함수의 핵심이다.
 *   - `<선택지>`는 **컷**이다. 거기서부터 끝까지는 전부 선택지이므로, 만나는 순간
 *     영영 멈춘다.
 *   - `<장면>`은 **잘라내기**다. 실제 narrator 출력은 서술보다 장면 블록이 먼저 오는
 *     모양(맨 앞, `<장면>...</장면>` 다음에 진짜 서술)이라, 장면 블록을 "첫 마커"로
 *     보고 거기서 멈춰버리면 그 뒤에 오는 진짜 서술을 통째로 삼켜 화면에 아무것도
 *     안 뜬다(과거 결함). 장면 블록은 처음이든 중간이든 끝이든 어디에 있든 그
 *     구간만 숨기고, 블록이 끝나면 그 다음 서술은 다시 정상적으로 흘려보내야 한다.
 *
 * 상태 기계 세 가지:
 *   NORMAL   — 서술을 내보내는 중, 두 시작 마커를 함께 감시한다.
 *   IN_SCENE — `<장면>` 안, `</장면>`을 기다리는 중. 이 사이 내용은 무엇이든 절대
 *              내보내지 않는다(닫히지 않으면 스트림 끝까지 그대로 버려진다 —
 *              마크업을 보여주느니 그 뒤 텍스트를 잃는 편이 낫다).
 *   CUT      — `<선택지>`를 만났다. 이후로는 영원히 아무것도 하지 않는다(그 뒤에
 *              `</장면>`이 오더라도 다시 흐르지 않는다).
 *
 * 붙들어 두는 길이(홀드백)는 NORMAL에서 감시하는 두 시작 마커 중 더 긴 쪽
 * (`<선택지>`, 5자) 기준 (길이-1)=4로 잡는다 — 어느 쪽의 앞부분이 걸쳐 오더라도
 * 그 진부분집합을 가리기에 충분하고, 기존에 `<선택지>` 하나만 있을 때 쓰던 값과
 * 정확히 같다. IN_SCENE에서는 홀드백을 따로 두지 않는다 — 그 안에서는 애초에
 * 아무것도 내보내지 않으므로 `</장면>`을 찾을 때까지 그냥 기다리면 되고, 어설프게
 * 커서를 앞으로 당기면 청크 경계에 걸쳐 오는 `</장면>`을 놓칠 위험만 생긴다.
 */
export function createNarrationSplitter() {
  let full = "";       // 지금까지 들어온 원문 전체(가공 없이) — finish()가 그대로 돌려준다
  let output = "";     // 화면에 내도 안전하다고 확정된 서술만 이어붙인 것(장면 블록 내용 제외)
  let emitted = 0;      // output 중 이미 drain으로 내보낸 만큼
  let pos = 0;           // full에서 "처리 완료"가 확정된 지점 — 이 앞은 다시 보지 않는다
  let state = "NORMAL"; // NORMAL | IN_SCENE | CUT
  const HOLDBACK = Math.max(CHOICE_MARKER.length, SCENE_MARKER.length) - 1;

  /**
   * pos부터 확정할 수 있는 만큼 확정해 output에 옮긴다. 장면이 끝나자마자 바로
   * 선택지가 오는 경우처럼 한 번의 push로 상태가 여러 단계를 넘어갈 수 있어
   * 루프를 돈다. 더 확정할 게 없으면(마커가 아직 안 왔거나 장면이 안 닫혔으면)
   * 조용히 멈추고 다음 push나 finish를 기다린다.
   */
  function resolve() {
    for (;;) {
      if (state === "CUT") return;

      if (state === "NORMAL") {
        const choiceAt = full.indexOf(CHOICE_MARKER, pos);
        const sceneAt = full.indexOf(SCENE_MARKER, pos);
        const choiceFirst = choiceAt !== -1 && (sceneAt === -1 || choiceAt <= sceneAt);
        const sceneFirst = !choiceFirst && sceneAt !== -1;

        if (choiceFirst) {
          output += full.slice(pos, choiceAt);
          pos = choiceAt;
          state = "CUT";
          return;
        }
        if (sceneFirst) {
          output += full.slice(pos, sceneAt);
          pos = sceneAt + SCENE_MARKER.length;
          state = "IN_SCENE";
          continue; // </장면>이 이미 같은 조각 안에 와 있을 수 있다
        }

        // 아직 마커가 안 왔다. 마커 길이보다 충분히 이전 문자는 마커의 시작일 수
        // 없으므로 그만큼은 지금 내보내도 안전하다(기존 홀드백 산술 그대로).
        const safeFrontier = Math.max(pos, full.length - HOLDBACK);
        if (safeFrontier > pos) {
          output += full.slice(pos, safeFrontier);
          pos = safeFrontier;
        }
        return;
      }

      // state === "IN_SCENE": </장면>을 찾을 때까지 아무것도 내보내지 않는다.
      const closeAt = full.indexOf(SCENE_CLOSE, pos);
      if (closeAt === -1) return; // 안 닫혔다 — finish까지 조용히 대기
      pos = closeAt + SCENE_CLOSE.length;
      state = "NORMAL";
      // 루프 계속 — 장면 바로 뒤에 선택지나 다음 서술이 있을 수 있다
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
      // 스트림이 끝났다 — NORMAL 중 홀드백으로 붙들려 있던 꼬리는 이제 마커가 될
      // 가능성이 없으므로 전부 내보낸다. IN_SCENE으로 끝났으면(장면이 안 닫혔으면)
      // 그 뒤 텍스트는 버린다. CUT이면 더 낼 것이 없다.
      if (state === "NORMAL" && pos < full.length) {
        output += full.slice(pos);
        pos = full.length;
      }
      const delta = output.length > emitted ? output.slice(emitted) : "";
      emitted = output.length;
      return { delta, full };
    }
  };
}
