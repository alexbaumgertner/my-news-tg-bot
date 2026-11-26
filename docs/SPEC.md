# Specification: personal news digest bot

Owner: Aleksandr Baumgertner · Created: 2026-11-26 · Status: Phase 0

## 1. Goal and principles

Twice a day the bot sends me a Telegram digest of world news selected for my career, projects, learning and life plans. The question it answers is not "what happened in the world" but "what changed in the areas where I work, learn and make decisions". News that is disturbing but has no effect on my life does not get in.

This is a tool for one user (me). General-purpose features are out of scope unless they are cheap and do not get in the way.

**Selection principles**

- **Relevance over urgency.** An item is included only if it affects my work, projects, learning, health or life plans.
- **"Why this matters to me".** Every item has a one-line link to my context and a link to the primary source.
- **Primary sources first.** Lab blogs, journals, ministries and EU institutions rank above aggregators and media.
- **Few but dense.** Morning: up to 7 items. Evening: up to 5. Skipping an item is better than padding the digest.
- **No Russian domestic agenda.** Russian domestic politics is excluded. Russian-language sources are allowed when they cover world topics.
- **One story = one item.** Coverage of the same event from many sources is merged into one item that links to the best source.
- **No fabrication.** Summaries contain only facts from the source. Science and medicine items state the study type: animal study, clinical trial (with phase), meta-analysis and so on.

## 2. Interest profile

The profile lives in `config/profile.yaml`. Each topic has a weight, keywords, stop words and a natural-language description for the LLM. The bot never edits the profile on its own; it proposes changes (see §7).

| Topic | Weight | What to catch |
|---|---|---|
| Agentic AI development | High | New models (Anthropic, OpenAI, Google, open-weights), Claude Code and agent tooling, MCP, agentic development practices, engineering-process manifestos |
| Learning science and education | High | Research on memory and learning, neuroscience, EdTech launches, universities and programs, language-learning technology. Feeds the easy-deep-learning portal and Sprachweise |
| Medicine and biology | High | HHT: clinical trials, new drugs, guidelines, conferences. More broadly: genetics, vascular medicine, major breakthroughs that have a publication behind them |
| Web stack | Medium | Releases and vulnerabilities in Next.js, React, Node.js, TypeScript, Vercel, Payload CMS, Neon, Postgres; Chrome extensions (Manifest V3, Chrome Web Store policy) |
| Indie hacking and product | Medium | Solo-founder cases, especially in EdTech; monetization of small SaaS; platforms and fees |
| IT job market | Medium | How AI changes hiring and developer roles; large IT service companies; remote work |
| Life and relocation | Medium | Turkey: work and residence permits, taxes, TRY exchange rate (briefly). EU: Blue Card, talent and entrepreneur visas, Germany in particular. Georgia: rules for individual entrepreneurs |
| Economy | Low | Only what affects income or costs: USD/TRY, tariffs and regulation that hit the IT market |
| Sport | Low | Training research; major volleyball tournaments (one line) |

**Hard exclusions:** Russian domestic politics, crime, disasters and conflicts with no direct effect on me, celebrity news, crypto hype, clickbait.

**Exception:** events that directly affect safety or daily life in Turkey and Antalya always get through, as a separate line.

## 3. Sources

Each source is defined in `config/sources.yaml` with these fields:

- `id`, `type`, `url`, `language`, `topics`
- `trust` (1–5)
- `poll_interval`
- `active`

The list below is a starting point. In Phase 0 each entry is checked to see whether it has RSS or an API or needs page parsing.

| Type | How it is read | Starting examples |
|---|---|---|
| Company and lab blogs | RSS/Atom, else page parsing | Anthropic, OpenAI, Google DeepMind, Hugging Face, GitHub Changelog, Vercel, Next.js, Node.js releases, Simon Willison |
| Science | Public APIs | arXiv (cs.AI, cs.CL, cs.HC), PubMed E-utilities (HHT, learning, memory), ClinicalTrials.gov (HHT), bioRxiv/medRxiv, Nature and Science news feeds |
| Patient and medical organizations | RSS / parsing | Cure HHT, relevant medical associations |
| EU and governments | RSS / parsing + translation | European Commission (Digital, Research & Innovation, Education), CORDIS, AI Act news; Germany: BMBF, DAAD, Make it in Germany; UNESCO and OECD (education); Turkey: official migration and tax sites |
| Publishers | RSS / new-release pages | O'Reilly, Manning, Pragmatic Bookshelf, popular-science publishers; new releases on my topics only |
| Telegram channels (v1) | MTProto, or the public web preview `t.me/s/<channel>` | List provided by me |
| Aggregators (fallback) | API / RSS | Hacker News (score threshold), Techmeme, Google News RSS for key queries |
| Russian-language | RSS | Habr (AI and Frontend hubs), N+1; world topics only |
| German and Turkish | RSS + translation | heise, t3n, Deutschlandfunk (science). Also reading material for German practice |

**Rules**

- If more than 90% of a source's items are rejected for 2 weeks in a row, the bot proposes disabling it.
- Scraping respects `robots.txt` and site terms. Full texts are never forwarded to Telegram: only my own short summary and a link.
- A new source can be added with `/add_source <url>` (v1). The bot detects its type and proposes topics.

