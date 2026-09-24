import { normalizeSession } from "../core/session.js";

const ACTIVE = "novel-if-play:session";
const PREFIX = "novel-if-play:saved:";

// 각 이야기를 별도 키로 저장한다. 다른 탭에서 저장한 이야기를 덮어쓰지 않는다.
export function createPlayStore(storage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  key: (index) => globalThis.localStorage.key(index),
  get length() { return globalThis.localStorage.length; }
}) {
  function read(key) {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value?.world_id && Array.isArray(value.turns) ? normalizeSession(value) : null;
  }
  return {
    active() { return read(ACTIVE); },
    get(id) { return read(PREFIX + id); },
    save(session) {
      storage.setItem(PREFIX + session.session_id, JSON.stringify(session));
      storage.setItem(ACTIVE, JSON.stringify(session));
    },
    list() {
      const sessions = new Map();
      const active = read(ACTIVE);
      if (active) sessions.set(active.session_id, active);
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(PREFIX)) continue;
        const session = read(key);
        if (session) sessions.set(session.session_id, session);
      }
      return [...sessions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
  };
}

export function downloadStory(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
