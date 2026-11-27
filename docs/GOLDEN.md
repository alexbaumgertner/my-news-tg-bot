# Golden set

The golden set is a list of real items that the owner labels `keep` or `drop`.
Tests use it to check scoring, dedup thresholds and prompts (SPEC §9).
The file is `tests/golden/items.jsonl`. Aim for 50 or more items, at least 25 `keep` and 25 `drop`.

## 1. Export candidates

Run on a Mac or on `home-ubuntu`. The machine needs network access. No database is needed.

```sh
pnpm install
pnpm golden:export
```

The command reads `config/sources.yaml` and writes `tmp/golden/candidates.csv`.
It uses the normal fetchers, their limits and the robots.txt rules.
A source that fails is logged and skipped. Sources without a fetcher (`clinicaltrials`, `html`) are skipped.

Options:

- `--per-source N`: items taken from each source. Default 3.
- `--seed N`: seed of the shuffle. The same seed gives the same sample if the feeds did not change. Default 1.
- `--out path`: output file. Default `tmp/golden/candidates.csv`.

The sample has all the tricky cases:

- Every active source gives items, so Russian-language media, world news and medical news are all there.
- If a picked item has duplicates, the export adds up to 4 items of that story. They get the same `dup_group` number and stand next to each other.
- The export adds up to 15 more stories that two or more sources report.
- The export never drops an item because it looks irrelevant. You need both `keep` and `drop` examples.

## 2. Label

Open the CSV in Excel, Numbers or Google Sheets. The file is UTF-8 with BOM, so Russian text shows correctly.
Fill the three empty columns for each row that you want in the set. Leave `label` empty to skip a row.
Do not change the other columns.

| Column   | Value                                                                                |
| -------- | ------------------------------------------------------------------------------------ |
| `label`  | `keep` (send it in the digest) or `drop` (never send it).                            |
| `topics` | Topic ids separated by `;`, in snake_case, for example `science_space;medicine_hht`. |
| `reason` | One short sentence. Required.                                                        |

Rules:

- `keep` needs at least one topic. `drop` may have none.
- Use the topic ids from `config/profile.yaml`.
- Judge the title and the snippet, as the bot does. Open the link only if you cannot decide.

Tricky cases:

- **Duplicates.** Rows with the same `dup_group` report one story. Label all of them the same way. Write in `reason` which one is the best source.
- **Russian-language media.** Label by the value of the story, not by the language.
- **Alarming world news.** `keep` only if it changes what you must know or do. `drop` fear without new facts.
- **Medical news.** `keep` a trial result, a guideline or a new treatment that fits your topics. `drop` a lifestyle tip or a press release without data.
- **Looks irrelevant.** Label it `drop`. Do not delete the row.

Save as CSV again. Comma, semicolon and tab separators all work.

## 3. Build and commit

```sh
pnpm golden:build path/to/labeled.csv
```

The command skips rows with an empty `label` and checks every other row.
It writes `tests/golden/items.jsonl`, sorted by `id`, and prints the counts of `keep` and `drop`.
It prints a warning if there are fewer than 25 of either.
If a row is invalid, it prints the row number and exits with an error. Row 1 is the header, so the first item is row 2.
Fix the row in the spreadsheet and run the command again.

Then commit the result:

```sh
git add tests/golden/items.jsonl
git commit -m "Add golden set"
```

## Notes

- `id` is the first 16 hex characters of the SHA-256 of the canonical URL. The same article always gets the same `id`.
- A spreadsheet may treat a cell that starts with `=` as a formula. Do not click such links in the `title` column.
