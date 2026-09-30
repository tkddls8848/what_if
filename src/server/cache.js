"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ROOT, getSettings } = require("./settings");

const DEFAULT_DIR = path.join(__dirname, "..", "..", "cache");

function cacheEnabled() {
  return getSettings().NOVEL_IF_CACHE;
}

function defaultDir() {
  return path.resolve(ROOT, getSettings().NOVEL_IF_CACHE_DIR);
}

function makeKey({ text, model, promptVersion }) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""))
    .update("\0")
    .update(String(model || ""))
    .update("\0")
    .update(String(promptVersion || ""))
    .digest("hex");
}

function cachePath(key, dir = defaultDir()) {
  return path.join(dir, `${key}.json`);
}

function readCache(key, dir = defaultDir()) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(key, dir), "utf8"));
  } catch (_error) {
    return null;
  }
}

function writeCache(key, value, dir = defaultDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(key, dir), JSON.stringify(value), "utf8");
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = { DEFAULT_DIR, defaultDir, cacheEnabled, makeKey, readCache, writeCache };
