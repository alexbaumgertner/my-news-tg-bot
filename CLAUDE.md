# Instructions for coding agents

This is a personal, single-user project: a Telegram bot that sends a personalized news digest. Read `docs/SPEC.md` before you change anything substantial.

## Language

- Everything in the repository is in English: code, comments, commit messages, PR descriptions, issues and docs.
- The bot's user-facing output can be in Russian, English or mixed. That is runtime configuration, not repository language.

## Stack and constraints

- TypeScript (strict), Node.js 22, pnpm.
- grammY for the bot, Drizzle ORM, PostgreSQL + pgvector, vitest for tests, pino for logs, zod for config and LLM output validation.
- The target host is `home-ubuntu`: Ubuntu Server on a 2013 MacBook Air with 8 GB RAM, shared with other agents.
  - Keep the process under ~500 MB of RSS.
  - No headless browsers, no local ML models.
  - Docker is optional; Postgres runs natively.
- All tables carry a `user_id` column, even though there is one user, so a multi-user version stays possible.

## Rules

- Stage files explicitly. Never run `git add -A` or `git add .`: other agents may share the worktree.
- Keep commits small, one logical change each. Reference the issue (`Refs #12` / `Closes #12`).
- Never commit secrets. Configuration comes from `.env`; keep `.env.example` up to date.
- Never invent feed URLs or API endpoints. Verify them with a real request. Mark broken ones `active: false` with a reason.
- LLM prompts live in `prompts/*.md`, not inline in code.
- LLM output must be validated with zod. Invalid output is logged and skipped, never trusted.
- Every change to scoring, dedup thresholds or prompts must pass the golden-set test (`tests/golden/`).
- Respect `robots.txt` and site terms. Never forward full article texts to Telegram: send a summary and a link only.
