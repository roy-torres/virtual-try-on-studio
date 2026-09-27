---
name: frontend-upload-downscale-decision
description: Why the frontend downscales uploads to ~1.6 MP by default — the workflow's ImageScaleToTotalPixels already forces 1 MP
metadata:
  type: project
---

Client-side canvas downscale of uploads is ON by default (checkbox "Downscale large
uploads"), triggering only above ~2.2 MP and targeting ~1.6 MP.

**Why:** both LoadImage nodes (76, 81) in `public/workflow.api.json` feed
`ImageScaleToTotalPixels` with `megapixels: 1`, and the output resolution comes from
`GetImageSize` on that already-scaled subject. Every pixel above 1 MP is uploaded and
decoded only to be discarded. Comfy's own resample is `nearest-exact`, which is a poor
downsampler from 12 MP; a high-quality canvas resample first is arguably better, not
worse. Targeting 1.6 MP (not 1.0) keeps ComfyUI doing the final scale itself, so
output dimensions are unchanged.

**How to apply:** if the workflow is ever re-exported with a different `megapixels`
value, or the scale nodes are removed, re-check `RESIZE_ABOVE_PIXELS` /
`RESIZE_TARGET_PIXELS` in `public/index.html`. Never resize below the workflow's
target — that would make ComfyUI upscale with nearest-exact. Related:
[[frontend-run-ui-contract]].
