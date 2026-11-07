export function runWorker(worker, message, onPartial) {
  let timeout;
  const operation = message.model ? "モデルの読み込み" : "翻訳";
  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new DOMException(`${operation}に時間がかかっています。もう一度お試しください。`, "TimeoutError"));
    }, 180000);
    worker.onmessage = ({ data }) => {
      if (data.partial !== undefined) onPartial?.(data);
      else resolve(data);
    };
    worker.onerror = () => reject(new Error("推論Workerを実行できませんでした。"));
    worker.postMessage(message);
  }).finally(() => clearTimeout(timeout));
}
