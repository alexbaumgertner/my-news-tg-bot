import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GoldenBuildError, buildGolden } from "../src/golden/build.js";

const OUT = "tests/golden/items.jsonl";
const input = process.argv[2];
if (!input) {
  console.error("Usage: pnpm golden:build <labeled.csv>");
  process.exit(1);
}

try {
  const result = buildGolden(readFileSync(input, "utf8"));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, result.jsonl, "utf8");
  console.log(
    `Wrote ${result.items.length} items to ${OUT}: keep ${result.keep}, drop ${result.drop}.`,
  );
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
} catch (error) {
  if (error instanceof GoldenBuildError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
