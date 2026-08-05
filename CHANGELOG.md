# Changelog

All notable changes to Exergy ∞ xFrame plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tab snapshots: full viewport or region select, delay (default 5s), popup controls, **Alt+Shift+S** shortcut.
- **Optimize for LinkedIn**: center-crop/scale to 1280×644 so LinkedIn does not resize again.
- Snapshot formats: **PNG (best)** for LinkedIn quality, **JPG** (95%), **GIF (smallest)** — 256-color single-frame.

### Fixed

- Popup layout stays compact after snapshot controls were added (no scrollbar).
- Pause/stop survive host pages that hide, remove, or restyle on-page controls (closed Shadow DOM overlay).
- Remount session overlay after navigations / DOM detach; re-inject when the popup checks status.
- Persist in-flight session state across MV3 service worker restarts.

### Changed

- Packaged zip artifact name includes `chrome-plugin`.
- Extension version **1.0.2**.

## [1.0.0] - 2026-07-28

### Added

- Chrome Manifest V3 tab capture: records the active tab (video + tab audio) to MP4 when supported, otherwise WebM.
- On-page countdown, optional logo watermark, optional captureable pointer, optional on-page session bar.
- Pause / continue and stop & save from the toolbar popup, on-page controls, or **P** / **S**.
- Hide native cursor during capture; hide on-page controls from the recording by default.
- Custom recording logo (extension storage).
- Offscreen `MediaRecorder`, IndexedDB handoff, and `saver.html` download path.
- GitHub Actions workflow to package the Chrome Web Store zip.
- Branded explainer (`index.html`) and project README.
