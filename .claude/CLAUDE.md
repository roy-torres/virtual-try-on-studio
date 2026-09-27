# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-dependency browser frontend ("Virtual Try-On Studio") for a single ComfyUI
workflow: **Flux.2 Klein image-edit 4B distilled**. Upload a SUBJECT image and an
ATTRIBUTE image, type a prompt, and the app queues the workflow on a locally running
ComfyUI and displays the result.

There is no package.json, no build step, no test suite, and no dependencies — just
`server.js` (Node stdlib only) and one self-contained `public/index.html`.

## Commands

```bash
node server.js            # start on http://localhost:5173
node --check server.js    # syntax-check after editing (there are no tests)

PORT=5173 COMFY_HOST=127.0.0.1 COMFY_PORT=8188 node server.js   # env knobs
```

Sanity checks while debugging:

```bash
curl -s http://127.0.0.1:8188/system_stats | jq .   # is ComfyUI up?
curl -s http://127.0.0.1:5173/comfy/system_stats    # is the proxy working?
curl -s http://127.0.0.1:8188/queue | jq .          # what is running/pending
lsof -i :5173 -i :8188                              # who holds the ports
```

Editing `public/index.html` needs no restart (files are read per request); editing
`server.js` does.

## Architecture

**`server.js`** — one `http.createServer` with three jobs, in this order:

1. Anything under `/comfy/*` is proxied to ComfyUI. It rewrites `Host`, `Origin`,
   and `Referer` to look local, because ComfyUI rejects cross-origin requests as
   DNS-rebinding protection. Removing that rewrite breaks the app.
2. `server.on("upgrade")` hand-rolls a websocket proxy for `/comfy/ws` by writing
   the HTTP upgrade request bytes onto a raw `net` socket and piping both ways.
   No `ws` library — keep it dependency-free.
3. Everything else is a static file from `public/`, path-normalized and confined to
   `PUBLIC_DIR`.

**`public/index.html`** — the whole app: markup, CSS, and JS in one file. The
generation flow is:

1. `POST /comfy/upload/image` for both files → ComfyUI returns server-side filenames.
2. Fetch `/workflow.api.json`, deep-clone it, and patch node inputs (see the node map
   below). A fresh random `noise_seed` per run.
3. `POST /comfy/prompt` with `{prompt, client_id}` → `prompt_id`.
4. Progress comes over the websocket (`progress`, `executing`, `execution_error`),
   filtered by `prompt_id`.
5. `waitForResult` polls `/comfy/history/<id>` for the finished image, and falls back
   to `/comfy/queue` for liveness. Deliberately no short timeout: CPU-mode runs take
   ~11 minutes, so it waits as long as the job is alive in the queue, with a 90s idle
   grace window and a 2h hard cap. Do not "fix" this into a fixed timeout.
6. The result is rendered from `/comfy/view?filename=…&subfolder=…&type=output`.

The websocket is only for progress UI; the image always arrives via history polling.

## Workflow node contract

`public/index.html` hardcodes node IDs that must match `public/workflow.api.json`:

| Constant / slot     | Node ID  | Class            | Patched with        |
| ------------------- | -------- | ---------------- | ------------------- |
| `slots.subject`     | `76`     | LoadImage        | uploaded filename   |
| `slots.attribute`   | `81`     | LoadImage        | uploaded filename   |
| `PROMPT_NODE`       | `92:109` | CLIPTextEncode   | `inputs.text`       |
| `SEED_NODE`         | `92:106` | RandomNoise      | `inputs.noise_seed` |
| `SAVE_NODE`         | `94`     | SaveImage        | read for the result |

Colon-containing IDs (`92:109`) come from a ComfyUI subgraph — they are literal
string keys, not nesting.

**If you re-export the workflow from ComfyUI (API format), re-check those five IDs
and update the constants.** `public/workflow.api.json` is the only copy the app
loads; the two JSON files in the repo root are byte-identical spares.

## Local model / hardware constraint

The workflow loads fp8 weights (`flux-2-klein-4b-fp8.safetensors`, CLIP
`qwen_3_4b.safetensors`, 4 steps, cfg 1). fp8 has no MPS dtype support, so on this
Apple Silicon machine ComfyUI is run with `--cpu` (~11 min/image). Launch args live in
`~/Library/Application Support/Comfy Desktop/installations.json`. The frontend does
not work around this — it surfaces whatever error ComfyUI returns. The faster fix is
the GGUF route (swap node `92:107` `UNETLoader` → `UnetLoaderGGUF`), not a frontend
change.

ComfyUI install: `/Users/roy/ComfyUI-Installs/Roy/ComfyUI`; outputs in
`/Users/roy/ComfyUI-Shared/output/`; logs at
`/Users/roy/ComfyUI-Installs/Roy/logs/comfyui.log`.

## Hooks (Claude Code automation)

Two vendored copies of the official Claude Code hooks docs live in the repo root.
They total ~400KB — **never read either one whole.** Grep or `sed -n` the section
you need:

| File                   | Lines | What it is                                                                                  |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------- |
| `hooks docs start.md`  | ~1.1k | The guide: first hook walkthrough, copy-paste recipes, troubleshooting                       |
| `hook docs.md`         | ~3.8k | The reference: full event list, input/output schemas, matcher rules, async/prompt/agent hooks |

