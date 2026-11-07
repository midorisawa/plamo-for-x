// 参考Web UIの推論処理とPLaMo翻訳プロンプトを0.8Bの日本語訳用に絞る
let runtime;

async function loadModel(blob, gpu) {
  const { default: createRuntime } = gpu ? await import("./runtime/gpu/plamo.mjs") :
    await import("./runtime/plamo.mjs");
  // llama.cppは正常なモデル読み込みの進捗も標準エラーに出力する
  const module = await createRuntime({ printErr: message => console.debug(message) });
  const call = (name, types = [], args = []) =>
    module.ccall(name, "number", types, args, gpu ? { async: true } : undefined);
  module.FS.mkdir("/model");
  module.FS.mount(module.WORKERFS, { blobs: [{ name: "translate.gguf", data: blob }] }, "/model");
  try {
    if (await call("load_model", ["number"], [-1]) !== 0) {
      throw new Error("モデルを読み込めませんでした。");
    }
  } finally {
    module.FS.unmount("/model");
  }
  return { module, call };
}

async function prepareModel(blob, mode) {
  if (mode === "cpu") return loadModel(blob, false);

  try {
    if (!navigator.gpu || !WebAssembly.Suspending) {
      throw new Error("このブラウザではGPU翻訳に必要な機能を利用できません。");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.features.has("shader-f16")) {
      throw new Error("GPU翻訳に必要な16ビット浮動小数点演算を利用できません。");
    }
    return await loadModel(blob, true);
  } catch (error) {
    if (mode === "gpu") throw new Error(`GPUを使用できません。 ${error.message}`);
    console.debug("WebGPU initialization failed; falling back to CPU", error);
    return loadModel(blob, false);
  }
}

self.onmessage = async ({ data: { text, blob, target, mode } }) => {
  try {
    runtime ??= await prepareModel(blob, mode);
    if (text === undefined) {
      self.postMessage({ ready: true });
      return;
    }
    const { module, call } = runtime;
    if (typeof target !== "string" || !/^(?:[a-z]{2,3}|zh-han[st])$/.test(target)) {
      throw new Error("翻訳先の言語を設定してください。");
    }
    const prompt = `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>${text}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${target}<|plamo:msg|>`;
    const space = await call("start_translation", ["string"], [prompt]);
    if (space === -2) throw new Error("投稿が長すぎるため翻訳できません。");
    if (space < 0) throw new Error("原文を処理できませんでした。");

    const decoder = new TextDecoder();
    const offset = Number(module._token_bytes());
    let translation = "";
    let lastUpdate = -Infinity;
    let ended = false;
    for (let index = 0; index < Math.min(space, 4096); index++) {
      const length = await call("next_token");
      if (length < 0) throw new Error("訳文の生成に失敗しました。");
      if (length === 0) {
        ended = true;
        break;
      }
      translation += decoder.decode(module.HEAPU8.subarray(offset, offset + length), { stream: true });
      const now = performance.now();
      if (now - lastUpdate >= 50 && translation.trim()) {
        self.postMessage({ partial: translation.trimStart() });
        lastUpdate = now;
      }
    }
    translation = (translation + decoder.decode()).trim();
    if (!translation) throw new Error("訳文を生成できませんでした。");
    self.postMessage({ text: translation, truncated: !ended });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
