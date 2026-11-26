import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { z } from "zod";
import { createDb } from "./client.js";
import { seedSources } from "./seed.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  CONFIG_DIR: z.string().min(1).default("./config"),
});

/** Apply pending migrations, then sync `sources` from config. Both steps are idempotent. */
async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      `Invalid environment variables:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
    process.exit(1);
  }
  const env = parsed.data;
  const { db, client } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: resolve("drizzle") });
    console.log("Migrations applied.");
    const count = await seedSources(db, env.CONFIG_DIR, env.TELEGRAM_OWNER_ID);
    console.log(`Seeded ${count} sources.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
