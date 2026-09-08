"use strict";

/**
 * 서술 제공처 폴백 체인.
 *
 * 앞에서부터 차례로 시도해 처음 성공한 결과를 돌려준다. 지금 쓰임새는
 * Cloudflare(주) → Gemini(무료 티어 폴백) 둘이지만, 이 파일은 누가 앞이고 누가
 * 뒤인지 모른다 — 순서는 server.js가 정한다.
 *
 * 클라이언트와 같은 규약을 그대로 내보인다(complete/narrate/isConfigured).
 * 호출부(turn.js)는 이게 한 제공처인지 셋인지 알 필요가 없다. 대신 성공한
 * 결과에 두 필드를 더 얹는다:
 *   - provider: 실제로 답한 제공처 이름
 *   - model: 실제로 쓴 모델 이름
 * turn.js가 이 값으로 계량하고 턴에 기록한다. 이게 없으면 Gemini가 쓴 서술을
 * Cloudflare 모델 이름으로 장부에 올려 — 요청한 모델과 실제로 답한 모델이
 * 다른데 기록은 하나뿐인 — 조용한 거짓말이 된다.
 *
 * ── 폴백해도 되는 순간은 언제인가 ──
 *
 * 스트리밍이라 아무 때나 넘어갈 수 없다. narrate()는 받은 글자를 즉시 onToken으로
 * 화면에 흘리는데, 이미 나간 글자는 되돌릴 수 없다. 한 글자라도 나간 뒤에 다른
 * 제공처로 다시 쓰면 플레이어는 같은 장면을 두 번, 그것도 서로 다른 내용으로 본다.
 *
 * 클라이언트 규약이 이걸 막아 준다 — narrate()가 ok:false면 onToken은 한 번도
 * 불리지 않았다(cloudflare.js·gemini.js 상단 참고). 그래도 여기서 한 번 더 센다.
 * 규약을 어기는 클라이언트가 나중에 하나 끼어들면 그 피해가 곧장 플레이어 화면에
 * 나타나기 때문이다(judge.js가 sim.applyJudgment와 같은 검사를 두 번 하는 것과
 * 같은 이유 — 중복이 아니라 방어의 이중화다).
 */

/**
 * 이 코드들에서만 다음 제공처로 넘어간다. 전부 "이 제공처가 지금 응답을 못 한다"는
 * 뜻이고, 다른 제공처라면 될 수 있는 것들이다.
 *
 * AUTH_FAILED도 넣는다. 토큰이 잘못된 건 사람이 고쳐야 할 설정 오류지 가용성
 * 문제가 아니지만, 그것 때문에 플레이어의 턴까지 잃을 이유는 없다. 대신 조용히
 * 넘어가지 않는다 — 성공 결과의 attempts에 무엇이 왜 실패했는지 남고, server.js가
 * 그걸 로그로 찍는다. 가리는 게 아니라 이어 가면서 알린다.
 */
const ADVANCE_ON = new Set([
  "NOT_CONFIGURED",
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "CAPACITY",
  "TIMEOUT",
  "CONNECTION_FAILED",
  "UPSTREAM_ERROR",
  "BAD_RESPONSE",
  "AUTH_FAILED"
]);

/**
 * 반대로 여기서 멈추는 것들(참고용 주석 — 판단은 위 목록의 여집합으로 한다):
 *   - ABORTED: 플레이어가 창을 닫았다. 아무도 안 기다리는 글을 다시 쓸 이유가 없다.
 *   - INVALID_ARGUMENT: 요청 자체가 잘못됐다. 어디로 보내도 똑같이 잘못됐다.
 *   - CONTENT_FILTERED: 내용에 대한 판단이다. 제공처를 갈아 가며 필터를 통과할
 *     때까지 두드리는 건 이 시스템이 할 일이 아니다.
 */

function errorResult(errorCode, message, retryable = false) {
  return { ok: false, error_code: errorCode, message, retryable };
}

/**
 * createFallbackClient({ providers })
 *
 * providers: [{ name, client, model }]
 *   - name  : 로그·응답에 실릴 이름("cloudflare", "gemini")
 *   - client: complete/narrate/isConfigured를 가진 객체
 *   - model : 그 제공처에서 쓸 모델 이름
 *
 * 호출부가 넘긴 model은 **첫 제공처에만** 적용된다. /api/turn이 받는 model은
 * Cloudflare 가격표(NEURONS_PER_MTOK)로 검증된 Cloudflare 모델 이름이라 다른
 * 제공처에서는 뜻이 없다 — Gemini에 "@cf/meta/llama-..."를 넘기면 404다.
 * 뒤쪽 제공처는 각자 등록된 model을 쓴다.
 */
