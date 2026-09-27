#!/usr/bin/env node
// Search and read https://lawsofux.com from the terminal. Node stdlib only.
//
//   lawsofux.js search <terms...> [-n 6] [--refresh]
//   lawsofux.js law <name-or-url> [--section takeaways|origins|"further reading"|examples]
//   lawsofux.js list [filter]
//
// The site is a Hugo build with no markdown endpoint, so this script builds its
// own corpus: the law list from /llms.txt (URL + one-line definition) plus the
// article list from /en/sitemap.xml, then fetches every page once, strips the
// HTML down to headings/paragraphs/bullets, and caches the lot as JSON in
// ~/.cache/lawsofux/ for 7 days. Roughly 45 pages, a few seconds to build.

const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = "https://lawsofux.com";
const CACHE_DIR = path.join(os.homedir(), ".cache", "lawsofux");
const CACHE_FILE = path.join(CACHE_DIR, "corpus.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;

function parseArgs(argv) {
  const opts = { n: 6, refresh: false, section: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n" || a === "--limit") opts.n = Number(argv[++i]);
    else if (a === "--refresh") opts.refresh = true;
    else if (a === "--section" || a === "-s") opts.section = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "lawsofux-skill/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// ---- HTML -> plain text -----------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? m);
}

// Keep the reading order of <main>, turn block tags into line breaks and
// headings/list items into markdown, drop everything else.
function htmlToText(html) {
  let s = html;
  const main = s.match(/<main[\s\S]*?<\/main>/i);
  if (main) s = main[0];
  s = s
    .replace(/<(script|style|svg|noscript|picture|figure)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<ul id=lang-list[\s\S]*?<\/ul>/i, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${"#".repeat(Number(l))} ${t}\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|ul|ol|div|section|article|blockquote|tr|dd|dt|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Keep external links visible: "text (url)". Internal nav links lose the href.
    .replace(/<a\b[^>]*href=["']?(https?:\/\/(?!lawsofux\.com)[^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "");
  s = decode(s)
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Drop the poster-shop links and the Next/Previous footer nav after "Related".
  s = s.replace(/^(Buy Large Format Poster|Download free poster.*|\(https:\/\/jonyablonski\.bigcartel\.com[^)]*\))$/gm, "");
  const nav = s.search(/^(Next|Previous)$/m);
  if (nav !== -1) s = s.slice(0, nav);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// ---- Corpus -----------------------------------------------------------------

function parseLlms(txt) {
  const laws = [];
  // Only the "## Laws" section; "## More" holds contact/privacy/book pages.
  const section = txt.match(/^## Laws\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  txt = section ? section[1] : txt;
  for (const m of txt.matchAll(/^- \[([^\]]+)\]\((https:\/\/lawsofux\.com\/[^)]+)\):\s*(.+)$/gm)) {
    laws.push({ title: m[1].trim(), url: m[2], summary: m[3].trim(), kind: "law" });
  }
  return laws;
}

function parseSitemapArticles(xml) {
  const urls = [...xml.matchAll(/<loc>(https:\/\/lawsofux\.com\/articles\/\d{4}\/[^<]+)<\/loc>/g)].map((m) => m[1]);
  return urls.map((url) => ({ title: null, url, summary: "", kind: "article" }));
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); }
  }));
  return out;
}

async function buildCorpus() {
  process.stderr.write(`building corpus from ${BASE} ...\n`);
  const [llms, sitemap] = await Promise.all([fetchText(`${BASE}/llms.txt`), fetchText(`${BASE}/en/sitemap.xml`)]);
  const entries = [...parseLlms(llms), ...parseSitemapArticles(sitemap)];
  const pages = await pool(entries, async (e) => {
    try {
      let text = htmlToText(await fetchText(e.url));
      // The site also serves markdown via content negotiation (see /llms.txt).
      // Its "Further Reading" loses the links, so it is only the fallback for
      // when the HTML layout changes under us.
      if (text.length < 300 || !/^## /m.test(text)) {
        const res = await fetch(e.url, { headers: { Accept: "text/markdown" } });
        if (res.ok) text = (await res.text()).trim();
      }
      const h1 = text.match(/^# (.+)$/m);
      return { ...e, title: e.title || (h1 ? h1[1] : e.url), text };
    } catch (err) {
      process.stderr.write(`  skip ${e.url}: ${err.message}\n`);
      return null;
    }
  });
  const corpus = { builtAt: new Date().toISOString(), pages: pages.filter(Boolean) };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(corpus));
  process.stderr.write(`cached ${corpus.pages.length} pages -> ${CACHE_FILE}\n`);
  return corpus;
}

