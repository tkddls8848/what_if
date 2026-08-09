#!/usr/bin/env node
/**
 * 제약 감사 리포트 (CLI).
 *
 * 검수 화면에 들어가기 전에 "무엇부터 봐야 하는가"를 결정적으로 뽑는다.
 * 판정은 `src/core/audit.js`가 하고 이 스크립트는 표시만 한다.
 *
 *   node scripts/audit_report.mjs
 *   node scripts/audit_report.mjs --doc gamja --severity error
 *   node scripts/audit_report.mjs --doc wings --code actor --limit 40
 *   node scripts/audit_report.mjs --json
 */
import { createLibrary } from "../mcp/library.js";
import { evidenceOf, findFact } from "../src/core/evidence.js";

const args = parseArgs(process.argv.slice(2));
const library = createLibrary();
const documents = library.documents()
  .filter((meta) => !args.doc || meta.document_id === args.doc);

if (!documents.length) {
  console.error(`작품을 찾을 수 없습니다. 사용 가능: ${library.documents().map((item) => item.document_id).join(", ") || "(없음)"}`);
  process.exit(1);
}

const report = documents.map((meta) => {
  const { analysis } = library.get(meta.document_id);
  const audit = analysis.diagnostics.audit;
  const violations = audit.violations
    .filter((item) => !args.severity || item.severity === args.severity)
    .filter((item) => !args.code || item.code === args.code)
    .map((item) => {
      const found = findFact(analysis, item.target_id);
      const evidence = found ? evidenceOf(analysis, found.fact, found.fact_type, { maxChars: 90 }) : null;
      return { ...item, quote: evidence?.quote || "" };
    });
  return { document_id: meta.document_id, title: meta.title, counts: audit.counts, violations };
});

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

report.forEach((entry) => {
  const { counts } = entry;
  console.log(`\n=== ${entry.title} (${entry.document_id}) ===`);
  console.log(`오류 ${counts.error} · 확인 필요 ${counts.warn}   ` +
    `actor ${counts.actor} / scope ${counts.scope} / polarity ${counts.polarity} / state ${counts.state} / temporal ${counts.temporal}`);

  if (!entry.violations.length) {
    console.log("표시할 위반이 없습니다.");
    return;
  }
  console.log(`표시 ${Math.min(args.limit, entry.violations.length)} / ${entry.violations.length}건 (심각도·단락 순)\n`);
  entry.violations
    .slice()
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.segment_index - b.segment_index)
    .slice(0, args.limit)
    .forEach((item) => {
      console.log(`[${item.severity === "error" ? "오류" : "확인"}] ${item.code} · 단락 ${item.segment_index} · ${item.target_id}`);
      console.log(`  ${item.message}`);
      if (item.quote) console.log(`  근거: ${item.quote}`);
    });
});

const totalErrors = report.reduce((sum, entry) => sum + entry.counts.error, 0);
console.log(`\n오류 합계: ${totalErrors}건. 검수 화면(/check)에서 위반 배지가 붙은 항목부터 처리하세요.`);

function rank(severity) {
  return severity === "error" ? 0 : 1;
}

function parseArgs(argv) {
  const out = { doc: "", severity: "", code: "", limit: 20, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--json") out.json = true;
    else if (key === "--doc") out.doc = argv[++i] || "";
    else if (key === "--severity") out.severity = argv[++i] || "";
    else if (key === "--code") out.code = argv[++i] || "";
    else if (key === "--limit") out.limit = Number(argv[++i]) || 20;
  }
  return out;
}
