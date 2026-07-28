(() => {
  if (window.__frameItOverlayLoaded) {
    return;
  }
  window.__frameItOverlayLoaded = true;

  const ROOT_ID = "frameit-root";
  let timerId = null;
  let recordingStartedAt = 0;
  let totalPausedMs = 0;
  let pausedAt = 0;
  let isPaused = false;

  const ICON_PAUSE = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1"></rect>
      <rect x="14" y="5" width="4" height="14" rx="1"></rect>
    </svg>`;
  const ICON_CONTINUE = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z"></path>
    </svg>`;
  const ICON_STOP = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2"></rect>
    </svg>`;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "frameit-show-countdown") {
      showCountdown()
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message.type === "frameit-show-session-bar") {
      recordingStartedAt = message.startedAt || Date.now();
      showSessionBar({ includeLogo: message.includeLogo !== false });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "frameit-teardown") {
      teardown();
      sendResponse({ ok: true });
      return false;
    }
  });

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("data-frameit", "true");
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function clearRoot() {
    const root = document.getElementById(ROOT_ID);
    if (root) {
      root.replaceChildren();
    }
  }

  function showCountdown() {
    return new Promise((resolve) => {
      const root = ensureRoot();
      clearRoot();
      clearTimer();

      const logoUrl = chrome.runtime.getURL("assets/exergy_connect_logo.png");
      const overlay = document.createElement("div");
      overlay.className = "frameit-countdown";
      overlay.innerHTML = `
        <div class="frameit-countdown__card">
          <img
            class="frameit-countdown__logo"
            src="${logoUrl}"
            alt="Exergy Connect"
            width="56"
            height="56"
          />
          <div class="frameit-countdown__brand">Exergy ∞ FrameIt</div>
          <div class="frameit-countdown__number" aria-live="polite">3</div>
          <div class="frameit-countdown__label">Starting capture...</div>
        </div>
      `;
      root.appendChild(overlay);

      const numberEl = overlay.querySelector(".frameit-countdown__number");
      let count = 3;

      const tick = () => {
        if (count > 1) {
          count -= 1;
          numberEl.textContent = String(count);
          timerId = window.setTimeout(tick, 1000);
          return;
        }

        numberEl.textContent = "1";
        window.setTimeout(async () => {
          overlay.remove();
          await waitFrames(2);
          await delay(100);
          try {
            await chrome.runtime.sendMessage({ type: "frameit-countdown-done" });
          } catch (_error) {
            // Session may have been aborted.
          }
          resolve();
        }, 1000);
      };

      timerId = window.setTimeout(tick, 1000);
    });
  }

  function showSessionBar({ includeLogo = true } = {}) {
    const root = ensureRoot();
    clearRoot();
    clearTimer();
    totalPausedMs = 0;
    pausedAt = 0;
    isPaused = false;

    if (includeLogo) {
      const logoUrl = chrome.runtime.getURL("assets/exergy_connect_logo.png");
      const watermark = document.createElement("img");
      watermark.className = "frameit-watermark";
      watermark.src = logoUrl;
      watermark.alt = "Exergy Connect";
      watermark.width = 48;
      watermark.height = 48;
      root.appendChild(watermark);
    }

    const bar = document.createElement("div");
    bar.className = "frameit-session-bar";
    bar.innerHTML = `
      <div class="frameit-session-bar__left">
        <span class="frameit-session-bar__dot" aria-hidden="true"></span>
        <span class="frameit-session-bar__title">Exergy ∞ FrameIt</span>
        <span class="frameit-session-bar__time" aria-live="polite">00:00</span>
      </div>
      <div class="frameit-session-bar__controls">
        <button
          type="button"
          class="frameit-btn frameit-btn--pause"
          title="Pause"
          aria-label="Pause"
        >${ICON_PAUSE}</button>
        <button
          type="button"
          class="frameit-btn frameit-btn--stop"
          title="Stop and save"
          aria-label="Stop and save"
        >${ICON_STOP}</button>
      </div>
    `;
    root.appendChild(bar);

    const timeEl = bar.querySelector(".frameit-session-bar__time");
    const pauseBtn = bar.querySelector(".frameit-btn--pause");
    const stopBtn = bar.querySelector(".frameit-btn--stop");

    const updateTime = () => {
      timeEl.textContent = formatElapsed(getElapsedMs());
    };
    updateTime();
    timerId = window.setInterval(updateTime, 250);

    pauseBtn.addEventListener("click", async () => {
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      try {
        if (isPaused) {
          const result = await chrome.runtime.sendMessage({
            type: "frameit-resume-session",
          });
          if (!result?.ok) {
            throw new Error(result?.error || "Could not continue recording.");
          }
          if (pausedAt) {
            totalPausedMs += Date.now() - pausedAt;
          }
          pausedAt = 0;
          isPaused = false;
          bar.classList.remove("frameit-session-bar--paused");
          pauseBtn.innerHTML = ICON_PAUSE;
          pauseBtn.title = "Pause";
          pauseBtn.setAttribute("aria-label", "Pause");
        } else {
          const result = await chrome.runtime.sendMessage({
            type: "frameit-pause-session",
          });
          if (!result?.ok) {
            throw new Error(result?.error || "Could not pause recording.");
          }
          pausedAt = Date.now();
          isPaused = true;
          bar.classList.add("frameit-session-bar--paused");
          pauseBtn.innerHTML = ICON_CONTINUE;
          pauseBtn.title = "Continue";
          pauseBtn.setAttribute("aria-label", "Continue");
        }
        updateTime();
      } catch (error) {
        window.alert(String(error?.message || error));
      } finally {
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
      }
    });

    stopBtn.addEventListener("click", async () => {
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      stopBtn.title = "Saving…";
      try {
        const result = await chrome.runtime.sendMessage({
          type: "frameit-stop-session",
        });
        if (!result?.ok) {
          pauseBtn.disabled = false;
          stopBtn.disabled = false;
          stopBtn.title = "Stop and save";
          window.alert(result?.error || "Could not save the recording.");
        }
      } catch (error) {
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
        stopBtn.title = "Stop and save";
        window.alert(String(error?.message || error));
      }
    });
  }

  function getElapsedMs() {
    const pausedExtra = isPaused && pausedAt ? Date.now() - pausedAt : 0;
    return Math.max(
      0,
      Date.now() - recordingStartedAt - totalPausedMs - pausedExtra
    );
  }

  function teardown() {
    clearTimer();
    const root = document.getElementById(ROOT_ID);
    if (root) {
      root.remove();
    }
  }

  function clearTimer() {
    if (timerId != null) {
      window.clearTimeout(timerId);
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

  function waitFrames(count) {
    return new Promise((resolve) => {
      const step = (left) => {
        if (left <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(() => step(left - 1));
      };
      step(count);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
