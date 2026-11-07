import { glossaryLimit, glossaryTerms, validGlossaryTerm, withGlossaryLock } from "./glossary.js";

function setupGlossarySelection() {
  const fields = document.querySelector("#glossary-selection");
  const choices = document.querySelector("#glossary-selection-choices");
  const status = document.querySelector("#glossary-selection-status");
  let pending = 0;
  let selectionRefresh = 0;

  async function refresh() {
    const refreshId = ++selectionRefresh;
    try {
      const { glossaries = [], selectedGlossaryIds = [] } =
        await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
      if (refreshId !== selectionRefresh || pending) return;
      const active = document.activeElement;
      const focusedId = choices.contains(active) ? active.value : undefined;
      choices.replaceChildren();
      let focusTarget;
      for (const { id, name, entries } of glossaries) {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = id;
        input.checked = selectedGlossaryIds.includes(id);
        if (id === focusedId) focusTarget = input;
        label.append(input, `${name}（${entries.length}組）`);
        choices.append(label);
      }
      if (!glossaries.length) choices.textContent = "登録済みの用語集はありません。";
      fields.disabled = !glossaries.length;
      focusTarget?.focus();
    } catch {
      if (refreshId !== selectionRefresh || pending) return;
      fields.disabled = true;
      status.textContent = "用語集を読み込めませんでした。";
    }
  }

  choices.addEventListener("change", async ({ target }) => {
    if (!pending) status.textContent = "";
    pending++;
    const checked = target.checked;
    try {
      const result = await chrome.runtime.sendMessage({ type: "set-glossary-selection", id: target.value, checked });
      if (result.error) throw new Error(result.error);
    } catch (error) {
      status.textContent = `用語集の選択を反映できませんでした。${error.message}`;
    } finally {
      if (--pending === 0) await refresh();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!pending && area === "local" && (changes.glossaries || changes.selectedGlossaryIds)) refresh();
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
  let editing;

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
    editing = glossary;
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
    const original = editing;
    fields.disabled = true;
    status.textContent = "";
    try {
      glossaries = await withGlossaryLock(async () => {
        const { glossaries = [], selectedGlossaryIds = [] } =
          await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
        const current = glossaries.find(item => item.id === id);
        if (original && (!current || (!entry && JSON.stringify(current) !== JSON.stringify(original)))) {
          throw new Error("別の画面で用語集が更新されました。最新の内容を開いてください。");
        }
        if (original && current && entry) {
          for (const key of ["name", "entries"]) {
            const before = JSON.stringify(original[key]);
            const latest = JSON.stringify(current[key]);
            const draft = JSON.stringify(entry[key]);
            if (draft === before) entry[key] = current[key];
            else if (latest !== before && latest !== draft) {
              throw new Error("別の画面で同じ項目が更新されました。最新の内容を開いてください。");
            }
          }
        }
        const next = glossaries.filter(item => item.id !== id);
        if (entry) next.push(entry);
        if (entry) glossaryTerms(next, selectedGlossaryIds);
        await chrome.storage.local.set({ glossaries: next });
        return next;
      });
      openEditor(entry?.id);
      status.textContent = entry ? "用語集を保存しました。" : "用語集を削除しました。";
    } catch (error) {
      const latest = await chrome.storage.local.get("glossaries").catch(() => ({}));
      if (latest.glossaries) glossaries = latest.glossaries;
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
