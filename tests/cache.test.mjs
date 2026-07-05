import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import cachePkg from "../src/server/cache.js";

const { makeKey, readCache, writeCache } = cachePkg;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-cache-"));
}

test("같은 입력은 같은 키, 텍스트·모델·모드·버전이 다르면 다른 키", () => {
  const base = { text: "원문", model: "qwen3.5:4b", mode: "scene", promptVersion: "scene-v1" };
  assert.equal(makeKey(base), makeKey({ ...base }));
  assert.notEqual(makeKey(base), makeKey({ ...base, text: "다른 원문" }));
  assert.notEqual(makeKey(base), makeKey({ ...base, model: "gemma4:e4b" }));
  assert.notEqual(makeKey(base), makeKey({ ...base, mode: "single" }));
  assert.notEqual(makeKey(base), makeKey({ ...base, promptVersion: "scene-v2" }));
});

test("write/read 왕복과 미존재 키", () => {
  const dir = tmpDir();
  const key = makeKey({ text: "t", model: "m", mode: "scene", promptVersion: "v" });
  assert.equal(readCache(key, dir), null);

  const value = { model: "m", analysis: { characters: [{ name: "복녀" }] }, diagnostics: { mode: "scene" } };
  assert.equal(writeCache(key, value, dir), true);
  assert.deepEqual(readCache(key, dir), value);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("손상된 캐시 파일은 miss로 처리된다", () => {
  const dir = tmpDir();
  const key = makeKey({ text: "t2", model: "m", mode: "scene", promptVersion: "v" });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), "{broken", "utf8");
  assert.equal(readCache(key, dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
