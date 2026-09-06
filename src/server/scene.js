"use strict";

/**
 * 장면 배경 이미지 서비스.
 *
 * 장면이 바뀔 때만(narration.parseScene이 null이 아닌 것을 돌려줄 때만) 호출된다.
 * 캐시 키는 world_id + 장소 + 시간 + 날씨의 해시다 — 같은 교실로 돌아오면 같은
 * 파일을 그대로 돌려준다(새로 그리지 않는다). "같은 그림"이 "비슷한 그림"보다
 * 강한 일관성을 준다는 것이 이 기능 전체의 설계 근거다.
 *
 * 이 모듈은 인물을 그리지 않는다. 카드도, 주인공 이름도, persona 텍스트도 받지
 * 않는다 — 애초에 프롬프트를 만들 재료로 넘기지 않으면 "인물이 샌다"는 사고 자체가
 * 구조적으로 불가능하다.
 *
 * CommonJS. src/core/를 참조하지 않는다(장면 파싱은 turn.js가 narration.js로 이미
 * 끝내고 {place,time,weather,visual}만 여기로 넘긴다) — 그래서 이 파일은 await
 * import()가 필요 없다. place/time/weather는 캐시 키·화면 라벨용 한국어이고,
 * visual만 이미지 프롬프트의 재료(영어)다 — buildPrompt 참고.
 *
 * error_code 어휘는 다른 모듈과 같다: INVALID_ARGUMENT | CONNECTION_FAILED |
 * (client.generate가 돌려주는 그대로) AUTH_FAILED | QUOTA_EXHAUSTED | CAPACITY |
 * RATE_LIMITED | UPSTREAM_ERROR | BAD_RESPONSE | NOT_CONFIGURED | TIMEOUT | INTERNAL
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { IMAGE_MODELS, DEFAULT_IMAGE_MODEL } = require("../llm/image");

/** 이 API는 prompt를 1~2048자로 제한한다(Cloudflare 스키마). */
const MAX_PROMPT_LENGTH = 2048;

/**
 * 사람을 배제하는 절. negative prompt가 없는 API라 배제를 프롬프트 안에 긍정문으로
 * 박아 넣어야 한다(스펙 설명 그대로). **영어로만 쓴다** — flux-1-schnell은 영어
 * 캡션으로 학습되어 있고, 한국어를 섞으면 그 자체가 노이즈가 되어 모델이 약한
 * 잔여 신호로 되돌아가 버린다(플레이어가 신고한 "모든 배경이 중국풍 짝퉁 같다"는
 * 결함의 근본 원인 — buildPrompt 전체가 한국어 67%였다). 아래에서 조립하는 프롬프트
 * 전체가 영어여야 한다는 불변식은 resolveScene의 한글 검사가 지킨다.
 */
const EMPTINESS_CLAUSE = "empty, unoccupied, no people, no figures, no characters, deserted, background only.";

/**
 * 부정 프롬프트. negative_prompt를 받는 모델(현재는 phoenix-1.0)에만 보낸다.
 *
 * EMPTINESS_CLAUSE가 왜 아직도 있는지: "사람 없음"을 긍정문으로 프롬프트에
 * 박아 넣는 방식은 negative_prompt가 없는 모델(flux-1-schnell, lucid-origin)의
 * 유일한 수단이라 그대로 남긴다(아래 buildPrompt의 omitEmptinessClause 참고 —
 * negative_prompt를 실제로 보내는 모델에서는 이 절을 프롬프트 본문에서 뺀다).
 * 반면 이 NEGATIVE_PROMPT는 진짜 부정 채널이다 — "그리지 말 것"을 모델이
 * 실제로 억제 대상으로 다루는 필드에 싣는다. 인물이 배경에 새어 들어오면
 * 인물 일관성 문제(이름·외형)가 곁문으로 다시 들어오므로, 사람과 관련된
 * 항목(사람·인물·얼굴·군중·손)을 우선하고, 통상적인 이미지 생성 잡음
 * (텍스트·워터마크·서명·로고·저품질·여분의 팔다리)도 함께 배제한다.
 * 영어로만 쓴다 — 아래 resolveScene의 한글 검사가 buildPrompt의 결과뿐 아니라
 * 이 값에도 그대로 적용된다.
 */
