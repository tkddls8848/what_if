"use strict";
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./settings");
const WORLD_ID = /^[a-z0-9_-]+$/;

async function loadWorld(worldId) {
  if (!WORLD_ID.test(String(worldId || ""))) {
    return { ok: false, status: 400, error_code: "INVALID_ARGUMENT", message: "world_id 형식이 올바르지 않습니다." };
  }
  const file = path.join(ROOT, "data", "worlds", `${worldId}.json`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return { ok: false, status: 404, error_code: "NOT_FOUND", message: `세계관 '${worldId}'을 찾을 수 없습니다.` };
  }

  // 파싱은 됐지만 모양이 계약과 다른 파일이 있다. loadWorldFile은 raw.world를 바로 읽으므로
  // 최상위가 null이면 여기서 던지고, 그대로 두면 핸들러 밖으로 나가 프로세스가 죽는다.
  try {
    const { loadWorldFile } = await import("../core/card.js");
    return { ok: true, ...loadWorldFile(raw) };
  } catch (error) {
    console.error("[world] load error:", error);
    return { ok: false, status: 500, error_code: "INTERNAL", message: `세계관 '${worldId}'을 읽을 수 없습니다.` };
  }
}


module.exports = { loadWorld };
