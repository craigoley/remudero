import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURE_CONFIG_PATH_SEGMENTS } from "../src/lib/config.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { main } from "../src/run-task.js";

const EXIT = Symbol("process.exit");

test("rmd read-model status is dispatched by main and reads the configured state dir", async (t) => {
  // A throwaway HOME: main() logs its invocation into the configured root's ledger, never the operator's.
  const home = makeTempDir("rmd-read-model-main");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  const configFile = join(home, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(join(configFile, ".."), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ claudeBin: "/usr/bin/true", root }));
  const saved = { home: process.env.HOME, guard: process.env[SELF_SYNC_GUARD_ENV], argv: process.argv };
  process.env.HOME = home;
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  process.argv = ["node", "run-task.js", "read-model", "status", "--json"];
  t.after(() => {
    process.env.HOME = saved.home;
    if (saved.guard === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = saved.guard;
    process.argv = saved.argv;
  });
  const printed: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void printed.push(String(line)));
  t.mock.method(console, "error", () => {});
  let exitCode: number | undefined;
  t.mock.method(process, "exit", ((code?: number): never => {
    exitCode = code;
    throw EXIT;
  }) as typeof process.exit);
  await main().catch((error: unknown) => {
    if (error !== EXIT) throw error;
  });
  assert.equal(exitCode, 0, "the read-model verb ran to completion");
  assert.deepEqual(JSON.parse(printed.join("\n")), { stateDir: join(root, "state"), instances: [] }, "status --json read the configured state dir");
  assert.match(readFileSync(join(root, "state", "ledger.ndjson"), "utf8"), /"verb":"read-model"/, "the invocation was logged under the fixture root");
});