async function loadCorpus(refresh) {
  if (!refresh && fs.existsSync(CACHE_FILE)) {
    const age = Date.now() - fs.statSync(CACHE_FILE).mtimeMs;
    if (age < CACHE_TTL_MS) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  }
  try {
    return await buildCorpus();
  } catch (err) {
    if (fs.existsSync(CACHE_FILE)) {
      process.stderr.write(`refresh failed (${err.message}); using stale cache\n`);
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
    throw err;
  }
}

// ---- Commands ---------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Curly apostrophes and accents on the site (Hick’s, Prägnanz) vs what gets
// typed at a terminal (hick's, pragnanz).
const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "for", "and", "or", "is", "are", "with", "on", "too", "how", "why", "what", "do", "does", "should", "my", "it"]);

function score(page, terms) {
  const title = norm(page.title), summary = norm(page.summary), body = norm(page.text);
  let total = 0, hits = 0;
  for (const t of terms) {
    const inBody = (body.match(new RegExp(escapeRe(t), "g")) || []).length;
    const inTitle = title.includes(t) ? 1 : 0;
    const inSummary = summary.includes(t) ? 1 : 0;
    if (inBody || inTitle || inSummary) hits++;
    // Body hits are capped low so the long articles don't drown out the laws.
    total += inTitle * 15 + inSummary * 8 + Math.min(inBody, 6);
  }
  if (hits === terms.length) total *= 2;
  if (page.kind === "law") total = Math.round(total * 1.5);
  return hits ? total : 0;
}

function snippets(page, terms, max = 2) {
  const out = [];
  for (const raw of page.text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || l === page.summary || out.includes(l)) continue;
    if (terms.some((t) => norm(l).includes(t))) {
      out.push(l.length > 170 ? l.slice(0, 167) + "..." : l);
      if (out.length === max) break;
    }
  }
  return out;
}

async function search(opts) {
  const query = opts.positional.join(" ").trim();
  if (!query) throw new Error("search needs at least one term");
  let terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => norm(m[1] || m[2]));
  const kept = terms.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (kept.length) terms = kept;
  const { pages } = await loadCorpus(opts.refresh);
  const ranked = pages
    .map((p) => ({ p, s: score(p, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.n);
  if (!ranked.length) return console.log(`No pages match: ${terms.join(", ")}`);
  console.log(`Top ${ranked.length} of ${pages.length} pages for: ${terms.join(", ")}\n`);
  for (const { p, s } of ranked) {
    console.log(`## ${p.title}  [${p.kind}, score ${s}]`);
    console.log(`   ${p.url}`);
    if (p.summary) console.log(`   ${p.summary}`);
    for (const line of snippets(p, terms)) console.log(`   > ${line}`);
    console.log();
  }
  console.log(`Read one in full:  lawsofux.js law "<name>"   (add --section takeaways to trim)`);
}

function pickSection(text, name) {
  const lines = text.split("\n");
  const want = norm(name);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) (.+)$/);
    if (!m) continue;
    if (start === -1 && norm(m[2]).includes(want)) { start = i; level = m[1].length; continue; }
    if (start !== -1 && m[1].length <= level) return lines.slice(start, i).join("\n");
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}

async function law(opts) {
  const q = opts.positional.join(" ").trim();
  if (!q) throw new Error('law needs a name or URL, e.g. law "hick\'s law"');
  const { pages } = await loadCorpus(opts.refresh);
  const nq = norm(q);
  let page = pages.find((p) => p.url === q || p.url === q.replace(/\/?$/, "/"))
    || pages.find((p) => norm(p.title) === nq)
    || pages.find((p) => norm(p.title).includes(nq))
    || pages.find((p) => p.url.toLowerCase().includes(nq.replace(/['\s]+/g, "-")));
  if (!page) {
    const near = pages.filter((p) => nq.split(/\s+/).some((t) => norm(p.title).includes(t))).map((p) => p.title);
    throw new Error(`no law matches "${q}"` + (near.length ? `. Did you mean: ${near.join(", ")}` : ""));
  }
  let body = page.text;
  if (opts.section) {
    body = pickSection(body, opts.section);
    if (body === null) throw new Error(`no section "${opts.section}" on ${page.title}`);
  }
  console.log(`Source: ${page.url}\n`);
  console.log(body);
}

async function list(opts) {
  const { pages } = await loadCorpus(opts.refresh);
  const filter = norm(opts.positional.join(" "));
  for (const p of pages) {
    const line = `${p.kind === "law" ? "law     " : "article "} ${p.title}  ${p.url}${p.summary ? `\n         ${p.summary}` : ""}`;
    if (!filter || norm(line).includes(filter)) console.log(line);
  }
}

const usage = `usage:
  lawsofux.js search <terms...> [-n 6] [--refresh]
  lawsofux.js law <name-or-url> [--section takeaways|examples|origins|"further reading"]
  lawsofux.js list [filter] [--refresh]`;

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const handlers = { search, law, list };
  if (!handlers[cmd]) { console.error(usage); process.exit(cmd ? 1 : 0); }
  await handlers[cmd](opts);
})().catch((err) => { console.error(`lawsofux: ${err.message}`); process.exit(1); });
