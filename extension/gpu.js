export async function checkGpu() {
  if (!navigator.gpu || !WebAssembly.Suspending) {
    throw new Error("このブラウザではGPU翻訳に必要な機能を利用できません。");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter?.features.has("shader-f16")) {
    throw new Error("GPU翻訳に必要な16ビット浮動小数点演算を利用できません。");
  }
}
