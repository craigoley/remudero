import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// 2026-10-03: two machine PRs edited one shard on adjacent lines and merged into a duplicate
// `priority:` key; the plan loader refused the whole plan and every daemon boot died for ~5 hours.
const TASKS_DIR = fileURLToPath(new URL("../plan/tasks.d/", import.meta.url));

test("every plan shard parses with unique keys", () => {
  const bad: string[] = [];
  for (const name of readdirSync(TASKS_DIR).filter((f) => f.endsWith(".yaml"))) {
    try {
      parse(readFileSync(join(TASKS_DIR, name), "utf8"), { uniqueKeys: true });
    } catch (err) {
      bad.push(`${name}: ${String((err as Error).message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(bad, [], "a shard with a duplicate key makes the whole plan unloadable");
});
