# Instructions for Codex

Follow `CLAUDE.md` for all project rules.

## Code Review Rules

- Write the review in English.
- Report a finding only if it is one of these: a bug, a security problem, data loss, a wrong result, a crash of the collector or the bot, or a violation of a rule in `CLAUDE.md` (for example: committed secrets, `git add -A`, prompts inline in code, an untested change to scoring).
- Each finding needs a concrete input or scenario from this project that fails. Do not report a case that has no realistic input.
- Threat model: a personal bot with one user and a fixed list of public sources in `config/sources.yaml`. Report malformed or changed real-world data, silent data loss and failures that stop a run. Report an attack from a hostile server only if the fix is small.
- Do not report style, naming, formatting (eslint and prettier check them), missing comments or docs, or optional refactoring.
- Use P1 for data loss, security problems and crashes. Use P2 only for wrong results that real data can trigger. Do not use P2 for extra hardening.
- On a re-review, check the new commits and the earlier findings. Do not raise new minor findings about code that did not change. Do not repeat a finding that is fixed or answered.
- If there are no valid findings, write "Didn't find any major issues."
