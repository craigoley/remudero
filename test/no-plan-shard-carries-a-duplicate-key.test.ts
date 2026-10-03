import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const TASKS_DIR = fileURLToPath(new URL("../plan/tasks.d/", import.meta.url));

// Two machine plan PRs from one base (#8911 judge, #8914 gardener) each added a `priority:`
// line to W1-T5469's shard; git merged both. W1-T5472 closes the merge race; this pins main.
test("no plan shard on main carries a duplicate key", () => {
  const bad: string[] = [];
  for (const name of readdirSync(TASKS_DIR).filter((f) => f.endsWith(".yaml"))) {
    try {
      parse(readFileSync(join(TASKS_DIR, name), "utf8"), { uniqueKeys: true });
    } catch (err) {
      bad.push(`${name}: ${String((err as Error).message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(bad, [], "a shard with a duplicate key fails every plan-reading CI suite");
});
