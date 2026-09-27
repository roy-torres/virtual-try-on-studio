---
name: laws-of-ux
description: Search and read Laws of UX (https://lawsofux.com) — Jon Yablonski's reference of psychology principles for interface design (Hick's, Fitts's, Jakob's, Miller's, Tesler's, Postel's, Parkinson's laws; Gestalt laws of proximity/similarity/common region; Doherty Threshold, Peak-End Rule, Zeigarnik and Von Restorff effects, Aesthetic-Usability, Choice Overload, Cognitive Load, Goal-Gradient, Serial Position, Occam's Razor, Pareto). Use when justifying a UX/UI decision with a named principle, asked "which law applies here", reviewing a design for usability, or asked what a specific UX law says, its takeaways, origins, or further reading.
---

# Laws of UX

`scripts/lawsofux.js` keeps an offline copy of every law page and article on
lawsofux.com (30 laws + 8 articles, HTML stripped to headings/paragraphs/bullets,
external links kept, cached 7 days in `~/.cache/lawsofux/corpus.json`). Node
stdlib only. Run from the project root:

```bash
S=".claude/skills/laws-of-ux/scripts/lawsofux.js"

node "$S" list [filter]                                     # every law with its one-line definition
node "$S" search <terms...> [-n 6] [--refresh]              # keyword search across full text
node "$S" law <name-or-url> [--section takeaways|examples|origins|"further reading"]
```

## Workflow

**"Which law applies to my situation?"** — run `list` (about 1.5 KB) and match
the situation to a definition yourself; keyword search is a poor fit for that
kind of question. Then read the winner's takeaways:

```bash
node "$S" list
node "$S" law "jakob's law" --section takeaways
```

**"What does X law say?"** — go straight to `law`. Names are matched
case-, apostrophe- and accent-insensitively (`hicks law`, `pragnanz`, `fitts`
all work); a URL or path also works. `--section` returns just one heading.

```bash
node "$S" law "peak-end rule"
node "$S" law millers --section origins
node "$S" law https://lawsofux.com/doherty-threshold/ --section "further reading"
```

**Specific terms** (`400ms`, `gestalt`, `progressive disclosure`, a person's
name) — use `search`. Results show title, kind (law/article), URL, definition,
and matching lines. Quote a phrase to keep it together.

```bash
node "$S" search gestalt grouping
node "$S" search "working memory" chunk
```

Always cite the page URL in your answer; the site is the canonical, attributable
source (CC BY-NC-ND, Jon Yablonski).

## Page anatomy

Every law page has the same headings, which is what `--section` matches:
`Takeaways` (the actionable bullets — usually the part to quote), `Examples`
(real products), `Origins` (who/when, with source link), `Further Reading`
(titles + external URLs), `Related` (three neighbouring laws). Articles are
long-form essays (Tesler's Law, Familiar vs Novel, Peak-End Rule, etc.) and
have free-form headings.

## Notes

* Ranking is heuristic (title 15, definition 8, body hits capped at 6 per
  term, ×2 when every term matches, ×1.5 for law pages). Common stopwords are
  dropped from queries.
* `--refresh` rebuilds the corpus (~45 requests, a few seconds). The site
  changes rarely; only needed if a law seems missing.
* Offline: `list`/`search`/`law` all work from the cache; if the cache is
  missing and the network is down, nothing works.
* The site also serves markdown via `Accept: text/markdown` at every URL and
  publishes `/llms.txt`; the script uses the former as a fallback if the HTML
  layout changes. `curl -sH 'Accept: text/markdown' https://lawsofux.com/hicks-law/`
  is a quick manual check.
