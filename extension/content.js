(() => {
  if (window.__frameItOverlayLoaded) {
    return;
  }
  window.__frameItOverlayLoaded = true;

  const ROOT_ID = "frameit-root";
  const CURSOR_STYLE_ID = "frameit-cursor-style";

  let hostEl = null;
  let shadowRoot = null;
  let cssTextPromise = null;
  let timerId = null;
  let recordingStartedAt = 0;
  let totalPausedMs = 0;
  let pausedAt = 0;
  let isPaused = false;
  let pointerEl = null;
  let onPointerMove = null;
  let onSessionKeyDown = null;
  let sessionBusy = false;
  let sessionUi = null; // { bar, pauseBtn, stopBtn, updateTime } when on-page bar exists
  let sessionActive = false;
  let sessionOptions = null;
  let guardTimerId = null;
  let remountScheduled = false;

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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    // Only accept overlay commands from this extension.
    if (sender.id !== chrome.runtime.id) {
      return false;
    }

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
      totalPausedMs = Number(message.totalPausedMs) || 0;
      pausedAt = Number(message.pausedAt) || 0;
      isPaused = Boolean(message.paused);
      showSessionBar({
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

    if (message.type === "frameit-ping-overlay") {
      sendResponse({
        ok: true,
        active: sessionActive,
        connected: Boolean(hostEl?.isConnected),
      });
      return false;
    }

    if (message.type === "frameit-teardown") {
      teardown();
      sendResponse({ ok: true });
      return false;
    }

    // Ignore internal offscreen/background traffic broadcast on this channel.
    return false;
  });

  document.addEventListener("fullscreenchange", () => {
    if (!sessionActive || !hostEl) return;
    placeHost(hostEl);
  });

  function loadCssText() {
    if (!cssTextPromise) {
      cssTextPromise = fetch(chrome.runtime.getURL("content.css"))
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to load overlay CSS (${response.status})`);
          }
          return response.text();
        })
        .catch((error) => {
          cssTextPromise = null;
          throw error;
        });
    }
    return cssTextPromise;
  }

  async function ensureRoot() {
    if (hostEl?.isConnected && shadowRoot) {
      placeHost(hostEl);
      return shadowRoot;
    }

    const cssText = await loadCssText();

    if (hostEl && !hostEl.isConnected) {
      hostEl.remove();
      hostEl = null;
      shadowRoot = null;
    }

    if (!hostEl) {
      hostEl = document.createElement("div");
      hostEl.id = ROOT_ID;
      hostEl.setAttribute("data-frameit", "true");
      // Closed shadow isolates controls from aggressive host-page CSS.
      shadowRoot = hostEl.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = cssText;
      shadowRoot.appendChild(style);
    }

    placeHost(hostEl);
    startDomGuard();
    return shadowRoot;
  }

  function canContainOverlay(el) {
    if (!el || el === hostEl) return false;
    if (el === document.documentElement || el === document.body) return true;
    if (el.nodeType !== 1) return false;
    const tag = el.tagName;
    // Replaced/media elements cannot host child overlay nodes.
    return !(
      tag === "VIDEO" ||
      tag === "AUDIO" ||
      tag === "IMG" ||
      tag === "CANVAS" ||
      tag === "IFRAME" ||
      tag === "EMBED" ||
      tag === "OBJECT"
    );
  }

  function placeHost(host) {
    const fullscreenEl = document.fullscreenElement;
    const parent =
      fullscreenEl && canContainOverlay(fullscreenEl)
        ? fullscreenEl
        : document.documentElement;
    if (host.parentElement !== parent) {
      parent.appendChild(host);
    }
  }

  function clearShadowContent() {
    if (!shadowRoot) return;
    for (const node of [...shadowRoot.childNodes]) {
      if (node.nodeName === "STYLE") continue;
      node.remove();
    }
  }

  function startDomGuard() {
    if (guardTimerId != null) return;
    // Poll lightly: busy SPAs mutate constantly, and fullscreen/top-layer
    // changes can detach the host without a reliable single mutation target.
    guardTimerId = window.setInterval(() => {
      if (!sessionActive) return;
      if (hostEl?.isConnected) {
        placeHost(hostEl);
        return;
      }
      scheduleRemount();
    }, 1000);
  }

  function stopDomGuard() {
    if (guardTimerId != null) {
      window.clearInterval(guardTimerId);
      guardTimerId = null;
    }
  }

  function scheduleRemount() {
    if (!sessionActive || remountScheduled) return;
    remountScheduled = true;
    queueMicrotask(async () => {
      remountScheduled = false;
      if (!sessionActive || hostEl?.isConnected) return;
      try {
        await showSessionBar(sessionOptions || {});
      } catch (_error) {
        // Page may be unloading.
      }
    });
  }

  async function showCountdown() {
    sessionActive = true;
    const root = await ensureRoot();
    clearShadowContent();
    clearTimer();
    stopPointer();
    unbindSessionKeys();
    sessionUi = null;

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
        <div class="frameit-countdown__brand">Exergy ∞ xFrame</div>
        <div class="frameit-countdown__number" aria-live="polite">3</div>
        <div class="frameit-countdown__label">Starting capture...</div>
      </div>
    `;
    root.appendChild(overlay);

    const numberEl = overlay.querySelector(".frameit-countdown__number");
    let count = 3;

    return new Promise((resolve) => {
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

  async function showSessionBar({
    includeLogo = true,
    logoDataUrl = null,
    hideControls = true,
    includePointer = false,
  } = {}) {
    sessionOptions = {
      includeLogo,
      logoDataUrl,
      hideControls,
      includePointer,
    };
    sessionActive = true;

    const root = await ensureRoot();
    clearShadowContent();
    stopPointer();
    unbindSessionKeys();
    clearTimer();
    sessionBusy = false;
    sessionUi = null;

    if (includeLogo) {
      const customLogo = normalizeLogoDataUrl(logoDataUrl);
      const logoUrl =
        customLogo || chrome.runtime.getURL("assets/exergy_connect_logo.png");
      const watermark = document.createElement("img");
      watermark.className = "frameit-watermark";
      watermark.src = logoUrl;
      watermark.alt = customLogo ? "Recording logo" : "Exergy Connect";
      watermark.width = 48;
      watermark.height = 48;
      root.appendChild(watermark);
    }

    if (includePointer) {
      startPointer(root);
    }

    // Always hide the native cursor while recording (capture stays clean).
    // Use P = pause/continue and S = stop & save when the cursor is hidden.
    hideNativeCursor(true);
    bindSessionKeys();

    // When controls are hidden from the video, omit the on-page session bar.
    // The extension popup (and P/S keys) provide pause / stop instead.
    if (hideControls) {
      return;
    }

    const bar = document.createElement("div");
    bar.className = "frameit-session-bar";
    if (isPaused) {
      bar.classList.add("frameit-session-bar--paused");
    }
    bar.innerHTML = `
      <div class="frameit-session-bar__left">
        <span class="frameit-session-bar__dot" aria-hidden="true"></span>
        <span class="frameit-session-bar__title">Exergy ∞ xFrame</span>
        <span class="frameit-session-bar__time" aria-live="polite">00:00</span>
      </div>
      <div class="frameit-session-bar__controls">
        <button
          type="button"
          class="frameit-btn frameit-btn--pause"
          title="${isPaused ? "Continue (P)" : "Pause (P)"}"
          aria-label="${isPaused ? "Continue" : "Pause"}"
        >${isPaused ? ICON_CONTINUE : ICON_PAUSE}</button>
        <button
          type="button"
          class="frameit-btn frameit-btn--stop"
          title="Stop and save (S)"
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

    sessionUi = { bar, pauseBtn, stopBtn, updateTime };

    pauseBtn.addEventListener("click", () => togglePause());
    stopBtn.addEventListener("click", () => stopAndSave());
  }

  function isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    return (
      target.isContentEditable ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT"
    );
  }

  function bindSessionKeys() {
    unbindSessionKeys();
    onSessionKeyDown = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      const key = String(event.key || "").toLowerCase();
      if (key === "p") {
        event.preventDefault();
        togglePause();
      } else if (key === "s") {
        event.preventDefault();
        stopAndSave();
      }
    };
    window.addEventListener("keydown", onSessionKeyDown, true);
  }

  function unbindSessionKeys() {
    if (onSessionKeyDown) {
      window.removeEventListener("keydown", onSessionKeyDown, true);
      onSessionKeyDown = null;
    }
  }

  async function togglePause() {
    if (sessionBusy) return;
    sessionBusy = true;
    const { pauseBtn, stopBtn, bar, updateTime } = sessionUi || {};
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
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
        if (bar) bar.classList.remove("frameit-session-bar--paused");
        if (pauseBtn) {
          pauseBtn.innerHTML = ICON_PAUSE;
          pauseBtn.title = "Pause (P)";
          pauseBtn.setAttribute("aria-label", "Pause");
        }
      } else {
        const result = await chrome.runtime.sendMessage({
          type: "frameit-pause-session",
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Could not pause recording.");
        }
        pausedAt = Date.now();
        isPaused = true;
        if (bar) bar.classList.add("frameit-session-bar--paused");
        if (pauseBtn) {
          pauseBtn.innerHTML = ICON_CONTINUE;
          pauseBtn.title = "Continue (P)";
          pauseBtn.setAttribute("aria-label", "Continue");
        }
      }
      if (sessionOptions) {
        sessionOptions = { ...sessionOptions };
      }
      if (updateTime) updateTime();
    } catch (error) {
      window.alert(String(error?.message || error));
    } finally {
      sessionBusy = false;
      if (pauseBtn) pauseBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
    }
  }

  async function stopAndSave() {
    if (sessionBusy) return;
    sessionBusy = true;
    const { pauseBtn, stopBtn } = sessionUi || {};
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.title = "Saving…";
    }
    try {
      const result = await chrome.runtime.sendMessage({
        type: "frameit-stop-session",
      });
      if (!result?.ok) {
        throw new Error(result?.error || "Could not save the recording.");
      }
    } catch (error) {
      sessionBusy = false;
      if (pauseBtn) pauseBtn.disabled = false;
      if (stopBtn) {
        stopBtn.disabled = false;
        stopBtn.title = "Stop and save (S)";
      }
      window.alert(String(error?.message || error));
    }
  }

  function hideNativeCursor(hidden) {
    let style = document.getElementById(CURSOR_STYLE_ID);
    if (hidden) {
      if (!style) {
        style = document.createElement("style");
        style.id = CURSOR_STYLE_ID;
        style.textContent =
          "html.frameit-hide-cursor, html.frameit-hide-cursor * { cursor: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      }
      document.documentElement.classList.add("frameit-hide-cursor");
      return;
    }
    document.documentElement.classList.remove("frameit-hide-cursor");
    if (style) style.remove();
  }

  function startPointer(root) {
    stopPointer();
    pointerEl = document.createElement("div");
    pointerEl.className = "frameit-pointer";
    pointerEl.setAttribute("aria-hidden", "true");
    pointerEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24">
        <path
          d="M4 3l12.5 9.2-5.3 1.2 3.4 7.4-2.6 1.2-3.5-7.5L4 17.8V3z"
          fill="#e8eef5"
          stroke="#0f1419"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      </svg>
    `;
    root.appendChild(pointerEl);

    onPointerMove = (event) => {
      pointerEl.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      pointerEl.classList.add("is-visible");
    };
    window.addEventListener("mousemove", onPointerMove, { passive: true });
  }

  function stopPointer() {
    if (onPointerMove) {
      window.removeEventListener("mousemove", onPointerMove);
      onPointerMove = null;
    }
    if (pointerEl) {
      pointerEl.remove();
      pointerEl = null;
    }
  }

  function getElapsedMs() {
    const pausedExtra = isPaused && pausedAt ? Date.now() - pausedAt : 0;
    return Math.max(
      0,
      Date.now() - recordingStartedAt - totalPausedMs - pausedExtra
    );
  }

  function teardown() {
    sessionActive = false;
    sessionOptions = null;
    remountScheduled = false;
    clearTimer();
    stopPointer();
    unbindSessionKeys();
    hideNativeCursor(false);
    stopDomGuard();
    sessionUi = null;
    sessionBusy = false;
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
      shadowRoot = null;
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

  function normalizeLogoDataUrl(value) {
    return typeof value === "string" && value.startsWith("data:image/")
      ? value
      : null;
  }
})();
