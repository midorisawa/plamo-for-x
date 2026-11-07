const offscreenPage = "offscreen.html";
let creating;

async function ensureOffscreen() {
  if (!creating) {
    creating = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(offscreenPage)],
      });
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

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "warm-translation" && sender.tab) {
    ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "warm-engine" }))
      .then(respond, () => respond());
    return true;
  }
  if (message.type === "translate-post" && sender.tab?.id !== undefined && sender.documentId) {
    (async () => {
      await ensureOffscreen();
      return chrome.runtime.sendMessage({
        type: "infer",
        id: message.id,
        text: message.text,
        target: message.target,
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
