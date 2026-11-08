import { runWorker } from "./inference-client.js";
import { checkGpu } from "./gpu.js";

export const models = [
  { id: "0.8b", label: "0.8B", size: "約573MB", bundled: true },
  { id: "2b", label: "2B", size: "約1.81GB" },
  { id: "8b", label: "8B", size: "約5.28GB", memory64: true },
  { id: "31b", label: "31B", size: "約19.53GB", memory64: true, gpuRequired: true },
];

// Memory64と16GiBの上限を宣言したWasmメモリーセクション
const hasMemory64 = WebAssembly.validate(Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0, 5, 6, 1, 5, 0, 128, 128, 16,
));

export function modelCompatibility({ memory64, gpuRequired }, mode) {
  if (memory64 && !hasMemory64) return "このブラウザーは64ビットWebAssemblyに対応していません。";
  if (gpuRequired && mode === "cpu") return "31Bの翻訳にはWebGPUが必要です。";
  return "";
}

export async function effectiveInferenceMode(mode, gpuAvailable) {
  return mode === "cpu" || mode === "gpu" ? mode : await gpuAvailable() ? "gpu" : "cpu";
}

async function validationMode(model) {
  const error = modelCompatibility(model);
  if (error) throw new Error(error);
  if (model.gpuRequired) {
    await checkGpu();
    return "gpu";
  }
  if (!model.memory64) return "cpu";
  const { inferenceMode } = await chrome.storage.local.get("inferenceMode");
  return effectiveInferenceMode(inferenceMode, () => checkGpu().then(() => true, () => false));
}

export const defaultModel = models[0].id;
const modelFilename = id => `plamo-3-translate-${id}-Q4_K_M.gguf`;
const stagedFilename = id => `${modelFilename(id)}.download`;
export const withModelLock = action => navigator.locks.request("sns-translator-models", action);

async function modelHandle(id, create) {
  return (await navigator.storage.getDirectory()).getFileHandle(modelFilename(id), { create });
}

export async function modelSource(id) {
  if (id === defaultModel) {
    const name = modelFilename(id);
    return {
      name,
      size: 573125952,
      lastModified: 0,
      url: chrome.runtime.getURL(`models/${name}`),
    };
  }
  try {
    const file = await (await modelHandle(id, false)).getFile();
    return file.size ? file : null;
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
    return null;
  }
}

export async function activeModel(selectedModel, available, mode) {
  const preferred = models.find(({ id }) => id === selectedModel);
  const ordered = preferred ? [preferred, ...models.filter(model => model !== preferred)] : models;
  for (const model of ordered) {
    if (modelCompatibility(model, mode)) continue;
    const { id } = model;
    const source = available ? available.get(id) : await modelSource(id);
    if (source) return { id, source };
  }
  return null;
}

async function validateModel(file, modelId, mode, signal) {
  const header = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  if (file.size < 24 || header !== "GGUF") {
    throw new Error("PLaMo 3 TranslateのQ4_K_M形式のGGUFファイルを選択してください。");
  }
  const worker = new Worker("./inference-worker.js", { type: "module" });
  try {
    const result = await runWorker(worker, { model: file, modelId, mode }, undefined, signal);
    if (!result.ready) throw new Error(result.error ?? "モデルを読み込めませんでした。");
  } finally {
    worker.terminate();
  }
}

export async function importModel(file) {
  const model = models.find(({ id, bundled }) => !bundled && file.name === modelFilename(id));
  if (!model) throw new Error("PLaMo 3 Translate 2B・8B・31Bの公式Q4_K_M形式のGGUFファイルを選択してください。");
  await validateModel(file, model.id, await validationMode(model));
  const writer = await (await modelHandle(model.id, true)).createWritable();
  await file.stream().pipeTo(writer);
}

export async function downloadModel(id, progress, signal) {
  const mode = await validationMode(models.find(model => model.id === id));
  const url = `https://huggingface.co/pfnet/plamo-3-translate-${id}-GGUF/resolve/main/${modelFilename(id)}`;
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("配布元からモデルを取得できませんでした。");
  const total = Number(response.headers.get("content-length"));
  let received = 0;
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      progress(received, total);
      controller.enqueue(chunk);
    },
  }));
  const directory = await navigator.storage.getDirectory();
  const stagedName = stagedFilename(id);
  const staged = await directory.getFileHandle(stagedName, { create: true });
  try {
    await stream.pipeTo(await staged.createWritable(), { signal });
    await validateModel(await staged.getFile(), id, mode, signal);
    signal?.throwIfAborted();
    await staged.move(modelFilename(id));
  } catch (error) {
    await directory.removeEntry(stagedName).catch(() => {});
    throw error;
  }
}

async function removeModelFile(name) {
  try {
    await (await navigator.storage.getDirectory()).removeEntry(name);
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
}

export function deleteModel(id) {
  return removeModelFile(modelFilename(id));
}

export function cleanStagedModels() {
  return withModelLock(async () => {
    for (const { id, bundled } of models) {
      if (!bundled) await removeModelFile(stagedFilename(id));
    }
  });
}
