importScripts("recordingStore.js");

const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
const EXTENSION_ORIGIN = chrome.runtime.getURL("/");
const SESSION_STORAGE_KEY = "frameitSession";

const CONTENT_SESSION_TYPES = new Set([
  "frameit-countdown-done",
  "frameit-stop-session",
  "frameit-pause-session",
  "frameit-resume-session",
]);

const EXTENSION_PAGE_TYPES = new Set([
  "frameit-start-session",
  "frameit-get-status",
]);

let session = null;
let sessionRestorePromise = null;

function isExtensionPageSender(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(EXTENSION_ORIGIN);
}

function isTabContentScript(sender) {
  return Boolean(sender?.tab) && !isExtensionPageSender(sender);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  const fromContentScript = isTabContentScript(sender);

  // Content scripts may only drive overlay/session UI events.
  if (fromContentScript && !CONTENT_SESSION_TYPES.has(message.type)) {
    return false;
  }

  // Popup / extension-page commands should not come from a tab content script.
  if (
    !fromContentScript &&
    !EXTENSION_PAGE_TYPES.has(message.type) &&
    !CONTENT_SESSION_TYPES.has(message.type)
  ) {
    // Ignore offscreen/saver-only traffic here (handled by dedicated listeners).
    return false;
  }

  if (message.type === "frameit-start-session") {
    if (fromContentScript) {
      sendResponse({ ok: false, error: "Start session must come from the extension UI" });
      return false;
    }
    startSession({
      includeLogo: message.includeLogo !== false,
      logoDataUrl: normalizeLogoDataUrl(message.logoDataUrl),
      hideControls: message.hideControls !== false,
      includePointer: Boolean(message.includePointer),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-countdown-done") {
    onCountdownDone()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-stop-session") {
    stopSession()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-pause-session") {
    pauseSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-resume-session") {
    resumeSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-get-status") {
    if (fromContentScript) {
      sendResponse({ ok: false, error: "Status is only available to the extension UI" });
      return false;
    }
    getStatus()
      .then((status) => sendResponse(status))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) {
    abortSession().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!session || session.tabId !== tabId) return;
  if (changeInfo.status === "complete" && session.phase === "recording") {
    ensureSessionOverlay().catch(() => {});
  }
});

async function startSession({
  includeLogo = true,
  logoDataUrl = null,
  hideControls = true,
  includePointer = false,
} = {}) {
  await ensureSessionRestored();
  if (session) {
    throw new Error("A session is already in progress");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found");
  }
  if (
    tab.url?.startsWith("chrome://") ||
    tab.url?.startsWith("chrome-extension://") ||
    tab.url?.startsWith("https://chrome.google.com/webstore") ||
    tab.url?.startsWith("https://chromewebstore.google.com/")
  ) {
    throw new Error("This page cannot be captured. Open a regular website tab.");
  }

  const tabTitle = tab.title || "Session";
  const sessionStartedAt = new Date();

  session = {
    tabId: tab.id,
    tabTitle,
    sessionStartedAt,
    phase: "acquiring",
    mimeType: "",
    includeLogo: Boolean(includeLogo),
    logoDataUrl: includeLogo ? normalizeLogoDataUrl(logoDataUrl) : null,
    hideControls: Boolean(hideControls),
    includePointer: Boolean(includePointer),
    paused: false,
    pausedAt: 0,
    totalPausedMs: 0,
  };
  await persistSession();

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    await ensureOffscreenDocument();
    const acquired = await sendToOffscreen({
      type: "frameit-acquire-stream",
      streamId,
      includePointer: Boolean(includePointer),
    });
    if (!acquired?.ok) {
      throw new Error(acquired?.error || "Failed to acquire tab stream");
    }

    await injectOverlay(tab.id);
    session.phase = "countdown";
    await persistSession();
    await chrome.tabs.sendMessage(tab.id, { type: "frameit-show-countdown" });
  } catch (error) {
    await abortSession();
    throw error;
  }
}

async function onCountdownDone() {
  await ensureSessionRestored();
  if (!session || session.phase !== "countdown") {
    return;
  }

  const started = await sendToOffscreen({ type: "frameit-start-recording" });
  if (!started?.ok) {
    await abortSession();
    throw new Error(started?.error || "Failed to start recording");
  }

  session.mimeType = started.mimeType || "";
  session.phase = "recording";
  session.paused = false;
  session.pausedAt = 0;
  session.totalPausedMs = 0;
  session.recordingStartedAt = Date.now();
  await persistSession();

  await ensureSessionOverlay();
}

