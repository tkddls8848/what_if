"use strict";
const fs = require("fs");
const path = require("path");
const defaults = require("../../config/runtime.json");
const ROOT = path.resolve(__dirname, "../..");

// 설정 값이나 비밀을 오류 메시지에 포함하지 않는다.
function validate(key, value) {
  if (!Object.hasOwn(defaults, key)) throw new Error(`지원하지 않는 일반 설정 키: ${key}`);
  const invalid = () => { throw new Error(`일반 설정 형식/범위 오류: ${key}`); };
  if (key === "NOVEL_IF_CACHE") {
    if ([true, "true", "1"].includes(value)) return true;
    if ([false, "false", "0"].includes(value)) return false;
    return invalid();
  }
  if (typeof defaults[key] === "number") {
    if (!["string", "number"].includes(typeof value) || String(value).trim() === "") return invalid();
    const n = Number(value);
    if (!Number.isFinite(n)) return invalid();
    if (key === "SCENE_CONFIDENCE") { if (n < 0 || n > 1) return invalid(); }
    else if (!Number.isInteger(n) || n <= 0 || (key === "PORT" && n > 65535)) return invalid();
    return n;
  }
  if (typeof value !== "string" || (!value.trim() && key !== "CF_GATEWAY_ID")) return invalid();
  if (key.endsWith("_URL") || key.endsWith("_API_BASE")) {
    let url;
    try { url = new URL(value); } catch { return invalid(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid();
  }
  return value.trim();
}

function readLocalSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error("로컬 일반 설정 파일을 읽을 수 없습니다."); }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("로컬 일반 설정 파일은 올바른 JSON이어야 합니다."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("로컬 일반 설정은 객체여야 합니다.");
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, validate(key, value)]));
}

const local = readLocalSettings(path.join(ROOT, "config/runtime.local.json"));

/** 셸/CI > 로컬 설정 > 버전 관리된 기본값. 일반 설정을 process.env에 복사하지 않는다. */
function getSettings(environment = process.env, overrides = local) {
  for (const [key, value] of Object.entries(overrides)) validate(key, value);
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const external = environment[key];
    const value = external !== undefined && external !== "" ? external : overrides[key] ?? fallback;
    return [key, validate(key, value)];
  }));
}

module.exports = { ROOT, getSettings, readLocalSettings };
