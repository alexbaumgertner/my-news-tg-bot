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
docs/        SPEC.md and decisions
```

## Working on this repo

Development runs on GitHub. Each task is an issue. To give an issue to the agent, add the label **`claude`**. Claude Code then runs in GitHub Actions, implements the issue and opens a pull request. To ask for changes on a pull request, write a comment that starts with `@claude`. Details: [`docs/SPEC.md` §11](docs/SPEC.md#11-development-workflow).

Conventions for humans and agents are in [`CLAUDE.md`](CLAUDE.md). All code, comments, commits, issues and docs are in **English** (Simplified Technical English style).
