/**
 * 뷰 모듈이 남의 함수를 import 없이 부르고 있지 않은지 검사한다.
 *
 * 이 저장소는 빌드 단계도 린터도 없고 브라우저가 ES module을 그대로 로드한다.
 * import를 빠뜨린 채 함수를 부르면 링크 시점에는 아무 일도 없다가 **그 UI를 실제로
 * 건드리는 순간** ReferenceError가 난다. 노드 테스트는 DOM을 쓰는 뷰 모듈을 실행할 수
 * 없으므로 소스를 정적으로 훑는다.
 *
 * 범위를 일부러 좁혔다: **다른 app 모듈이 export한 이름**이 호출되는데 여기서
 * import하지도, 여기서 선언하지도 않은 경우만 잡는다. 지역 함수·전역·이벤트 이름은
 * 애초에 검사 대상이 아니므로 거짓 경보가 생기지 않는다. 무딘 경보로 테스트를 못 믿게
 * 만드는 쪽이 놓치는 것보다 나쁘다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(fileURLToPath(new URL("../src/app", import.meta.url)));

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listModules(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/^\s*\/\/.*$/gmu, " ");
}

/** 이 모듈이 export하는 함수 이름. */
function exportedFunctions(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+function\s+([\w$]+)/gu)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/gu)) {
    match[1].split(",").forEach((part) => {
      const name = part.split(/\bas\b/u).pop().trim();
      if (name) names.add(name);
    });
  }
  return names;
}

function importedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from/gu)) {
    match[1].split(",").forEach((part) => {
      const name = part.split(/\bas\b/u).pop().trim();
      if (name) names.add(name);
    });
  }
  for (const match of source.matchAll(/import\s+([\w$]+)\s*(?:,|from)/gu)) names.add(match[1]);
  return names;
}

/** 이 모듈 안에서 선언된 최상위 이름. */
function declaredNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/gmu)) names.add(match[1]);
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/gmu)) names.add(match[1]);
  return names;
}

test("view modules import every cross-module function they call", () => {
  const modules = listModules(APP_DIR).map((file) => {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    return { file, source, exports: exportedFunctions(source) };
  });

  const problems = [];

  modules.forEach((current) => {
    const owners = new Map();
    modules.forEach((other) => {
      if (other.file === current.file) return;
      other.exports.forEach((name) => {
        if (!owners.has(name)) owners.set(name, path.relative(APP_DIR, other.file));
      });
    });

    const known = new Set([...importedNames(current.source), ...declaredNames(current.source)]);
    const seen = new Set();

    for (const match of current.source.matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/gu)) {
      const name = match[2];
      if (!owners.has(name) || known.has(name) || seen.has(name)) continue;
      seen.add(name);
      problems.push(`${path.relative(APP_DIR, current.file)} → ${name}() (${owners.get(name)}에서 export)`);
    }
  });

  assert.deepEqual(problems, [], `import 없이 호출하는 함수:\n  ${problems.join("\n  ")}`);
});
