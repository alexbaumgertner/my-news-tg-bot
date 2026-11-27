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

## Before you push

- Run `pnpm lint && pnpm test && pnpm build`. `pnpm lint` includes `prettier --check`. Fix every failure before you push. Run `pnpm exec prettier --write` on the files you changed.
- Run the checks once before each push. Do not re-run them after each small edit.
- Add or update a test for every behavior that you change or fix.

## Pull requests

- One issue, one pull request. Branch from `main`. Do not change files that the issue does not need. Do not reformat unrelated code.
- The description has these parts: `Closes #<n>`; "What changed" (bullets); "Please check" (deviations from the issue, new dependencies, migrations, anything you did not finish); "Depends on #<n>" if there is one. Keep it short.
- The final comment is 10 lines or fewer: what changed, what you did not do, the check results. Do not recap your steps.

## Dependencies and migrations

- Add a dependency only if the issue needs it. Prefer small libraries. Name each new dependency and the reason in "Please check". When a task parses data or processes batches, measure memory against the budget in SPEC section 9.
- For a standard format (HTML, robots.txt, URLs, RSS, dates), use a maintained library. Do not write your own parser. If no library fits, give the reason in "Please check".
- Create migrations with `drizzle-kit generate`. Never edit a migration that is on `main`. List each migration in "Please check".

## Fetchers and external data

- Treat all remote data as untrusted and possibly malformed.
- A fetcher must throw when a result is partial or invalid. `runCollector` treats a normal return as success and advances `lastSuccessAt`.
- Every loop over remote data has limits for pages, items, bytes and time. When a limit is hit, throw. Never return a partial result as complete.
- Read a remote body with a size limit. Do not call `response.text()` on a body without a limit.
- Never build a regular expression from remote text.
- A permission check fails closed. When the check fails, do not fetch (for example, robots.txt).
- Every cache has an expiry time.
- Set `textFormat` ("html" or "text") on every `RawItem`.
- Tests use recorded fixtures and no network.

## Review comments

- Codex reviews each pull request. The owner writes `@claude` to ask for fixes.
- Read each finding. Fix valid findings. If a finding is wrong or out of scope, reply with the reason and do not change the code. If a finding is valid but outside the issue, say so in the reply and suggest a follow-up issue.
- Fix the cause, not only the line. Before you push, check the same file for the same kind of problem. Fix all of them in one commit. This avoids extra review rounds.
- Add a test for each fix.
- After the push, reply on each fixed thread: `Fixed in <short hash>: <one line>`. Resolve the thread if your tools allow it.

## Save tokens

- Read only the files that the task needs. Search before you open a large file. Do not read the whole repository.
- Do not paste long command output or whole files into comments. Show only the relevant lines.
- When you fix review comments, read only the review threads and the files that they point to.
- Ask the owner only when the issue is unclear (see "How work is done").
