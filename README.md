# Virtual Try-On Studio

A small frontend for the **Flux.2 Klein image-edit** ComfyUI workflow
(`2+flux2_klein_image_edit_4b_distilled_api.json`).

Upload two images (e.g. a person + a garment), type a prompt, hit **Generate**,
and the result is shown inline.

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
| (each run)        | `92:106` – `RandomNoise` seed randomised |
| Output image      | `94` – `SaveImage`                     |

`public/workflow.api.json` is a copy of the API-format workflow; edit it there
if you change the graph in ComfyUI (export as *API format*).

## Note for Apple Silicon

The bundled workflow loads fp8 weights (`flux-2-klein-4b-fp8.safetensors`,
`qwen_3_4b.safetensors`). On the MPS backend ComfyUI currently errors with:

> Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.

That's a ComfyUI/model issue, not the frontend. Options: start ComfyUI with
`--cpu`, or swap in non-fp8 / bf16 weights in the Load nodes. The frontend
surfaces whatever error ComfyUI returns.
