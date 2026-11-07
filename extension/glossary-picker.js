const glossaryPicker = document.createElement("dialog");
glossaryPicker.className = "sns-translator-glossary";
glossaryPicker.setAttribute("aria-label", "適用する用語集");
glossaryPicker.innerHTML = `
  <form>
    <h2>適用する用語集</h2>
    <p>選択はすべてのXタブで共有され、次の翻訳から適用されます。</p>
    <div class="sns-translator-glossary-choices"></div>
    <p role="status"></p>
    <div class="sns-translator-glossary-actions">
      <button type="button" data-action="settings">設定タブで編集</button>
      <button type="button" data-action="cancel">キャンセル</button>
      <button type="submit">適用</button>
    </div>
  </form>`;

const glossaryChoices = glossaryPicker.querySelector(".sns-translator-glossary-choices");
const glossaryFeedback = glossaryPicker.querySelector("[role=status]");
const glossaryApply = glossaryPicker.querySelector("[type=submit]");

async function showGlossaryPicker() {
  if (glossaryPicker.open) return;
  document.body.append(glossaryPicker);
  glossaryFeedback.textContent = "";
  glossaryChoices.textContent = "読み込み中…";
  glossaryApply.disabled = true;
  glossaryPicker.showModal();
  try {
    const { glossaries = [], selectedGlossaryIds = [] } =
      await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
    glossaryChoices.replaceChildren();
    for (const { id, name, entries } of glossaries) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = id;
      input.checked = selectedGlossaryIds.includes(id);
      label.append(input, ` ${name}（${entries.length}組）`);
      glossaryChoices.append(label);
    }
    if (!glossaries.length) glossaryChoices.textContent = "設定タブで用語集を作成できます。";
    glossaryApply.disabled = false;
  } catch {
    glossaryFeedback.textContent = "用語集を読み込めませんでした。";
  }
}

glossaryPicker.querySelector("[data-action=cancel]").addEventListener("click", () => glossaryPicker.close());
glossaryPicker.querySelector("[data-action=settings]").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "open-glossary-settings" });
    if (result.error) throw new Error(result.error);
    glossaryPicker.close();
  } catch {
    glossaryFeedback.textContent = "設定タブを開けませんでした。";
  }
});
glossaryPicker.querySelector("form").addEventListener("submit", async event => {
  event.preventDefault();
  if (glossaryApply.disabled) return;
  glossaryApply.disabled = true;
  glossaryFeedback.textContent = "";
  try {
    const ids = [...glossaryChoices.querySelectorAll("input:checked")].map(input => input.value);
    const result = await chrome.runtime.sendMessage({ type: "select-glossaries", ids });
    if (result.error) throw new Error(result.error);
    glossaryPicker.close();
  } catch (error) {
    glossaryFeedback.textContent = error.message;
  } finally {
    glossaryApply.disabled = false;
  }
});