function createFallbackClient({ providers = [] } = {}) {
  const chain = (Array.isArray(providers) ? providers : []).filter(
    (entry) => entry && entry.client && typeof entry.client.narrate === "function"
  );

  function isConfigured() {
    return chain.some((entry) => entry.client.isConfigured());
  }

  /** 설정된 제공처만 남긴다. 설정 안 된 것은 시도조차 하지 않는다. */
  function usable() {
    return chain.filter((entry) => entry.client.isConfigured());
  }

  /**
   * 호출부가 넘긴 model은 **체인의 주 제공처**(chain[0])에만 적용된다.
   *
   * "지금 시도하는 순서의 첫 번째"가 아니다. 주 제공처가 설정 안 돼 빠지면
   * 폴백이 순서상 첫 번째가 되는데, 그때 호출부의 model을 그대로 주면 Gemini에
   * "@cf/meta/llama-..."를 넘기게 된다 — 폴백만 설정한 환경에서 매 턴 404다.
   */
  function modelFor(entry, requested) {
    if (requested && chain.length > 0 && entry === chain[0]) return requested;
    return entry.model;
  }

  /**
   * 체인 전체가 실패했을 때 무엇을 돌려줄지.
   *
   * **첫 제공처의** 오류를 돌려준다. 마지막 것이 아니다 — 운영자가 고쳐야 할 곳은
   * 주 제공처이고, 폴백의 오류만 보여 주면 "Gemini 할당이 없다"는 메시지 뒤로
   * 정작 Cloudflare에서 무슨 일이 있었는지가 사라진다. 대신 attempts에 전부 싣는다.
   */
  function collapse(attempts) {
    if (attempts.length === 0) {
      return errorResult(
        "NOT_CONFIGURED",
        "서술 제공처가 하나도 설정되지 않았습니다. CF_ACCOUNT_ID/CF_API_TOKEN 또는 GEMINI_API_KEY가 필요합니다.",
        false
      );
    }
    const first = attempts[0];
    const trail = attempts.map((item) => `${item.provider}=${item.error_code}`).join(", ");
    return {
      ...first.error,
      message: attempts.length > 1 ? `${first.error.message} (폴백도 모두 실패: ${trail})` : first.error.message,
      attempts
    };
  }

  /**
   * complete/narrate 공통 순회.
   *
   * run(entry, model)은 그 제공처를 한 번 호출한다. guard()는 폴백이 아직
   * 허용되는지 묻는다(스트리밍에서 글자가 이미 나갔으면 false).
   */
  async function chainCall({ requestedModel, run, guard }) {
    const list = usable();
    const attempts = [];

    for (const entry of list) {
      const model = modelFor(entry, requestedModel);
      const result = await run(entry, model);

      if (result.ok) {
        return { ...result, provider: entry.name, model, attempts };
      }

      attempts.push({ provider: entry.name, error_code: result.error_code, error: result });

      if (!ADVANCE_ON.has(result.error_code)) break;
      // 이미 화면에 글자가 나갔으면 여기서 멈춘다 — 겹쳐 쓰지 않는다.
      if (guard && !guard()) break;
    }

    return collapse(attempts);
  }

  async function complete({ model, ...rest } = {}) {
    return chainCall({
      requestedModel: model,
      run: (entry, resolved) => entry.client.complete({ ...rest, model: resolved })
    });
  }

  async function narrate({ model, onToken, ...rest } = {}) {
    let emitted = false;

    return chainCall({
      requestedModel: model,
      run: (entry, resolved) => entry.client.narrate({
        ...rest,
        model: resolved,
        onToken: onToken
          ? (piece) => {
              // 플래그를 먼저 세운다. onToken이 던져도 "글자는 이미 나갔다"는
              // 사실은 남아야 한다 — 그 예외가 폴백을 열어 주면 안 된다.
              emitted = true;
              onToken(piece);
            }
          : (_piece) => { emitted = true; }
      }),
      guard: () => !emitted
    });
  }

  /** 헬스 체크용 — 어떤 제공처가 어떤 순서로, 설정됐는지 그대로 보여 준다. */
  function describe() {
    return chain.map((entry) => ({
      provider: entry.name,
      model: entry.model,
      configured: entry.client.isConfigured()
    }));
  }

  return { complete, narrate, isConfigured, describe };
}

module.exports = { createFallbackClient, ADVANCE_ON };
