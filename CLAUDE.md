# Instructions for coding agents

This is a personal, single-user project: a Telegram bot that sends a personalized news digest. Read `docs/SPEC.md` before you change anything substantial.

## Language

- Everything in the repository is in English: code, comments, commit messages, PR descriptions, issues and docs.
- Write in Simplified Technical English (ASD-STE100 style):
  - Short sentences. Procedures: 20 words or fewer per sentence.
  - Active voice and the imperative for instructions ("Run the migration", not "The migration should be run").
  - One word for one meaning. Do not use synonyms for the same thing (for example, always "story", never also "cluster" or "event").
  - No idioms, no slang, no ambiguous pronouns.
- The bot's user-facing output can be in Russian, English or mixed. That is runtime configuration, not repository language.

## How work is done

- Development runs on GitHub. Each task is a GitHub issue.
- The owner adds the label `claude` to an issue. The workflow `.github/workflows/claude.yml` starts Claude Code on a GitHub-hosted runner.
- The agent reads the issue, `CLAUDE.md` and `docs/SPEC.md`. Then it makes a branch, implements the issue, runs the tests and opens a pull request with `Closes #<n>`.
- For large issues, split the work into subagents (for example, one for code and one for tests). Do not ask the owner to split the issue.
- To change a pull request, the owner writes a comment that starts with `@claude`.
- If the issue is not clear, write a question as an issue comment and stop. Do not guess requirements.
- `home-ubuntu` is the runtime host for the bot only. It is not a development machine.
- Release: the owner publishes a tag `vX.Y.Z`. `home-ubuntu` deploys it within 2 minutes (see `deploy/` and SPEC §8).

## Stack and constraints

- TypeScript (strict), Node.js 26 (Active LTS until October 2027, end of life April 2029), pnpm.
- grammY for the bot, Drizzle ORM, PostgreSQL + pgvector, vitest for tests, pino for logs, zod for config and LLM output validation.
- The runtime host is `home-ubuntu`: Ubuntu Server on a 2013 MacBook Air with 8 GB RAM, shared with other services.
  - Keep the process under ~500 MB of RSS.
  - No headless browsers, no local ML models.
  - Docker is optional; Postgres runs natively.
- All tables carry a `user_id` column, even though there is one user, so a multi-user version stays possible.

## Rules

- Stage files explicitly. Never run `git add -A` or `git add .`.
- Keep commits small, one logical change each. Reference the issue (`Refs #12` / `Closes #12`).
- Never commit secrets. Configuration comes from `.env`; keep `.env.example` up to date.
- Never invent feed URLs or API endpoints. Verify them with a real request. Mark broken ones `active: false` with a reason.
- LLM prompts live in `prompts/*.md`, not inline in code.
- LLM output must be validated with zod. Invalid output is logged and skipped, never trusted.
- Every change to scoring, dedup thresholds or prompts must pass the golden-set test (`tests/golden/`).
- Respect `robots.txt` and site terms. Never forward full article texts to Telegram: send a summary and a link only.
