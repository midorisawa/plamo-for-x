import { glossaryTerms } from "./glossary.js";

const offscreenPage = "offscreen.html";
let creating;
let closing = Promise.resolve();

function offscreenContexts() {
  return chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(offscreenPage)],
  });
}

async function ensureOffscreen() {
  if (!creating) {
    creating = (async () => {
      await closing;
      const contexts = await offscreenContexts();
      if (contexts.length) return;
      await chrome.offscreen.createDocument({
        url: offscreenPage,
        reasons: ["WORKERS"],
        justification: "PLaMo 3 Translateのローカル推論Workerを実行する",
      });
    })().finally(() => { creating = undefined; });
  }
  await creating;
}

chrome.tabs.onRemoved.addListener(() => {
  const pendingCreation = creating;
  closing = closing.then(async () => {
    await pendingCreation?.catch(() => {});
    if (!(await offscreenContexts()).length) return;
    const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
    if (!tabs.length) await chrome.offscreen.closeDocument();
  }).catch(error => console.warn("翻訳エンジンを終了できませんでした。", error));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.tab && message.type === "get-glossary-terms") {
    (async () => {
      const { glossaries = [], selectedGlossaryIds = [] } =
        await chrome.storage.local.get(["glossaries", "selectedGlossaryIds"]);
      return { terms: glossaryTerms(glossaries, selectedGlossaryIds) };
    })().then(respond, error => respond({ error: error.message }));
    return true;
  }
  if (message.type === "get-gpu-support") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: "check-engine-gpu" }))
      .then(respond, () => respond(false));
    return true;
  }
  if (message.type === "warm-translation" && sender.tab) {
    (async () => {
      await ensureOffscreen();
      const { inferenceMode: mode, selectedModel } =
        await chrome.storage.local.get(["inferenceMode", "selectedModel"]);
      return chrome.runtime.sendMessage({ type: "warm-engine", mode, selectedModel });
    })().then(respond, () => respond());
    return true;
  }
  if (message.type === "translate-post" && sender.tab?.id !== undefined && sender.documentId) {
    (async () => {
      await ensureOffscreen();
      const { inferenceMode: mode, selectedModel } =
        await chrome.storage.local.get(["inferenceMode", "selectedModel"]);
      return chrome.runtime.sendMessage({
        type: "infer",
        id: message.id,
        text: message.text,
        target: message.target,
        postId: message.postId,
        preview: message.preview,
        glossary: message.glossary,
        mode,
        selectedModel,
        tabId: sender.tab.id,
        documentId: sender.documentId,
      });
    })().then(respond, () => respond({ error: "翻訳エンジンを起動できませんでした。" }));
    return true;
  }
  if (message.type === "inference-result" && sender.url === chrome.runtime.getURL(offscreenPage)) {
    const { id, tabId, documentId, result } = message;
    chrome.tabs.sendMessage(tabId, { type: "translation-result", id, result }, { documentId })
      .catch(() => {}); // ページを閉じた場合は結果の送信先が消える
  }
});
