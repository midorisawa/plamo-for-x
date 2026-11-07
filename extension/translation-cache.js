const cacheLimit = 64 * 1024 * 1024;
const cacheTtl = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
let database;

function entryBytes(key, entry) {
  return encoder.encode(key).byteLength + encoder.encode(JSON.stringify(entry)).byteLength;
}

function pruneCache(store, metadata, bytes, now) {
  const oldest = store.index("createdAt").openCursor();
  oldest.onsuccess = () => {
    const cursor = oldest.result;
    if (!cursor || (bytes <= cacheLimit && now - cursor.key < cacheTtl)) {
      metadata.put(bytes, "bytes");
      return;
    }
    bytes -= entryBytes(cursor.primaryKey, cursor.value);
    cursor.delete();
    cursor.continue();
  };
}

function openCache() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("sns-translator-cache", 2);
    request.onupgradeneeded = event => {
      const metadata = request.result.createObjectStore("metadata");
      if (event.oldVersion === 0) {
        const store = request.result.createObjectStore("translations");
        store.createIndex("createdAt", "createdAt");
        metadata.put(0, "bytes");
        return;
      }
      const store = request.transaction.objectStore("translations");
      const entries = store.openCursor();
      let bytes = 0;
      entries.onsuccess = () => {
        const cursor = entries.result;
        if (!cursor) {
          pruneCache(store, metadata, bytes, Date.now());
          return;
        }
        bytes += entryBytes(cursor.primaryKey, cursor.value);
        cursor.continue();
      };
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
  const now = Date.now();
  const entry = { result, createdAt: now };
  const size = entryBytes(key, entry);
  if (size > cacheLimit) return;
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["translations", "metadata"], "readwrite");
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    const store = transaction.objectStore("translations");
    const metadata = transaction.objectStore("metadata");
    const total = metadata.get("bytes");
    const previous = store.get(key);
    previous.onsuccess = () => {
      const replacedSize = previous.result ? entryBytes(key, previous.result) : 0;
      store.put(entry, key);
      pruneCache(store, metadata, total.result + size - replacedSize, now);
    };
  });
}
