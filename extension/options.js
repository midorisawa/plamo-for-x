import { importModel, savedModel } from "./model.js";

const input = document.querySelector("input");
const status = document.querySelector("#status");
const languageSelect = document.querySelector("#target-language");
const languageStatus = document.querySelector("#language-status");
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

try {
  status.textContent = await savedModel() ? "モデルを保存済みです。" : "モデルが未登録です。";
} catch {
  status.textContent = "モデルの保存先を確認できませんでした。";
}

input.addEventListener("change", async () => {
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  status.textContent = "モデルを保存中…";
  try {
    await importModel(file);
    status.textContent = "モデルを保存しました。Xで翻訳できます。";
  } catch (error) {
    status.textContent = `モデルを保存できませんでした。 ${error.message}`;
  } finally {
    input.value = "";
    input.disabled = false;
  }
});
input.disabled = false;
