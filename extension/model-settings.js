import { activeModel, cleanStagedModels, defaultModel, deleteModel, downloadModel, importModel, models, modelSource, withModelLock } from "./model.js";

export function setupModelSettings() {
  const select = document.querySelector("#selected-model");
  const selectionStatus = document.querySelector("#model-selection-status");
  const feedback = document.querySelector("#model-feedback");
  const input = document.querySelector("#import-model");
  const list = document.querySelector("#model-list");
  const template = document.querySelector("#model-row");
  let busy = false;
  let modelRefresh = 0;

  const rows = models.flatMap(({ id, label, size, bundled }) => {
    const row = template.content.firstElementChild.cloneNode(true);
    const name = `PLaMo 3 Translate ${label}`;
    row.querySelector("strong").textContent = name;
    const status = row.querySelector("small");
    const progress = row.querySelector("progress");
    const download = row.querySelector(".download-model");
    const cancel = row.querySelector(".cancel-download");
    const remove = row.querySelector(".remove-model");
    progress.setAttribute("aria-label", `${name}のダウンロード進捗`);
    download.setAttribute("aria-label", `${name}をダウンロード`);
    cancel.setAttribute("aria-label", `${name}のダウンロードを中止`);
    remove.setAttribute("aria-label", `${name}を削除`);
    list.append(row);
    if (bundled) {
      status.textContent = `${size}・同梱`;
      download.hidden = true;
      return [];
    }
    status.textContent = size;
    download.disabled = true;

    download.addEventListener("click", async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      cancel.addEventListener("click", abort, { once: true });
      download.hidden = true;
      cancel.hidden = false;
      progress.hidden = false;
      progress.removeAttribute("value");
      status.textContent = "ダウンロード中…";
      try {
        await changeFiles(() => downloadModel(id, (received, total) => {
          if (total > 0) {
            progress.max = total;
            progress.value = received;
          }
          const message = `ダウンロード中・${Math.floor(received / 1e6)}MB取得済み`;
          if (status.textContent !== message) status.textContent = message;
        }, controller.signal), `${name}を保存しました。`, controller.signal);
      } finally {
        cancel.removeEventListener("click", abort);
        cancel.hidden = true;
        progress.hidden = true;
      }
    });
    remove.addEventListener("click", () => {
      if (window.confirm(`${name}を削除しますか？`)) {
        changeFiles(() => deleteModel(id), `${name}を削除しました。`);
      }
    });
    return [{ id, size, status, download, remove }];
  });

  function disableControls() {
    select.disabled = true;
    input.disabled = true;
    for (const { download, remove } of rows) download.disabled = remove.disabled = true;
  }

  async function readActiveModel(available) {
    const { selectedModel } = await chrome.storage.local.get("selectedModel");
    return activeModel(selectedModel, available);
  }

  async function refresh() {
    const refreshId = ++modelRefresh;
    try {
      const available = new Map(await Promise.all(models.map(async ({ id }) => [id, await modelSource(id)])));
      const active = await readActiveModel(available);
      if (refreshId !== modelRefresh || busy) return;
      const options = models.filter(({ id }) => available.get(id))
        .map(({ id, label }) => new Option(`PLaMo 3 Translate ${label}`, id));
      select.replaceChildren(...(options.length ? options : [new Option("モデル未登録", "")]));
      select.value = active?.id ?? "";
      select.disabled = busy || !active;
      input.disabled = busy;
      for (const { id, size, status, download, remove } of rows) {
        const installed = Boolean(available.get(id));
        status.textContent = installed ? `${size}・保存済み` : size;
        download.hidden = installed;
        remove.hidden = !installed;
        download.disabled = remove.disabled = busy;
      }
    } catch {
      if (refreshId !== modelRefresh || busy) return;
      disableControls();
      selectionStatus.textContent = "モデルの保存先を確認できませんでした。";
    }
  }

  async function run(action, status, success = "", signal) {
    if (busy) return;
    busy = true;
    disableControls();
    status.textContent = "";
    try {
      await withModelLock(action);
      status.textContent = success;
    } catch (error) {
      status.textContent = signal?.aborted ? "ダウンロードを中止しました。" : `操作を完了できませんでした。 ${error.message}`;
    } finally {
      busy = false;
      await refresh();
    }
  }

  function changeFiles(action, success, signal) {
    return run(async () => {
      const previous = await readActiveModel();
      await action();
      const id = previous && await modelSource(previous.id) ? previous.id : defaultModel;
      await chrome.storage.local.set({ selectedModel: id });
    }, feedback, success, signal);
  }

  select.addEventListener("change", () => {
    const selectedModel = select.value;
    run(async () => {
      if (!await modelSource(selectedModel)) throw new Error("選択したモデルは削除されました。");
      await chrome.storage.local.set({ selectedModel });
    }, selectionStatus);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!busy && area === "local" && changes.selectedModel) refresh();
  });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    await changeFiles(async () => {
      feedback.textContent = "モデルを保存中…";
      await importModel(file);
    }, "モデルを保存しました。");
    input.value = "";
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !busy) refresh();
  });
  cleanStagedModels().catch(error => console.warn("モデルの一時ファイルを削除できませんでした。", error));
  refresh();
}
