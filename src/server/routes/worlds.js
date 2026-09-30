"use strict";
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../settings');
const { loadWorld } = require('../world_store');
const { getClient } = require('../clients');
const { isAllowedSmallModel } = require('../ollama_client');
const { compileCards } = require('../compile_card');
const { fetchSource } = require('../fetch_source');
const { saveGeneratedCards } = require('../card_library');
const { errorBody, watchDisconnect, startSse } = require('../http');

module.exports = function registerRoutes(app) {
  app.get("/api/worlds", async (_req, res) => {
    const dir = path.join(ROOT, "data", "worlds");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch (error) {
      console.error("[worlds] list error:", error);
      files = [];
    }

    const worlds = [];
    for (const file of files) {
      const worldId = file.slice(0, -".json".length);
      const loaded = await loadWorld(worldId);
      if (!loaded.ok) {
        // 파일 하나가 깨졌다고 목록 전체가 죽으면 안 된다 — loadWorld가 이미 파싱/모양
        // 오류를 잡아 ok:false로 돌려주므로 여기서는 건너뛰고 계속한다.
        console.error(`[worlds] '${worldId}' 건너뜀: ${loaded.message}`);
        continue;
      }
      worlds.push({
        world_id: loaded.world.world_id,
        title: loaded.world.title,
        setting: loaded.world.setting,
        card_names: loaded.cards.map((card) => card.canonical_name)
      });
    }

    res.json({ worlds });
  });

  /**
   * 세계관 상세. 헤더·캐스트·오프닝을 한 번에 그리도록 정규화된 {world, cards}를
   * 그대로 돌려준다. 경로 조작 방지는 loadWorld 안의 WORLD_ID 검사를 그대로 재사용한다
   * — world_id가 파일 경로에 들어가는 지점은 한 곳(loadWorld)이어야 검사도 한 곳이다.
   */
  app.get("/api/worlds/:world_id", async (req, res) => {
    const loaded = await loadWorld(req.params.world_id);
    if (!loaded.ok) {
      res.status(loaded.status).json(errorBody(loaded.error_code, loaded.message));
      return;
    }
    res.json({ world: loaded.world, cards: loaded.cards });
  });

  /** 사람이 검수한 카드만 수정한다. 나머지 저작된 세계관 필드는 그대로 보존한다. */
  app.post("/api/worlds/:world_id/compile", async (req, res) => {
    const loaded = await loadWorld(req.params.world_id);
    if (!loaded.ok) return res.status(loaded.status).json(errorBody(loaded.error_code,loaded.message));
    const { text, url, model = "qwen3.5:4b" } = req.body || {};
    if ((typeof text !== "string" || !text.trim()) === (typeof url !== "string" || !url.trim()) ||
        typeof model !== "string" || !isAllowedSmallModel(model)) {
      return res.status(400).json(errorBody("INVALID_ARGUMENT","설정 본문 또는 Fandom URL 하나와 4B~7B Ollama 모델을 지정하세요."));
    }
    const sse = String(req.headers.accept || "").includes("text/event-stream") ? startSse(res) : null;
    const abort = watchDisconnect(res);
    function finishError(result) {
      if (abort.signal.aborted) return;
      if (sse) {sse.send("error",errorBody(result.error_code,result.message));sse.end();}
      else res.status(result.error_code === "INVALID_ARGUMENT" ? 400 : 502).json(errorBody(result.error_code,result.message));
    }
    try {
      let source = {ok:true,text,source_url:""};
      if (url) {
        sse?.send("progress",{message:"설정 문서를 가져오고 있습니다."});
        source = await fetchSource(url);
        if (!source.ok) return finishError(source);
      }
      const result = await compileCards({text:source.text,sourceUrl:source.source_url,worldId:req.params.world_id,
        model,client:getClient(),signal:abort.signal,onProgress:(progress) => sse?.send("progress",progress)});
      if (!result.ok) return finishError(result);
      if (abort.signal.aborted) return;
      const saved = saveGeneratedCards(path.join(ROOT,"data","worlds"),req.params.world_id,result);
      const body = {ok:true,card_ids:saved.added.map((card) => card.card_id),added:saved.added.length,skipped:saved.skipped,diagnostics:result.diagnostics};
      if (sse) {sse.send("done",body);sse.end();} else res.json(body);
    } catch (error) {
      console.error("[card-compile]",error.message);
      finishError({error_code:"INTERNAL",message:"카드 생성 또는 저장에 실패했습니다. 기존 카드는 유지됩니다."});
    }
  });

  app.put("/api/worlds/:world_id/cards/:card_id", async (req, res) => {
    const loaded = await loadWorld(req.params.world_id);
    if (!loaded.ok) return res.status(loaded.status).json(errorBody(loaded.error_code, loaded.message));
    const card = loaded.cards.find((item) => item.card_id === req.params.card_id);
    if (!card) return res.status(404).json(errorBody("NOT_FOUND", "카드를 찾을 수 없습니다."));
    const { canonical_name, traits, taboos, examples, knowledge_as_of, status } = req.body || {};
    const validLines = (value) => Array.isArray(value) && value.length <= 50 && value.every((line) => typeof line === "string" && line.length <= 2000);
    if (typeof canonical_name !== "string" || !canonical_name.trim() || canonical_name.length > 100 ||
        !validLines(traits) || !validLines(taboos) || !validLines(examples) ||
        typeof knowledge_as_of !== "string" || knowledge_as_of.length > 2000 ||
        !["confirmed", "edited", "rejected"].includes(status)) {
      return res.status(400).json(errorBody("INVALID_ARGUMENT", "이름, 성격, 금기, 대사, 지식 시점과 검수 상태를 확인하세요."));
    }
    try {
      const file = path.join(ROOT, "data", "worlds", `${req.params.world_id}.json`);
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const index = loaded.cards.findIndex((item) => item.card_id === card.card_id);
      const current = raw.cards[index];
      raw.cards[index] = { ...current, canonical_name: canonical_name.trim(), knowledge_as_of, status,
        persona: { ...current.persona, traits, taboos }, speech: { ...current.speech, examples } };
      const temp = `${file}.${require("crypto").randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", { flag: "wx" });
        fs.renameSync(temp, file);
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("[card] save error:", error);
      res.status(500).json(errorBody("INTERNAL", "카드를 저장하지 못했습니다."));
    }
  });
};
