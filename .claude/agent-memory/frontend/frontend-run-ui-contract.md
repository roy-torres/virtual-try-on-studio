---
name: frontend-run-ui-contract
description: How the generation UI is structured — run panel states, upload cache, ws lifecycle — and the invariants not to break
metadata:
  type: project
---

`public/index.html` states the UI must keep handling, in one static run panel
(`#runPanel`) that is updated with `setText`, never `innerHTML`:

- ComfyUI offline → Generate disabled, `#help` says why (checked every 15 s).
- Preparing / uploading / queued (with queue position) / per-node phase / sampling
  with step count / stopping / stopped / error / result.
- Websocket down mid-run → note says the live feed is disconnected and polling
  continues. The image only ever arrives from history polling.

Invariants worth protecting:

- `slots[x].uploadedName` + `uploadKey` cache the ComfyUI-side filename; the key is
  `name|size|lastModified|downscale-flag`. Re-rolling a seed on the same files must
  not re-upload.
- Uploads are renamed `tryon-<slot>-<base>.<ext>` so subject and attribute can never
  collide on the server when two files share a name.
- The step ETA is measured from the first `progress` event, not from run start —
  loading fp8 weights dominates the first minutes and pacing from t0 would lie.
- Previous result stays on screen, dimmed (`.stale`) and captioned "Previous result",
  until the next one lands.

See [[frontend-upload-downscale-decision]] for the resize rationale.
