# my-news-tg-bot

A personal Telegram bot that sends me a morning and an evening digest of world news **filtered for my own life and career**. It collects from many sources, has an LLM score each story against my interest profile, and sends only the few items that actually matter to me.

> Status: **Phase 0 (preparation)**. Open questions are resolved (SPEC §12). No code yet. Specification: [`docs/SPEC.md`](docs/SPEC.md). Plan: [milestones](https://github.com/alexbaumgertner/my-news-tg-bot/milestones).

## Why this exists

General news feeds are built for everyone, so they are noisy and anxious. Most headlines are about events that do not change anything in my work, my projects or my plans. Meanwhile, the things that *do* matter are spread across lab blogs, arXiv, PubMed, EU and German government sites, publishers and niche Telegram channels, often in languages I do not read every day.

This bot is a **single-user tool, built for me first**. If someone else finds it useful later, that is a bonus, not the goal.

### What makes it unique for me

- **Relevance over urgency.** An item makes the digest only if it affects my work, my projects, my learning, my health or my life plans. Disturbing world news with no impact on my life is filtered out on purpose.
- **"Why this matters to me" on every item.** Each item comes with one line that ties it to my context, such as my Claude Code workflow, the easy-deep-learning portal, the HHT research platform, or my plans for living in Turkey and moving to the EU.
- **My topics, my weights.** These come from a versioned `profile.yaml`:
  - agentic AI development and new models;
  - learning science and EdTech;
  - HHT and medical research;
  - my web stack (Next.js, Node.js, TypeScript, Payload, Vercel);
  - indie hacking;
  - the IT job market;
  - life in Turkey, EU Blue Card and German visas;
  - sport science.
- **Primary sources and other languages.** The bot reads EU, German and other national sites, publishers and research databases. It translates them, so I see what never reaches the Russian- or English-speaking news bubble.
- **English practice built in.** In `mixed` mode the digest is written in B2–C1 English, highlights a few C1 expressions and ends the evening with "Words of the day". It is a small piece of the *context-driven learning* idea behind easy-deep-learning.
- **It learns from me.** 👍/👎 and "more like this" buttons tune topic and source weights. Profile changes are only proposed, never applied silently.
- **No Russian domestic politics.** Russian-language sources are fine when they write about world topics.
- **Self-hosted.** It runs on my home server (`home-ubuntu`). The profile, the history and my reactions stay with me.

## How it works

```
sources ──► collect ──► normalize ──► dedupe into stories ──► cheap pre-filter
                                                                   │
Telegram ◄── deliver ◄── compose digest (strong LLM) ◄── rank ◄── score (fast LLM)
    │
    └── feedback buttons ──► topic / source weights
```

1. **Collect** from RSS/Atom feeds (science and tech magazines, lab blogs), arXiv, PubMed, Hacker News and public Telegram channels; later ClinicalTrials.gov and EU/German government sites.
2. **Normalize** each item: extract the full text, detect the language, canonicalize the URL.
3. **Dedupe** exactly by URL and hash, and semantically by embeddings. Ten articles about one event become one story.
4. **Pre-filter** with no LLM: keywords, stop words and embedding similarity to my topics.
5. **Score** with the cheapest model (Claude Haiku class), within a $5/month budget. The output is strict JSON: topics, relevance, impact, why-me, confidence, study type.
6. **Rank** by relevance × topic weight × source trust × freshness, with at most 3 items per topic.
7. **Compose** with the same cheap model, in English by default (Russian or mixed on request).
8. **Deliver** at 07:30 and 20:30 (Europe/Istanbul).

## Tech stack

| Part | Choice |
|---|---|
| Runtime | TypeScript, Node.js 26 LTS, pnpm |
| Telegram bot | [grammY](https://grammy.dev/) (long polling) |
| LLM | Anthropic API, cheapest model (Haiku class) for scoring and writing; $5/month budget |
| Embeddings | Hosted embeddings API, no local models (the server has 8 GB RAM) |
| Storage | PostgreSQL + pgvector, Drizzle ORM |
| Scheduling | systemd timers |
| Hosting | `home-ubuntu` (Ubuntu Server, MacBook Air 2013, 8 GB RAM), reached over Tailscale |

## Roadmap

| Milestone | Scope |
|---|---|
| **Phase 0: Preparation** | Interest profile, verified source list, golden set, server and API accounts, open decisions |
| **MVP** | RSS, arXiv, PubMed, HN and public Telegram channel fetchers; the full pipeline; morning and evening digests in `ru`/`en`; 👍/👎 buttons; deployed on home-ubuntu; 14-day trial run |
| **v1** | Book-release notices, EU and German government sources with translation, ClinicalTrials.gov, `mixed` language mode with vocabulary, `/deep`, `/search`, weekly profile tuning |
| **v2** | Urgent pushes, export of vocabulary to Sprachweise/Anki, web archive, weekly long-read, feeds for easy-deep-learning and the HHT research platform |

MVP acceptance criteria are in [`docs/SPEC.md`](docs/SPEC.md#10-milestones-and-acceptance-criteria).

## Repository layout (planned)

```
config/      profile.yaml, sources.yaml (examples are committed; the real profile may stay local)
prompts/     LLM prompts as Markdown, versioned with the code
src/         fetchers/, pipeline/, llm/, bot/, db/
tests/       unit tests and tests/golden/ (labeled items for prompt regression)
deploy/      systemd units and timers for home-ubuntu
docs/        SPEC.md, DB.md (schema) and decisions
```

## Interest profile

Copy `config/profile.example.yaml` to `config/profile.yaml` and edit it. The bot reads the profile from `CONFIG_DIR` (default `./config`). The real file is in `.gitignore` and is not committed. `loadProfile` in `src/profile.ts` validates the file and rejects unknown fields.

## Run collection by hand

Collection fetches every due source and stores new items. It seeds `sources` from `config/sources.yaml` when the table is empty. `deploy/deploy.sh` already runs the seed after each migration (`pnpm db:migrate`).

On a development machine with a database:

```bash
pnpm collect
```

On `home-ubuntu`, after a deploy (the file `/etc/my-news-tg-bot.env` is owned by `root:newsbot`, mode 640):

```bash
sudo -u newsbot bash -c 'set -a; . /etc/my-news-tg-bot.env; set +a; cd /opt/my-news-tg-bot && node dist/collect.js'
```

The command prints one summary line: sources ok, not modified and failed, items fetched and items inserted. Exit code 0: at least one source succeeded, or nothing was due. Exit code 1: every due source failed, or the database is not reachable. A second run right after the first one does not duplicate items.

Count items per source:

```sql
SELECT s.slug, count(i.id) AS items, max(i.fetched_at) AS last_fetched
FROM sources s
LEFT JOIN items i ON i.source_id = s.id
GROUP BY s.slug
ORDER BY items DESC;
```

## Process stories and send a digest by hand

Run these after `pnpm collect`. Both commands read `.env`, run once and exit.

```bash
pnpm process
pnpm digest --slot morning --dry-run
pnpm digest --slot morning
```

`pnpm process` runs dedup, the pre-filter and scoring for stories that are not scored yet. It logs the counts of every stage and prints one summary line, for example: `Process: embedded 12, clustered 12 (9 new stories), pre-filter passed 4 / dropped 5, scored 4, invalid 0, failed 0`. A missing `EMBEDDINGS_API_KEY` or `ANTHROPIC_API_KEY` is logged and the stage degrades or is skipped. It is not a crash. Exit code 1 means a database error.

`pnpm digest --slot morning|evening [--dry-run]` ranks the stories, composes the text, formats it and sends it to `TELEGRAM_OWNER_ID`. The language comes from the owner's `user_settings`.

- `--dry-run` prints the messages to stdout. It sends nothing and writes nothing, so no story counts as sent.
- A real run records the digest (user, local date, slot, message ids, story ids). A story counts as sent only after Telegram accepted all messages of the digest.
- The same slot on the same day is sent once. A second run prints `already_sent` and sends nothing.
- If the send fails, the command exits with code 1. The digest stays unsent. Run the same command again to retry. If a digest has several messages and a later one fails, the retry sends all of them again.
- If no story passes the ranking, the bot sends a short "nothing important" message.
- The footer counts the items of the last 24 hours that are not in the digest.
- Both commands exit with code 1 on failure and log one error line. Logs never contain secrets.

The command prints one summary line: `Digest morning: sent, 6 stories, 1 messages`.

## Working on this repo

Development runs on GitHub. Each task is an issue. To give an issue to the agent, add the label **`claude`**. Claude Code then runs in GitHub Actions, implements the issue and opens a pull request. To ask for changes on a pull request, write a comment that starts with `@claude`. Details: [`docs/SPEC.md` §11](docs/SPEC.md#11-development-workflow).

Conventions for humans and agents are in [`CLAUDE.md`](CLAUDE.md). All code, comments, commits, issues and docs are in **English** (Simplified Technical English style).
