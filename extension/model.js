export const models = [
  { id: "0.8b", label: "0.8B", size: "約573MB", bundled: true },
  { id: "2b", label: "2B", size: "約1.81GB" },
];

export const defaultModel = models[0].id;
const modelFilename = id => `plamo-3-translate-${id}-Q4_K_M.gguf`;
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

export async function activeModel(selectedModel, available) {
  const preferred = models.find(({ id }) => id === selectedModel);
  const ordered = preferred ? [preferred, ...models.filter(model => model !== preferred)] : models;
  for (const { id } of ordered) {
    const source = available ? available.get(id) : await modelSource(id);
    if (source) return { id, source };
  }
  return null;
}

async function saveModel(id, stream, signal) {
  signal?.throwIfAborted();
  const writer = await (await modelHandle(id, true)).createWritable();
  await stream.pipeTo(writer, { signal });
}

export async function importModel(file) {
  const model = models.find(({ id, bundled }) => !bundled && file.name === modelFilename(id));
  const header = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  if (!model || header !== "GGUF") {
    throw new Error("PLaMo 3 Translate 2BのQ4_K_M形式のGGUFファイルを選択してください。");
  }
  await saveModel(model.id, file.stream());
}

export async function downloadModel(id, progress, signal) {
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
  await saveModel(id, stream, signal);
}

export async function deleteModel(id) {
  try {
    await (await navigator.storage.getDirectory()).removeEntry(modelFilename(id));
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
}