```bash
grep -n '^#\{2,3\} ' "hook docs.md"          # section index with line numbers
sed -n '1540,1820p' "hook docs.md"           # e.g. the whole PreToolUse section
```

Every event in the reference is a `### <EventName>` heading, so
`grep -n '^### Stop' "hook docs.md"` jumps straight to it.

### Where hooks go here

`.claude/settings.json` (shared with the project) or `.claude/settings.local.json`
(machine-local, already holds the local permission grants). `~/.claude/settings.json`
applies to every project. Entries **merge** across levels rather than replacing each
other. The `/hooks` menu is read-only — edit the JSON.

### Config shape

Three levels: event → matcher group → handlers. All matching handlers run in parallel.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "…", "timeout": 30 }]
      }
    ]
  }
}
```

Handler types: `command` (shell; JSON input on stdin), `http` (POST to a URL),
`mcp_tool`, `prompt` (single-turn model call), `agent` (subagent, experimental).
Useful handler fields: `if` (permission-rule filter like `"Edit(server.js)"`, tool
events only), `timeout` (default 600s for command; 30s on `UserPromptSubmit`),
`async` / `asyncRewake` (background), `args` (exec form — no shell, use it whenever
the command contains a path).

### Events worth knowing for this repo

| Event              | Fires                                            |
| ------------------ | ------------------------------------------------ |
| `SessionStart`     | session begins or resumes; stdout becomes context |
| `UserPromptSubmit` | before a prompt is processed; stdout becomes context; can block |
| `PreToolUse`       | before a tool call; can block it                 |
| `PostToolUse`      | after a tool call succeeds                       |
| `Notification`     | Claude needs input (matchers: `permission_prompt`, `idle_prompt`, …) |
| `Stop`             | Claude finishes responding                       |
| `FileChanged`      | a watched file changes on disk (`matcher` = the filenames) |
| `SessionEnd`       | session terminates (hooks share a ~1.5s budget)  |

Full table at `hook docs.md:38`.

### Matchers

`""` / `"*"` / omitted matches everything. A value of only letters, digits, `_`,
`-`, spaces, `,`, `|` is exact-match or a `|`/`,` list (`Edit|Write`). Anything else
is an **unanchored** JS regex — `Edit.*` also matches `NotebookEdit`, so write
`^Edit$` when you mean one tool.

### Exit codes and output

* **0** — success. stdout is shown to Claude only on `UserPromptSubmit`,
  `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`; everywhere else it
  goes to the debug log. stderr is never shown on 0.
* **2** — blocking error. `PreToolUse` blocks the tool, `UserPromptSubmit` rejects
  the prompt. The message is your stderr (or the JSON `reason`). JSON cannot
  override an exit-2 block.
* Other codes — non-blocking; the action proceeds.

For structured control, exit 0 and print one JSON object to stdout: `continue`,
`stopReason`, `systemMessage`, `terminalSequence` (desktop notification / bell —
hooks have no `/dev/tty`), plus per-event `decision`/`reason` and
`hookSpecificOutput`. Output strings cap at 10,000 chars. Pick exit codes *or*
JSON per hook, not both.

### Configured hooks

One is live, in `.claude/settings.json`:

* `Stop` → `/usr/bin/env node ${CLAUDE_PROJECT_DIR}/.claude/hooks/log-turn.js`
  (exec form, because the project path contains spaces). It appends one Markdown
  entry per finished turn to `.claude/logs/session-log.md`: timestamp, session id,
  the prompt, a tool tally, files written, bash commands, and Claude's closing
  message. The final message comes from the hook input's `last_assistant_message`
  (the transcript lags at Stop time); everything else is parsed back out of
  `transcript_path`. It always exits 0 and prints nothing, so it can never block
  or fail a turn. Delete the log file any time — it is recreated on the next stop.

### Other hook ideas that fit this project

Natural candidates, in rough order of value:

* `PostToolUse` on `Edit|Write` with `if: "Edit(server.js)"` → `node --check
  server.js`, exit 2 on failure so a syntax error comes straight back to Claude.
  Editing `server.js` also needs a server restart; `public/index.html` does not.
* `PostToolUse` on writes to `public/workflow.api.json` → assert the five contract
  node IDs (`76`, `81`, `92:109`, `92:106`, `94`) still exist, since a re-export
  silently breaks the frontend.
* `Notification` with matcher `permission_prompt` → `osascript -e 'display
  notification …'`, worthwhile because CPU-mode runs take ~11 minutes and the
  terminal is not being watched.
* `Stop` → same notification, for the end of a long generation.
* `SessionStart` → `curl -s http://127.0.0.1:8188/system_stats` and print whether
  ComfyUI is up, so the state is known before any debugging starts.

### Gotchas

Handlers run in the current directory with Claude Code's environment. A shell
profile that prints anything on startup corrupts JSON stdout parsing. Hooks also
fire inside subagents. Debug with `claude --debug` and check the `/hooks` menu to
confirm a hook is registered; troubleshooting is at `hooks docs start.md:946`.
