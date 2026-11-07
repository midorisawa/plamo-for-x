import { activeModel, defaultModel } from "./model.js";
import { checkGpu } from "./gpu.js";
import { readTranslation, saveTranslation } from "./translation-cache.js";

let worker;
let loadedModel;
let workerMode;
let idleTimer;
let preparing;
let busy = false;
let gpuSupport;

function gpuAvailable() {
  return gpuSupport ??= checkGpu().then(() => true, () => false);
}

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

function prepare(mode, model, selectedModel) {
  preparing ??= (async () => {
    clearTimeout(idleTimer);
    model ??= (await activeModel(selectedModel))?.source;
    if (!model) throw new Error("拡張機能の設定でモデルを読み込んでください。");
    if (mode !== "gpu" && mode !== "cpu") mode = await gpuAvailable() ? "gpu" : "cpu";
    if (worker && model.name === loadedModel.name && model.lastModified === loadedModel.lastModified &&
        model.size === loadedModel.size && mode === workerMode) return;
    resetWorker();
    worker = new Worker("./inference-worker.js", { type: "module" });
    const result = await runWorker({ model, mode });
    if (result.error) throw new Error(result.error);
    loadedModel = { name: model.name, lastModified: model.lastModified, size: model.size };
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

async function translate(text, target, mode, model, onPartial) {
  if (text.includes("<|plamo:") || text.includes("\0")) {
    return { error: "原文に翻訳できない制御文字が含まれています。" };
  }
  // 事前読み込みの完了を待ち、翻訳時に指定された実行先を適用する
  if (preparing) await preparing.catch(() => {});
  await prepare(mode, model);
  const result = await runWorker({ text, target }, onPartial);
  if (result.error) resetWorker();
  else keepWorkerReady();
  return result;
}

async function infer(message, respond) {
  const { id, tabId, documentId, text, target, mode, postId, preview } = message;
  function sendResult(result) {
    return chrome.runtime.sendMessage({ type: "inference-result", id, tabId, documentId, result }).catch(() => {});
  }

  const active = await activeModel(message.selectedModel);
  if (!active) {
    respond({ error: "拡張機能の設定でモデルを読み込んでください。" });
    return;
  }
  const { id: modelId, source: model } = active;
  const keyParts = [model.lastModified, model.size, target];
  if (modelId !== defaultModel) keyParts.unshift(modelId);
  const translationKey = source => JSON.stringify([1, ...keyParts, source]);
  const previewKey = postId && JSON.stringify(["preview", ...keyParts, postId]);
  const key = translationKey(text);
  const cached = await readTranslation(key).catch(() => undefined);
  const savedPreview = previewKey && !preview
    ? await readTranslation(previewKey).catch(() => undefined)
    : undefined;
  const prefix = savedPreview && text.startsWith(savedPreview.source)
    ? savedPreview.text + savedPreview.separator
    : "";

  async function rememberPreview(result) {
    if (previewKey && preview && result.text && !result.truncated) {
      await saveTranslation(previewKey, { ...preview, text: result.text }).catch(() => {});
    }
  }

  if (cached && (!prefix || cached.text.startsWith(prefix))) {
    respond({ accepted: true });
    await rememberPreview(cached);
    return sendResult(cached);
  }
  if (busy) {
    respond({ busy: true, error: "別の投稿を翻訳中です。完了してからもう一度お試しください。" });
    return;
  }
  busy = true;
  respond({ accepted: true });
  let result;
  try {
    if (prefix) {
      await sendResult({ partial: prefix });
      const suffix = text.slice(savedPreview.source.length).trim();
      const suffixKey = translationKey(suffix);
      if (suffix) {
        const cachedSuffix = await readTranslation(suffixKey).catch(() => undefined);
        result = cachedSuffix ?? await translate(suffix, target, mode, model,
          ({ partial }) => sendResult({ partial: prefix + partial }));
        if (result.text && !result.truncated && !cachedSuffix) {
          await saveTranslation(suffixKey, result).catch(() => {});
        }
        if (result.text) result = { ...result, text: prefix + result.text };
      } else {
        result = { text: prefix.trimEnd() };
      }
    } else {
      result = await translate(text, target, mode, model, sendResult);
    }
    if (result.text && !result.truncated) await saveTranslation(key, result).catch(() => {});
    await rememberPreview(result);
  } catch (error) {
    resetWorker();
    result = { error: error.message };
  } finally {
    busy = false;
  }
  return sendResult(result);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.tab) return;
  if (message.type === "check-engine-gpu") {
    gpuAvailable().then(respond);
    return true;
  }
  if (message.type === "warm-engine") {
    respond({ accepted: true });
    if (!busy) prepare(message.mode, undefined, message.selectedModel).catch(() => {});
    return;
  }
  if (message.type !== "infer") return;
  infer(message, respond).catch(error => respond({ error: error.message }));
  return true;
});
