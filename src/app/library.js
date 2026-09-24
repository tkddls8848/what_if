import { createSession, forkSession, sessionMarkdown } from "../core/session.js";
import { stageLabel, recoveryLabel } from "../core/sim.js";
import { createPlayStore, downloadStory } from "./play-store.js";
import { isPlayableCard } from "../core/card.js";

const store = createPlayStore();
const content = document.getElementById("content");
const notice = document.getElementById("notice");
const route = location.pathname;
const params = new URLSearchParams(location.search);
const statusNames = {suggested:"검토 대기",confirmed:"확정",edited:"수정됨",rejected:"등장 제외",manual:"직접 작성"};
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function link(text, href) { const el = node("a", text, "button"); el.href = href; return el; }
function button(text, run) {
  const el = node("button", text);
  el.type = "button";
  el.onclick = async () => {
    el.disabled = true;
    try { await run(); } catch (error) { notice.textContent = error.message; }
    finally { el.disabled = false; }
  };
  return el;
}
async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "불러오지 못했습니다. 다시 시도하세요.");
  return result;
}
function begin(world, cards) {
  const card_ids = cards.filter(isPlayableCard).map((card) => card.card_id);
  if (!card_ids.length) throw new Error("참여할 캐릭터가 없습니다. 검수 화면에서 카드를 확인하세요.");
  const active = store.active();
  if (active) store.save(active);
  store.save(createSession({ world_id:world.world_id, card_ids, opening:world.opening }));
  location.href = "/";
}
async function worlds() {
  const { worlds } = await api("/api/worlds");
  if (worlds.length) content.append(compileForm(worlds));
  const grid = node("div", "", "grid");
  content.append(grid);
  if (!worlds.length) content.append(node("p", "등록된 세계관이 없습니다."));
  for (const world of worlds) {
    const box = node("article", "", "story-card");
    box.append(node("h2", world.title), node("p", world.setting), node("p", world.card_names.join(" · "), "muted"));
    const actions = node("div", "", "actions");
    actions.append(button("새 이야기 시작", async () => {
      const detail = await api(`/api/worlds/${encodeURIComponent(world.world_id)}`);
      begin(detail.world, detail.cards);
    }), link("캐릭터 살펴보기", `/check?world=${encodeURIComponent(world.world_id)}`));
    box.append(actions);
    grid.append(box);
  }
}

