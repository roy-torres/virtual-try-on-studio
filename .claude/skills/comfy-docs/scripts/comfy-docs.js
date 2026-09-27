#!/usr/bin/env node
// Search and read https://docs.comfy.org from the terminal. Node stdlib only.
//
//   comfy-docs.js search <terms...> [-n 8] [--section built-in-nodes] [--refresh]
//   comfy-docs.js page <url-or-path> [--grep <term>]
//   comfy-docs.js index [filter]
//
// The docs are Mintlify-hosted, which gives us three free things:
//   /llms.txt        every page with a one-line description (the index)
//   /llms-full.txt   every English page as markdown in one ~9MB file
//   <any page>.md    a single page as markdown
// `search` ranks pages from a cached llms-full.txt; `page` fetches one page live.

const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = "https://docs.comfy.org";
const CACHE_DIR = path.join(os.homedir(), ".cache", "comfy-docs");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const opts = { n: 8, section: null, refresh: false, grep: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n" || a === "--limit") opts.n = Number(argv[++i]);
    else if (a === "--section" || a === "-s") opts.section = argv[++i];
    else if (a === "--refresh") opts.refresh = true;
    else if (a === "--grep" || a === "-g") opts.grep = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: "text/markdown, text/plain, */*" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// Download a docs file once a day; reuse the cached copy otherwise.
async function cached(name, refresh) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  if (!refresh && fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < CACHE_TTL_MS) return fs.readFileSync(file, "utf8");
  }
  process.stderr.write(`fetching ${BASE}/${name} ...\n`);
  const text = await fetchText(`${BASE}/${name}`);
  fs.writeFileSync(file, text);
  return text;
}

// llms-full.txt is a concatenation of pages, each starting with
// "# Title\nSource: https://docs.comfy.org/<path>\n\n<description>".
function splitPages(full) {
  const pages = [];
  const re = /^# (.+)\nSource: (https:\/\/docs\.comfy\.org\/\S+)\n/gm;
  let m, prev = null;
  while ((m = re.exec(full))) {
    if (prev) prev.body = full.slice(prev.start, m.index);
    prev = { title: m[1].trim(), url: m[2], start: m.index + m[0].length };
    pages.push(prev);
  }
  if (prev) prev.body = full.slice(prev.start);
  return pages;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function score(page, terms) {
  const title = page.title.toLowerCase();
  const url = page.url.toLowerCase();
  const body = page.body.toLowerCase();
  let total = 0, hits = 0;
  for (const t of terms) {
    const re = new RegExp(escapeRe(t), "g");
    const inBody = (body.match(re) || []).length;
    const inTitle = title.includes(t) ? 1 : 0;
    const inUrl = url.includes(t) ? 1 : 0;
    if (inBody || inTitle || inUrl) hits++;
    total += inTitle * 12 + inUrl * 6 + Math.min(inBody, 25);
  }
  // Pages that mention every term outrank pages that hammer one term.
  if (hits === terms.length) total *= 2;
  return hits ? total : 0;
}

function snippets(page, terms, max = 2) {
  const out = [];
  const lines = page.body.split("\n");
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("<") || l.startsWith("```")) continue;
    const low = l.toLowerCase();
    if (terms.some((t) => low.includes(t))) {
      out.push(l.length > 160 ? l.slice(0, 157) + "..." : l);
      if (out.length === max) break;
    }
  }
  return out;
}

async function search(opts) {
  const query = opts.positional.join(" ").trim();
  if (!query) throw new Error("search needs at least one term");
  // "quoted phrases" stay together; everything else splits on whitespace.
  const terms = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) terms.push((m[1] || m[2]).toLowerCase());

  let pages = splitPages(await cached("llms-full.txt", opts.refresh));
  if (opts.section) pages = pages.filter((p) => p.url.startsWith(`${BASE}/${opts.section}`));

  const ranked = pages
    .map((p) => ({ p, s: score(p, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.n);

  if (!ranked.length) {
    console.log(`No pages match: ${terms.join(", ")}`);
    return;
  }
  console.log(`Top ${ranked.length} of ${pages.length} pages for: ${terms.join(", ")}\n`);
  for (const { p, s } of ranked) {
    console.log(`## ${p.title}  (score ${s})`);
    console.log(`   ${p.url}`);
    for (const line of snippets(p, terms)) console.log(`   > ${line}`);
    console.log();
  }
  console.log(`Read one in full:  comfy-docs.js page <url>`);
}

async function page(opts) {
  let target = opts.positional[0];
  if (!target) throw new Error("page needs a URL or a docs path like development/comfyui-server/comms_routes");
  if (!target.startsWith("http")) target = `${BASE}/${target.replace(/^\/+/, "")}`;
  target = target.replace(/\.md$/, "") + ".md";
  const text = await fetchText(target);
  if (opts.grep) {
    const re = new RegExp(escapeRe(opts.grep), "i");
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (re.test(l)) console.log(`${i + 1}: ${l}`);
    });
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

async function index(opts) {
  const text = await cached("llms.txt", opts.refresh);
  const filter = opts.positional.join(" ").toLowerCase();
  const lines = text.split("\n").filter((l) => !filter || l.toLowerCase().includes(filter));
  console.log(lines.join("\n"));
}

const usage = `usage:
  comfy-docs.js search <terms...> [-n 8] [--section <path-prefix>] [--refresh]
  comfy-docs.js page <url-or-path> [--grep <term>]
  comfy-docs.js index [filter] [--refresh]`;

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const handlers = { search, page, index };
  if (!handlers[cmd]) {
    console.error(usage);
    process.exit(cmd ? 1 : 0);
  }
  await handlers[cmd](opts);
})().catch((err) => {
  console.error(`comfy-docs: ${err.message}`);
  process.exit(1);
});
