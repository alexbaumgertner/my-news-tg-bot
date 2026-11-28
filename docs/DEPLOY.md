# Deploy to home-ubuntu

This guide installs the bot on a fresh Ubuntu Server host. Follow the steps in order. Run each command as the user shown. Architecture and reasons: [SPEC §8](SPEC.md#8-architecture-and-stack).

Paths used in this guide:

| Path | Purpose |
| --- | --- |
| `/opt/my-news-tg-bot` | Checkout of the repository, owned by `newsbot` |
| `/etc/my-news-tg-bot.env` | Environment file, owner `root:newsbot`, mode 640 |
| `/var/lib/newsbot` | State directory (locks, last deployed tag) |
| `/usr/local/bin/newsbot-deploy` | Root-owned copy of `deploy/deploy.sh` |
| `/usr/local/bin/newsbot-autodeploy` | Root-owned copy of `deploy/autodeploy.sh` |

## 1. Prerequisites

You need: a host with 8 GB RAM, a sudo user, internet access, a Telegram bot token from @BotFather, your numeric Telegram user id, an Anthropic API key and an embeddings API key.

### Node.js 26 and pnpm

The units run `/usr/bin/node`, so install Node.js system-wide. Check the installer URL on the NodeSource site before you run it.

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pnpm
node --version   # v26.x
pnpm --version
```

### PostgreSQL 18 with pgvector

Ubuntu packages may carry an older PostgreSQL. Use the PostgreSQL apt repository (PGDG).

```bash
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt-get install -y postgresql-18 postgresql-18-pgvector
```

Create the database user and the database. Replace `CHANGE_ME` with a long random password. Do not reuse a password.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE newsbot LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE news_bot OWNER newsbot;
\c news_bot
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

The administrator creates the extension here, so the `newsbot` role needs no extra rights. `DATABASE_URL` is then `postgres://newsbot:CHANGE_ME@localhost:5432/news_bot`.

### The `newsbot` system user

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin newsbot
sudo mkdir -p /opt/my-news-tg-bot
sudo chown newsbot:newsbot /opt/my-news-tg-bot
```

## 2. Get the code

Clone the repository as `newsbot`. Check out the newest release tag.

```bash
sudo -u newsbot git clone https://github.com/alexbaumgertner/my-news-tg-bot.git /opt/my-news-tg-bot
```

You build the first release in step 6. Before that, create the configuration (steps 3 and 4).

## 3. Environment file

Create `/etc/my-news-tg-bot.env`. Systemd reads it with `EnvironmentFile=`, and `deploy.sh` sources it for migrations. Write plain `KEY=value` lines, with no `export` and no quotes.

```bash
sudo install -m 640 -o root -g newsbot /dev/null /etc/my-news-tg-bot.env
sudoedit /etc/my-news-tg-bot.env
```

The code reads these variables (`src/config.ts`). An empty value counts as unset. `.env.example` has the same list with comments.

**Required**

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_OWNER_ID` | Your numeric Telegram user id. The bot answers only this user. |
| `DATABASE_URL` | PostgreSQL connection string (see step 1) |

**Optional, with defaults**

| Variable | Default |
| --- | --- |
| `NODE_ENV` | `development` (the unit sets `production`) |
| `LOG_LEVEL` | `info` (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `ANTHROPIC_API_KEY` | none. Without it, scoring is skipped and an error is logged. |
| `LLM_MODEL` | `claude-haiku-5-5` |
| `LLM_DAILY_LIMIT_USD` | `0.16` |
| `LLM_MONTHLY_LIMIT_USD` | `5` |
| `LLM_PRICE_INPUT_PER_MTOK` | `1` |
| `LLM_PRICE_OUTPUT_PER_MTOK` | `5` |
| `LLM_PRICE_CACHE_READ_PER_MTOK` | `0.1` |
| `LLM_PRICE_CACHE_WRITE_PER_MTOK` | `1.25` |
| `LLM_BATCH_PRICE_FACTOR` | `0.5` |
| `SCORING_MODE` | `batch` (`batch` or `sync`) |
| `SCORING_DAILY_CAP` | `100` |
| `SCORING_MAX_CHARS` | `1500` |
| `SCORING_MAX_OUTPUT_TOKENS` | `500` |
| `COMPOSE_MAX_OUTPUT_TOKENS` | `800` |
| `EMBEDDINGS_API_KEY` | none. Without it, dedup by embedding is degraded or skipped. |
| `EMBEDDINGS_API_URL` | `https://api.voyageai.com/v1/embeddings` |
| `EMBEDDINGS_MODEL` | `voyage-3.5` |
| `DEDUP_SIMILARITY_THRESHOLD` | `0.88` |
| `DEDUP_WINDOW_HOURS` | `48` |
| `PREFILTER_MIN_SIMILARITY` | `0.4` |
| `PREFILTER_WEIGHT_DISCOUNT` | `0.05` |
| `FEEDBACK_STEP` | `0.05` |
| `FEEDBACK_TOPIC_MIN` / `FEEDBACK_TOPIC_MAX` | `0.5` / `1.5` |
| `FEEDBACK_SOURCE_MIN` / `FEEDBACK_SOURCE_MAX` | `0.5` / `1.5` |
| `HTTP_USER_AGENT` | `my-news-tg-bot/0.1` |
| `NCBI_API_KEY` | none. Raises the PubMed rate limit. |
| `HN_MIN_SCORE` | `100` |
| `CONFIG_DIR` | `./config` (relative to `/opt/my-news-tg-bot`) |

Minimal file:

```ini
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_OWNER_ID=<your numeric id>
DATABASE_URL=postgres://newsbot:<password>@localhost:5432/news_bot
ANTHROPIC_API_KEY=<key>
EMBEDDINGS_API_KEY=<key>
```

A wrong value stops the process at start. The error lists each bad variable.

## 4. Interest profile

Copy the example and edit it. The file is in `.gitignore`, so a checkout of a new tag does not remove it.

```bash
sudo -u newsbot cp /opt/my-news-tg-bot/config/profile.example.yaml /opt/my-news-tg-bot/config/profile.yaml
sudo -u newsbot nano /opt/my-news-tg-bot/config/profile.yaml
```

The bot rejects unknown fields. `config/sources.yaml` comes with the repository.

## 5. systemd units (one time)

The `newsbot` user has no sudo rights to install units. Install them by hand. Do this again only when `deploy.sh` prints a warning that a unit is new or changed.

```bash
cd /opt/my-news-tg-bot
sudo cp deploy/my-news-tg-bot.service \
  deploy/newsbot-pipeline.service deploy/newsbot-pipeline.timer \
  deploy/newsbot-digest@.service deploy/newsbot-digest-morning.timer deploy/newsbot-digest-evening.timer \
  deploy/newsbot-autodeploy.service deploy/newsbot-autodeploy.timer \
  /etc/systemd/system/
sudo cp deploy/deploy.sh /usr/local/bin/newsbot-deploy
sudo cp deploy/autodeploy.sh /usr/local/bin/newsbot-autodeploy
sudo chown root:root /usr/local/bin/newsbot-deploy /usr/local/bin/newsbot-autodeploy
sudo chmod 755 /usr/local/bin/newsbot-deploy /usr/local/bin/newsbot-autodeploy
sudo systemctl daemon-reload
```

`deploy.sh` runs `sudo /usr/bin/systemctl enable --now my-news-tg-bot` and `sudo /usr/bin/systemctl restart my-news-tg-bot` as `newsbot`. Allow exactly these two commands and nothing else:

```bash
sudo visudo -f /etc/sudoers.d/newsbot
```

```text
newsbot ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now my-news-tg-bot, /usr/bin/systemctl restart my-news-tg-bot
```

For the schedule of each unit, see [README, Schedule](../README.md#schedule).

## 6. First deploy

Pick the newest tag, for example `v0.1.0`. Run the deploy script by hand. It installs, builds, migrates, seeds the sources and starts the bot.

```bash
sudo -u newsbot newsbot-deploy v0.1.0
```

Then enable the timers. Enable `newsbot-autodeploy.timer` last, so it does not start a second deploy during the first one.

```bash
sudo -u newsbot sh -c 'echo v0.1.0 > /var/lib/newsbot/last-tag'
sudo systemctl enable --now newsbot-pipeline.timer newsbot-digest-morning.timer newsbot-digest-evening.timer
sudo systemctl enable --now newsbot-autodeploy.timer
```

The first command records the tag, so the autodeploy timer does not deploy it again. If `/var/lib/newsbot` does not exist yet, run `sudo systemctl start newsbot-autodeploy.service` once, or create it: `sudo install -d -o newsbot -g newsbot /var/lib/newsbot`.

Check: `systemctl list-timers 'newsbot-*'` shows the next runs. `systemctl status my-news-tg-bot` shows `active (running)`.

After a reboot, the bot and the timers start by themselves.

## 7. Smoke test

Run these checks once after the first deploy. Each step must pass before the next one.

Set up a shell helper for the commands that need the environment:

```bash
nb() { sudo -u newsbot bash -c "set -a; . /etc/my-news-tg-bot.env; set +a; cd /opt/my-news-tg-bot && $*"; }
```

- [ ] **Bot is up.** `systemctl is-active my-news-tg-bot` prints `active`. In Telegram, send `/start` to the bot. It answers `Ready. Commands: /digest, /lang ru|en, /schedule. ...`.
- [ ] **Collect.** Run `nb node dist/collect.js`. Expected last line, with your own numbers:
  `Collection done: sources ok 20, not modified 0, failed 1; items fetched 400, inserted 380`
  Exit code 0 means at least one source worked. A second run right after it inserts about 0 items.
- [ ] **Process.** Run `nb node dist/process.js`. Expected last line, with your own numbers:
  `Process: embedded 12, clustered 12 (9 new stories), pre-filter passed 4 / dropped 5, scored 4, invalid 0, failed 0`
  If the line says that a stage was skipped, check `EMBEDDINGS_API_KEY` and `ANTHROPIC_API_KEY`.
- [ ] **Digest, dry run.** Run `nb node dist/digest.js --slot morning --dry-run`. Expected: the digest messages on stdout, then one summary line in the form `Digest morning: <status>, 6 stories, 1 messages`. Nothing is sent and nothing is stored.
- [ ] **Real digest.** Send `/digest` in Telegram. Expected: first `Building the digest…`, then the digest with story titles, one "why this matters to me" line for each story and a link for each story. Press 👍 on one story and check that the button reacts.
- [ ] **Timers.** `systemctl list-timers 'newsbot-*'` shows a next run for the pipeline, both digests and autodeploy.

If a step fails, read the logs (step 9) and fix the cause. Do not continue.

## 8. Run commands by hand

On the host, use `node dist/<name>.js` with the environment loaded (the `nb` helper above). On a development machine, use `pnpm`:

| Task | On the host | On a development machine |
| --- | --- | --- |
| Collect | `nb node dist/collect.js` | `pnpm collect` |
| Process | `nb node dist/process.js` | `pnpm process` |
| Digest, dry run | `nb node dist/digest.js --slot morning --dry-run` | `pnpm digest --slot morning --dry-run` |
| Digest, real | `nb node dist/digest.js --slot morning` | `pnpm digest --slot morning` |
| Migrate | `nb pnpm db:migrate` | `pnpm db:migrate` |

To run through systemd, which also takes the shared lock, use:

```bash
sudo systemctl start newsbot-pipeline.service         # collect, then process
sudo systemctl start newsbot-digest@morning.service   # digest, slot morning
```

Details of each command: [README](../README.md#run-collection-by-hand).

## 9. Logs

All processes write to stdout. Systemd sends stdout to journald. The bot writes no log files.

```bash
journalctl -u my-news-tg-bot -f                  # the bot
journalctl -u newsbot-pipeline -n 100            # collect and process
journalctl -u 'newsbot-digest@*' -n 100          # digests
journalctl -u newsbot-autodeploy -n 100          # deploys
journalctl -u my-news-tg-bot -u newsbot-autodeploy --since today
```

In production, log lines are JSON (pino). Logs never contain secrets.

### Log rotation

No `logrotate` file is needed. Journald rotates and deletes old entries by itself. Set a size limit, so logs cannot fill the disk:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/newsbot.conf <<'EOF'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=1month
EOF
sudo systemctl restart systemd-journald
journalctl --disk-usage
```

The limit applies to the whole journal of the host, not only to this bot. If the host has no persistent journal (`/var/log/journal` does not exist), the journal lives in RAM and `RuntimeMaxUse` applies instead. Create the directory to keep logs after a reboot: `sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`.

## 10. Updates

Update by release tag. The owner publishes a tag `vX.Y.Z` on GitHub.

1. `newsbot-autodeploy.timer` runs every 2 minutes. It reads the newest tag with `git ls-remote`.
2. For a new tag, it calls `newsbot-deploy <tag>`. The script checks out the tag, runs `pnpm install --frozen-lockfile` and `pnpm build`, applies migrations and restarts the bot.
3. The script prints a warning if a unit in `deploy/` is new or changed. Install it by hand (step 5).
4. Each tag is tried once. To retry a failed tag, run `sudo -u newsbot newsbot-deploy <tag>`.

To deploy at once, without waiting for the timer, run the same command. `newsbot-deploy` does not write `/var/lib/newsbot/last-tag`. Only `newsbot-autodeploy` writes it. After a manual deploy of the newest tag, record the tag. Then the timer does not deploy the same tag again:

```bash
sudo -u newsbot sh -c 'echo v0.2.0 > /var/lib/newsbot/last-tag'   # the tag you deployed
```

If you change `deploy/deploy.sh` or `deploy/autodeploy.sh` in a release, copy it to `/usr/local/bin` again (step 5).

Check the result: `journalctl -u newsbot-autodeploy -n 50` and `systemctl status my-news-tg-bot`.

## 11. Rollback

Autodeploy reads `/var/lib/newsbot/last-tag`. The file holds one tag, for example `v0.2.0`. The timer deploys the newest tag in origin when it differs from the file. `newsbot-deploy` does not write the file. So a rollback needs these steps, in this order.

1. Stop the timer, so it cannot deploy while you work:

   ```bash
   sudo systemctl stop newsbot-autodeploy.timer
   ```

2. Record the rejected tag, which is the newest tag in origin. The timer then sees no new tag:

   ```bash
   sudo -u newsbot sh -c 'echo v0.2.0 > /var/lib/newsbot/last-tag'   # the rejected tag
   ```

3. Find the previous tag and deploy it by hand:

   ```bash
   git -C /opt/my-news-tg-bot tag --list 'v*' --sort=-v:refname | head -3
   sudo -u newsbot newsbot-deploy v0.1.0     # the previous tag
   ```

4. Publish a fixed tag, for example `v0.2.1`. Then start the timer. It sees a tag that differs from the file and deploys it:

   ```bash
   sudo systemctl start newsbot-autodeploy.timer
   ```

Do not start the timer before the fixed tag exists. If step 2 is skipped, the next timer run deploys the rejected tag again.

Migrations do not roll back. If the bad release added a migration, the old code runs on the new schema. Check `drizzle/` between the two tags. If the migration is not compatible, restore the database from a backup.

## 12. Troubleshooting

| Symptom | Check |
| --- | --- |
| Bot does not start | `journalctl -u my-news-tg-bot -n 100`. Look for `Invalid environment variables`. |
| `CREATE EXTENSION vector` fails in migration | Install `postgresql-18-pgvector`. Create the extension as `postgres` (step 1). |
| Deploy exit code 2, 3 or 4 | 2: bad tag format. 3: tag not in origin. 4: the service failed after restart. |
| Pipeline unit shows exit 75 | Another run holds `/var/lib/newsbot/pipeline.lock`. This counts as success. |
| `/digest` says "The digest failed" | `journalctl -u my-news-tg-bot -n 100`. |