function compileForm(worlds) {
  const section = node("section", "", "story-card");
  section.append(node("h2", "설정 자료로 캐릭터 만들기"), node("p", "같은 인물이 두 구간 이상 등장하는 설정 자료를 넣어 주세요. 생성한 카드는 검수 후 이야기에 참여합니다.", "muted"));
  const form = node("form");
  const label = node("label", "추가할 세계관");
  const picker = node("select"); picker.name = "world_id";
  worlds.forEach((world) => {const option = node("option",world.title);option.value = world.world_id;picker.append(option);});
  label.append(picker);form.append(label);
  const modeLabel = node("label", "자료 입력 방법");
  const mode = node("select");
  for (const [value,title] of [["text","본문 붙여넣기"],["url","Fandom URL"]]) {
    const option = node("option",title);option.value = value;mode.append(option);
  }
  modeLabel.append(mode);form.append(modeLabel);
  const text = field(form,"캐릭터 설정 자료", "", true);text.maxLength = 20000;text.minLength = 100;text.required = true;
  const url = field(form,"Fandom 문서 URL", "");url.type = "url";url.maxLength = 2000;url.parentElement.hidden = true;url.disabled = true;
  mode.onchange = () => {
    const paste = mode.value === "text";
    text.parentElement.hidden = !paste;text.disabled = !paste;text.required = paste;
    url.parentElement.hidden = paste;url.disabled = paste;url.required = !paste;
  };
  const model = field(form,"로컬 추출 모델", "qwen3.5:4b");model.required = true;
  const progress = node("p","", "muted");progress.setAttribute("role","status");
  const submit = node("button","캐릭터 카드 생성");submit.type = "submit";
  const actions = node("div","","actions");actions.append(submit);
  form.append(actions,progress);section.append(form);
  let running = false;
  form.onsubmit = async (event) => {
    event.preventDefault();if (running || !form.reportValidity()) return;
    running = true;
    const worldId = picker.value;
    const body = {model:model.value.trim(),[mode.value]:mode.value === "text" ? text.value : url.value.trim()};
    const controls = [...form.elements];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => {control.disabled = true;});
    progress.textContent = "생성을 시작합니다. Ollama가 실행 중이어야 합니다.";
    try {
      const response = await fetch(`/api/worlds/${encodeURIComponent(worldId)}/compile`,{method:"POST",headers:{"Content-Type":"application/json",Accept:"text/event-stream"},body:JSON.stringify(body)});
      if (!response.ok) {const error = await response.json();throw new Error(error.message || "생성을 시작하지 못했습니다.");}
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "",completed = false;
      for (;;) {
        const {done,value} = await reader.read();if (done) break;
        buffer += decoder.decode(value,{stream:true});
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0,cut);buffer = buffer.slice(cut + 2);
          const kind = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];if (!data) continue;
          const payload = JSON.parse(data);
          if (kind === "error") throw new Error(payload.message);
          if (kind === "progress") progress.textContent = payload.message;
          if (kind === "done") {
            completed = true;
            progress.textContent = `${payload.added}개 카드를 검토 대기로 저장했습니다. 기존 인물 ${payload.skipped}개는 덮어쓰지 않았습니다.`;
            actions.querySelector("a")?.remove();
            actions.append(link("생성된 카드 검수",`/check?world=${encodeURIComponent(worldId)}`));
          }
        }
      }
      if (!completed) throw new Error("연결이 끊겼습니다. 검수 화면에서 저장 여부를 확인한 뒤 다시 시도하세요.");
    } catch (error) {progress.textContent = error.message;}
    finally {controls.forEach((control,index) => {control.disabled = disabled[index];});running = false;}
  };
  return section;
}
function field(form, title, value, multiline = false) {
  const label = node("label", title);
  const input = node(multiline ? "textarea" : "input");
  input.value = value || "";
  input.maxLength = multiline ? 10000 : 100;
  label.append(input); form.append(label); return input;
}
async function review() {
  const { worlds } = await api("/api/worlds");
  const label = node("label", "세계관");
  const picker = node("select");
  worlds.forEach((world) => { const option = node("option", world.title); option.value = world.world_id; picker.append(option); });
  picker.value = worlds.some((world) => world.world_id === params.get("world")) ? params.get("world") : worlds[0]?.world_id || "";
  label.append(picker); content.append(label);
  const cardsBox = node("div"); content.append(cardsBox);
  let generation = 0;
  async function showCards() {
    const request = ++generation;
    if (!picker.value) return;
    const detail = await api(`/api/worlds/${encodeURIComponent(picker.value)}`);
    if (request !== generation) return;
    cardsBox.replaceChildren();
    for (const card of detail.cards) {
      const form = node("form", "", "story-card");
      const heading = node("h2", card.canonical_name);
      const status = node("p", `검수 상태: ${statusNames[card.status] || "검토 대기"}`, "muted");
      form.append(heading, status);
      if (card.source?.spans?.length) {
        const evidence = node("details");evidence.append(node("summary","생성 근거 보기"));
        if (card.source.url) {
          try {const source = new URL(card.source.url);if (source.protocol === "https:") evidence.append(link("설정 자료 원문",source.href));} catch { /* 잘못된 출처는 링크하지 않는다 */ }
        }
        for (const span of card.source.spans) evidence.append(node("p",span.quote));
        form.append(evidence);
      }
      if (card.relationships?.length) form.append(node("p",card.relationships.map((relation) => `${relation.kind}: ${relation.note}`).join("\n"),"muted"));
      const name = field(form, "이름", card.canonical_name);
      name.required = true;
      const traits = field(form, "성격 · 한 줄에 하나", card.persona.traits.join("\n"), true);
      const taboos = field(form, "금기 · 한 줄에 하나", card.persona.taboos.join("\n"), true);
      const examples = field(form, "말투 예시 · 한 줄에 하나", card.speech.examples.join("\n"), true);
      const knowledge = field(form, "캐릭터가 알고 있는 원작 시점", card.knowledge_as_of);
      knowledge.maxLength = 2000;
      const lines = (input) => input.value.split("\n").map((line) => line.trim()).filter(Boolean);
      async function save(nextStatus) {
        if (!form.reportValidity()) return;
        await api(`/api/worlds/${encodeURIComponent(detail.world.world_id)}/cards/${encodeURIComponent(card.card_id)}`, {
          method:"PUT", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ canonical_name:name.value, traits:lines(traits), taboos:lines(taboos), examples:lines(examples), knowledge_as_of:knowledge.value, status:nextStatus })
        });
        heading.textContent = name.value; status.textContent = `검수 상태: ${statusNames[nextStatus]}`;
        notice.textContent = "저장했습니다. 다음 장면부터 반영됩니다.";
      }
      const actions = node("div", "", "actions");
      actions.append(button("확정", () => save("confirmed")), button("수정 저장", () => save("edited")), button("등장에서 제외", () => save("rejected")));
      form.onsubmit = (event) => event.preventDefault();
      form.append(actions); cardsBox.append(form);
    }
  }
  picker.onchange = () => showCards().catch((error) => { notice.textContent = error.message; });
  await showCards();
}
async function sessions() {
  const saved = store.list();
  if (!saved.length) { content.append(node("p", "아직 시작한 이야기가 없습니다."), link("세계관 고르기", "/worlds")); return; }
  // 세계관 서버가 잠시 없어도 저장된 소설을 읽고 내려받을 수 있다.
  const { worlds } = await api("/api/worlds").catch(() => ({worlds:[]}));
  const titles = new Map(worlds.map((world) => [world.world_id, world.title]));
  const selected = params.get("id") ? store.get(params.get("id")) : null;
  if (params.get("id") && !selected) throw new Error("저장된 이야기를 찾을 수 없습니다.");
  if (!selected) {
    for (const session of saved) {
      const box = node("article", "", "story-card");
      box.append(node("h2", titles.get(session.world_id) || session.world_id), node("p", `${session.turn_count}턴 · ${session.ended ? "완결" : "진행 중"} · ${session.created_at ? new Date(session.created_at).toLocaleString() : ""}`, "muted"),
        node("p", (session.turns.at(-1)?.narration || session.opening).slice(0, 180)),
        link("기록 보기", `/session?id=${encodeURIComponent(session.session_id)}`));
      content.append(box);
    }
    return;
  }
  const detail = await api(`/api/worlds/${encodeURIComponent(selected.world_id)}`).catch(() => ({cards:[]}));
  const names = new Map(detail.cards.map((card) => [card.card_id,card.canonical_name]));
  content.append(node("h2", titles.get(selected.world_id) || selected.world_id));
  const actions = node("div", "", "actions");
  actions.append(link("목록", "/session"), button(selected.ended ? "결말 읽기" : "이어하기", () => { store.save(selected); location.href = "/"; }),
    button("소설 내려받기", () => downloadStory(`${selected.world_id}.md`, sessionMarkdown(selected), "text/markdown")),
    button("기록 내려받기", () => downloadStory(`${selected.session_id}.json`, JSON.stringify(selected, null, 2), "application/json")));
  content.append(actions);
  function branch(at) { const fork = forkSession(selected, at); store.save(fork); location.href = "/"; }
  const opening = node("article", "", "turn-card");
  opening.append(node("h2", "첫 장면"), node("p", selected.opening), button("첫 장면에서 분기", () => branch(0)));
  content.append(opening);
  for (const turn of selected.turns) {
    const box = node("article", "", "turn-card");
    box.append(node("h2", `${turn.index}턴`), node("p", turn.user_input, "muted"), node("p", turn.narration));
    if (turn.truncated) box.append(node("p", "도중에 끊긴 장면입니다.", "muted"));
    if (turn.snapshot) {
      const details = node("details"); details.append(node("summary", "이때의 상황"));
      const snapshot = turn.snapshot;
      details.append(node("p", [snapshot.current_scene?.place, snapshot.current_scene?.time, snapshot.current_scene?.weather].filter(Boolean).join(" · ") || "장소 미정"));
      Object.entries(snapshot.sim.characters).forEach(([id, value]) => details.append(node("p", `${names.get(id) || id}: ${stageLabel(value.stage)}`)));
      details.append(node("p", `회복: ${recoveryLabel(snapshot.sim.recovery)}`));
      box.append(details, button("여기서 다른 이야기로 분기", () => branch(turn.index)));
    }
    content.append(box);
  }
}
const screens = {
  "/worlds": ["어떤 세계로 들어갈까요?", "등장인물과 배경을 고르고, 당신의 행동으로 다음 장면을 이어 가세요. 기존 이야기는 내 이야기에 보관됩니다.", worlds],
  "/check": ["캐릭터 검수", "성격과 말투, 알고 있는 시점을 확인하세요. 저장한 설정은 이 세계관의 다음 장면부터 적용됩니다.", review],
  "/session": ["내 이야기", "이 브라우저에 저장된 장면을 읽고, 이어 하거나 다른 선택으로 분기하세요.", sessions]
};
const screen = screens[route] || screens["/worlds"];
document.getElementById("pageTitle").textContent = screen[0];
document.title = `${screen[0]} · Novel IF`;
document.getElementById("intro").textContent = screen[1];
document.querySelectorAll("nav a").forEach((a) => { if (a.getAttribute("href") === route) a.setAttribute("aria-current", "page"); });
try { await screen[2](); } catch (error) { notice.textContent = error.message; }