## 4. Processing pipeline

1. **Collect.** Runs every 1–3 hours, depending on each source's interval. There is one fetcher per source type behind a common `Fetcher` interface. Output goes to `items`: URL, title, text, published date, source, language.
2. **Normalize.** Extract the full text (Readability), clean it, detect the language, canonicalize the URL.
3. **Deduplicate.**
   - Exact: by URL and text hash.
   - Semantic: by embeddings. Similar items are merged into one story; the threshold is tuned on the golden set, starting near cosine 0.88.
4. **Cheap pre-filter, no LLM.** Profile keywords and stop words, plus embedding similarity to the topic descriptions. Goal: drop most of the noise before any LLM call.
5. **LLM scoring** with a fast, cheap model (Haiku class). Each story gets strict JSON:
   - `topics[]`
   - `relevance` (0–10)
   - `impact`: work, project, learning, health or life
   - `why_me`: one sentence
   - `novelty`, `confidence`
   - `is_russia_domestic`
   - `study_type`, for science
6. **Rank.** `score = relevance × topic weight × source trust × freshness + primary-source bonus`. At most 3 items per topic, so AI news cannot crowd out everything else.
7. **Compose** with a strong model (Sonnet class). Each item gets a headline, 2–3 sentences of substance, a "why this matters to me" line and a link. The text is translated into the output language, plus the learning block (§6).
8. **Deliver.** Format as Telegram HTML, send on schedule, and record what was sent so nothing repeats.
9. **Feedback.** Reactions and buttons are stored in `feedback` and adjust weights (§7).

## 5. Digest format

- **Morning, 07:30** (Europe/Istanbul, configurable): the overnight and 24-hour highlights, up to 7 items.
- **Evening, 20:30:** the day's items, up to 5, plus one long read and the English block.
- Items are grouped by topic. Empty topics are hidden.
- On a quiet day the bot says so ("Quiet day, 2 items"). It never pads the digest to the limit.
- A message must fit Telegram's 4096-character limit. If it does not, it is split by topic.
- **Urgent (v2).** A very high score sends a separate push within an hour, at most once a day. Examples: a new Claude model release, HHT trial results, a change to Turkish work-permit rules.

Example (`ru` mode, shown in English for this doc):

```
☀️ Morning, 27 November · 6 items

🤖 Agentic AI
1. <Headline>
Substance in 2–3 sentences.
→ Why it matters to you: changes your Claude Code workflow.
🔗 Anthropic · EN

🧬 Medicine
2. <Headline> [phase 2]
...

Filtered out: 214 items from 38 sources.
```

Buttons: 👍 · 👎 · More like this · Already knew · More details.

## 6. Languages and English practice

The digest also trains my English from B2 toward C1. This is an example of *context-driven learning*: learning built into reading I do anyway.

- **Language modes** (`/lang`): `ru`, `en`, `mixed`.
- **`mixed`:** item text is in B2–C1 English and the "why it matters" line is in Russian. Each item highlights 1–2 C1 expressions in bold.
- **Evening "Words of the day":** 5 expressions from today's news, each with a translation and the example sentence from the source. There is also one active-use task: I reply with a sentence and the bot checks and corrects it.
- Technical terms are not simplified. Expressions already shown are not repeated (`vocab_seen`).
- **Other source languages** (German, Turkish, French) are translated into the digest language. For German sources, one original sentence can be included, which supports my German toward B2.
- **v2:** export vocabulary to Sprachweise or to CSV for Anki.

## 7. Commands and feedback

| Command | What it does | Stage |
|---|---|---|
| `/start` | Bind the chat, check the whitelist | MVP |
| `/digest` | Build a digest now | MVP |
| `/lang ru\|en\|mixed` | Output language | MVP (`mixed` in v1) |
| `/schedule` | Morning and evening times | MVP |
| `/topics` | Topics and weights | v1 |
| `/mute <topic> <days>` | Mute a topic temporarily | v1 |
| `/sources`, `/add_source <url>` | List and add sources | v1 |
| `/deep <n>` | Deep dive into item n: context, what it means for me | v1 |
| `/search <query>` | Search the archive of collected items | v1 |
| `/stats` | Failing sources, token spend, 👍/👎 ratio | v1 |

**How the bot learns**

- Every reaction is stored and nudges the topic weight and source trust, within fixed bounds.
- Once a week (Sunday) the bot proposes profile changes, for example: "You pressed 'More like this' 5 times on WebGPU items. Add a topic?" The profile changes only after I confirm, and every version is kept (`profile_versions`).
- "Already knew" lowers the trust of aggregators that bring a story late.

**Access:** the bot answers only my Telegram `user_id` (whitelist in `.env`). Everyone else gets silence.

## 8. Architecture and stack