async function pauseSession() {
  await ensureSessionRestored();
  if (!session || session.phase !== "recording" || session.paused) {
    throw new Error("Session is not recording");
  }

  const paused = await sendToOffscreen({ type: "frameit-pause-recording" });
  if (!paused?.ok) {
    throw new Error(paused?.error || "Failed to pause recording");
  }

  session.paused = true;
  session.pausedAt = Date.now();
  await persistSession();
}

async function resumeSession() {
  await ensureSessionRestored();
  if (!session || session.phase !== "recording" || !session.paused) {
    throw new Error("Session is not paused");
  }

  const resumed = await sendToOffscreen({ type: "frameit-resume-recording" });
  if (!resumed?.ok) {
    throw new Error(resumed?.error || "Failed to resume recording");
  }

  if (session.pausedAt) {
    session.totalPausedMs =
      (session.totalPausedMs || 0) + (Date.now() - session.pausedAt);
  }
  session.pausedAt = 0;
  session.paused = false;
  await persistSession();
}

async function stopSession() {
  await ensureSessionRestored();
  if (!session) {
    throw new Error("No active session");
  }

  const { tabId, tabTitle, sessionStartedAt, mimeType } = session;
  const extension = (mimeType || "").includes("mp4") ? ".mp4" : ".webm";
  const filename = buildFilename(tabTitle, sessionStartedAt, extension);

  session.phase = "stopping";
  await persistSession();

  try {
    const stopped = await sendToOffscreen({
      type: "frameit-stop-recording",
      filename,
    });
    if (!stopped?.ok) {
      throw new Error(stopped?.error || "Failed to stop recording");
    }

    const finalMime = stopped.mimeType || mimeType || "video/webm";
    const finalName =
      stopped.filename ||
      buildFilename(
        tabTitle,
        sessionStartedAt,
        finalMime.includes("mp4") ? ".mp4" : ".webm"
      );

    await downloadPendingRecording(finalName);

    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // Tab may have closed.
    }

    session = null;
    await persistSession();
    await closeOffscreenDocument();

    return { filename: finalName, mimeType: finalMime };
  } catch (error) {
    await abortSession();
    throw error;
  }
}

async function getStatus() {
  await ensureSessionRestored();
  if (session?.phase === "recording") {
    await ensureSessionOverlay().catch(() => {});
  }
  return {
    ok: true,
    active: Boolean(session),
    phase: session?.phase || null,
    paused: Boolean(session?.paused),
    recordingStartedAt: session?.recordingStartedAt || null,
    pausedAt: session?.pausedAt || null,
    totalPausedMs: session?.totalPausedMs || 0,
    hideControls: session?.hideControls !== false,
  };
}

async function downloadPendingRecording(filename) {
  const saverUrl = `${chrome.runtime.getURL("saver.html")}?filename=${encodeURIComponent(
    filename
  )}`;

  return new Promise((resolve, reject) => {
    let saverTabId = null;
    const timeoutId = setTimeout(() => {
      finish(new Error("Timed out while saving the recording"), true);
    }, 120_000);

    function finish(error, removeTab) {
      clearTimeout(timeoutId);
      chrome.runtime.onMessage.removeListener(onMessage);
      if (removeTab && saverTabId != null) {
        chrome.tabs.remove(saverTabId).catch(() => {});
      }
      if (error) reject(error);
      else resolve();
    }

    function onMessage(message, sender) {
      if (message?.type !== "frameit-save-done") return;
      if (!isExtensionPageSender(sender)) return;
      if (message.ok) {
        finish(null, false);
      } else {
        finish(new Error(message.error || "Failed to save recording"), true);
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);

    chrome.tabs
      .create({ url: saverUrl, active: false })
      .then((tab) => {
        saverTabId = tab.id;
      })
      .catch((error) => {
        finish(error, false);
      });
  });
}

async function abortSession() {
  const tabId = session?.tabId;
  session = null;
  await persistSession();

  try {
    await sendToOffscreen({ type: "frameit-discard" });
  } catch (_error) {
    // Offscreen may not exist.
  }

  try {
    await clearPendingRecording();
  } catch (_error) {
    // ignore
  }

  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // ignore
    }
  }

  await closeOffscreenDocument();
}

