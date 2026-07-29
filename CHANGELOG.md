# Changelog

All notable changes to Exergy ∞ xFrame plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Keep pause/stop available when host pages hide or remove the on-page controls (fullscreen containers, aggressive SPA DOM cleanup, and conflicting page CSS via a closed Shadow DOM overlay).
- Remount the session overlay after navigations and when the host detaches the UI, and re-inject it when the popup checks status.
- Persist in-flight session state across Manifest V3 service worker restarts so the toolbar popup can still pause or stop an active recording.

### Changed

- Rename the packaged Chrome extension zip artifact to include `chrome-plugin` in the filename.
- Minor README wording updates.

## [1.0.0] - 2026-07-28

### Added

- Chrome Manifest V3 tab capture extension that records the active tab (video + tab audio) to MP4 when supported, otherwise WebM.
- On-page countdown, optional logo watermark, optional captureable pointer, and optional on-page session bar.
- Pause / continue and stop & save from the toolbar popup, on-page controls, or **P** / **S** keyboard shortcuts.
- Hide native cursor during capture; hide on-page controls from the recording by default.
- Custom recording logo support (stored in extension storage).
- Offscreen `MediaRecorder`, IndexedDB handoff, and `saver.html` download path.
- GitHub Actions workflow to package the extension zip for Chrome Web Store upload.
- Branded explainer page (`index.html`) and project README.