const NEGATIVE_PROMPT = "people, person, human figure, character, characters, face, faces, crowd, crowds, hands, fingers, text, watermark, signature, logo, blurry, low quality, extra limbs.";

/** 한글(가-힣) 포함 여부. buildPrompt/NEGATIVE_PROMPT가 실수로 한국어를 실었는지 확인하는 데만 쓴다. */
const HANGUL_RE = /[가-힣]/;

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * 응답 바이트로 실제 이미지 형식을 판별한다. Cloudflare의 flux-1-schnell 문서
 * 페이지는 응답을 base64 이미지라고만 적어 두지만, 실제로 받아 보면 JPEG다
 * (매직 바이트 FF D8 FF, base64로는 "/9j/"로 시작) — PNG가 아니다. 확장자를
 * 하드코딩하지 않고 바이트에서 직접 판별하는 이유는, 모델이 나중에 형식을
 * 바꿔도(Cloudflare가 흔히 그러듯 공지 없이) "조용히 잘못된 파일"이 아니라
 * "형식을 모르겠다"는 에러로 드러나야 하기 때문이다.
 */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 캐시 파일을 찾을 때 시도할 확장자 순서. 새로 쓸 때는 실제로 감지된 형식만 쓴다. */
const KNOWN_IMAGE_EXTENSIONS = ["jpg", "png"];

function detectImageExtension(buffer) {
  if (buffer.length >= JPEG_MAGIC.length && buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return "jpg";
  }
  if (buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return "png";
  }
  return null;
}

/**
 * 캐시 키. world_id + 장소 + 시간 + 날씨 넷을 NUL로 구분해 해시한다 — 필드
 * 구분자를 두지 않고 그냥 이어붙이면 "교실"+"밤"과 "교"+"실밤"이 같은 해시가 되는
 * 사고가 날 수 있다(src/server/cache.js의 makeKey와 같은 이유로 같은 관용을 쓴다).
 */
function sceneHash({ worldId, scene }) {
  return crypto
    .createHash("sha256")
    .update(String(worldId || ""))
    .update("\0")
    .update(String(scene.place || ""))
    .update("\0")
    .update(String(scene.time || ""))
    .update("\0")
    .update(String(scene.weather || ""))
    .digest("hex");
}

/**
 * 해시에서 결정론적 정수 하나를 뽑는다. 원래 목적은 이 값을 flux-1-schnell의
 * `seed`로 보내, 캐시를 지우고 다시 그려도 같은 그림이 나오게 하는 것이었다.
 *
 * 그 전제는 깨졌다: 실제로 배포된 flux-1-schnell은 `seed` 필드가 존재하기만
 * 해도(값과 무관하게) 요청 전체를 400으로 거부한다(AiError 5006,
 * "Additional or unevaluated properties '/seed' at '/' not allowed") —
 * Cloudflare의 모델 문서 페이지가 seed를 파라미터로 문서화하고 있는 것과
 * 다르게, 실제 배포된 모델은 이 필드를 아예 받지 않는다. 그래서 resolveScene은
 * 이제 이 함수를 호출하지 않고, `client.generate()`에 seed를 절대 보내지
 * 않는다(src/llm/image.js 참고).
 *
 * "캐시를 지우고 다시 그리면 같은 그림이 나온다"는 성질은 이 API로는 더 이상
 * 복구할 수 없다 — 대체 수단은 없다. 지금 남은 유일한 일관성 보장은 캐시
 * 파일 자체다: 같은 장면이면 같은 해시가 같은 파일을 그대로 돌려준다(동일성),
 * 캐시가 없으면 매번 다른 그림이 나온다(유사성조차 보장되지 않는다). 이
 * 함수는 순수 함수라 여전히 테스트되고 export되지만, 실사용 경로에서는
 * 죽은 코드다 — 나중에 seed를 받는 이미지 모델로 옮기면 그때 다시 쓸모가
 * 생길 수 있어 지우지 않고 남겨 둔다.
 */
