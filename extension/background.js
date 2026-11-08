import { glossaryTerms, withGlossaryLock } from "./glossary.js";
import { activeModel, effectiveInferenceMode, modelCompatibility, models, modelSource } from "./model.js";

const offscreenPage = "offscreen.html";
let creating;
let gpuCheck;
let selectedTerms;
let iconUpdate = Promise.resolve();
const startingTranslations = new Map();

function offscreenContexts() {
  return chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(offscreenPage)],
  });
}

async function ensureOffscreen() {
  if (!creating) {
    creating = (async () => {
      const contexts = await offscreenContexts();
      if (contexts.length) return;
      await chrome.offscreen.createDocument({
        url: offscreenPage,
        reasons: ["WORKERS"],
        justification: "ローカル推論Workerを実行し、配色に合わせてツールバーアイコンを切り替える",
      });
    })().finally(() => { creating = undefined; });
  }
  await creating;
}

function startThemeObserver() {
  ensureOffscreen().catch(error => console.warn("アイコンの配色を確認できませんでした。", error));
  updateToolbarIcon().catch(error => console.warn("アイコンを更新できませんでした。", error));
}

function initializeExtension() {
  allowGpuCacheAccess().catch(() => {});
  startThemeObserver();
}

function allowGpuCacheAccess() {
  return chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
}

function gpuAvailable() {
  return gpuCheck ??= (async () => {
    await allowGpuCacheAccess().catch(() => {});
    const { gpuSupport } = await chrome.storage.session.get("gpuSupport");
    if (typeof gpuSupport === "boolean") return gpuSupport;
    await ensureOffscreen();
    const supported = await chrome.runtime.sendMessage({ type: "check-engine-gpu" });
    if (typeof supported === "boolean") {
      await chrome.storage.session.set({ gpuSupport: supported }).catch(() => {});
    }
    return supported === true;
  })().finally(() => { gpuCheck = undefined; });
}

chrome.runtime.onInstalled.addListener(initializeExtension);
chrome.runtime.onStartup.addListener(initializeExtension);

function updateToolbarIcon(dark) {
  const update = iconUpdate.then(async () => {
    if (typeof dark === "boolean") await chrome.storage.session.set({ toolbarDark: dark });
    const { enabled } = await chrome.storage.local.get("enabled");
    const { toolbarDark } = await chrome.storage.session.get("toolbarDark");
    const theme = enabled === false ? "disabled" : toolbarDark ? "dark" : "light";
    await chrome.action.setIcon({
      path: { 16: `icons/toolbar-${theme}-16.png`, 32: `icons/toolbar-${theme}-32.png` },
    });
  });
  iconUpdate = update.catch(() => {});
  return update;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.glossaries || changes.selectedGlossaryIds)) {
    selectedTerms = undefined;
  }
  if (area === "local" && changes.enabled) {
    updateToolbarIcon().catch(error => console.warn("アイコンを更新できませんでした。", error));
    if (changes.enabled.newValue === false) {
      releaseEngine().catch(error => console.warn("翻訳エンジンを終了できませんでした。", error));
    }
  }
});

async function releaseEngine() {
  await creating?.catch(() => {});
  if ((await offscreenContexts()).length) await chrome.runtime.sendMessage({ type: "release-engine" });
}

