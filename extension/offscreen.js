import { savedModel } from "./model.js";

let worker;
let modelVersion;
let workerMode;
let idleTimer;
let preparing;
let busy = false;

function resetWorker() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = undefined;
}

function runWorker(message, onPartial) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.partial !== undefined) onPartial(data);
      else resolve(data);
    };
    worker.onerror = () => reject(new Error("推論Workerを実行できませんでした。"));
    worker.postMessage(message);
  });
}

function keepWorkerReady() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(resetWorker, 5 * 60 * 1000);
}

function prepare(mode) {
  preparing ??= (async () => {
    clearTimeout(idleTimer);
    const model = await savedModel();
    if (!model) throw new Error("拡張機能の設定でモデルを読み込んでください。");
    if (worker && model.lastModified === modelVersion && mode === workerMode) return;
    resetWorker();
    worker = new Worker("./inference-worker.js", { type: "module" });
    const result = await runWorker({ blob: model, mode });
    if (result.error) throw new Error(result.error);
    modelVersion = model.lastModified;
    workerMode = mode;
  })().catch(error => {
    resetWorker();
    throw error;
  }).finally(() => {
    preparing = undefined;
    if (worker && !busy) keepWorkerReady();
  });
  return preparing;
}

async function translate(text, target, mode, onPartial) {
  if (text.includes("<|plamo:") || text.includes("\0")) {
    return { error: "原文に翻訳できない制御文字が含まれています。" };
  }
  // 事前読み込みの完了を待ち、翻訳時に指定された実行先を適用する
  if (preparing) await preparing.catch(() => {});
  await prepare(mode);
  const result = await runWorker({ text, target }, onPartial);
  if (result.error) resetWorker();
  else keepWorkerReady();
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.tab) return;
  if (message.type === "warm-engine") {
    respond({ accepted: true });
    if (!busy) prepare(message.mode).catch(() => {});
    return;
  }
  if (message.type !== "infer") return;
  if (busy) {
    respond({ busy: true, error: "別の投稿を翻訳中です。完了してからもう一度お試しください。" });
    return;
  }
  busy = true;
  respond({ accepted: true });
  const { id, tabId, documentId, text, target, mode } = message;
  function sendResult(result) {
    return chrome.runtime.sendMessage({ type: "inference-result", id, tabId, documentId, result }).catch(() => {});
  }
  translate(text, target, mode, sendResult).catch(error => {
    resetWorker();
    return { error: error.message };
  }).then(result => {
    busy = false;
    return sendResult(result);
  });
});
