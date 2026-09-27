---
name: frontend-testing-without-a-browser
description: How to actually exercise index.html's JS with no dependencies — a stub-DOM harness in the scratchpad
metadata:
  type: feedback
---

Verify frontend changes by executing the script, not just eyeballing it: extract the
`<script>` block, `node --check` it, then `eval` it against a ~40-line stub DOM
(getElementById over ids scraped from the markup, classList/dataset/style stubs, fake
`fetch`/`WebSocket`). Driving stubbed ComfyUI responses through it exercises upload
dedup, ws progress, stop, and error paths in seconds.

**Why:** there is no test suite, no build step, and no browser automation in this repo,
and "it parses" does not catch a typo'd element id or a broken run lifecycle.

**How to apply:** keep the harness in the session scratchpad, never in the repo — the
project is deliberately two files. Gotchas: stub elements need `dataset.slot` on the
dropzones, and `document.createElement("img")` stubs never fire `onload`, so
image-dimension code paths stay untested there.