chrome.tabs.onRemoved.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
    if (!tabs.length) await releaseEngine();
  } catch (error) {
    console.warn("翻訳エンジンを終了できませんでした。", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "toolbar-color-scheme" && typeof message.dark === "boolean") {
    (async () => {
      if (sender.url === chrome.runtime.getURL(offscreenPage)) {
        // Chromeの外観を参照できる画面があれば、OSの配色による上書きを避ける
        const [tabs, pages] = await Promise.all([
          chrome.tabs.query({ url: "https://x.com/*", discarded: false }),
          chrome.runtime.getContexts({ contextTypes: ["TAB", "POPUP"] }),
        ]);
        if (tabs.length || pages.length) return;
      }
      await updateToolbarIcon(message.dark);
    })().then(() => respond(true), () => respond(false));
    return true;
  }
  if (sender.tab && message.type === "get-glossary-terms") {
    if (!selectedTerms) {
      const request = chrome.storage.local.get(["glossaries", "selectedGlossaryIds"])
        .then(({ glossaries = [], selectedGlossaryIds = [] }) =>
          ({ terms: glossaryTerms(glossaries, selectedGlossaryIds) }));
      selectedTerms = request;
      request.catch(() => {
        if (selectedTerms === request) selectedTerms = undefined;
      });
    }
    selectedTerms.then(respond, error => respond({ error: error.message }));
    return true;
  }
  if (message.type === "set-glossary-selection" && sender.url?.split("#")[0] === chrome.runtime.getURL("options.html")) {
    withGlossaryLock(async () => {
      const { glossaries = [], selectedGlossaryIds = [] } =
        await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
      if (!glossaries.some(({ id }) => id === message.id)) throw new Error("用語集は削除されました。");
      const next = glossaries.filter(({ id }) => id === message.id ? message.checked : selectedGlossaryIds.includes(id))
        .map(({ id }) => id);
      glossaryTerms(glossaries, next);
      await chrome.storage.local.set({ selectedGlossaryIds: next });
    }).then(() => respond({}), error => respond({ error: error.message }));
    return true;
  }
  if (message.type === "get-gpu-support") {
    gpuAvailable().then(respond, () => respond(false));
    return true;
  }
  if (message.type === "get-translation-models" && sender.tab) {
    (async () => {
      const { selectedModel, inferenceMode } = await chrome.storage.local.get(["selectedModel", "inferenceMode"]);
      const mode = await effectiveInferenceMode(inferenceMode, () => gpuAvailable().catch(() => false));
      const available = new Map(await Promise.all(models.map(async ({ id }) => [id, await modelSource(id)])));
      const active = await activeModel(selectedModel, available, mode);
      return {
        activeModelId: active?.id,
        models: models.filter(model => available.get(model.id) && !modelCompatibility(model, mode))
          .map(({ id, label, gpuRequired }) =>
          ({ id, label: `PLaMo 3 Translate ${label}${gpuRequired ? "（WebGPU必須）" : ""}` })),
      };
    })().then(respond, () => respond());
    return true;
  }
  if (message.type === "warm-translation" && sender.tab) {
    (async () => {
      const { enabled, inferenceMode: mode, selectedModel } =
        await chrome.storage.local.get(["enabled", "inferenceMode", "selectedModel"]);
      if (enabled === false) return;
      await ensureOffscreen();
      return chrome.runtime.sendMessage({ type: "warm-engine", mode, selectedModel });
    })().then(respond, () => respond());
    return true;
  }
  if (message.type === "stop-post-translation" && sender.tab?.id !== undefined && sender.documentId) {
    const { id } = message;
    const key = JSON.stringify([sender.tab.id, sender.documentId, id]);
    const starting = startingTranslations.get(key);
    if (starting) starting.stopped = true;
    if (starting && !starting.forwarded) {
      respond();
      return;
    }
    chrome.runtime.sendMessage({
      type: "stop-inference", id, tabId: sender.tab.id, documentId: sender.documentId,
    }).then(() => respond(), () => respond());
    return true;
  }
  if (message.type === "translate-post" && sender.tab?.id !== undefined && sender.documentId) {
    const key = JSON.stringify([sender.tab.id, sender.documentId, message.id]);
    const starting = { stopped: false, forwarded: false };
    startingTranslations.set(key, starting);
    (async () => {
      const { enabled, inferenceMode: mode, selectedModel } =
        await chrome.storage.local.get(["enabled", "inferenceMode", "selectedModel"]);
      if (enabled === false) return { error: "投稿の翻訳は無効です。" };
      await ensureOffscreen();
      if (starting.stopped) return { stopped: true };
      starting.forwarded = true;
      return chrome.runtime.sendMessage({
        type: "infer",
        id: message.id,
        text: message.text,
        target: message.target,
        postId: message.postId,
        preview: message.preview,
        cacheRevision: message.cacheRevision,
        glossary: message.glossary,
        mode,
        selectedModel,
        modelId: message.modelId,
        tabId: sender.tab.id,
        documentId: sender.documentId,
      });
    })().finally(() => startingTranslations.delete(key))
      .then(respond, () => respond({ error: "翻訳エンジンを起動できませんでした。" }));
    return true;
  }
  if (message.type === "inference-result" && sender.url === chrome.runtime.getURL(offscreenPage)) {
    const { id, tabId, documentId, result } = message;
    chrome.tabs.sendMessage(tabId, { type: "translation-result", id, result }, { documentId })
      .catch(() => {}); // ページを閉じた場合は結果の送信先が消える
  }
});
