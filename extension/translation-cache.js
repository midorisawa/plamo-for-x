const defaultCacheLimit = 64_000_000;
const cacheTtl = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
let database;

function entryBytes(key, entry) {
  return encoder.encode(key).byteLength + encoder.encode(JSON.stringify(entry)).byteLength;
}

function pruneCache(store, metadata, bytes, limit, now) {
  const oldest = store.index("createdAt").openCursor();
  oldest.onsuccess = () => {
    const cursor = oldest.result;
    if (!cursor || (bytes <= limit && now - cursor.key < cacheTtl)) {
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
          pruneCache(store, metadata, bytes, defaultCacheLimit, Date.now());
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

async function writeCache(write) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["translations", "metadata"], "readwrite");
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    write(transaction.objectStore("translations"), transaction.objectStore("metadata"));
  });
}

export async function readCacheRevision() {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const request = db.transaction("metadata").objectStore("metadata").get("revision");
    request.onsuccess = () => resolve(request.result ?? 0);
    request.onerror = () => reject(request.error);
  });
}

export async function saveTranslation(key, result, revision) {
  const now = Date.now();
  const entry = { result, createdAt: now };
  const size = entryBytes(key, entry);
  return writeCache((store, metadata) => {
    const configured = metadata.get("limit");
    const total = metadata.get("bytes");
    const currentRevision = metadata.get("revision");
    const previous = store.get(key);
    previous.onsuccess = () => {
      if (revision !== undefined && revision !== (currentRevision.result ?? 0)) return;
      const limit = configured.result ?? defaultCacheLimit;
      if (size > limit) return;
      const replacedSize = previous.result ? entryBytes(key, previous.result) : 0;
      store.put(entry, key);
      pruneCache(store, metadata, total.result + size - replacedSize, limit, now);
    };
  });
}

export async function readCacheUsage() {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("metadata");
    const metadata = transaction.objectStore("metadata");
    const bytes = metadata.get("bytes");
    const limit = metadata.get("limit");
    transaction.oncomplete = () => resolve({ bytes: bytes.result, limit: limit.result ?? defaultCacheLimit });
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function setCacheLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("キャッシュ上限が無効です。");
  return writeCache((store, metadata) => {
    metadata.put(limit, "limit");
    const total = metadata.get("bytes");
    total.onsuccess = () => pruneCache(store, metadata, total.result, limit, Date.now());
  });
}

export async function clearTranslationCache() {
  return writeCache((store, metadata) => {
    store.clear();
    metadata.put(0, "bytes");
    const revision = metadata.get("revision");
    revision.onsuccess = () => metadata.put((revision.result ?? 0) + 1, "revision");
  });
}
