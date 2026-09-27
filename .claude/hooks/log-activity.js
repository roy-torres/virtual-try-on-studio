#!/usr/bin/env node
// Stop hook: append one plain-text line per finished turn to .claude/logs/activity.log
//
// The greppable companion to log-turn.js (which writes the Markdown session log).
// One turn = one line, tab-separated fields:
//
//   2026-09-09 11:43:12  a1b2c3d4  12.4s  Bash x3, Edit  files: server.js  cmd: node --check server.js  prompt: add a second hook
//
// Same contract as the other Stop hook: reads JSON on stdin, prints nothing,
// always exits 0 so logging can never block or fail a turn.

const fs = require("fs");
const path = require("path");

const MAX_PROMPT = 160;
const MAX_CMD = 100;
const MAX_LIST = 6; // files / commands listed per line

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

// One line, so every field is collapsed to single spaces and clipped short.
function clip(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Tool calls made since the last real user prompt in the transcript.
function readTurn(transcriptPath, cwd) {
  const turn = { prompt: "", tools: new Map(), files: [], commands: [], startedAt: 0 };
  if (!transcriptPath) return turn;

  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return turn;
  }

  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* partial write at the tail of the file */
    }
  }

  // A user prompt is a "user" entry whose content is a plain string; tool
  // results are "user" entries whose content is an array.
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "user" && typeof e.message?.content === "string" && !e.isMeta) {
      turn.prompt = e.message.content;
      turn.startedAt = Date.parse(e.timestamp) || 0;
      start = i;
      break;
    }
  }

  const seenFiles = new Set();
  for (const e of entries.slice(start)) {
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block.type !== "tool_use") continue;
      turn.tools.set(block.name, (turn.tools.get(block.name) || 0) + 1);

      const input = block.input || {};
      const file = input.file_path || input.notebook_path;
      if (file && /^(Edit|Write|NotebookEdit)$/.test(block.name)) {
        const rel = cwd && file.startsWith(cwd) ? path.relative(cwd, file) : file;
        if (!seenFiles.has(rel)) {
          seenFiles.add(rel);
          turn.files.push(rel);
        }
      }
      if (block.name === "Bash" && input.command) {
        turn.commands.push(clip(input.command, MAX_CMD));
      }
    }
  }
  return turn;
}

function list(label, items) {
  if (!items.length) return "";
  const shown = items.slice(0, MAX_LIST).join(" | ");
  const rest = items.length > MAX_LIST ? " +" + (items.length - MAX_LIST) : "";
  return label + ": " + shown + rest;
}

function main() {
  const input = readStdin();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const turn = readTurn(input.transcript_path, cwd);

  const tools = [...turn.tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? name + " x" + n : name))
    .join(", ");

  const stamp = new Date().toLocaleString("sv-SE"); // 2026-09-09 11:42:13, local time
  const elapsed = turn.startedAt ? ((Date.now() - turn.startedAt) / 1000).toFixed(1) + "s" : "-";

  const fields = [
    stamp,
    String(input.session_id || "unknown").slice(0, 8),
    elapsed,
    tools || "no tools",
    list("files", turn.files),
    list("cmd", turn.commands),
    turn.prompt ? "prompt: " + clip(turn.prompt, MAX_PROMPT) : "",
  ].filter(Boolean);

  const logDir = path.join(cwd, ".claude", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "activity.log"), fields.join("\t") + "\n");
}

try {
  main();
} catch {
  // Never fail the turn over logging.
}
process.exit(0);
