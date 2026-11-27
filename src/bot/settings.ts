import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { userSettings } from "../db/schema.js";

export type Settings = typeof userSettings.$inferSelect;
export type SettingsPatch = Partial<
  Pick<Settings, "language" | "morningTime" | "eveningTime" | "chatId">
>;

/** Read the settings of a user. Create the row with defaults if it is missing. */
export async function getSettings(db: Db, userId: number): Promise<Settings> {
  await db.insert(userSettings).values({ userId }).onConflictDoNothing();
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return row!;
}

export async function updateSettings(
  db: Db,
  userId: number,
  patch: SettingsPatch,
): Promise<Settings> {
  await getSettings(db, userId);
  const [row] = await db
    .update(userSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId))
    .returning();
  return row!;
}
