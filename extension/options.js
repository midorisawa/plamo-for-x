import { modelSource, withModelLock } from "./model.js";
import { setupModelSettings } from "./model-settings.js";
import { setupGlossarySettings } from "./glossary-settings.js";
import { glossaryTerms, withGlossaryLock } from "./glossary.js";
import { clearTranslationCache, readCacheUsage, setCacheLimit } from "./translation-cache.js";

const popup = chrome.extension.getViews({ type: "popup" }).includes(window);
document.documentElement.classList.toggle("popup", popup);
if (!popup) {
  setupModelSettings();
  document.querySelector("#glossary-picker").open = true;
}
setupGlossarySettings(popup);
const enabledSwitch = document.querySelector("#enabled");
const enabledLabel = document.querySelector("#enabled-label");
let translationEnabled = true;

function showEnabled(value) {
  translationEnabled = value !== false;
  enabledSwitch.checked = translationEnabled;
  enabledLabel.textContent = translationEnabled ? "有効" : "無効";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) showEnabled(changes.enabled.newValue);
});
chrome.storage.local.get("enabled").then(({ enabled }) => {
  showEnabled(enabled);
  enabledSwitch.disabled = false;
}).catch(() => { enabledLabel.textContent = "状態を読み込めませんでした"; });
enabledSwitch.addEventListener("change", async () => {
  enabledSwitch.disabled = true;
  try {
    await chrome.storage.local.set({ enabled: enabledSwitch.checked });
  } catch {
    enabledSwitch.checked = translationEnabled;
    enabledLabel.textContent = "切り替えられませんでした";
  } finally {
    enabledSwitch.disabled = false;
  }
});

const languageSelect = document.querySelector("#target-language");
const settingsForm = document.querySelector("#translation-settings");
const settingsFields = document.querySelector("#translation-fields");
const saveButton = document.querySelector("#save-settings");
const saveStatus = document.querySelector("#save-status");
const modelSelect = document.querySelector("#selected-model");
const glossaryChoices = document.querySelector("#glossary-selection-choices");
const autoTranslate = document.querySelector("#auto-translate");
const inferenceSelect = document.querySelector("#inference-mode");
const browserLanguage = preferredTranslationLanguage();
const languageNames = new Intl.DisplayNames(["ja"], { type: "language" });
languageSelect.add(new Option(
  browserLanguage ? `ブラウザの優先言語（${languageNames.of(browserLanguage)}）` : "翻訳先を選択",
  "",
));
for (const code of translationLanguages) {
  const names = new Intl.DisplayNames([code], { type: "language" });
  languageSelect.add(new Option(names.of(code), code));
}

const sourceLanguagesField = document.querySelector("#source-languages");
const allSourceLanguages = document.querySelector("#all-source-languages");
const sourceLanguageChoices = document.querySelector("#source-language-choices");
const priorityEnd = translationLanguages.indexOf("ko") + 1;
const japaneseOrder = new Intl.Collator("ja");
const sourceLanguagesInOrder = [
  ...translationLanguages.slice(0, priorityEnd),
  ...translationLanguages.slice(priorityEnd).sort((a, b) => japaneseOrder.compare(languageNames.of(a), languageNames.of(b))),
  "und",
];
const sourceInputs = sourceLanguagesInOrder.map(code => {
  const label = document.createElement("label");
  label.className = "check";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = code;
  label.append(checkbox, code === "und" ? "言語を判定できない原文" : languageNames.of(code));
  sourceLanguageChoices.append(label);
  return checkbox;
});

function visibleSourceInputs() {
  return sourceInputs.filter(checkbox => !checkbox.parentElement.hidden);
}

function updateSourceChoices() {
  const target = languageSelect.value || browserLanguage;
  for (const checkbox of sourceInputs) checkbox.parentElement.hidden = checkbox.value === target;
  updateSourceSummary();
}

function readSourceLanguages() {
  const checked = sourceInputs.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
  return checked.length === sourceInputs.length ? null : checked;
}

function updateSourceSummary() {
  const visible = visibleSourceInputs();
  const checkedCount = visible.filter(checkbox => checkbox.checked).length;
  allSourceLanguages.checked = checkedCount === visible.length;
  allSourceLanguages.indeterminate = checkedCount > 0 && !allSourceLanguages.checked;
}

function readSettings() {
  return {
    targetLanguage: languageSelect.value,
    sourceLanguages: readSourceLanguages(),
    inferenceMode: inferenceSelect.value,
    autoTranslate: autoTranslate.checked,
  };
}

languageSelect.addEventListener("change", updateSourceChoices);
sourceLanguagesField.addEventListener("change", event => {
  if (event.target === allSourceLanguages) {
    for (const checkbox of visibleSourceInputs()) checkbox.checked = allSourceLanguages.checked;
  }
  updateSourceSummary();
});

