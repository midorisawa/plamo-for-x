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

function setupGlossarySelection(onLoad, onEdit) {
  const fields = document.querySelector("#glossary-selection");
  const choices = document.querySelector("#glossary-selection-choices");
  const status = document.querySelector("#glossary-selection-status");
  const count = document.querySelector("#glossary-selection-count");
  const popupCount = document.querySelector("#glossary-popup-count");
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
      let selectedCount = 0;
      const sources = new Set();
      for (const { id, name, entries } of glossaries) {
        const row = document.createElement("div");
        row.className = "glossary-choice";
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = id;
        input.checked = selectedGlossaryIds.includes(id);
        const enabled = entries.filter(term => term.enabled !== false);
        if (input.checked) {
          selectedCount++;
          for (const { source } of enabled) sources.add(source);
        }
        if (id === focusedId && active.tagName === "INPUT") focusTarget = input;
        const description = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = name;
        const meta = document.createElement("small");
        meta.textContent = `有効 ${enabled.length} / ${entries.length}組`;
        description.append(title, meta);
        label.append(input, description);
        row.append(label);
        if (onEdit) {
          const button = document.createElement("button");
          button.type = "button";
          button.value = id;
          button.textContent = "編集";
          button.setAttribute("aria-label", `${name}を編集`);
          button.addEventListener("click", () => onEdit(id));
          if (id === focusedId && active.tagName === "BUTTON") focusTarget = button;
          row.append(button);
        }
        choices.append(row);
      }
      if (!glossaries.length) choices.textContent = "保存済みの用語集はありません。";
      fields.disabled = false;
      const applied = `適用する用語 ${sources.size} / ${glossaryLimit}組`;
      count.textContent = onEdit ? `選択中 ${selectedCount}件 · ${applied}` : applied;
      popupCount.textContent = selectedCount ? `${selectedCount}件選択中` : "未選択";
      onLoad?.(glossaries);
      focusTarget?.focus({ preventScroll: true });
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
  if (popup) {
    setupGlossarySelection();
    return;
  }

  const form = document.querySelector("#glossary-form");
  const heading = document.querySelector("#glossary-editor-title");
  const empty = document.querySelector("#glossary-editor-empty");
  const create = document.querySelector("#glossary-new");
  const importButton = document.querySelector("#glossary-import");
  const fileStatus = document.querySelector("#glossary-file-status");
  const name = document.querySelector("#glossary-name");
  const rows = document.querySelector("#glossary-entries");
  const entryCount = document.querySelector("#glossary-entry-count");
  const template = document.querySelector("#glossary-entry");
  const add = document.querySelector("#glossary-add-entry");
  const save = form.querySelector('button[type="submit"]');
  const remove = document.querySelector("#glossary-delete");
  const fileInput = document.querySelector("#glossary-file");
  const exportButton = document.querySelector("#glossary-export");
  const fields = form.querySelector("fieldset");
  const status = document.querySelector("#glossary-status");
  let glossaries = [];
  let editing;
  let invalidInput;

  function clearValidation() {
    invalidInput?.setCustomValidity("");
    invalidInput = undefined;
  }

  function showValidation(input, message) {
    invalidInput = input;
    input.setCustomValidity(message);
    input.reportValidity();
  }

  function updateRows() {
    const count = rows.childElementCount;
    entryCount.textContent = `${count} / ${glossaryLimit}行`;
    add.disabled = count >= glossaryLimit;
    Array.from(rows.children).forEach((row, index) => {
      row.querySelector("legend").textContent = `用語 ${index + 1}`;
    });
  }

  function addEntry(entry = {}) {
    const row = template.content.firstElementChild.cloneNode(true);
    const [source, target, enabled, bidirectional] = row.querySelectorAll("input");
    source.value = source.defaultValue = entry.source ?? "";
    target.value = target.defaultValue = entry.target ?? "";
    enabled.checked = entry.enabled !== false;
    bidirectional.checked = entry.bidirectional === true;
    const arrow = row.querySelector(".glossary-direction");
    const [sourceLabel, targetLabel] = row.querySelectorAll(".glossary-term-pair label span");
    const showDirection = () => {
      arrow.textContent = bidirectional.checked ? "↔" : "→";
      sourceLabel.textContent = bidirectional.checked ? "用語1" : "原語";
      targetLabel.textContent = bidirectional.checked ? "用語2" : "訳語";
    };
    showDirection();
    bidirectional.addEventListener("change", showDirection);
    row.querySelector("button").addEventListener("click", () => {
      const adjacent = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      updateRows();
      (adjacent?.querySelector("input") ?? add).focus();
    });
    rows.append(row);
    updateRows();
    return source;
  }

  function syncLibrary() {
    const deleted = editing && !glossaries.some(item => item.id === editing.id);
    remove.hidden = !editing || deleted;
    heading.textContent = form.hidden ? "用語集を編集" : deleted ? "削除された用語集" :
      editing ? editing.name : "新しい用語集";
    for (const button of document.querySelectorAll(".glossary-choice button")) {
      if (button.value === editing?.id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    exportButton.disabled = !glossaries.length;
  }

  function openEditor(id) {
    editing = glossaries.find(item => item.id === id);
    form.hidden = id === undefined;
    empty.hidden = !form.hidden;
    name.value = name.defaultValue = editing?.name ?? "";
    clearValidation();
    rows.replaceChildren();
    if (!form.hidden) {
      for (const entry of editing?.entries ?? [{}]) addEntry(entry);
    }
    syncLibrary();
    status.textContent = "";
  }

  function draftEntries() {
    return Array.from(rows.children, row => {
      const [original, translation, enabled, bidirectional] = row.querySelectorAll("input");
      return {
        source: readGlossaryText(original), target: readGlossaryText(translation),
        ...(!enabled.checked && { enabled: false }),
        ...(bidirectional.checked && { bidirectional: true }),
      };
    });
  }

  function switchEditor(id) {
    if (fields.disabled) return;
    const changed = !form.hidden && (name.value !== name.defaultValue.replace(/[\r\n]/g, "") ||
      !sameEntries(editing?.entries ?? [], draftEntries().filter(term => term.source || term.target)));
    if (changed && !window.confirm("保存していない変更を破棄しますか？")) return;
    const previousId = editing?.id;
    openEditor(id);
    if (id === "") name.focus();
    else if (id !== undefined) heading.focus();
    else {
      const button = Array.from(document.querySelectorAll(".glossary-choice button"))
        .find(button => button.value === previousId);
      (button ?? create).focus();
    }
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
        let next = glossaries.filter(item => item.id !== id);
        if (entry) {
          next = current ? glossaries.map(item => item.id === id ? entry : item) : glossaries.concat(entry);
          glossaryTerms(next, selectedGlossaryIds);
          await chrome.storage.local.set({ glossaries: next });
        } else {
          await chrome.storage.local.set({
            glossaries: next, selectedGlossaryIds: selectedGlossaryIds.filter(selected => selected !== id),
          });
        }
        return next;
      });
      fields.disabled = false;
      openEditor(entry?.id);
      status.textContent = entry ? "用語集を保存しました。" : "用語集を削除しました。";
      (entry ? save : create).focus();
    } catch (error) {
      const latest = await chrome.storage.local.get("glossaries").catch(() => ({}));
      if (latest.glossaries) {
        glossaries = latest.glossaries;
        syncLibrary();
      }
      status.textContent = `用語集を更新できませんでした。 ${error.message}`;
      fields.disabled = false;
      (entry || remove.hidden ? save : remove).focus();
    } finally {
      fields.disabled = false;
    }
  }

  create.addEventListener("click", () => switchEditor(""));
  document.querySelector("#glossary-cancel").addEventListener("click", () => switchEditor());
  add.addEventListener("click", () => addEntry().focus());
  remove.addEventListener("click", () => {
    if (editing && window.confirm(`「${editing.name}」を削除しますか？`)) update(editing.id);
  });
  form.addEventListener("input", clearValidation);
  form.addEventListener("submit", event => {
    event.preventDefault();
    status.textContent = "";
    const title = readGlossaryText(name);
    if (!title.trim()) {
      showValidation(name, "用語集の名前を入力してください。");
      return;
    }
    const entries = [];
    for (const [index, term] of draftEntries().entries()) {
      const { source, target } = term;
      if (!source && !target) continue;
      const sourceValid = validGlossaryTerm(source);
      if (!sourceValid || !validGlossaryTerm(target)) {
        const input = rows.children[index].querySelectorAll("input")[sourceValid ? 1 : 0];
        const label = input.closest("label").querySelector("span").textContent;
        const missing = `${label}を入力してください。`;
        showValidation(input, input.value.trim() ? "用語に使えない文字が含まれています。" : missing);
        return;
      }
      entries.push(term);
    }
    if (!entries.length) {
      showValidation(rows.querySelector("input") ?? addEntry(), "原語と訳語を1組以上入力してください。");
      return;
    }
    const id = editing?.id ?? crypto.randomUUID();
    update(id, { id, name: title, entries });
  });

  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files;
    fileInput.value = "";
    if (!file) return;
    importButton.disabled = true;
    fileStatus.textContent = "";
    try {
      const imported = parseGlossaryFile(await file.text());
      await withGlossaryLock(async () => {
        const { glossaries = [] } = await chrome.storage.local.get("glossaries");
        const next = glossaries.concat(imported);
        await chrome.storage.local.set({ glossaries: next });
      });
      fileStatus.textContent = `${imported.length}件の用語集を追加しました。`;
    } catch (error) {
      fileStatus.textContent = error instanceof SyntaxError ? "JSONファイルを読み込めませんでした。" : error.message;
    } finally {
      importButton.disabled = false;
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
      fileStatus.textContent = `用語集を書き出せませんでした。 ${error.message}`;
    }
  });

  setupGlossarySelection(items => {
    glossaries = items;
    create.disabled = false;
    syncLibrary();
  }, switchEditor);
  importButton.disabled = false;
}
