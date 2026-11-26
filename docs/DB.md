# Database schema

Storage is PostgreSQL with the `pgvector` extension. The schema is in `src/db/schema.ts` (Drizzle ORM). SQL migrations are in `drizzle/`.

## Rules

- Every table has a `user_id` column (bigint, the Telegram user id). Unique constraints include `user_id`.
- Primary keys are `bigint` identity columns named `id`.
- Timestamps use `timestamptz`.

## Tables

| Table | Purpose | Key constraints |
|---|---|---|
| `sources` | Source registry, copied from `config/sources.yaml`. | unique `(user_id, slug)` | Fetch state: `last_fetched_at` (last attempt), `last_success_at`, `last_failure_at`, `last_error`, `consecutive_failures`, `etag`, `last_modified`.
| `items` | One fetched article. Has an optional `embedding` and a `story_id`. | unique `(user_id, canonical_url)`, unique `(user_id, content_hash)` |
| `stories` | A group of items about one event. Has an `embedding`. | none |
| `scores` | LLM score of a story (topics, relevance 0–10, impact, `why_me`, novelty, confidence). | unique `(story_id, prompt_version)` |
| `digests` | One digest that the bot sent (kind, language, times). | none |
| `digest_items` | A story inside a digest, with the text that was sent. | unique `(digest_id, story_id)` |
| `feedback` | A reaction to a digest item. | none |
| `profile_versions` | Every version of the interest profile (JSON). | unique `(user_id, version)` |
| `llm_usage` | Tokens and cost of each LLM call, for the budget limits. | none |
| `vocab_seen` | Stub for v1: words shown in the English block. | unique `(user_id, language, word)` |

## Vectors

- `items.embedding` and `stories.embedding` are `vector(1024)`. The size is `EMBEDDING_DIMENSIONS` in `src/db/schema.ts`. Change it if the embeddings model changes. This needs a new migration.
- Both columns have an HNSW index with `vector_cosine_ops`. HNSW needs no training data, so it works on an empty table and stays correct while the data grows. The data is small, so the index is cheap.
- Query example: `ORDER BY embedding <=> $1 LIMIT 5`. Cosine similarity is `1 - distance`.

## Migrations

- Set `DATABASE_URL` and `TELEGRAM_OWNER_ID` in `.env`. The database user needs the right to run `CREATE EXTENSION vector`, or an admin must create the extension first.
- Run `pnpm db:migrate`. It applies pending migrations, then copies `config/sources.yaml` into `sources` for the owner. Both steps are safe to run again.
- To change the schema: edit `src/db/schema.ts`, run `pnpm db:generate`, review the new SQL file in `drizzle/` and commit it.
- Never edit a migration that was already released.
- Integration test: set `TEST_DATABASE_URL` to a throwaway database and run `pnpm test`. The test drops the `public` schema in that database.
