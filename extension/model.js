export const modelFilename = "plamo-3-translate-0.8b-Q4_K_M.gguf";

async function modelHandle(create) {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(modelFilename, { create });
}

export async function savedModel() {
  try {
    const file = await (await modelHandle(false)).getFile();
    return file.size ? file : null;
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
    return null;
  }
}

export async function importModel(file) {
  const header = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  if (file.name !== modelFilename || header !== "GGUF") {
    throw new Error(`${modelFilename}を選択してください。`);
  }
  const writer = await (await modelHandle(true)).createWritable();
  await file.stream().pipeTo(writer);
}
