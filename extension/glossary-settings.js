import { glossaryLimit, glossaryTerms, parseGlossaryFile, validGlossaryTerm, withGlossaryLock } from "./glossary.js";

function readGlossaryText(input) {
  // インポートした文字列は編集されるまで入力欄で表示できない改行も保持する
  const original = input.defaultValue;
  return input.value === original.replace(/[\r\n]/g, "") ? original : input.value.trim();
}

function sameEntries(before, after) {
  return before.length === after.length && before.every((term, index) => {
    const other = after[index];
    return term.source === other.source && term.target === other.target &&
      (term.enabled !== false) === (other.enabled !== false) &&
      (term.bidirectional === true) === (other.bidirectional === true);
  });
}

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
  const fileInput = document.querySelector("#glossary-file");
  const exportButton = document.querySelector("#glossary-export");
  const fields = form.querySelector("fieldset");
  const status = document.querySelector("#glossary-status");
  let glossaries = [];
  let editing;

  function addEntry(entry = {}) {
    const row = template.content.firstElementChild.cloneNode(true);
    const [source, target, enabled, bidirectional] = row.querySelectorAll("input");
    source.value = source.defaultValue = entry.source ?? "";
    target.value = target.defaultValue = entry.target ?? "";
    enabled.checked = entry.enabled !== false;
    bidirectional.checked = entry.bidirectional === true;
    row.querySelector("button").addEventListener("click", () => {
      row.remove();
      add.disabled = false;
      if (!rows.childElementCount) addEntry();
    });
    rows.append(row);
    add.disabled = rows.childElementCount >= glossaryLimit;
    return source;
  }

  function renderList(id) {
    select.replaceChildren(new Option("新しい用語集", ""),
      ...glossaries.map(item => new Option(item.name, item.id)));
    const deleted = id && !glossaries.some(item => item.id === id);
    if (deleted) {
      const option = new Option(`${editing.name}（削除済み）`, id);
      option.disabled = true;
      select.add(option);
    }
    select.value = id;
    remove.disabled = !id || deleted;
    exportButton.disabled = !glossaries.length;
  }

  function openEditor(id) {
    const glossary = glossaries.find(item => item.id === id);
    editing = glossary;
    renderList(glossary?.id ?? "");
    name.value = name.defaultValue = glossary?.name ?? "";
    rows.replaceChildren();
    for (const entry of glossary?.entries ?? [{}]) addEntry(entry);
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
        if (original && (!current || (!entry &&
            (current.name !== original.name || !sameEntries(current.entries, original.entries))))) {
          throw new Error("別の画面で用語集が更新されました。最新の内容を開いてください。");
        }
        if (original && current && entry) {
          const nameConflict = entry.name !== original.name &&
            current.name !== original.name && current.name !== entry.name;
          const entriesUnchanged = sameEntries(entry.entries, original.entries);
          const entriesConflict = !entriesUnchanged &&
            !sameEntries(current.entries, original.entries) && !sameEntries(current.entries, entry.entries);
          if (nameConflict || entriesConflict) {
            throw new Error("別の画面で同じ項目が更新されました。最新の内容を開いてください。");
          }
          if (entry.name === original.name) entry.name = current.name;
          if (entriesUnchanged) entry.entries = current.entries;
        }
        const next = glossaries.filter(item => item.id !== id);
        if (entry) next.push(entry);
        if (entry) {
          glossaryTerms(next, selectedGlossaryIds);
          await chrome.storage.local.set({ glossaries: next });
        } else {
          await chrome.storage.local.set({
            glossaries: next, selectedGlossaryIds: selectedGlossaryIds.filter(selected => selected !== id),
          });
        }
        return next;
      });
      openEditor(entry?.id);
      status.textContent = entry ? "用語集を保存しました。" : "用語集を削除しました。";
    } catch (error) {
      const latest = await chrome.storage.local.get("glossaries").catch(() => ({}));
      if (latest.glossaries) {
        glossaries = latest.glossaries;
        renderList(original?.id ?? "");
      }
      status.textContent = `用語集を更新できませんでした。 ${error.message}`;
    } finally {
      fields.disabled = false;
    }
  }

  select.addEventListener("change", () => openEditor(select.value));
  add.addEventListener("click", () => addEntry().focus());
  remove.addEventListener("click", () => {
    if (editing && window.confirm("この用語集を削除しますか？")) update(editing.id);
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const title = readGlossaryText(name);
    try {
      if (!title.trim()) throw new Error("用語集の名前を入力してください。");
      const entries = [];
      for (const [index, row] of Array.from(rows.children).entries()) {
        const [original, translation, enabled, bidirectional] = row.querySelectorAll("input");
        const source = readGlossaryText(original);
        const target = readGlossaryText(translation);
        if (!source && !target) continue;
        if (!validGlossaryTerm(source) || !validGlossaryTerm(target)) {
          throw new Error(`${index + 1}行目の原語と訳語を確認してください。`);
        }
        entries.push({
          source, target, ...(!enabled.checked && { enabled: false }),
          ...(bidirectional.checked && { bidirectional: true }),
        });
      }
      if (!entries.length) throw new Error("原語と訳語を1組以上入力してください。");
      const id = editing?.id ?? crypto.randomUUID();
      const entry = { id, name: title, entries };
      update(id, entry);
    } catch (error) {
      status.textContent = error.message;
    }
  });

  document.querySelector("#glossary-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files;
    fileInput.value = "";
    if (!file) return;
    fields.disabled = true;
    status.textContent = "";
    try {
      const imported = parseGlossaryFile(await file.text());
      glossaries = await withGlossaryLock(async () => {
        const { glossaries = [] } = await chrome.storage.local.get("glossaries");
        const next = glossaries.concat(imported);
        await chrome.storage.local.set({ glossaries: next });
        return next;
      });
      renderList(editing?.id ?? "");
      status.textContent = `${imported.length}件の用語集を追加しました。`;
    } catch (error) {
      status.textContent = error instanceof SyntaxError ? "JSONファイルを読み込めませんでした。" : error.message;
    } finally {
      fields.disabled = false;
    }
  });

  exportButton.addEventListener("click", async () => {
    try {
      const { glossaries = [] } = await chrome.storage.local.get("glossaries");
      if (!glossaries.length) throw new Error("登録済みの用語集はありません。");
      const presets = glossaries.map(({ name, entries }) => ({ name, terms: entries }));
      const file = new Blob([JSON.stringify(presets, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "glossaries.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      status.textContent = `用語集をエクスポートできませんでした。 ${error.message}`;
    }
  });

  chrome.storage.local.get("glossaries").then(settings => {
    glossaries = settings.glossaries ?? [];
    openEditor("");
    fields.disabled = false;
  }).catch(() => { status.textContent = "用語集を読み込めませんでした。"; });
}
