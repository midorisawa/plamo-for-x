import { setupModelSettings } from "./model-settings.js";
import { setupGlossarySettings } from "./glossary-settings.js";
import { clearTranslationCache, readCacheUsage, setCacheLimit } from "./translation-cache.js";

const popup = chrome.extension.getViews({ type: "popup" }).includes(window);
document.documentElement.classList.toggle("popup", popup);
if (!popup) {
  setupModelSettings();
  const root = document.documentElement;
  const dismissed = "settings-highlight-dismissed";
  window.addEventListener("hashchange", () => root.classList.remove(dismissed));
  document.addEventListener("click", ({ target }) => {
    if (target.closest(".settings-nav a")) {
      root.classList.remove(dismissed);
      return;
    }
    const panel = document.querySelector(".panel:target");
    if (panel && !panel.contains(target)) root.classList.add(dismissed);
  });
}
setupGlossarySettings(popup);
const enabledSwitch = document.querySelector("#enabled");
const enabledLabel = document.querySelector("#enabled-label");
if (popup) document.querySelector(".app-header").append(enabledSwitch.closest("label"));
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
const settingsFields = document.querySelector("#translation-fields");
const settingsStatus = document.querySelector("#settings-status");
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

languageSelect.addEventListener("change", () => {
  updateSourceChoices();
  applySetting("targetLanguage", languageSelect.value);
});
sourceLanguagesField.addEventListener("change", event => {
  if (event.target === allSourceLanguages) {
    for (const checkbox of visibleSourceInputs()) checkbox.checked = allSourceLanguages.checked;
  }
  updateSourceSummary();
  applySetting("sourceLanguages", readSourceLanguages());
});
inferenceSelect.addEventListener("change", () => applySetting("inferenceMode", inferenceSelect.value));
autoTranslate.addEventListener("change", () => applySetting("autoTranslate", autoTranslate.checked));

const settingsKeys = ["targetLanguage", "sourceLanguages", "inferenceMode", "autoTranslate"];
let settingsRefresh = 0;
let gpuSupport;

async function refreshSettings() {
  const refresh = ++settingsRefresh;
  const { targetLanguage, sourceLanguages, inferenceMode, autoTranslate: automatic } =
    await chrome.storage.local.get(settingsKeys);
  const explicitMode = inferenceMode === "gpu" || inferenceMode === "cpu";
  const gpu = (!explicitMode || typeof automatic !== "boolean") &&
    await (gpuSupport ??= chrome.runtime.sendMessage({ type: "get-gpu-support" }).catch(() => false)) === true;
  if (refresh !== settingsRefresh) return;
  languageSelect.value = translationLanguage(targetLanguage);
  for (const checkbox of sourceInputs) checkbox.checked = sourceLanguages?.includes(checkbox.value) ?? true;
  inferenceSelect.value = explicitMode ? inferenceMode : gpu ? "gpu" : "cpu";
  autoTranslate.checked = typeof automatic === "boolean" ? automatic : gpu;
  updateSourceChoices();
}

try {
  await refreshSettings();
  for (const control of [languageSelect, sourceLanguagesField, inferenceSelect, autoTranslate]) control.disabled = false;
  settingsFields.disabled = false;
  settingsStatus.textContent = "";
} catch {
  settingsStatus.textContent = "設定を読み込めませんでした。";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && settingsKeys.some(key => key in changes)) {
    refreshSettings().catch(() => {});
  }
});

async function applySetting(key, value) {
  settingsStatus.textContent = "";
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {
    settingsStatus.textContent = "設定を反映できませんでした。";
    await refreshSettings().catch(() => {});
  }
}

const mebibyte = 1024 * 1024;
const cacheSettings = document.querySelector("#cache-settings");
const cacheFields = cacheSettings.querySelector("fieldset");
const cacheLimitInput = document.querySelector("#cache-limit");
const cacheMeter = document.querySelector("#cache-meter");
const cacheUsage = document.querySelector("#cache-usage");
const cacheStatus = document.querySelector("#cache-status");
const cacheNumber = new Intl.NumberFormat("ja", { maximumFractionDigits: 2 });
const invalidCacheLimitMessage = "キャッシュの上限をMiB単位の正の整数で入力してください。";
const cacheLimitUpdates = popup ? null : new BroadcastChannel("sns-translator-cache-limit");
let requestedLimit;
let editingCacheLimit = false;
let pendingCacheLimits = 0;
let cacheInputRevision = 0;

async function updateCacheSettings(action, success, failure) {
  const inputRevision = cacheInputRevision;
  const canUpdateStatus = () => inputRevision === cacheInputRevision &&
    cacheStatus.textContent !== invalidCacheLimitMessage;
  try {
    await action?.();
    const { bytes, limit } = await readCacheUsage();
    cacheMeter.max = limit;
    cacheMeter.value = bytes;
    const used = bytes > 0 && bytes / mebibyte < 0.01
      ? "0.01MiB未満" : `${cacheNumber.format(bytes / mebibyte)}MiB`;
    cacheUsage.textContent = `${used} / ${cacheNumber.format(limit / mebibyte)}MiB`;
    if (!pendingCacheLimits) {
      requestedLimit = limit;
      if (!editingCacheLimit) cacheLimitInput.value = limit / mebibyte;
    }
    cacheFields.disabled = false;
    if (success !== null && canUpdateStatus()) cacheStatus.textContent = success;
  } catch {
    if (canUpdateStatus()) cacheStatus.textContent = failure;
  }
}

function applyCacheLimit() {
  if (cacheFields.disabled) return;
  const limit = cacheLimitInput.valueAsNumber * mebibyte;
  if (!cacheLimitInput.validity.valid || !Number.isSafeInteger(limit)) {
    cacheStatus.textContent = invalidCacheLimitMessage;
    return;
  }
  editingCacheLimit = false;
  if (cacheStatus.textContent === invalidCacheLimitMessage) cacheStatus.textContent = "";
  if (limit === requestedLimit) return;
  requestedLimit = limit;
  pendingCacheLimits++;
  updateCacheSettings(async () => {
    try {
      await setCacheLimit(limit);
      cacheLimitUpdates.postMessage("changed");
    } catch (error) {
      if (requestedLimit === limit) {
        requestedLimit = undefined;
        editingCacheLimit = true;
      }
      throw error;
    } finally {
      pendingCacheLimits--;
    }
  }, "キャッシュの上限を変更しました。", "キャッシュの上限を変更できませんでした。");
}

cacheLimitInput.addEventListener("input", () => {
  editingCacheLimit = true;
  cacheInputRevision++;
});
cacheLimitInput.addEventListener("blur", applyCacheLimit);
cacheSettings.addEventListener("submit", event => {
  event.preventDefault();
  applyCacheLimit();
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
function refreshCacheUsage() {
  updateCacheSettings(null, null, "キャッシュの使用量を読み込めませんでした。");
}

cacheLimitUpdates?.addEventListener("message", refreshCacheUsage);
document.addEventListener("visibilitychange", () => {
  if (!popup && !document.hidden) {
    refreshCacheUsage();
  }
});
if (!popup) updateCacheSettings(null, "", "キャッシュの使用量を読み込めませんでした。");
