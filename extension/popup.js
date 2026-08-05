const DEFAULT_LOGO_URL = "assets/exergy_connect_logo.png";
const LOGO_STORAGE_KEY = "customLogoDataUrl";
const SNAPSHOT_MODE_KEY = "snapshotMode";
const SNAPSHOT_DELAY_KEY = "snapshotDelay";
const SNAPSHOT_LINKEDIN_KEY = "snapshotLinkedIn";
const SNAPSHOT_FORMAT_KEY = "snapshotFormat";
const SNAPSHOT_JPG_KEY = "snapshotJpg"; // legacy
const MAX_LOGO_BYTES = 500_000;

const startBtn = document.getElementById("start");
const snapshotBtn = document.getElementById("snapshot");
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
const snapshotModeFullEl = document.getElementById("snapshotModeFull");
const snapshotModeRegionEl = document.getElementById("snapshotModeRegion");
const snapshotDelayEl = document.getElementById("snapshotDelay");
const snapshotLinkedInEl = document.getElementById("snapshotLinkedIn");
const snapshotFormatPngEl = document.getElementById("snapshotFormatPng");
const snapshotFormatJpgEl = document.getElementById("snapshotFormatJpg");
const snapshotFormatGifEl = document.getElementById("snapshotFormatGif");

let timerId = null;
let statusSnapshot = null;
let customLogoDataUrl = null;

initLogoSettings();
initSnapshotSettings();
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

snapshotModeFullEl.addEventListener("change", persistSnapshotSettings);
snapshotModeRegionEl.addEventListener("change", persistSnapshotSettings);
snapshotDelayEl.addEventListener("change", persistSnapshotSettings);
snapshotLinkedInEl.addEventListener("change", persistSnapshotSettings);
snapshotFormatPngEl.addEventListener("change", persistSnapshotSettings);
snapshotFormatJpgEl.addEventListener("change", persistSnapshotSettings);
snapshotFormatGifEl.addEventListener("change", persistSnapshotSettings);

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  snapshotBtn.disabled = true;
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
    snapshotBtn.disabled = false;
  }
});

snapshotBtn.addEventListener("click", async () => {
  snapshotBtn.disabled = true;
  startBtn.disabled = true;
  setSnapshotControlsDisabled(true);
  setStatus("Starting snapshot…");

  const mode = snapshotModeRegionEl.checked ? "region" : "full";
  const delay = Number(snapshotDelayEl.value) || 0;
  const linkedIn = snapshotLinkedInEl.checked;
  const format = selectedSnapshotFormat();

  try {
    await persistSnapshotSettings();
    const result = await chrome.runtime.sendMessage({
      type: "frameit-start-snapshot",
      mode,
      delay,
      linkedIn,
      format,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not take snapshot");
    }
    setStatus(
      delay > 0
        ? "Countdown running on the tab."
        : mode === "region"
          ? "Select a region on the tab."
          : "Capturing snapshot…"
    );
    window.close();
  } catch (error) {
    setStatus(String(error?.message || error), true);
    snapshotBtn.disabled = false;
    startBtn.disabled = false;
    setSnapshotControlsDisabled(false);
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

async function initSnapshotSettings() {
  try {
    const stored = await chrome.storage.local.get([
      SNAPSHOT_MODE_KEY,
      SNAPSHOT_DELAY_KEY,
      SNAPSHOT_LINKEDIN_KEY,
      SNAPSHOT_FORMAT_KEY,
      SNAPSHOT_JPG_KEY,
    ]);
    const mode = stored?.[SNAPSHOT_MODE_KEY] === "region" ? "region" : "full";
    snapshotModeFullEl.checked = mode === "full";
    snapshotModeRegionEl.checked = mode === "region";

    const delay = Number(stored?.[SNAPSHOT_DELAY_KEY]);
    const allowed = new Set(["0", "3", "5", "10"]);
    const delayValue = allowed.has(String(delay)) ? String(delay) : "5";
    snapshotDelayEl.value = delayValue;
    snapshotLinkedInEl.checked = stored?.[SNAPSHOT_LINKEDIN_KEY] === true;
    applySnapshotFormat(
      normalizePopupSnapshotFormat(
        stored?.[SNAPSHOT_FORMAT_KEY],
        stored?.[SNAPSHOT_JPG_KEY]
      )
    );
  } catch (_error) {
    snapshotModeFullEl.checked = true;
    snapshotDelayEl.value = "5";
    snapshotLinkedInEl.checked = false;
    applySnapshotFormat("png");
  }
}

async function persistSnapshotSettings() {
  const mode = snapshotModeRegionEl.checked ? "region" : "full";
  const delay = Number(snapshotDelayEl.value) || 0;
  await chrome.storage.local.set({
    [SNAPSHOT_MODE_KEY]: mode,
    [SNAPSHOT_DELAY_KEY]: delay,
    [SNAPSHOT_LINKEDIN_KEY]: snapshotLinkedInEl.checked,
    [SNAPSHOT_FORMAT_KEY]: selectedSnapshotFormat(),
  });
}

function selectedSnapshotFormat() {
  if (snapshotFormatGifEl.checked) return "gif";
  if (snapshotFormatJpgEl.checked) return "jpg";
  return "png";
}

function applySnapshotFormat(format) {
  snapshotFormatPngEl.checked = format === "png";
  snapshotFormatJpgEl.checked = format === "jpg";
  snapshotFormatGifEl.checked = format === "gif";
}

function normalizePopupSnapshotFormat(value, legacyJpg) {
  if (value === "jpg" || value === "gif" || value === "png") return value;
  if (legacyJpg === true) return "jpg";
  return "png";
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
    if (result?.snapshotActive) {
      statusSnapshot = null;
      showSnapshotBusy(result);
      setStatus(`Snapshot in progress (${result.snapshotPhase || "active"}).`);
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
  snapshotBtn.disabled = false;
  setOptionsDisabled(false);
  setSnapshotControlsDisabled(false);
  activeSessionEl.hidden = true;
}

function showSnapshotBusy(_status) {
  clearTimer();
  startBtn.hidden = false;
  startBtn.disabled = true;
  snapshotBtn.disabled = true;
  setOptionsDisabled(false);
  setSnapshotControlsDisabled(true);
  activeSessionEl.hidden = true;
}

function showActive(status) {
  startBtn.hidden = true;
  snapshotBtn.disabled = true;
  setOptionsDisabled(true);
  setSnapshotControlsDisabled(true);
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

function setSnapshotControlsDisabled(disabled) {
  snapshotModeFullEl.disabled = disabled;
  snapshotModeRegionEl.disabled = disabled;
  snapshotDelayEl.disabled = disabled;
  snapshotLinkedInEl.disabled = disabled;
  snapshotFormatPngEl.disabled = disabled;
  snapshotFormatJpgEl.disabled = disabled;
  snapshotFormatGifEl.disabled = disabled;
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