let savedSettings;
try {
  const { targetLanguage, sourceLanguages, inferenceMode, autoTranslate: automatic } =
    await chrome.storage.local.get(["targetLanguage", "sourceLanguages", "inferenceMode", "autoTranslate"]);
  languageSelect.value = translationLanguage(targetLanguage);
  for (const checkbox of sourceInputs) checkbox.checked = sourceLanguages?.includes(checkbox.value) ?? true;
  updateSourceChoices();
  const explicitMode = inferenceMode === "gpu" || inferenceMode === "cpu";
  const gpu = (!explicitMode || typeof automatic !== "boolean") &&
    await chrome.runtime.sendMessage({ type: "get-gpu-support" }).catch(() => false) === true;
  inferenceSelect.value = explicitMode ? inferenceMode : gpu ? "gpu" : "cpu";
  autoTranslate.checked = typeof automatic === "boolean" ? automatic : gpu;
  savedSettings = readSettings();
  for (const control of [languageSelect, sourceLanguagesField, inferenceSelect, autoTranslate]) control.disabled = false;
  settingsFields.disabled = false;
  saveButton.disabled = false;
  saveStatus.textContent = "";
} catch {
  saveStatus.textContent = "設定を読み込めませんでした。";
}

function readChanges(draft) {
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(savedSettings[key])));
  const model = modelSelect.selectedOptions[0];
  if (model?.value && !model.defaultSelected) changes.selectedModel = model.value;
  const choices = [...glossaryChoices.querySelectorAll("input")];
  if (choices.some(input => input.checked !== input.defaultChecked)) {
    changes.selectedGlossaryIds = choices.filter(input => input.checked).map(input => input.value);
  }
  return changes;
}

settingsForm.addEventListener("change", () => {
  saveStatus.textContent = Object.keys(readChanges(readSettings())).length ? "未保存の変更があります。" : "";
});

async function saveChanges(changes) {
  if (changes.selectedGlossaryIds) {
    const { glossaries = [] } = await chrome.storage.local.get("glossaries");
    changes.selectedGlossaryIds = glossaries.filter(({ id }) => changes.selectedGlossaryIds.includes(id)).map(({ id }) => id);
    glossaryTerms(glossaries, changes.selectedGlossaryIds);
  }
  if (changes.selectedModel) {
    await withModelLock(async () => {
      if (!await modelSource(changes.selectedModel)) throw new Error("選択したモデルは削除されました。");
      await chrome.storage.local.set(changes);
    });
  } else if (Object.keys(changes).length) {
    await chrome.storage.local.set(changes);
  }
}

settingsForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (saveButton.disabled) return;
  const draft = readSettings();
  const changes = readChanges(draft);
  settingsFields.disabled = true;
  saveButton.disabled = true;
  saveStatus.textContent = "保存中…";
  try {
    if (changes.selectedGlossaryIds) await withGlossaryLock(() => saveChanges(changes));
    else await saveChanges(changes);
    if (changes.selectedModel) {
      for (const option of modelSelect.options) option.defaultSelected = option.value === changes.selectedModel;
      modelSelect.value = changes.selectedModel;
    }
    if (changes.selectedGlossaryIds) {
      for (const input of glossaryChoices.querySelectorAll("input")) {
        input.defaultChecked = input.checked = changes.selectedGlossaryIds.includes(input.value);
      }
    }
    savedSettings = draft;
    saveStatus.textContent = "設定を保存しました。";
  } catch (error) {
    saveStatus.textContent = `設定を保存できませんでした。 ${error.message}`;
  } finally {
    settingsFields.disabled = false;
    saveButton.disabled = false;
  }
});

const mebibyte = 1024 * 1024;
const cacheSettings = document.querySelector("#cache-settings");
const cacheFields = cacheSettings.querySelector("fieldset");
const cacheLimitInput = document.querySelector("#cache-limit");
const cacheMeter = document.querySelector("#cache-meter");
const cacheUsage = document.querySelector("#cache-usage");
const cacheStatus = document.querySelector("#cache-status");
const cacheNumber = new Intl.NumberFormat("ja", { maximumFractionDigits: 2 });

async function updateCacheSettings(action, success, failure, syncLimit = true) {
  cacheFields.disabled = true;
  try {
    await action?.();
    const { bytes, limit } = await readCacheUsage();
    cacheMeter.max = limit;
    cacheMeter.value = bytes;
    const used = bytes > 0 && bytes / mebibyte < 0.01
      ? "0.01MiB未満" : `${cacheNumber.format(bytes / mebibyte)}MiB`;
    cacheUsage.textContent = `${used} / ${cacheNumber.format(limit / mebibyte)}MiB`;
    if (syncLimit) cacheLimitInput.value = limit / mebibyte;
    cacheStatus.textContent = success;
  } catch {
    cacheStatus.textContent = failure;
  } finally {
    cacheFields.disabled = false;
  }
}

cacheSettings.addEventListener("submit", event => {
  event.preventDefault();
  const limit = cacheLimitInput.valueAsNumber * mebibyte;
  updateCacheSettings(() => setCacheLimit(limit), "キャッシュの上限を保存しました。", "キャッシュの上限を保存できませんでした。");
});
const clearCacheDialog = document.querySelector("#clear-cache-dialog");
document.querySelector("#clear-cache").addEventListener("click", () => {
  clearCacheDialog.returnValue = "";
  clearCacheDialog.showModal();
});
clearCacheDialog.addEventListener("close", () => {
  if (clearCacheDialog.returnValue === "confirm") {
    updateCacheSettings(clearTranslationCache, "キャッシュを削除しました。", "キャッシュを削除できませんでした。");
  }
});
document.addEventListener("visibilitychange", () => {
  if (!popup && !document.hidden && !cacheFields.disabled) {
    updateCacheSettings(null, cacheStatus.textContent, "キャッシュの使用量を読み込めませんでした。", false);
  }
});
if (!popup) updateCacheSettings(null, "", "キャッシュの使用量を読み込めませんでした。");