async function injectOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function ensureSessionOverlay() {
  if (!session || session.tabId == null) return;
  if (session.phase !== "recording" && session.phase !== "countdown") return;

  try {
    await injectOverlay(session.tabId);
  } catch (_error) {
    // Tab may disallow scripting momentarily.
    return;
  }

  if (session.phase === "countdown") {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "frameit-show-countdown",
      });
    } catch (_error) {
      // ignore
    }
    return;
  }

  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: "frameit-show-session-bar",
      startedAt: session.recordingStartedAt,
      includeLogo: session.includeLogo !== false,
      logoDataUrl: session.logoDataUrl || null,
      hideControls: session.hideControls !== false,
      includePointer: Boolean(session.includePointer),
      paused: Boolean(session.paused),
      pausedAt: session.pausedAt || 0,
      totalPausedMs: session.totalPausedMs || 0,
    });
  } catch (_error) {
    // Overlay may be unavailable on restricted pages.
  }
}

function serializeSession(value) {
  if (!value) return null;
  return {
    ...value,
    sessionStartedAt:
      value.sessionStartedAt instanceof Date
        ? value.sessionStartedAt.toISOString()
        : value.sessionStartedAt,
  };
}

function deserializeSession(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ...value,
    sessionStartedAt: value.sessionStartedAt
      ? new Date(value.sessionStartedAt)
      : new Date(),
  };
}

async function persistSession() {
  if (session) {
    await chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: serializeSession(session),
    });
  } else {
    await chrome.storage.session.remove(SESSION_STORAGE_KEY);
  }
}

async function ensureSessionRestored() {
  if (session) return session;
  if (!sessionRestorePromise) {
    sessionRestorePromise = restoreSession().finally(() => {
      sessionRestorePromise = null;
    });
  }
  return sessionRestorePromise;
}

async function restoreSession() {
  if (session) return session;

  let stored = null;
  try {
    const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    stored = deserializeSession(result?.[SESSION_STORAGE_KEY]);
  } catch (_error) {
    stored = null;
  }

  if (!stored) {
    return null;
  }

  let recorder = null;
  try {
    if (await hasOffscreenDocument()) {
      recorder = await sendToOffscreen({ type: "frameit-recorder-status" });
    }
  } catch (_error) {
    recorder = null;
  }

  // Only an actively encoding recorder is safely recoverable after SW restart.
  // Holding a stream during countdown/acquire without MediaRecorder is discarded.
  if (!recorder?.ok || !recorder.recording) {
    await chrome.storage.session.remove(SESSION_STORAGE_KEY);
    try {
      await sendToOffscreen({ type: "frameit-discard" });
    } catch (_error) {
      // Offscreen may already be gone.
    }
    await closeOffscreenDocument();
    return null;
  }

  session = {
    ...stored,
    mimeType: stored.mimeType || recorder.mimeType || "",
    paused: Boolean(recorder.paused),
    phase: "recording",
    recordingStartedAt: stored.recordingStartedAt || Date.now(),
  };

  await persistSession();
  return session;
}

async function ensureOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification:
        "Hold the tab MediaStream and MediaRecorder for Exergy ∞ Frame sessions.",
    });
  }

  await waitForOffscreenReady();
}

async function waitForOffscreenReady() {
  const deadline = Date.now() + 5000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!(await hasOffscreenDocument())) {
      await delay(50);
      continue;
    }

    try {
      // Only the offscreen page answers this; content scripts ignore it.
      const response = await chrome.runtime.sendMessage({
        type: "frameit-offscreen-ping",
      });
      if (response?.ok && response.source === "offscreen") {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }

  throw new Error(
    `Offscreen recorder did not become ready${
      lastError ? `: ${lastError.message || lastError}` : ""
    }`
  );
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }

  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  return clients.some((client) => client.url === OFFSCREEN_URL);
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLogoDataUrl(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("data:image/")) return null;
  // Keep message payloads bounded; popup already enforces ~500 KB files.
  if (value.length > 700_000) return null;
  return value;
}

function buildFilename(tabTitle, date, extension) {
  const safeTitle = sanitizeTitle(tabTitle);
  const stamp = formatSessionStamp(date);
  return `${safeTitle} ${stamp}${extension}`;
}

function sanitizeTitle(title) {
  const cleaned = String(title || "Session")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || "Session").slice(0, 80);
}

function formatSessionStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}_${minutes}`;
}

// Recover an in-flight session if the service worker was restarted mid-capture.
ensureSessionRestored().catch(() => {});
