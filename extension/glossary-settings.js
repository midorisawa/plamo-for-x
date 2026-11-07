import { glossaryLimit, glossaryTerms, validGlossaryTerm, withGlossaryLock } from "./glossary.js";

function setupGlossarySelection() {
  const fields = document.querySelector("#glossary-selection");
  const choices = document.querySelector("#glossary-selection-choices");
  const status = document.querySelector("#glossary-selection-status");

  async function refresh() {
    try {
      const { glossaries = [], selectedGlossaryIds = [] } =
        await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
      const draft = new Map([...choices.querySelectorAll("input")]
        .filter(input => input.checked !== input.defaultChecked).map(input => [input.value, input.checked]));
      choices.replaceChildren();
      for (const { id, name, entries } of glossaries) {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = id;
        input.defaultChecked = selectedGlossaryIds.includes(id);
        input.checked = draft.get(id) ?? input.defaultChecked;
        label.append(input, `${name}（${entries.length}組）`);
        choices.append(label);
      }
      if (!glossaries.length) choices.textContent = "登録済みの用語集はありません。";
      fields.disabled = !glossaries.length;
      status.textContent = "";
    } catch {
      status.textContent = "用語集を読み込めませんでした。";
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.glossaries || changes.selectedGlossaryIds)) refresh();
  });
  refresh();
}

export function setupGlossarySettings(popup) {
  setupGlossarySelection();
  if (popup) return;

  const form = document.querySelector("#glossary-form");
  const select = document.querySelector("#glossary-list");
  const name = document.querySelector("#glossary-name");
  const rows = document.querySelector("#glossary-entries");
  const template = document.querySelector("#glossary-entry");
  const add = document.querySelector("#glossary-add-entry");
  const remove = document.querySelector("#glossary-delete");
  const fields = form.querySelector("fieldset");
  const status = document.querySelector("#glossary-status");
  let glossaries = [];

  function addEntry(entry = {}) {
    const row = template.content.firstElementChild.cloneNode(true);
    const [source, target] = row.querySelectorAll("input");
    source.value = entry.source ?? "";
    target.value = entry.target ?? "";
    row.querySelector("button").addEventListener("click", () => {
      row.remove();
      add.disabled = false;
      if (!rows.childElementCount) addEntry();
    });
    rows.append(row);
    add.disabled = rows.childElementCount >= glossaryLimit;
    return source;
  }

  function openEditor(id) {
    const glossary = glossaries.find(item => item.id === id);
    select.replaceChildren(new Option("新しい用語集", ""),
      ...glossaries.map(item => new Option(item.name, item.id)));
    select.value = glossary?.id ?? "";
    name.value = glossary?.name ?? "";
    rows.replaceChildren();
    for (const entry of glossary?.entries ?? [{}]) addEntry(entry);
    remove.disabled = !glossary;
    status.textContent = "";
  }

  async function update(id, entry) {
    fields.disabled = true;
    status.textContent = "";
    try {
      glossaries = await withGlossaryLock(async () => {
        const { glossaries = [], selectedGlossaryIds = [] } =
          await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
        const next = glossaries.filter(item => item.id !== id);
        if (entry) next.push(entry);
        if (entry) glossaryTerms(next, selectedGlossaryIds);
        await chrome.storage.local.set({ glossaries: next });
        return next;
      });
      openEditor(entry?.id);
      status.textContent = entry ? "用語集を保存しました。" : "用語集を削除しました。";
    } catch (error) {
      status.textContent = `用語集を更新できませんでした。 ${error.message}`;
    } finally {
      fields.disabled = false;
    }
  }

  select.addEventListener("change", () => openEditor(select.value));
  add.addEventListener("click", () => addEntry().focus());
  remove.addEventListener("click", () => {
    if (select.value && window.confirm("この用語集を削除しますか？")) update(select.value);
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const title = name.value.trim();
    try {
      if (!title) throw new Error("用語集の名前を入力してください。");
      const entries = [];
      for (const [index, row] of Array.from(rows.children).entries()) {
        const [source, target] = Array.from(row.querySelectorAll("input"), input => input.value.trim());
        if (!source && !target) continue;
        if (!validGlossaryTerm(source) || !validGlossaryTerm(target)) {
          throw new Error(`${index + 1}行目の原語と訳語を確認してください。`);
        }
        entries.push({ source, target });
      }
      if (!entries.length) throw new Error("原語と訳語を1組以上入力してください。");
      const id = select.value || crypto.randomUUID();
      const entry = { id, name: title, entries };
      glossaryTerms([entry], [id]);
      update(id, entry);
    } catch (error) {
      status.textContent = error.message;
    }
  });

  chrome.storage.local.get("glossaries").then(settings => {
    glossaries = settings.glossaries ?? [];
    openEditor("");
    fields.disabled = false;
  }).catch(() => { status.textContent = "用語集を読み込めませんでした。"; });
}
