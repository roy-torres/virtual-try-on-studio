# Virtual Try-On Studio

A small frontend for the **Flux.2 Klein image-edit** ComfyUI workflow
(`2+flux2_klein_image_edit_4b_distilled_api.json`).

Upload two images (a person, and a piece of clothing or an accessory), type a
short prompt, hit **Generate**, and the result is shown inline.

**Demo video:** <https://vimeo.com/1230764928>

## How to use

1. **Subject**: upload a photo of the person. Use at least 512 px on the shorter
   side, with some space above the head if you're adding a hat. Smaller photos
   still work, but the app warns you because the result will be blurry.
2. **Attribute**: upload the item to try on (a cap, glasses, a shirt, …).
3. **Prompt**: write **one short sentence describing the finished picture**,
   for example *"The model is wearing the hat."*
4. Click **Generate** and leave the tab open. The status dot shows whether
   ComfyUI is reachable, and the run panel shows progress, elapsed time and the
   seed. **Stop run** cancels.
5. Optional: tick **Lock seed** to reproduce a result, or keep **Downscale large
   uploads** on to send big photos faster (the workflow resizes to ~1 MP anyway).

### Prompt tips (learned from testing)

The workflow uses a small, fast 4-step model, and it's sensitive to how the
prompt is worded:

| Prompt | What happened |
| --- | --- |
| *"The model is wearing the hat."* | ✅ cap placed correctly |
| Long instructions: *"Dress the person in image 1 with the clothing from image 2. Keep the face, pose… unchanged."* | ❌ nothing changed, or the logo landed on the forehead |
| Listing examples: *"…a hat on the head, glasses on the face…"* | ❌ added the hat **and** glasses |
| Generic: *"Put the item from image 2 on the person…"* | ❌ no hat, logo on the neck |

Say what the item is, describe the end result, and skip the "keep X unchanged"
clauses. That's why the prompt box starts empty instead of pre-filled.

## Requirements

- Node.js 18+ (22.9+ for the demo-mode command below); no npm packages
- A running [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with the Flux.2
  Klein 4B models installed (`flux-2-klein-4b-fp8.safetensors`,
  `qwen_3_4b.safetensors`)

## Run

```bash
node server.js
```

Then open <http://localhost:5173>.

`server.js` has **no dependencies**. It:

1. serves the UI in `public/`
2. proxies everything under `/comfy/*` to ComfyUI, so the browser hits no CORS wall
3. proxies the ComfyUI websocket for live progress

### Config (env vars)

| var          | default     | meaning                    |
| ------------ | ----------- | -------------------------- |
| `PORT`       | `5173`      | port the frontend listens on |
| `COMFY_HOST` | `127.0.0.1` | ComfyUI host               |
| `COMFY_PORT` | `8188`      | ComfyUI port               |
| `DEMO_PASSWORD` | _(unset)_ | turns on demo mode (see below) |
| `DEMO_MAX_QUEUE` | `2`      | demo mode: max jobs running + pending |

## Public demo (password-protected)

To share the app over a temporary public URL:

```bash
cp .env.example .env            # then set a real DEMO_PASSWORD in .env
node --env-file-if-exists=.env server.js
cloudflared tunnel --url http://localhost:5173   # brew install cloudflared
```

cloudflared prints an `https://….trycloudflare.com` link. Visitors log in with
the password (any username). The link lasts only while your Mac, ComfyUI,
the server, and the tunnel are running, and it changes on every restart.

With `DEMO_PASSWORD` set, the server:

- requires HTTP Basic auth on every page, API call, and the websocket
- only allows the ComfyUI routes the UI uses (`system_stats`, `upload/image`,
  `prompt`, `history/<id>`, `queue`, `view`, `interrupt`), so everything else
  (Manager, settings, model downloads) returns 403
- rebuilds every `/prompt` from `public/workflow.api.json`, so visitors can set
  only the two images, the prompt text, and the seed
- refuses new jobs once `DEMO_MAX_QUEUE` are already queued (HTTP 429)

Without `DEMO_PASSWORD`, `node server.js` behaves exactly as before.

**Secrets:** `.env` is gitignored, so never commit it and never hard-code keys
or passwords in code. `.env.example` holds placeholders only.

## How it maps to the workflow

| UI element        | workflow node                          |
| ----------------- | -------------------------------------- |
| SUBJECT image     | `76` – `LoadImage`                     |
| ATTRIBUTE image   | `81` – `LoadImage`                     |
| Prompt box        | `92:109` – `CLIPTextEncode` (`text`)   |
| Seed (random, or locked) | `92:106` – `RandomNoise` (`noise_seed`) |
| Output image      | `94` – `SaveImage`                     |

`public/workflow.api.json` is a copy of the API-format workflow; edit it there
if you change the graph in ComfyUI (export as *API format*).

## Note for Apple Silicon

The bundled workflow loads fp8 weights (`flux-2-klein-4b-fp8.safetensors`,
`qwen_3_4b.safetensors`). On the MPS backend ComfyUI currently errors with:

> Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.

That's a ComfyUI/model issue, not the frontend. Options: start ComfyUI with
`--cpu` (what this project uses; about 11 minutes per image on an M-series
Mac), or swap in non-fp8 / GGUF weights in the Load nodes. The frontend
surfaces whatever error ComfyUI returns.

## Built with Claude Code

The app was built with [Claude Code](https://claude.com/claude-code), and the
project setup for it is checked in under `.claude/`:

| Path | What it does |
| --- | --- |
| `.claude/CLAUDE.md` | project brief: architecture, the workflow node contract, the CPU-mode constraint |
| `.claude/agents/` | subagents: `frontend` (UI in `public/index.html`), `debugger` (root-causing failed runs), `ux-laws-review`, `python-backend` |
| `.claude/skills/comfy-docs/` | offline search of the ComfyUI docs, so API answers come from the source |
| `.claude/skills/laws-of-ux/` | offline search of [Laws of UX](https://lawsofux.com), used to justify UI decisions |
| `.claude/hooks/` | two `Stop` hooks that log every turn to `.claude/logs/` (gitignored) |
| `.claude/settings.json` | shared permission allowlist and the hook registration |

`.claude/settings.local.json` and `.claude/logs/` stay local and are gitignored.
