"use strict";
const path = require("path");
const { ROOT, getSettings } = require("./settings");
const { createOllamaClient } = require("./ollama_client");
const { createCloudflareClient } = require("../llm/cloudflare");
const { createGeminiClient } = require("../llm/gemini");
const { createFallbackClient } = require("../llm/fallback");
const { createImageClient } = require("../llm/image");
const { createJevClient } = require("../llm/jev");
const { createBudget, DEFAULT_NARRATION_MODEL } = require("../llm/budget");

// 장부는 요청/세션마다 새로 만들지 않는다.
const turnBudget = createBudget();
function cloudflareCredentials() {
  return { accountId: process.env.CF_ACCOUNT_ID, apiToken: process.env.CF_API_TOKEN,
    apiBase: getSettings().CF_API_BASE };
}
function getCloudflareClient() {
  return createCloudflareClient({ ...cloudflareCredentials(), timeoutMs: getSettings().CF_TIMEOUT_MS });
}
function getGeminiClient() {
  const settings = getSettings();
  return createGeminiClient({ apiKey: process.env.GEMINI_API_KEY, apiBase: settings.GEMINI_API_BASE,
    model: settings.GEMINI_MODEL, timeoutMs: settings.GEMINI_TIMEOUT_MS });
}
function getNarrationClient() {
  return createFallbackClient({ providers: [
    { name: "cloudflare", client: getCloudflareClient(), model: DEFAULT_NARRATION_MODEL },
    { name: "gemini", client: getGeminiClient(), model: getSettings().GEMINI_MODEL }
  ] });
}
function getImageClient() {
  const settings = getSettings();
  return createImageClient({ ...cloudflareCredentials(), timeoutMs: settings.CF_IMAGE_TIMEOUT_MS,
    model: settings.IMAGE_MODEL, width: settings.IMAGE_WIDTH, height: settings.IMAGE_HEIGHT });
}
function getDirectorClient() {
  const settings = getSettings();
  return createJevClient({ ...cloudflareCredentials(), gatewayId: settings.CF_GATEWAY_ID,
    aigToken: process.env.CF_AI_GATEWAY_TOKEN, timeoutMs: settings.JEV_TIMEOUT_MS });
}
function getClient() {
  const settings = getSettings();
  return createOllamaClient({ baseUrl: settings.OLLAMA_URL, timeoutMs: settings.OLLAMA_TIMEOUT_MS });
}
function getSceneRoot() { return path.resolve(ROOT, getSettings().SCENE_ROOT); }
module.exports = { getCloudflareClient, getGeminiClient, getNarrationClient, getImageClient,
  getDirectorClient, getClient, getSceneRoot, turnBudget };
