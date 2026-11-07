const cacheLimit = 20_000;
const cacheTtl = 30 * 24 * 60 * 60 * 1000;
let database;

function openCache() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("sns-translator-cache", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("translations");
      store.createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    database = undefined;
    throw error;
  });
  return database;
}

export async function readTranslation(key) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const request = db.transaction("translations").objectStore("translations").get(key);
    request.onsuccess = () => {
      const entry = request.result;
      resolve(entry && Date.now() - entry.createdAt < cacheTtl ? entry.result : undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveTranslation(key, result) {
  const db = await openCache();
  const now = Date.now();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("translations", "readwrite");
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    const store = transaction.objectStore("translations");
    store.put({ result, createdAt: now }, key);
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - cacheLimit;
      const oldest = store.index("createdAt").openCursor();
      oldest.onsuccess = () => {
        const cursor = oldest.result;
        if (!cursor || (excess <= 0 && now - cursor.key < cacheTtl)) return;
        cursor.delete();
        excess--;
        cursor.continue();
      };
    };
  });
}
