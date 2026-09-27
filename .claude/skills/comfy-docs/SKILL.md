---
name: comfy-docs
description: Search and read the official ComfyUI documentation at https://docs.comfy.org (server HTTP/WebSocket API, /prompt /queue /history /upload /view routes, websocket message types, built-in node reference, custom node development, workflow JSON/API format, model folders, Comfy Cloud, installation and troubleshooting). Use whenever a question is about how ComfyUI itself behaves, before guessing from memory.
---

# ComfyUI docs search

`scripts/comfy-docs.js` searches an offline copy of every English page on
docs.comfy.org (Mintlify serves the whole site as markdown, cached for 24h in
`~/.cache/comfy-docs/`) and fetches single pages live. Node stdlib only.

Run everything from the project root:

```bash
S=".claude/skills/comfy-docs/scripts/comfy-docs.js"

node "$S" search <terms...> [-n 8] [--section <prefix>] [--refresh]
node "$S" page <url-or-path> [--grep <term>]
node "$S" index [filter]
```

## Workflow

1. **Search first** with 2–4 specific terms. Quote a phrase to keep it together.
   Results show title, URL, score, and matching lines.
   ```bash
   node "$S" search websocket progress prompt_id
   node "$S" search "noise_seed" RandomNoise
   node "$S" search LoadImage --section built-in-nodes -n 3
   ```
2. **Read the page** that answers it. `page` accepts a full URL or the path part.
   Use `--grep` to pull only the matching lines from a long page instead of
   dumping all of it into context.
   ```bash
   node "$S" page development/comfyui-server/comms_routes --grep history
   node "$S" page https://docs.comfy.org/development/comfyui-server/comms_messages
   ```
3. **Cite the URL** in your answer so the user can open it.

`index` prints the site map (`llms.txt`) with one line per page; filter it to
browse a topic when you don't know the right search terms yet:
`node "$S" index "custom node"`.

## Section prefixes for `--section`

`development` (server API, cloud, frontend), `development/comfyui-server`
(routes, messages, execution model), `built-in-nodes` (~1000 node reference
pages), `custom-nodes`, `tutorials`, `api-reference`, `registry`, `interface`,
`installation`, `support`.

## Pages that matter most for this repo

| Topic                                   | Path                                           |
| --------------------------------------- | ---------------------------------------------- |
| HTTP + WebSocket routes (`/prompt`, `/queue`, `/history`, `/upload/image`, `/view`) | `development/comfyui-server/comms_routes` |
| WebSocket message types (`progress`, `executing`, `execution_error`) | `development/comfyui-server/comms_messages` |
| End-to-end API client examples          | `development/comfyui-server/api-examples`      |
| Execution model / caching               | `development/comfyui-server/execution_model_inversion_guide` |
| A built-in node, e.g. LoadImage         | `built-in-nodes/LoadImage`                     |

## Notes

* Scores are heuristic (title hit 12, URL hit 6, body hits capped at 25 per
  term, ×2 when every term appears). Node reference pages are AI-generated and
  numerous, so add `--section development` when you want the server/API docs
  rather than node pages.
* `--refresh` re-downloads the 9 MB dump; only needed if a page seems stale.
* If the network is down, `search`/`index` still work from the cache; `page`
  does not. Fall back to `search` snippets in that case.
* The docs source is https://github.com/Comfy-Org/docs if a page needs
  history or a diff.
