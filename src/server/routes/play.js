"use strict";
const { getSettings } = require('../settings');
const { loadWorld } = require('../world_store');
const { getClient, getCloudflareClient, getNarrationClient, getDirectorClient, getImageClient, getSceneRoot, turnBudget } = require('../clients');
const { DEFAULT_NARRATION_MODEL, NEURONS_PER_MTOK } = require('../../llm/budget');
const turn = require('../turn');
const scene = require('../scene');
const { errorBody, watchDisconnect, startSse } = require('../http');

module.exports = function registerRoutes(app) {
  app.get("/api/cf/health", (_req, res) => {
    res.json({
      ok: true,
      configured: getCloudflareClient().isConfigured(),
      model: DEFAULT_NARRATION_MODEL,
      // 체인 전체를 그대로 보여 준다 — 어떤 제공처가 어떤 순서로 있고 각각 설정이
      // 됐는지. 폴백은 평소에 안 보이므로(주 제공처가 살아 있는 동안은 한 번도
      // 안 불린다), 정작 필요한 날에 키가 비어 있었다는 걸 그때 알게 되면 늦다.
      providers: getNarrationClient().describe(),
      budget: turnBudget.snapshot()
    });
  });

  app.post("/api/turn", async (req, res) => {
    const userInput = String(req.body?.user_input || "").trim();
    const model = String(req.body?.model || DEFAULT_NARRATION_MODEL).trim();
    const wantsStream = String(req.headers.accept || "").includes("text/event-stream");

    if (!userInput) {
      res.status(400).json(errorBody("INVALID_ARGUMENT", "행동을 입력하세요."));
      return;
    }

    // model은 llm/cloudflare.js에서 업스트림 URL 경로에 그대로 들어간다
    // (`${base}/accounts/${account}/ai/run/${model}`). fetch/URL은 경로 세그먼트의
    // `..`를 정규화하므로, 검증 없이 넘기면 `../../../../accounts/X/tokens/verify` 같은
    // 값이 인증된(Authorization: Bearer) 요청을 임의의 Cloudflare v4 API 경로로 보낼 수
    // 있다 — world_id를 WORLD_ID 정규식으로 제한하는 것과 같은 이유다. 가격표에 있는
    // 모델만 허용하면 검증과 동시에 계량 가능함도 보장된다.
    if (!Object.prototype.hasOwnProperty.call(NEURONS_PER_MTOK, model)) {
      res.status(400).json(errorBody(
        "INVALID_ARGUMENT",
        `지원하지 않는 model입니다. 다음 중 하나를 쓰세요: ${Object.keys(NEURONS_PER_MTOK).join(", ")}`
      ));
      return;
    }

    const { normalizeSession } = await import("../../core/session.js");
    const session = normalizeSession(req.body?.session);

    const loaded = await loadWorld(session.world_id);
    if (!loaded.ok) {
      res.status(loaded.status).json(errorBody(loaded.error_code, loaded.message));
      return;
    }

    const { isPlayableCard } = await import("../../core/card.js");
    const playableCards = loaded.cards.filter((card) => isPlayableCard(card) &&
      (!session.card_ids.length || session.card_ids.includes(card.card_id)));
    if (!playableCards.length) {
      res.status(400).json(errorBody("INVALID_ARGUMENT", "이야기에 참여할 캐릭터가 없습니다. 세계관에서 카드를 확인하세요."));
      return;
    }

    const sse = wantsStream ? startSse(res) : null;
    const abort = watchDisconnect(res);

    let result;
    try {
      result = await turn.runTurn({
        world: loaded.world,
        cards: playableCards,
        session,
        userInput,
        client: getNarrationClient(),
        model,
        budget: turnBudget,
        onNarration: (delta) => { if (sse) sse.send("narration", { delta }); },
        signal: abort.signal,
        // 로컬 Ollama가 판정자다. 없거나(설치 안 함) 죽어 있으면 judge.js가
        // CONNECTION_FAILED를 돌려주고 runTurn은 judge_unavailable:true로 턴을
        // 그대로 성공시킨다 — 판정 하나 때문에 턴을 잃지 않는다(스펙 그대로).
        judgeClient: getClient(),
        // 미술감독. 잔액이 없거나(PAYMENT_REQUIRED) 호출이 실패하면 runTurn이
        // scene_unavailable:true로 턴을 그대로 성공시킨다 — 배경 그림 하나 때문에
        // 턴을 잃지 않는다.
        directorClient: getDirectorClient(),
        confidenceThreshold: getSettings().SCENE_CONFIDENCE
      });
    } catch (error) {
      console.error("[turn] error:", error);
      result = errorBody("INTERNAL", "턴 생성 내부 오류");
    }

    if (abort.signal.aborted) return;

    // 폴백이 실제로 쓰였으면 남긴다. 플레이어 화면에는 아무 일도 없어 보이지만
    // (그게 폴백의 목적이다), 주 제공처가 왜 답하지 못했는지는 운영자가 알아야
    // 한다 — 할당이 말랐는지, 토큰이 잘못됐는지는 대응이 전혀 다르다.
    if (result.ok && result.provider_attempts) {
      const trail = result.provider_attempts.map((item) => `${item.provider}=${item.error_code}`).join(", ");
      console.warn(`[turn] 폴백 사용: ${trail} → ${result.provider}`);
    }

    if (!result.ok) {
      const body = errorBody(result.error_code, result.message, result.retryable);
      if (sse) {
        sse.send("error", body);
        sse.end();
      } else {
        res.status(result.error_code === "INVALID_ARGUMENT" ? 400 : 502).json(body);
      }
      return;
    }

    const body = {
      turn: result.turn,
      session: result.session,
      budget: result.budget,
      truncated: result.truncated,
      budget_unknown: result.budget_unknown,
      // 게이지가 왜 움직였는지(last_change)와 판정기가 살아 있었는지(judge_unavailable)를
      // 실어 보낸다 — runTurn은 이미 이 값들을 계산해 돌려주지만, 이 응답 바디가 그동안
      // 빠뜨리고 있었다. play.html의 게이지/트리거 UI는 이 두 필드 없이는 아무것도
      // 그릴 수 없다(sim 자체는 session.sim에 이미 실려 있다).
      judge_unavailable: result.judge_unavailable,
      last_change: result.last_change,
      // 이 턴을 실제로 쓴 제공처. Cloudflare가 아니면 budget_unknown이 함께 true가
      // 되는데(Neuron은 Cloudflare의 단위다 — turn.js 참고), 이 필드가 있어야 UI가
      // "단가를 모른다"와 "Cloudflare가 아니라 무료 폴백이 썼다"를 구분해 보여 준다.
      provider: result.provider,
      // 장면 판정 호출이 실패했을 때만 true다(judge_unavailable과 같은 원칙 —
      // 모르는 값을 "없음"으로 적지 않는다). 이 턴은 장면을 유지한 채 성공했다.
      scene_unavailable: result.scene_unavailable
    };
    if (sse) {
      sse.send("done", body);
    } else {
      res.json(body);
    }

    // 장면 이미지는 서술이 화면에 완전히 다 흐른 "다음"이다 — 독자는 이미 서술과
    // 선택지를 전부 받았고, 이건 그 위에 몇 초 늦게 얹히는 배경 그림일 뿐이다.
    // result.scene이 null이면(장면이 안 바뀌었으면) 아무 것도 하지 않는다. 여기서
    // 실패해도(Workers AI 오류, 디스크 쓰기 실패 등) 턴은 이미 성공한 채로 끝났다 —
    // 그림 한 장 때문에 턴을 실패시키지 않는다. SSE가 아니면 보낼 채널이 없으니
    // 그래도 캐시는 데워 두고 조용히 끝낸다(다음에 같은 장면이 오면 즉시 나간다).
    // 장면 판정이 실패했으면 왜 실패했는지 운영자가 알아야 한다 — 특히
    // PAYMENT_REQUIRED(게이트웨이 잔액)처럼 사람이 고쳐야 하는 것. 플레이어 화면에는
    // 그냥 배경이 안 바뀐 것으로만 보인다.
    if (result.scene_unavailable) {
      console.warn("[director] 장면 판정 실패 — 장면을 유지합니다.");
    }

    // 신뢰도 미달로 장면을 유지한 턴. 이걸 서술과 함께 모으면 world.stage에 빠진
    // 장소의 목록이 된다(설계 6절의 "운영 대응은 로그다"). 서술은 앞부분만 남긴다 —
    // 로그에 본문을 통째로 쏟으면 읽을 수 없다.
    if (result.scene_low_confidence) {
      const answers = result.scene_answers || {};
      const summary = ["place", "time", "weather"]
        .map((key) => {
          const a = answers[key];
          return a ? `${key}=${a.choice}(${a.confidence})` : `${key}=?`;
        })
        .join(" ");
      console.warn(`[director] 신뢰도 미달로 장면 유지: ${summary} | ${result.turn.narration.slice(0, 80)}`);
    }

    // 그림을 그릴지는 scene이 아니라 scene_changed가 정한다 — 장면이 안 바뀐 턴에도
    // result.scene에는 (직전 장면이 있으면) 값이 들어 있다.
    if (result.scene_changed && result.scene) {
      try {
        const sceneResult = await scene.resolveScene({
          world: loaded.world,
          scene: result.scene,
          client: getImageClient(),
          budget: turnBudget,
          rootDir: getSceneRoot()
        });
        if (!sceneResult.ok) {
          console.error("[scene] resolve error:", sceneResult.error_code, sceneResult.message);
        } else if (sse) {
          sse.send("scene", { url: sceneResult.url, cached: sceneResult.cached });
        }
      } catch (error) {
        console.error("[scene] 내부 오류:", error);
      }
    }

    if (sse) sse.end();
  });

};