function seedFromHash(hash) {
  const n = parseInt(hash.slice(0, 8), 16);
  return (n % 2147483646) + 1; // 1 ~ 2147483646
}

/**
 * 프롬프트 조립. **전체가 영어여야 한다** — 이 함수는 이제 한국어 재료를 전혀
 * 쓰지 않는다:
 *
 *   - world.setting(한국어 배경 설명)과 world.tone은 더 이상 쓰지 않는다. tone은
 *     애초에 "글을 어떻게 쓸지"를 지시하는 문장이지 장소가 어떻게 생겼는지가
 *     아니었다 — 그림에는 처음부터 노이즈였다.
 *   - 장면의 place/time/weather(한국어, 화면 라벨이자 캐시 키)도 쓰지 않는다.
 *
 * 대신 두 영어 재료만 쓴다: world.visual_style(세계관 단위로 저자가 미리 써 둔
 * 아트 디렉션 — 화풍·팔레트·톤)과 scene.visual(narrator가 이번 장면에 대해 매
 * 턴 새로 쓰는 구체적 시각 묘사, src/core/narration.js의 VISUAL_LINE 참고).
 * scene.visual은 이번 턴에 실제로 바뀐 사실이라 자르지 않는다 — 2048자를 넘기면
 * world.visual_style 쪽만 잘라낸다(어차피 세계관 전체에 걸친 요약이라 좀 잘려도
 * 뜻이 크게 상하지 않는다).
 *
 * 호출부(resolveScene)가 scene.visual이 비어 있을 때 이 함수를 아예 부르지
 * 않는 것으로 A4 폴백을 구현한다 — 여기서는 그 판단을 하지 않는다(순수 조립
 * 함수로 남긴다).
 *
 * omitEmptinessClause: negative_prompt를 실제로 보내는 모델(phoenix-1.0)을 쓸
 * 때 resolveScene이 true로 넘긴다 — "사람 없음"을 긍정문으로 프롬프트에 욱여
 * 넣는 것은 negative_prompt가 없는 모델을 위한 우회로였는데, 진짜 부정 채널이
 * 있으면 그 우회로를 프롬프트 본문에 중복으로 남겨 둘 이유가 없다(글자 수만
 * 축내고, style이 잘릴 여지만 늘린다). 기본값은 false다 — 이 함수를 직접
 * 호출하는 기존 테스트/호출부는 이 인자를 전혀 몰라도 이전과 완전히 같은
 * 결과를 받는다.
 */
function buildPrompt({ world, scene, omitEmptinessClause = false } = {}) {
  const header = "background illustration, photorealistic digital painting. place only, no characters.";
  const visual = (scene && scene.visual) || "";
  const style = (world && world.visual_style) || "";
  const emptiness = omitEmptinessClause ? "" : EMPTINESS_CLAUSE;

  // visual(장면별, 이번 턴 재료)은 보호한다 — 잘리는 건 style(세계관 단위 요약)뿐이다.
  const fixed = [header, visual, emptiness];
  const fixedLength = fixed.filter(Boolean).join(" ").length + 2; // 조립 시 재료 앞뒤로 붙는 공백 여유

  const budget = Math.max(0, MAX_PROMPT_LENGTH - fixedLength);
  let trimmedStyle = style;
  if (trimmedStyle.length > budget) trimmedStyle = trimmedStyle.slice(0, budget).trim();

  const prompt = [header, trimmedStyle, visual, emptiness].filter(Boolean).join(" ");
  return prompt.length > MAX_PROMPT_LENGTH ? prompt.slice(0, MAX_PROMPT_LENGTH) : prompt;
}

