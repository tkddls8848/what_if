import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import settings from "../src/server/settings.js";

test("일반 설정은 셸 > 로컬 > 기본값이며 전역 환경을 변경하지 않는다", () => {
  const input = {PORT:"4100", NOVEL_IF_CACHE:"0"};
  const local = {PORT:4200, GEMINI_MODEL:"local-model"};
  const resolved = settings.getSettings(input, local);
  assert.equal(resolved.PORT, 4100);
  assert.equal(resolved.GEMINI_MODEL, "local-model");
  assert.equal(resolved.NOVEL_IF_CACHE, false);
  assert.equal(resolved.CF_TIMEOUT_MS, 120000);
  assert.deepEqual(input, {PORT:"4100", NOVEL_IF_CACHE:"0"});
  assert.deepEqual(local, {PORT:4200, GEMINI_MODEL:"local-model"});
});

test("설정은 잘못된 타입·범위·자격증명 포함 URL을 값 노출 없이 거부한다", () => {
  for (const invalid of [{PORT:-1}, {SCENE_CONFIDENCE:1.1}, {IMAGE_WIDTH:null},
    {OLLAMA_URL:"http://user:secret@host/"}, {CF_API_BASE:"https://example.com?token=secret"},
    {CF_API_TOKEN:"secret"}, {TYPO_MODEL:"secret"}]) {
    assert.throws(() => settings.getSettings({}, invalid), error => !error.message.includes("secret"));
  }
  assert.equal(settings.getSettings({SCENE_CONFIDENCE:"0"}, {}).SCENE_CONFIDENCE, 0);
});

test("로컬 JSON 설정의 파싱 오류·미지원 키는 값 노출 없이 실패한다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-settings-"));
  const file = path.join(dir, "runtime.local.json");
  try {
    assert.deepEqual(settings.readLocalSettings(file), {});
    fs.writeFileSync(file, '{"PORT":4100}');
    assert.deepEqual(settings.readLocalSettings(file), {PORT:4100});
    for (const text of ['{"CF_API_TOKEN":"secret"}', '{"broken-secret"', '[]']) {
      fs.writeFileSync(file, text);
      assert.throws(() => settings.readLocalSettings(file), error => !error.message.includes("secret"));
    }
  } finally {fs.unlinkSync(file); fs.rmdirSync(dir);}
});
