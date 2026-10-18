import { repoRoot } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { getPriority } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { planPrPreflight, planPrPreflightAsync } from "#src/lib/plan-pr-emitter.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const ROOT = repoRoot();
const SETUP_URL = pathToFileURL(join(repoRoot(), "test/setup/tmp-hygiene.ts")).href;
const PROOF_NAME = "test/the-plan-pr-shard-check-runs-with-the-setup-preload.test.ts";

function fixture(withSetup: boolean) {
  const repo = gitRepo();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  symlinkSync(join(ROOT, "node_modules"), join(repo.dir, "node_modules"), "dir");
  writeFileSync(join(repo.dir, "package.json"), '{"type":"module"}\n');
  for (const dir of ["scripts", "src", "test/setup"]) mkdirSync(join(repo.dir, dir), { recursive: true });
  for (const [path, name] of [
    ["scripts/lint-plan-precheck.mjs", "lint-plan"],
    ["scripts/task-id-existence-check.mjs", "task-id"],
    ["src/check-proof-main.ts", "check-proof"],
  ]) {
    writeFileSync(join(repo.dir, path!), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(repo.dir, `${name}.json`))}, JSON.stringify({
        selfSync: process.env.RMD_SELF_SYNC_DONE ?? null,
        context: process.env.NODE_TEST_CONTEXT ?? null,
      }));
    `);
  }
  if (withSetup) {
    writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), `
      await import(${JSON.stringify(SETUP_URL)});
      const { appendFileSync } = await import("node:fs");
      appendFileSync(${JSON.stringify(join(repo.dir, "setup.ndjson"))}, JSON.stringify({
        argv: process.execArgv,
        selfSync: process.env.RMD_SELF_SYNC_DONE ?? null,
        context: process.env.NODE_TEST_CONTEXT ?? null,
      }) + "\\n");
    `);
  }
  writeFileSync(join(repo.dir, "test/every-shard-on-main-is-lintable.test.ts"), `
    import { writeFileSync } from "node:fs";
    import { getPriority } from "node:os";
    import { test } from "node:test";
    test("fixture shard is lintable", () => {
      writeFileSync(${JSON.stringify(join(repo.dir, "census.json"))}, JSON.stringify({
        selfSync: process.env.RMD_SELF_SYNC_DONE ?? null,
        priority: getPriority(),
        argv: process.execArgv,
      }));
    });
  `);
  return repo;
}

for (const asyncRun of [false, true]) {
  for (const withSetup of [true, false]) {
    test(`${PROOF_NAME}: ${asyncRun ? "async" : "sync"} census ${withSetup ? "loads the setup" : "supports a tree without setup"} at low priority while cli children retain self-sync`, async () => {
      const repo = fixture(withSetup);
      const parentEnv = { ...process.env };
      const parentPriority = getPriority();
      try {
        process.env.RMD_SELF_SYNC_DONE = "parent-sentinel";
        const input = {
          cwd: repo.dir,
          title: "chore(plan): fixture",
          body: "Acceptance:\n- fixture proof | unit test: fixture shard is lintable",
        };
        const checks = { budgetMs: () => 30_000 };
        const result = asyncRun ? await planPrPreflightAsync(input, checks) : planPrPreflight(input, checks);
        assert.deepEqual(result, { ok: true, failures: [], unreadable: [] });
        const census = JSON.parse(readFileSync(join(repo.dir, "census.json"), "utf8"));
        assert.equal(census.selfSync, null, "the census removes even an inherited self-sync variable");
        assert.ok(census.argv.includes("--test-concurrency=1"));
        if (existsSync("/usr/bin/nice") || existsSync("/bin/nice")) {
          // nice increments an inherited priority; Darwin can report20 where Linux caps at19.
          // Measure a real sibling under the same +10 contract rather than importing another OS's cap.
          const nice = existsSync("/usr/bin/nice") ? "/usr/bin/nice" : "/bin/nice";
          const measured = execFileSync(nice, ["-n", "10", process.execPath, "--input-type=module", "-e",
            'import { getPriority } from "node:os"; process.stdout.write(String(getPriority()));'], { encoding: "utf8" });
          assert.match(measured, /^-?\d+$/, "the native nice control emits a real integer observation");
          const nativePriority = Number(measured);
          assert.ok(nativePriority >= parentPriority, "the control never raises the inherited scheduling priority");
          assert.equal(census.priority, nativePriority, "the real census matches its native nice control");
        }
        for (const name of ["lint-plan", "task-id", "check-proof"]) {
          assert.deepEqual(JSON.parse(readFileSync(join(repo.dir, `${name}.json`), "utf8")), {
            selfSync: "1", context: null,
          }, `${name} keeps the cli self-sync guard and removes the inherited test context`);
        }
        if (withSetup) {
          const rows = readFileSync(join(repo.dir, "setup.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
          assert.equal(rows.length, 1, "the real setup loads successfully in the single census file child");
          assert.equal(rows[0].selfSync, null);
          assert.ok(rows[0].argv.includes("./test/setup/tmp-hygiene.ts"));
        } else {
          assert.equal(existsSync(join(repo.dir, "setup.ndjson")), false);
        }
        assert.equal(process.env.RMD_SELF_SYNC_DONE, "parent-sentinel", "the child's environment is isolated");
        assert.equal(process.env.NODE_TEST_CONTEXT, parentEnv.NODE_TEST_CONTEXT);
      } finally {
        if (parentEnv.RMD_SELF_SYNC_DONE === undefined) delete process.env.RMD_SELF_SYNC_DONE;
        else process.env.RMD_SELF_SYNC_DONE = parentEnv.RMD_SELF_SYNC_DONE;
        repo.cleanup();
      }
    });
  }
}
