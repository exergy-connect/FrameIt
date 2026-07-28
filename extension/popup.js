const DEFAULT_LOGO_URL = "assets/exergy_connect_logo.png";
const LOGO_STORAGE_KEY = "customLogoDataUrl";
const MAX_LOGO_BYTES = 500_000;

const startBtn = document.getElementById("start");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const includeLogoEl = document.getElementById("includeLogo");
const logoOptionsEl = document.getElementById("logoOptions");
const logoPreviewEl = document.getElementById("logoPreview");
const chooseLogoBtn = document.getElementById("chooseLogo");
const resetLogoBtn = document.getElementById("resetLogo");
const logoFileEl = document.getElementById("logoFile");
const hideControlsEl = document.getElementById("hideControls");
const includePointerEl = document.getElementById("includePointer");
const activeSessionEl = document.getElementById("activeSession");
const activeTimeEl = document.getElementById("activeTime");

let timerId = null;
let statusSnapshot = null;
let customLogoDataUrl = null;

initLogoSettings();
refreshStatus();

includeLogoEl.addEventListener("change", syncLogoOptionsVisibility);

chooseLogoBtn.addEventListener("click", () => {
  logoFileEl.click();
});

resetLogoBtn.addEventListener("click", async () => {
  customLogoDataUrl = null;
  await chrome.storage.local.remove(LOGO_STORAGE_KEY);
  applyLogoPreview();
  setStatus("Using the Exergy logo.");
});

logoFileEl.addEventListener("change", async () => {
  const file = logoFileEl.files?.[0];
  logoFileEl.value = "";
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setStatus("Please choose an image file.", true);
    return;
  }
  if (file.size > MAX_LOGO_BYTES) {
    setStatus("Logo must be 500 KB or smaller.", true);
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    customLogoDataUrl = dataUrl;
    await chrome.storage.local.set({ [LOGO_STORAGE_KEY]: dataUrl });
    applyLogoPreview();
    setStatus("Custom logo saved.");
  } catch (error) {
    setStatus(String(error?.message || error), true);
  }
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("Starting session…");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-start-session",
      includeLogo: includeLogoEl.checked,
      logoDataUrl: includeLogoEl.checked ? customLogoDataUrl : null,
      hideControls: hideControlsEl.checked,
      includePointer: includePointerEl.checked,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not start session");
    }
    setStatus("Countdown running on the tab.");
    window.close();
  } catch (error) {
    setStatus(String(error?.message || error), true);
    startBtn.disabled = false;
  }
});

pauseBtn.addEventListener("click", async () => {
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  try {
    const type = statusSnapshot?.paused
      ? "frameit-resume-session"
      : "frameit-pause-session";
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not update recording.");
    }
    await refreshStatus();
  } catch (error) {
    setStatus(String(error?.message || error), true);
  } finally {
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", async () => {
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus("Saving…");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-stop-session",
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not save the recording.");
    }
    clearTimer();
    statusSnapshot = null;
    showIdle();
    setStatus("Saved to Downloads.");
  } catch (error) {
    setStatus(String(error?.message || error), true);
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

async function initLogoSettings() {
  try {
    const stored = await chrome.storage.local.get(LOGO_STORAGE_KEY);
    const value = stored?.[LOGO_STORAGE_KEY];
    customLogoDataUrl =
      typeof value === "string" && value.startsWith("data:image/")
        ? value
        : null;
  } catch (_error) {
    customLogoDataUrl = null;
  }
  applyLogoPreview();
  syncLogoOptionsVisibility();
}

function applyLogoPreview() {
  logoPreviewEl.src = customLogoDataUrl || DEFAULT_LOGO_URL;
  resetLogoBtn.hidden = !customLogoDataUrl;
}

function syncLogoOptionsVisibility() {
  logoOptionsEl.hidden = !includeLogoEl.checked;
}

async function refreshStatus() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-get-status",
    });
    if (result?.active) {
      statusSnapshot = result;
      showActive(result);
      setStatus(`Session in progress (${result.phase || "active"}).`);
      return;
    }
    statusSnapshot = null;
    showIdle();
  } catch (_error) {
    // Service worker may still be waking up.
  }
}

function showIdle() {
  clearTimer();
  startBtn.hidden = false;
  startBtn.disabled = false;
  setOptionsDisabled(false);
  activeSessionEl.hidden = true;
}

function showActive(status) {
  startBtn.hidden = true;
  setOptionsDisabled(true);
  activeSessionEl.hidden = false;
  activeSessionEl.classList.toggle("is-paused", Boolean(status.paused));

  const canControl = status.phase === "recording";
  pauseBtn.disabled = !canControl;
  stopBtn.disabled = !canControl;
  pauseBtn.textContent = status.paused ? "Continue" : "Pause";

  if (status.recordingStartedAt) {
    updateActiveTime(status);
    clearTimer();
    timerId = window.setInterval(
      () => updateActiveTime(statusSnapshot || status),
      250
    );
  } else {
    activeTimeEl.textContent = "…";
    clearTimer();
  }
}

function setOptionsDisabled(disabled) {
  includeLogoEl.disabled = disabled;
  hideControlsEl.disabled = disabled;
  includePointerEl.disabled = disabled;
  chooseLogoBtn.disabled = disabled;
  resetLogoBtn.disabled = disabled;
  logoFileEl.disabled = disabled;
}

function updateActiveTime(status) {
  if (!status?.recordingStartedAt) {
    activeTimeEl.textContent = "00:00";
    return;
  }
  const pausedExtra =
    status.paused && status.pausedAt ? Date.now() - status.pausedAt : 0;
  const elapsed = Math.max(
    0,
    Date.now() -
      status.recordingStartedAt -
      (status.totalPausedMs || 0) -
      pausedExtra
  );
  activeTimeEl.textContent = formatElapsed(elapsed);
}

function clearTimer() {
  if (timerId != null) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the image."));
    };
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}
