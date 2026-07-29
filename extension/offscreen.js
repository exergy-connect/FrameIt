const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const OFFSCREEN_ONLY_TYPES = new Set([
  "frameit-offscreen-ping",
  "frameit-recorder-status",
  "frameit-acquire-stream",
  "frameit-start-recording",
  "frameit-pause-recording",
  "frameit-resume-recording",
  "frameit-stop-recording",
  "frameit-discard",
]);

let captureStream = null;
let audioContext = null;
let mediaRecorder = null;
let recordedChunks = [];
let activeMimeType = "";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // Ignore anything originating from a tab content script.
  if (sender.tab || !OFFSCREEN_ONLY_TYPES.has(message.type)) {
    return false;
  }

  if (message.type === "frameit-offscreen-ping") {
    sendResponse({ ok: true, source: "offscreen" });
    return false;
  }

  if (message.type === "frameit-recorder-status") {
    sendResponse({ ok: true, ...getRecorderStatus() });
    return false;
  }

  if (message.type === "frameit-acquire-stream") {
    acquireStream(message.streamId, {
      includePointer: Boolean(message.includePointer),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-start-recording") {
    startRecording()
      .then((mimeType) => sendResponse({ ok: true, mimeType }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-pause-recording") {
    try {
      pauseRecording();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  if (message.type === "frameit-resume-recording") {
    try {
      resumeRecording();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  if (message.type === "frameit-stop-recording") {
    stopRecording(message.filename)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-discard") {
    cleanup();
    clearPendingRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  return false;
});

function getRecorderStatus() {
  const recorderState = mediaRecorder?.state || "inactive";
  const hasStream = Boolean(
    captureStream && captureStream.getTracks().some((track) => track.readyState === "live")
  );
  return {
    source: "offscreen",
    hasStream,
    recording: recorderState === "recording" || recorderState === "paused",
    paused: recorderState === "paused",
    mimeType: activeMimeType || mediaRecorder?.mimeType || "",
  };
}

async function acquireStream(streamId, { includePointer = false } = {}) {
  cleanup();

  const cursor = includePointer ? "always" : "never";

  async function openStream(withAudio) {
    // Prefer cursor constraint so the OS pointer is not baked into tab capture
    // unless the user opted in. Fall back if the browser rejects it.
    const attempts = [
      {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          cursor,
        },
      },
      {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    ];

    let lastError;
    for (const video of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: withAudio
            ? {
                mandatory: {
                  chromeMediaSource: "tab",
                  chromeMediaSourceId: streamId,
                },
              }
            : false,
          video,
        });
        await applyCursorConstraint(stream, cursor);
        return stream;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Failed to acquire tab stream");
  }

  try {
    captureStream = await openStream(true);
  } catch (_audioError) {
    captureStream = await openStream(false);
  }

  const audioTracks = captureStream.getAudioTracks();
  if (audioTracks.length > 0) {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(captureStream);
    source.connect(audioContext.destination);
  }
}

async function applyCursorConstraint(stream, cursor) {
  const [track] = stream.getVideoTracks();
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({ advanced: [{ cursor }] });
  } catch (_error) {
    try {
      await track.applyConstraints({ cursor });
    } catch (_error2) {
      // Cursor constraint unsupported; content script hides/restores pointer.
    }
  }
}

async function pickMimeType(stream) {
  for (const mimeType of MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try {
      await probeRecorder(stream, mimeType);
      return mimeType;
    } catch (_error) {
      // Advertised types can still fail at start(); try the next candidate.
    }
  }

  await probeRecorder(stream, undefined);
  return "";
}

function probeRecorder(stream, mimeType) {
  return new Promise((resolve, reject) => {
    let recorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (error) {
      reject(error);
      return;
    }

    const fail = (error) => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch (_e) {
        // ignore
      }
      reject(error || new Error("MediaRecorder probe failed"));
    };

    recorder.onerror = (event) => fail(event.error || new Error("probe error"));
    recorder.onstart = () => {
      try {
        recorder.stop();
      } catch (error) {
        fail(error);
      }
    };
    recorder.onstop = () => resolve();

    try {
      recorder.start(100);
    } catch (error) {
      fail(error);
    }
  });
}

async function startRecording() {
  if (!captureStream) {
    throw new Error("Capture stream is not ready");
  }

  recordedChunks = [];
  activeMimeType = await pickMimeType(captureStream);

  mediaRecorder = activeMimeType
    ? new MediaRecorder(captureStream, { mimeType: activeMimeType })
    : new MediaRecorder(captureStream);

  activeMimeType = mediaRecorder.mimeType || activeMimeType || "video/webm";

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.start(1000);
  return activeMimeType;
}

function pauseRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    throw new Error("Recorder is not recording");
  }
  mediaRecorder.pause();
}

function resumeRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "paused") {
    throw new Error("Recorder is not paused");
  }
  mediaRecorder.resume();
}

async function stopRecording(filename) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("Recorder is not active");
  }
  if (!filename || typeof filename !== "string") {
    throw new Error("Missing download filename");
  }

  const mimeType = activeMimeType || mediaRecorder.mimeType || "video/webm";

  await new Promise((resolve, reject) => {
    mediaRecorder.onstop = () => resolve();
    mediaRecorder.onerror = (event) =>
      reject(event.error || new Error("Recorder failed while stopping"));
    try {
      if (mediaRecorder.state === "recording") {
        mediaRecorder.requestData();
      }
      mediaRecorder.stop();
    } catch (error) {
      reject(error);
    }
  });

  const blob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];

  if (blob.size === 0) {
    cleanup();
    throw new Error("Recording produced an empty file");
  }

  // Offscreen cannot use chrome.downloads; hand the blob to the SW via IndexedDB.
  await putPendingRecording(blob);
  cleanup();

  return {
    mimeType,
    size: blob.size,
    filename,
    extension: mimeType.includes("mp4") ? ".mp4" : ".webm",
  };
}

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch (_error) {
      // ignore
    }
  }
  mediaRecorder = null;
  recordedChunks = [];
  activeMimeType = "";

  if (captureStream) {
    for (const track of captureStream.getTracks()) {
      track.stop();
    }
    captureStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}
