import test from "node:test";
import assert from "node:assert/strict";
import { createSession, appendTurn, makeTurn, normalizeSession, forkSession, sessionMarkdown } from "../src/core/session.js";
import { createPlayStore } from "../src/app/play-store.js";

function storage() {
  const values = new Map();
  return { getItem:key => values.get(key) || null, setItem:(key,value) => values.set(key,value),
    key:index => [...values.keys()][index], get length() { return values.size; } };
}
test("새 세계관을 시작해도 이전 세션과 종료 상태를 보존한다", () => {
  const store = createPlayStore(storage());
  const first = { ...createSession({world_id:"demo"}), ended:true };
  store.save(first);
  const second = createSession({world_id:"lighthouse"});
  store.save(second);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(first.session_id).ended, true);
  assert.equal(store.active().session_id, second.session_id);
  store.save(store.get(first.session_id));
  assert.equal(store.active().session_id, first.session_id);
});
test("분기는 선택 턴의 관계와 장소만 복원하며 원본과 미래 기록을 공유하지 않는다", () => {
  let session = createSession({world_id:"demo", card_ids:["a"], opening:"시작"});
  const snapshot = { sim:session.sim, current_scene:{location_id:"room",place:"방",time:"밤",weather:"비"} };
  session = appendTurn(session, {...makeTurn({index:1,narration:"장면 1"}), snapshot, truncated:true});
  session = appendTurn(session, {...makeTurn({index:2,narration:"미래"}), snapshot:{...snapshot,current_scene:{place:"미래 장소"}}});
  session.sim = { ...session.sim, recovery:90 };
  session.ended = true;
  const normalized = normalizeSession(session);
  assert.equal(normalized.turns[0].truncated, true);
  const fork = forkSession(normalized, 1);
  assert.equal(fork.turn_count, 1);
  assert.equal(fork.sim.recovery, 0);
  assert.equal(fork.current_scene.place, "방");
  assert.notEqual(fork.session_id, session.session_id);
  assert.equal(fork.parent_session_id, session.session_id);
  assert.ok(!fork.ended);
  fork.sim.recovery = 42;
  fork.turns[0].narration = "변경";
  assert.equal(session.turns[0].narration, "장면 1");
  assert.equal(snapshot.sim.recovery, 0);
  assert.equal(forkSession(session, 0).turn_count, 0);
  assert.throws(() => forkSession(session, 3));
});
test("상태가 기록되지 않은 턴을 현재 상태로 추측해 분기하지 않는다", () => {
  const session = appendTurn(createSession({world_id:"demo"}), makeTurn({index:1}));
  assert.throws(() => forkSession(session, 1), /상태 기록/);
});
test("내려받는 소설에는 오프닝, 선택한 행동, 서술과 잘림 안내가 포함된다", () => {
  const session = appendTurn(createSession({world_id:"demo",opening:"첫 장면"}), {
    ...makeTurn({index:1,user_input:"문을 연다",narration:"누군가 서 있다"}),truncated:true
  });
  const output = sessionMarkdown(session);
  for (const value of ["첫 장면","문을 연다","누군가 서 있다","도중에 끊김"]) assert.ok(output.includes(value));
});
test("저장 실패를 삼키지 않아 UI에서 사용자에게 알릴 수 있다", () => {
  const store = createPlayStore({setItem() {throw new Error("quota");}});
  assert.throws(() => store.save(createSession({world_id:"demo"})), /quota/);
});
