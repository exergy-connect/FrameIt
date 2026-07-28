(async () => {
  const params = new URLSearchParams(window.location.search);
  const filename = params.get("filename") || "session.webm";
  let objectUrl = null;

  try {
    const blob = await takePendingRecording();
    if (!blob) {
      throw new Error("Recording data was empty");
    }

    // Service workers lack URL.createObjectURL; this extension page provides it.
    objectUrl = URL.createObjectURL(blob);
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
    });
    await waitForDownloadSettled(downloadId);

    await chrome.runtime.sendMessage({ type: "frameit-save-done", ok: true });
  } catch (error) {
    try {
      await chrome.runtime.sendMessage({
        type: "frameit-save-done",
        ok: false,
        error: String(error?.message || error),
      });
    } catch (_error) {
      // Service worker may have gone away.
    }
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    window.close();
  }
})();

function waitForDownloadSettled(downloadId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }, 120_000);

    function finish() {
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        finish();
        return;
      }
      if (delta.state.current === "interrupted") {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("Download was interrupted before it completed"));
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.search({ id: downloadId }).then((results) => {
      const item = results && results[0];
      if (!item) return;
      if (item.state === "complete") {
        finish();
      } else if (item.state === "interrupted") {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("Download was interrupted before it completed"));
      }
    });
  });
}