| Component | Choice | Why |
|---|---|---|
| Language | TypeScript, Node.js 22, pnpm | My main stack |
| Telegram bot | grammY | Modern, typed, good plugins |
| Reading Telegram channels (v1) | GramJS (MTProto) or the `t.me/s/` web preview | The Bot API cannot read other channels |
| Parsing | rss-parser, @mozilla/readability + jsdom, fetch with retries | Light dependencies, no headless browser |
| LLM | Anthropic API: Haiku for scoring, Sonnet for writing; a provider adapter | Prompt caching for the profile, Batch API for off-peak scoring |
| Embeddings | Hosted API (Voyage or similar) | Local models are too heavy for 8 GB RAM |
| Database | PostgreSQL + pgvector, Drizzle ORM | One database for rows and vectors |
| Scheduler | systemd timers | Survives reboots |
| Config | `config/profile.yaml`, `config/sources.yaml`, `prompts/*.md` | Profile and prompts are versioned |

**Tables:**

- Content: `sources`, `items`, `stories`, `scores`, `digests`, `digest_items`
- Learning and feedback: `feedback`, `vocab_seen`, `profile_versions`
- Cost tracking: `llm_usage`

Every table has `user_id`.

**Deployment (decided): `home-ubuntu`.**

- The machine already runs, is reachable over Tailscale and has native Postgres.
- It has no limits on long processes or on an MTProto session.
- The bot uses long polling, so no public IP or webhook is needed.
- Risks: home internet and power. These are acceptable for a personal tool.
- Vercel + Neon can be reconsidered if the bot ever becomes a product.

**Budget.**

- Daily and monthly LLM spend limits are set in config; usage is recorded in `llm_usage`.
- Expected volume: 1–3k items a day. A few hundred reach LLM scoring and 15–20 reach composition.
- Set the final ceiling after one week of measurements against current Anthropic pricing.

## 9. Non-functional requirements

- **Reliability.**
  - The digest goes out even if some sources fail.
  - If the LLM is unavailable, a degraded digest (headlines and links from the pre-filter) is sent with a note.
- **Timeliness.** Collection and processing finish 15 minutes before delivery. A digest arrives no more than 5 minutes late.
- **Budget.** Over the daily limit, scoring degrades to high-trust sources only, and the bot reports it.
- **Quality.**
  - No facts that are not in the source.
  - Items with low `confidence` are flagged.
  - Medical items always state the study type and never give treatment advice.
- **Privacy.**
  - The profile, history and reactions stay on my server.
  - Secrets live in `.env`.
  - The MTProto session is stored encrypted.
- **Site rules.** Respect `robots.txt`, poll at sensible intervals and send a custom User-Agent. Telegram gets a summary and a link only.
- **Tests.**
  - Unit tests for scoring, dedup and formatting.
  - Golden set: ~50 items I labeled as keep or drop, used for regression on prompts and thresholds.
- **Extensibility.**
  - A new source type is a new `Fetcher` implementation, with no pipeline changes.
  - `user_id` is on every table from day one.
- **Resources.** Under ~500 MB of RSS on a shared 8 GB machine.
- **Observability.** Structured logs (pino). Failing sources and spend are visible in `/stats` (v1) and in the logs.

## 10. Milestones and acceptance criteria

**Phase 0 — Preparation**

- Write `profile.yaml`.
- Collect and verify `sources.yaml` (~30 sources).
- Label the golden set.
- Prepare home-ubuntu and the API accounts.
- Resolve the open questions in §11.

**MVP (one sprint, about a week)**

- Sources: RSS/Atom, arXiv, PubMed, Hacker News.
- The full pipeline: dedup, pre-filter, scoring, ranking, composition.
- Morning and evening digests in `ru` and `en`.
- 👍/👎 buttons.
- Commands: `/start`, `/digest`, `/lang`, `/schedule`.
- Deployed on home-ubuntu with an install guide.

**v1 (2–3 weeks)**

- Sources: Telegram channels, EU and German government sites with translation, ClinicalTrials.gov.
- `mixed` mode with vocabulary.
- Commands: `/deep`, `/search`, `/topics`, `/mute`, `/sources`, `/add_source`, `/stats`.
- Weekly profile tuning.

**v2**

- Urgent pushes.
- Vocabulary export to Sprachweise and Anki.
- A web archive and a weekly long read.
- Feeds for the easy-deep-learning portal (EdTech) and the HHT research platform (new research).

**MVP acceptance criteria** (checked over 14 days of operation)

- [ ] Digests arrive on time in at least 95% of slots.
- [ ] 👎 is below 20% of rated items.
- [ ] Zero items on Russian domestic politics and zero duplicate stories.
- [ ] Every item has a working source link and a "why it matters to me" line.
- [ ] LLM spend stays within budget.
- [ ] I actually read the digest on at least 10 of the 14 days. This is the main product criterion.

## 11. Open questions

- [x] Where to run it → home-ubuntu.
- [ ] Which Telegram channels to read (my list).
- [ ] How to read channels: personal account (risk of restrictions for automation), a separate account, or the public web preview.
- [ ] Default language: `ru`, `en` or `mixed` right away.
- [ ] Exact digest times (now 07:30 and 20:30). Check them against the sleep schedule and the 12:44 daily focus.
- [ ] HHT news: in the main digest or as a separate feed for the HHT research platform.
- [ ] Acceptable monthly LLM budget.
