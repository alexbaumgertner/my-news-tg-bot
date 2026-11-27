export type Language = "ru" | "en";

export function parseLanguage(arg: string): Language | null {
  const value = arg.trim().toLowerCase();
  return value === "ru" || value === "en" ? value : null;
}

/** Parse "H:MM" or "HH:MM" (24-hour). Return "HH:MM", or null if invalid. */
export function parseTime(arg: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(arg.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Parse "morning HH:MM" or "evening HH:MM". */
export function parseSchedule(arg: string): { slot: "morning" | "evening"; time: string } | null {
  const parts = arg.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const slot = parts[0]!.toLowerCase();
  const time = parseTime(parts[1]!);
  if ((slot !== "morning" && slot !== "evening") || !time) return null;
  return { slot, time };
}
