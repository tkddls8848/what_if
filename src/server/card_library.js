"use strict";
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { normalizeNameKey } = require("./pipeline");

/** 추론 후 파일을 다시 읽는다. 생성 중 검수된 카드와 동시에 추가된 카드를 보존한다. */
function saveGeneratedCards(directory, worldId, result) {
  if (!/^[a-z0-9_-]+$/.test(worldId)) throw new Error("세계관 식별자가 올바르지 않습니다.");
  const file = path.join(directory, `${worldId}.json`);
  const raw = JSON.parse(fs.readFileSync(file,"utf8"));
  const existing = Array.isArray(raw.cards) ? raw.cards : [];
  const names = new Set(existing.map((card) => normalizeNameKey(card.canonical_name)));
  const ids = new Set(existing.map((card) => card.card_id));
  const added = result.cards.filter((card) => !names.has(normalizeNameKey(card.canonical_name)) && !ids.has(card.card_id));
  const availableIds = new Set([...ids,...added.map((card) => card.card_id)]);
  // 중복 인물은 기존 id를 유지한다. 새 카드가 중복 후보의 임시 id를 참조하지 않게 한다.
  const replacements = new Map(result.cards.map((card) => [card.card_id,
    existing.find((item) => normalizeNameKey(item.canonical_name) === normalizeNameKey(card.canonical_name))?.card_id || card.card_id]));
  for (const card of added) card.relationships = card.relationships.map((relation) => ({...relation,target_card_id:replacements.get(relation.target_card_id) || relation.target_card_id})).filter((relation) => availableIds.has(relation.target_card_id));
  if (!added.length) return {added:[],skipped:result.cards.length};
  raw.cards = [...existing,...added];
  raw.sources = [...(Array.isArray(raw.sources) ? raw.sources : []).filter((source) => source.source_id !== result.source.source_id),result.source];
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp,JSON.stringify(raw,null,2) + "\n",{flag:"wx"});
    fs.renameSync(temp,file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return {added,skipped:result.cards.length - added.length};
}
module.exports = {saveGeneratedCards};
