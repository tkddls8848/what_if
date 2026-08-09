/**
 * 평가 스크립트 회귀.
 *
 * as-of 질의 평가는 "그 시점에 답할 수 있는가 / 미래를 흘리지 않는가"를 재는데,
 * 이건 품질 지표이기 전에 **계약**이다. 누출이 하나라도 생기면 회귀이므로
 * `npm test`에서 함께 돈다.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("as-of QA fixture passes with zero leaks", async () => {
  const { stdout } = await run(process.execPath, [
    "--no-warnings",
    path.join(REPO, "scripts", "eval_asof_qa.mjs"),
    "--json"
  ], { cwd: REPO, maxBuffer: 8 * 1024 * 1024 });

  const report = JSON.parse(stdout);
  assert.ok(report.summary.total >= 10, "평가 항목이 충분해야 한다");
  assert.equal(report.summary.leaks, 0, "시점 누출은 곧 회귀다");
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.answerable_correct, report.summary.total);

  // 답할 수 있는 경우와 거부해야 하는 경우가 모두 들어 있어야 의미가 있다.
  const expectations = new Set(report.results.map((row) => row.expect));
  assert.ok(expectations.has("answerable"));
  assert.ok(expectations.has("refused"));
});

test("audit report script runs and reports counts", async () => {
  const { stdout } = await run(process.execPath, [
    "--no-warnings",
    path.join(REPO, "scripts", "audit_report.mjs"),
    "--json"
  ], { cwd: REPO, maxBuffer: 8 * 1024 * 1024 });

  const report = JSON.parse(stdout);
  assert.ok(report.length >= 2);
  report.forEach((entry) => {
    assert.ok(entry.document_id);
    assert.equal(entry.counts.scope, 0, "규칙 채널은 근거 범위를 벗어나면 안 된다");
    assert.equal(entry.counts.total, entry.violations.length);
  });
});
