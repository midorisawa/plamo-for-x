export function runWorker(worker, message, onPartial, signal) {
  let timeout;
  let abort;
  const operation = message.model ? "モデルの読み込み" : "翻訳";
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    abort = () => reject(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => {
      reject(new DOMException(`${operation}に時間がかかっています。もう一度お試しください。`, "TimeoutError"));
    }, 180000);
    worker.onmessage = ({ data }) => {
      if (data.partial !== undefined) onPartial?.(data);
      else resolve(data);
    };
    worker.onerror = () => reject(new Error("推論Workerを実行できませんでした。"));
    worker.postMessage(message);
  }).finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  });
}
