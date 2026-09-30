import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import env from "../src/server/env.js";

function withFile(text, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, text);
  try { run(file); } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
}

test(".env는 자격증명만 로드하고 셸 값은 보존한다", () => {
  const keys = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "PORT", "NODE_OPTIONS", "UNEXPECTED_SETTING"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.CF_ACCOUNT_ID = "shell-account";
    for (const key of keys.slice(1)) delete process.env[key];
    withFile("CF_ACCOUNT_ID=file-account\nCF_API_TOKEN=fake-token\nPORT=9999\nNODE_OPTIONS=invalid\nUNEXPECTED_SETTING=x", file => {
      const result = env.loadEnvFile(file);
      assert.equal(process.env.CF_ACCOUNT_ID, "shell-account");
      assert.equal(process.env.CF_API_TOKEN, "fake-token");
      assert.deepEqual(result.applied, ["CF_API_TOKEN"]);
      for (const key of keys.slice(2)) assert.equal(process.env[key], undefined);
      assert.ok(!JSON.stringify(result).includes("fake-token"));
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("파서는 export, 따옴표, 내부 #·=와 뒤쪽 주석을 구분한다", () => {
  for (const [line, value] of [
    ["export CF_API_TOKEN=token", "token"],
    ['CF_API_TOKEN="double quoted"', "double quoted"],
    ["CF_API_TOKEN='single quoted'", "single quoted"],
    ["CF_API_TOKEN=key=value", "key=value"],
    ["CF_API_TOKEN=trimmed # comment", "trimmed"],
    ['CF_API_TOKEN="value#hash"', "value#hash"],
    ["CF_API_TOKEN=", ""]
  ]) assert.deepEqual(env.parseLine(line), {key:"CF_API_TOKEN", value});
});

test("깨진 키·주석·빈 줄은 로드하지 않는다", () => {
  for (const line of ["# comment", "", "no equals", "=no-key", "1INVALID=x", "INVALID-KEY=x"]) assert.equal(env.parseLine(line), null);
});

test("없는 .env는 선택 사항이며 값 없는 결과만 반환한다", () => {
  withFile("", file => assert.deepEqual(env.loadEnvFile(file + ".missing"), {loaded:false, applied:[], skipped:[]}));
});

test("공유 .env 예제에는 자격증명 키만 있고 값은 없다", () => {
  const allowed = new Set(["CF_ACCOUNT_ID", "CF_API_TOKEN", "GEMINI_API_KEY", "CF_AI_GATEWAY_TOKEN"]);
  for (const line of fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8").split(/\r?\n/)) {
    const item = env.parseLine(line);
    if (item) { assert.ok(allowed.has(item.key)); assert.equal(item.value, ""); }
  }
});
