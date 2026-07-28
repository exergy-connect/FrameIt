const FRAMEIT_DB_NAME = "exergy-frame";
const FRAMEIT_DB_VERSION = 1;
const FRAMEIT_STORE = "recordings";
const FRAMEIT_PENDING_KEY = "pending";

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FRAMEIT_DB_NAME, FRAMEIT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FRAMEIT_STORE)) {
        db.createObjectStore(FRAMEIT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Failed to open recording database"));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function putPendingRecording(blob) {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readwrite");
    tx.objectStore(FRAMEIT_STORE).put(blob, FRAMEIT_PENDING_KEY);
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

async function takePendingRecording() {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readwrite");
    const store = tx.objectStore(FRAMEIT_STORE);
    const blob = await idbRequest(store.get(FRAMEIT_PENDING_KEY));
    store.delete(FRAMEIT_PENDING_KEY);
    await waitForTransaction(tx);
    return blob || null;
  } finally {
    db.close();
  }
}

async function clearPendingRecording() {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readwrite");
    tx.objectStore(FRAMEIT_STORE).delete(FRAMEIT_PENDING_KEY);
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}
