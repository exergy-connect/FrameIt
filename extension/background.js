const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

let session = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "frameit-start-session") {
    startSession()
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

  if (message.type === "frameit-get-status") {
    sendResponse({
      ok: true,
      active: Boolean(session),
      phase: session?.phase || null,
    });
    return false;
  }

  // Ignore messages meant for the offscreen document or content script.
  if (sender?.id === chrome.runtime.id) {
    return false;
  }
});

async function startSession() {
  if (session) {
    throw new Error("A session is already in progress");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found");
  }
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("https://chrome.google.com/webstore")) {
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
  };

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    await ensureOffscreenDocument();
    const acquired = await sendToOffscreen({
      type: "frameit-acquire-stream",
      streamId,
    });
    if (!acquired?.ok) {
      throw new Error(acquired?.error || "Failed to acquire tab stream");
    }

    await injectOverlay(tab.id);
    session.phase = "countdown";
    await chrome.tabs.sendMessage(tab.id, { type: "frameit-show-countdown" });
  } catch (error) {
    await abortSession();
    throw error;
  }
}

async function onCountdownDone() {
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
  session.recordingStartedAt = Date.now();

  await chrome.tabs.sendMessage(session.tabId, {
    type: "frameit-show-session-bar",
    startedAt: session.recordingStartedAt,
  });
}

async function stopSession() {
  if (!session) {
    throw new Error("No active session");
  }

  const { tabId, tabTitle, sessionStartedAt, mimeType } = session;
  const extension = (mimeType || "").includes("mp4") ? ".mp4" : ".webm";
  const filename = buildFilename(tabTitle, sessionStartedAt, extension);

  session.phase = "stopping";

  try {
    const stopped = await sendToOffscreen({
      type: "frameit-stop-recording",
    });
    if (!stopped?.ok) {
      throw new Error(stopped?.error || "Failed to stop recording");
    }

    const finalMime = stopped.mimeType || mimeType || "video/webm";
    const finalName = buildFilename(
      tabTitle,
      sessionStartedAt,
      (finalMime.includes("mp4") ? ".mp4" : ".webm")
    );

    await downloadRecording(stopped.dataUrl, finalName);

    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // Tab may have closed.
    }

    session = null;
    await closeOffscreenDocument();

    return { filename: finalName, mimeType: finalMime };
  } catch (error) {
    await abortSession();
    throw error;
  }
}

async function downloadRecording(dataUrl, filename) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("Recording data was empty");
  }

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });
}

async function abortSession() {
  const tabId = session?.tabId;
  session = null;

  try {
    await sendToOffscreen({ type: "frameit-discard" });
  } catch (_error) {
    // Offscreen may not exist.
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
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function ensureOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification:
        "Hold the tab MediaStream and MediaRecorder for Exergy ∞ FrameIt sessions.",
    });
  }

  await waitForOffscreenReady();
}

async function waitForOffscreenReady() {
  const deadline = Date.now() + 5000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "frameit-offscreen-ping",
      });
      if (response?.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