/**
 * resolveScene({ world, scene, client, budget, rootDir })
 *   -> { ok:true, url, cached }
 *   -> { ok:false, error_code, message, retryable }
 *
 * client는 src/llm/image.js의 createImageClient() 결과(또는 같은 모양의 generate를
 * 가진 대역)를 기대한다. rootDir 아래 data/scenes/{world_id}/{hash}.{jpg|png}에
 * 쓴다 — 확장자는 하드코딩하지 않고 응답 바이트에서 감지한 형식을 그대로 쓴다
 * (detectImageExtension 참고. 실제 flux-1-schnell은 JPEG를 돌려준다).
 *
 * 캐시 히트를 확인할 때는 응답을 아직 못 받았으므로 형식을 모른다 — 그래서
 * KNOWN_IMAGE_EXTENSIONS 순서대로 두 확장자를 모두 시도해 먼저 찾히는 파일을
 * 쓴다. sceneHash 자체(캐시 키)는 그대로다 — 형식 문제와 무관하다.
 */
async function resolveScene({ world, scene, client, budget, rootDir } = {}) {
  if (!scene || typeof scene !== "object") {
    return errorResult("INVALID_ARGUMENT", "장면 묘사(scene)가 필요합니다.", false);
  }
  const worldId = String((world && world.world_id) || "");
  if (!worldId) {
    return errorResult("INVALID_ARGUMENT", "world.world_id가 필요합니다.", false);
  }

  const hash = sceneHash({ worldId, scene });
  const dir = path.join(String(rootDir || path.join(__dirname, "..", "..")), "data", "scenes", worldId);

  // 캐시 적중 — 이게 이 기능의 핵심이다. 이미 있으면 클라이언트를 아예 부르지 않는다.
  // 형식(확장자)을 아직 모르므로 알려진 확장자를 순서대로 시도한다.
  for (const ext of KNOWN_IMAGE_EXTENSIONS) {
    const candidate = path.join(dir, `${hash}.${ext}`);
    try {
      if (fs.existsSync(candidate)) {
        return { ok: true, url: `/data/scenes/${worldId}/${hash}.${ext}`, cached: true };
      }
    } catch (_error) {
      // 존재 확인 자체가 실패해도(권한 등) 캐시 미스로 보고 다음 확장자/생성으로 넘어간다.
    }
  }

  if (!client || typeof client.generate !== "function") {
    return errorResult("CONNECTION_FAILED", "이미지 클라이언트가 없습니다.", true);
  }

  // A4 폴백: narrator가 <장면> 블록에 visual(영어 묘사)을 안 썼다. 여기서 한국어
  // place/time/weather로 대체 조립하면 이 기능 전체의 존재 이유(영어 전용 프롬프트)가
  // 다시 깨지므로, 그 대신 이 장면의 이미지 생성을 통째로 건너뛴다 — 패널은 텍스트
  // placeholder로 남는다(server.js가 !ok 결과를 로그만 남기고 scene SSE를 보내지
  // 않는 것과 정확히 같은 경로). world.visual_style만으로 그리는 대안도 있었지만,
  // 그러면 그 세계관의 모든 "바뀐 장면"이 같은 그림이 되어 이 기능의 핵심 가치
  // (장면마다 다른, 그러나 같은 장면이면 같은 그림)를 잃는다 — 그래서 건너뛰는
  // 쪽을 골랐다.
  const visual = scene.visual && String(scene.visual).trim();
  if (!visual) {
    return errorResult(
      "INVALID_ARGUMENT",
      "장면에 visual(영어 시각 묘사)이 없어 이미지 생성을 건너뜁니다 — narrator가 <장면> 블록에 visual 줄을 빠뜨렸습니다.",
      false
    );
  }

  // client가 어떤 모델로 구성됐는지(client.model, src/llm/image.js의
  // createImageClient가 채워 준다)로 negative_prompt 지원 여부를 판단한다.
  // client가 model을 모르면(예: 이 필드를 안 채운 대역/과거 스타일 페이크)
  // 부정 채널을 지원하지 않는다고 보수적으로 가정한다 — 알 수 없는 모델에
  // 임의로 negative_prompt 필드를 만들어 보내는 쪽보다, 기존처럼 긍정 문구
  // (EMPTINESS_CLAUSE)만 쓰는 쪽이 회귀 위험이 없다.
  const modelId = client.model;
  const modelConfig = modelId ? IMAGE_MODELS[modelId] : null;
  const acceptsNegativePrompt = Boolean(modelConfig && modelConfig.acceptsNegativePrompt);
  const negativePrompt = acceptsNegativePrompt ? NEGATIVE_PROMPT : undefined;

  const prompt = buildPrompt({ world, scene, omitEmptinessClause: acceptsNegativePrompt });
  // A3 안전장치: 조립된 프롬프트에 한글이 남아 있으면 그 자체가 버그다(위 buildPrompt
  // 주석 참고 — 재료를 전부 영어로만 골랐으니 정상 경로에서는 있을 수 없다). 잘못된
  // 이미지 하나를 더 만드느니, 여기서 멈추고 구조화 오류로 알린다. 장면 패널은
  // 이 경우에도 이미 텍스트 placeholder로 정상 동작한다. NEGATIVE_PROMPT는
  // 고정 상수라 정상 경로에서 한글이 섞일 수 없지만, 같은 불변식이므로 같은
  // 방식으로 지킨다.
  if (HANGUL_RE.test(prompt) || (negativePrompt && HANGUL_RE.test(negativePrompt))) {
    return errorResult(
      "INTERNAL",
      "이미지 프롬프트에 한글이 섞여 있습니다(버그) — 전송하지 않습니다.",
      false
    );
  }
  // seed를 보내지 않는다 — 실제 flux-1-schnell은 그 필드가 있기만 해도 400을 낸다
  // (seedFromHash의 docstring, src/llm/image.js의 buildFluxBody 참고). steps는
  // 넘기지 않는다 — 모델별 기본 스텝 수는 client가 이미 알고 있다(createImageClient
  // 생성 시점에 server.js가 채워 넣거나, 그마저 없으면 레지스트리 기본값을 쓴다).
  const generated = await client.generate({ prompt, negativePrompt });
  if (!generated.ok) return generated;

  if (budget) {
    budget.recordImage({
      // client가 model을 모르면(위와 같은 이유로) 계량이라도 하도록 앱의 기본
      // 모델(DEFAULT_IMAGE_MODEL)로 가정한다 — 실제 운영 경로에서는 client.model이
      // 항상 채워져 있으므로 이 폴백은 model 정보가 없는 대역에서만 쓰인다.
      model: modelId || DEFAULT_IMAGE_MODEL,
      tiles: generated.usage && generated.usage.tiles,
      steps: generated.usage && generated.usage.steps
    });
  }

  const buffer = Buffer.from(generated.base64, "base64");
  const ext = detectImageExtension(buffer);
  if (!ext) {
    // 모르는 형식을 확장자 없이(또는 틀린 확장자로) 디스크에 쓰면 나중에 조용히
    // 깨진 이미지로만 드러난다 — 여기서 구조화 오류로 즉시 드러낸다. Cloudflare는
    // 이미 이 호출의 Neurons를 청구했으므로(위에서 이미 기록했다) 예산 기록은
    // 그대로 두고 파일만 쓰지 않는다.
    return errorResult("BAD_RESPONSE", "Workers AI가 알 수 없는 이미지 형식을 반환했습니다.", false);
  }

  const file = path.join(dir, `${hash}.${ext}`);
  const url = `/data/scenes/${worldId}/${hash}.${ext}`;

  // 쓰기 실패는 턴을 죽이면 안 된다 — 이 저장소가 이미 겪은 교훈(가드 없는 호출이
  // 프로세스를 죽인 적이 있다)을 여기서도 지킨다. 구조화 오류로 감싸 돌려준다.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buffer);
  } catch (_error) {
    return errorResult("INTERNAL", "장면 이미지를 저장하지 못했습니다.", false);
  }

  return { ok: true, url, cached: false };
}

module.exports = {
  resolveScene, sceneHash, seedFromHash, buildPrompt, detectImageExtension,
  MAX_PROMPT_LENGTH, EMPTINESS_CLAUSE, NEGATIVE_PROMPT, KNOWN_IMAGE_EXTENSIONS
};
