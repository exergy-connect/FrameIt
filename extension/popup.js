const startBtn = document.getElementById("start");
const statusEl = document.getElementById("status");

refreshStatus();

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("Starting session…");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-start-session",
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

async function refreshStatus() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-get-status",
    });
    if (result?.active) {
      startBtn.disabled = true;
      setStatus(`Session in progress (${result.phase || "active"}).`);
    }
  } catch (_error) {
    // Service worker may still be waking up.
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}
