import { activeModel, defaultModel, effectiveInferenceMode, modelCompatibility, models, modelSource } from "./model.js";
import { checkGpu } from "./gpu.js";
import { readCacheRevision, readTranslation, saveTranslation } from "./translation-cache.js";
import { glossaryLimit, validGlossaryTerm } from "./glossary.js";
import { runWorker } from "./inference-client.js";

let worker;
let loadedModel;
let workerMode;
let idleTimer;
let preparing;
let preparationController;
let busy;
const inferences = new Map();
let gpuSupport;
let releaseWhenIdle = false;

function gpuAvailable() {
  return gpuSupport ??= checkGpu().then(() => true, () => false);
}

function resetWorker() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = undefined;
}

function keepWorkerReady() {
  if (releaseWhenIdle) {
    resetWorker();
    return;
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(resetWorker, 5 * 60 * 1000);
}

function prepare(mode, active, selectedModel) {
  if (preparing) return preparing;
  preparationController = new AbortController();
  const { signal } = preparationController;
  preparing = (async () => {
    clearTimeout(idleTimer);
    mode = await effectiveInferenceMode(mode, gpuAvailable);
    active ??= await activeModel(selectedModel, undefined, mode);
    if (!active) throw new Error("拡張機能の設定でモデルを読み込んでください。");
    const { id: modelId, source: model } = active;
    signal.throwIfAborted();
    const error = modelCompatibility(models.find(({ id }) => id === modelId), mode);
    if (error) throw new Error(error);
    if (worker && model.name === loadedModel.name && model.lastModified === loadedModel.lastModified &&
        model.size === loadedModel.size && mode === workerMode) return;
    resetWorker();
    worker = new Worker("./inference-worker.js", { type: "module" });
    const result = await runWorker(worker, { model, modelId, mode }, undefined, signal);
    if (!result.ready) throw new Error(result.error ?? "モデルを読み込めませんでした。");
    loadedModel = { name: model.name, lastModified: model.lastModified, size: model.size };
    workerMode = mode;
  })().catch(error => {
    resetWorker();
    throw error;
  }).finally(() => {
    preparing = undefined;
    preparationController = undefined;
    if (worker && !busy) keepWorkerReady();
  });
  return preparing;
}

async function translate(text, target, mode, active, glossary, onPartial, signal) {
  if (text.includes("<|plamo:") || text.includes("\0")) {
    return { error: "原文に翻訳できない制御文字が含まれています。" };
  }
  // 事前読み込みの完了を待ち、翻訳時に指定された実行先を適用する
  if (preparing) {
    await preparing.catch(error => {
      if (error.name === "TimeoutError") throw error;
    });
  }
  signal.throwIfAborted();
  await prepare(mode, active);
  signal.throwIfAborted();
  const result = await runWorker(worker, { text, target, glossary }, onPartial, signal);
  if (result.error && !result.inputTooLong) resetWorker();
  else keepWorkerReady();
  return result;
}

async function infer(message, respond, controller) {
  const { signal } = controller;
  const { id, tabId, documentId, text, target, postId, preview, glossary = [] } = message;
  function sendResult(result) {
    if (signal.aborted) return;
    return chrome.runtime.sendMessage({
      type: "inference-result", id, tabId, documentId, result: { ...result, modelId, cacheRevision: revision },
    }).catch(() => {});
  }

  if (!Array.isArray(glossary) || glossary.length > glossaryLimit * 2 ||
      glossary.some(term => !validGlossaryTerm(term?.source) || !validGlossaryTerm(term?.target))) {
    respond({ error: "用語集の原語と訳語を確認してください。" });
    return;
  }
  const revision = message.cacheRevision === undefined
    ? await readCacheRevision().catch(() => null) : message.cacheRevision;
  async function save(key, result) {
    if (!signal.aborted && revision !== null) await saveTranslation(key, result, revision).catch(() => {});
  }
  const requested = models.find(({ id }) => id === message.modelId);
  const mode = await effectiveInferenceMode(message.mode, gpuAvailable);
  const active = message.modelId === undefined ? await activeModel(message.selectedModel, undefined, mode) :
    requested && { id: requested.id, source: await modelSource(requested.id) };
  if (!active?.source) {
    respond({ error: "選択したモデルを使用できません。設定でモデルを追加するか、別のモデルを選んでください。" });
    return;
  }
  const { id: modelId, source: model } = active;
  const keyParts = [model.lastModified, model.size, target];
  if (modelId !== defaultModel) keyParts.unshift(modelId);
  if (glossary.length) keyParts.push(glossary.map(({ source, target }) => [source, target]));
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
      await save(previewKey, { ...preview, text: result.text });
    }
  }

  if (signal.aborted) {
    respond({ stopped: true });
    return;
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
  busy = controller;
  respond({ accepted: true });
  let result;
  try {
    if (prefix) {
      await sendResult({ partial: prefix });
      const suffix = text.slice(savedPreview.source.length).trim();
      const suffixKey = translationKey(suffix);
      if (suffix) {
        const cachedSuffix = await readTranslation(suffixKey).catch(() => undefined);
        result = cachedSuffix ?? await translate(suffix, target, mode, active, glossary,
          ({ partial }) => sendResult({ partial: prefix + partial }), signal);
        if (result.text && !result.truncated && !cachedSuffix) {
          await save(suffixKey, result);
        }
        if (result.text) result = { ...result, text: prefix + result.text };
      } else {
        result = { text: prefix.trimEnd() };
      }
    } else {
      result = await translate(text, target, mode, active, glossary, sendResult, signal);
    }
    if (result.text && !result.truncated) await save(key, result);
    await rememberPreview(result);
  } catch (error) {
    resetWorker();
    result = { error: error.message };
  } finally {
    busy = undefined;
  }
  return sendResult(result);
}

function inferenceKey({ tabId, documentId, id }) {
  return JSON.stringify([tabId, documentId, id]);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.tab) return;
  if (message.type === "stop-inference") {
    const running = inferences.get(inferenceKey(message));
    if (!running) {
      respond();
      return;
    }
    running.controller.abort();
    if (busy === running.controller) preparationController?.abort();
    running.done.finally(() => respond());
    return true;
  }
  if (message.type === "release-engine") {
    releaseWhenIdle = true;
    if (!busy && !preparing) resetWorker();
    respond();
    return;
  }
  if (message.type === "check-engine-gpu") {
    gpuAvailable().then(respond);
    return true;
  }
  if (message.type === "warm-engine") {
    releaseWhenIdle = false;
    respond({ accepted: true });
    if (!busy) prepare(message.mode, undefined, message.selectedModel).catch(() => {});
    return;
  }
  if (message.type !== "infer") return;
  releaseWhenIdle = false;
  const key = inferenceKey(message);
  const controller = new AbortController();
  const done = infer(message, respond, controller).catch(error => respond({ error: error.message }))
    .finally(() => inferences.delete(key));
  inferences.set(key, { controller, done });
  return true;
});
