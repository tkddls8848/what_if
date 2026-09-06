import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadEnvFile } = await import("../src/server/env.js");

/** 임시 디렉터리에 .env를 써서 loadEnvFile을 돌리고, 끝나면 지운다. */
function withEnvFile(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-env-test-"));
  const filePath = path.join(dir, ".env");
  fs.writeFileSync(filePath, contents, "utf8");
  try {
    return run(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 테스트가 건드리는 process.env 키를 기억해뒀다가 끝나면 원상 복구한다. */
function withProcessEnv(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    process.env[key] = overrides[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("이미 설정된 환경변수는 덮어쓰지 않고 skipped에 넣는다", () => {
  withProcessEnv({ TEST_ENV_ALREADY_SET: "shell-value" }, () => {
    withEnvFile("TEST_ENV_ALREADY_SET=file-value\n", (filePath) => {
      const result = loadEnvFile(filePath);
      assert.equal(result.loaded, true);
      assert.equal(process.env.TEST_ENV_ALREADY_SET, "shell-value");
      assert.deepEqual(result.skipped, ["TEST_ENV_ALREADY_SET"]);
      assert.deepEqual(result.applied, []);
    });
  });
});

test("설정되지 않은 키는 새로 세팅하고 applied에 넣는다", () => {
  withProcessEnv({}, () => {
    delete process.env.TEST_ENV_NEW_KEY;
    withEnvFile("TEST_ENV_NEW_KEY=hello\n", (filePath) => {
      const result = loadEnvFile(filePath);
      assert.equal(result.loaded, true);
      assert.equal(process.env.TEST_ENV_NEW_KEY, "hello");
      assert.deepEqual(result.applied, ["TEST_ENV_NEW_KEY"]);
      delete process.env.TEST_ENV_NEW_KEY;
    });
  });
});

test("주석, 빈 줄, export 접두사, 따옴표, '='을 포함한 값, 트레일링 주석을 처리한다", () => {
  withProcessEnv({}, () => {
    for (const key of ["A_KEY", "B_KEY", "C_KEY", "D_KEY", "E_KEY"]) delete process.env[key];
    const contents = [
      "# 전체 줄 주석",
      "",
      "export A_KEY=exported-value",
      'B_KEY="double quoted"',
      "C_KEY='single quoted'",
      "D_KEY=postgres://user:pass@host:5432/db?sslmode=require",
      "E_KEY=trimmed # trailing comment",
      ""
    ].join("\n");
    withEnvFile(contents, (filePath) => {
      const result = loadEnvFile(filePath);
      assert.equal(process.env.A_KEY, "exported-value");
      assert.equal(process.env.B_KEY, "double quoted");
      assert.equal(process.env.C_KEY, "single quoted");
      assert.equal(process.env.D_KEY, "postgres://user:pass@host:5432/db?sslmode=require");
      assert.equal(process.env.E_KEY, "trimmed");
      assert.deepEqual(
        result.applied.sort(),
        ["A_KEY", "B_KEY", "C_KEY", "D_KEY", "E_KEY"].sort()
      );
      for (const key of ["A_KEY", "B_KEY", "C_KEY", "D_KEY", "E_KEY"]) delete process.env[key];
    });
  });
});

test("따옴표 안의 '#'은 주석으로 취급하지 않는다", () => {
  withProcessEnv({}, () => {
    delete process.env.HASH_KEY;
    withEnvFile('HASH_KEY="value#with#hash"\n', (filePath) => {
      loadEnvFile(filePath);
      assert.equal(process.env.HASH_KEY, "value#with#hash");
      delete process.env.HASH_KEY;
    });
  });
});

test("깨진 줄은 무시하고 나머지는 계속 읽는다", () => {
  withProcessEnv({}, () => {
    delete process.env.GOOD_KEY;
    const contents = [
      "this line has no equals sign",
      "=no-key-before-equals",
      "GOOD_KEY=good-value"
    ].join("\n");
    withEnvFile(contents, (filePath) => {
      const result = loadEnvFile(filePath);
      assert.equal(process.env.GOOD_KEY, "good-value");
      assert.deepEqual(result.applied, ["GOOD_KEY"]);
      delete process.env.GOOD_KEY;
    });
  });
});

test("파일이 없으면 loaded: false를 돌려주고 던지지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novel-if-env-test-"));
  try {
    const missing = path.join(dir, "does-not-exist", ".env");
    const result = loadEnvFile(missing);
    assert.deepEqual(result, { loaded: false, applied: [], skipped: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("유효하지 않은 키 이름은 무시한다", () => {
  withProcessEnv({}, () => {
    delete process.env.VALID_KEY;
    const contents = ["1INVALID=value", "INVALID-KEY=value", "VALID_KEY=value"].join("\n");
    withEnvFile(contents, (filePath) => {
      const result = loadEnvFile(filePath);
      assert.deepEqual(result.applied, ["VALID_KEY"]);
      assert.equal(process.env["1INVALID"], undefined);
      assert.equal(process.env["INVALID-KEY"], undefined);
      delete process.env.VALID_KEY;
    });
  });
});
