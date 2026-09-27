#!/usr/bin/env node
// Stop hook: append a one-entry summary of the finished turn to .claude/logs/session-log.md
//
// Input arrives as JSON on stdin (session_id, cwd, transcript_path,
// last_assistant_message, ...). The final assistant text is taken from
// last_assistant_message because the transcript file lags at Stop time; every-
// thing else (the prompt, the tool calls) is read back from the transcript.
//
// Always exits 0 and prints nothing: a logging hook must never block a turn.

const fs = require("fs");
const path = require("path");

const MAX_PROMPT = 600;
const MAX_SUMMARY = 2000;
const MAX_LIST = 12; // files / commands listed per entry

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function clip(text, max) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + ` … [+${s.length - max} chars]` : s;
}

// Tool calls made since the last real user prompt in the transcript.
function readTurn(transcriptPath, cwd) {
  const turn = { prompt: "", tools: new Map(), files: [], commands: [] };
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
        turn.commands.push(clip(input.command.replace(/\s+/g, " "), 120));
      }
    }
  }
  return turn;
}

function main() {
  const input = readStdin();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const turn = readTurn(input.transcript_path, cwd);

  const tools = [...turn.tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} x${n}` : name))
    .join(", ");

  const stamp = new Date().toLocaleString("sv-SE"); // 2026-09-09 11:42:13, local time
  const out = [`## ${stamp} — session ${String(input.session_id || "unknown").slice(0, 8)}`, ""];

  if (turn.prompt) out.push(`**Prompt:** ${clip(turn.prompt, MAX_PROMPT)}`, "");
  if (tools) out.push(`**Tools:** ${tools}`, "");
  if (turn.files.length) {
    out.push(`**Files changed:** ${turn.files.slice(0, MAX_LIST).join(", ")}` +
      (turn.files.length > MAX_LIST ? ` (+${turn.files.length - MAX_LIST} more)` : ""), "");
  }
  if (turn.commands.length) {
    out.push("**Commands:**", ...turn.commands.slice(0, MAX_LIST).map((c) => `- \`${c}\``));
    if (turn.commands.length > MAX_LIST) out.push(`- (+${turn.commands.length - MAX_LIST} more)`);
    out.push("");
  }
  const summary = clip(input.last_assistant_message, MAX_SUMMARY);
  if (summary) out.push("**Result:**", "", summary, "");
  out.push("---", "");

  const logDir = path.join(cwd, ".claude", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "session-log.md"), out.join("\n") + "\n");
}

try {
  main();
} catch {
  // Never fail the turn over logging.
}
process.exit(0);
