import { setupModelSettings } from "./model-settings.js";
import { clearTranslationCache, readCacheUsage, setCacheLimit } from "./translation-cache.js";

setupModelSettings(chrome.extension.getViews({ type: "popup" }).includes(window));
const languageSelect = document.querySelector("#target-language");
const languageStatus = document.querySelector("#language-status");
const inferenceSelect = document.querySelector("#inference-mode");
const inferenceStatus = document.querySelector("#inference-status");
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

try {
  const { targetLanguage } = await chrome.storage.local.get("targetLanguage");
  languageSelect.value = translationLanguage(targetLanguage);
  languageSelect.disabled = false;
  languageSelect.addEventListener("change", async () => {
    languageSelect.disabled = true;
    try {
      await chrome.storage.local.set({ targetLanguage: languageSelect.value });
      languageStatus.textContent = "";
    } catch {
      languageStatus.textContent = "翻訳先を保存できませんでした。";
    } finally {
      languageSelect.disabled = false;
    }
  });
} catch {
  languageStatus.textContent = "翻訳先の設定を読み込めませんでした。";
}

const sourceLanguagesField = document.querySelector("#source-languages");
const allSourceLanguages = document.querySelector("#all-source-languages");
const sourceLanguageChoices = document.querySelector("#source-language-choices");
const sourceLanguageStatus = document.querySelector("#source-language-status");
const sourceInputs = [...translationLanguages, "und"].map(code => {
  const label = document.createElement("label");
  label.className = "check";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = code;
  label.append(checkbox, code === "und" ? "言語を判定できない原文" : languageNames.of(code));
  sourceLanguageChoices.append(label);
  return checkbox;
});

function showSourceLanguages(saved) {
  for (const checkbox of sourceInputs) checkbox.checked = saved?.includes(checkbox.value) ?? true;
  const checkedCount = sourceInputs.filter(checkbox => checkbox.checked).length;
  allSourceLanguages.checked = checkedCount === sourceInputs.length;
  allSourceLanguages.indeterminate = checkedCount > 0 && !allSourceLanguages.checked;
}

try {
  let { sourceLanguages } = await chrome.storage.local.get("sourceLanguages");
  showSourceLanguages(sourceLanguages);
  sourceLanguagesField.disabled = false;
  sourceLanguagesField.addEventListener("change", async event => {
    if (event.target === allSourceLanguages) {
      for (const checkbox of sourceInputs) checkbox.checked = allSourceLanguages.checked;
    }
    const checked = sourceInputs.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
    const selected = checked.length === sourceInputs.length ? null : checked;
    showSourceLanguages(selected);
    sourceLanguagesField.disabled = true;
    try {
      await chrome.storage.local.set({ sourceLanguages: selected });
      sourceLanguages = selected;
      sourceLanguageStatus.textContent = "";
    } catch {
      showSourceLanguages(sourceLanguages);
      sourceLanguageStatus.textContent = "原文の言語設定を保存できませんでした。";
    } finally {
      sourceLanguagesField.disabled = false;
    }
  });
} catch {
  sourceLanguageStatus.textContent = "原文の言語設定を読み込めませんでした。";
}

try {
  const { inferenceMode } = await chrome.storage.local.get("inferenceMode");
  let savedMode = inferenceMode === "gpu" || inferenceMode === "cpu" ? inferenceMode : "auto";
  inferenceSelect.value = savedMode;
  inferenceSelect.disabled = false;
  inferenceSelect.addEventListener("change", async () => {
    inferenceSelect.disabled = true;
    try {
      await chrome.storage.local.set({ inferenceMode: inferenceSelect.value });
      savedMode = inferenceSelect.value;
      inferenceStatus.textContent = "";
    } catch {
      inferenceSelect.value = savedMode;
      inferenceStatus.textContent = "翻訳の実行先を保存できませんでした。";
    } finally {
      inferenceSelect.disabled = false;
    }
  });
} catch {
  inferenceStatus.textContent = "翻訳の実行先を読み込めませんでした。";
}

const autoTranslate = document.querySelector("#auto-translate");
const autoTranslateStatus = document.querySelector("#auto-translate-status");
try {
  const settings = await chrome.storage.local.get("autoTranslate");
  autoTranslate.checked = settings.autoTranslate === true;
  autoTranslate.disabled = false;
  autoTranslate.addEventListener("change", async () => {
    const checked = autoTranslate.checked;
    autoTranslate.disabled = true;
    try {
      await chrome.storage.local.set({ autoTranslate: checked });
      autoTranslateStatus.textContent = "";
    } catch {
      autoTranslate.checked = !checked;
      autoTranslateStatus.textContent = "自動翻訳の設定を保存できませんでした。";
    } finally {
      autoTranslate.disabled = false;
    }
  });
} catch {
  autoTranslateStatus.textContent = "自動翻訳の設定を読み込めませんでした。";
}

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
  if (!document.hidden && !cacheFields.disabled) {
    updateCacheSettings(null, cacheStatus.textContent, "キャッシュの使用量を読み込めませんでした。", false);
  }
});
updateCacheSettings(null, "", "キャッシュの使用量を読み込めませんでした。");
