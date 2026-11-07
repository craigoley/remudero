import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { main, AUTHOR_MAX_WORKERS } from "#scripts/preflight-author.mjs";
import { MacAuthorCapacityRefusal } from "#scripts/lib/mac-author-admission.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Selection = { fullRun: false; suites: string[]; narrow: string[]; reasons: string[] };

function authorFixture(t: TestContext) {
  const repo = gitRepo({ kind: "w1-t11583-author", seedCommit: false });
  t.after(() => repo.cleanup());
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts", "coverage"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  const tsxTool = realpathSync(join(REPO_ROOT, "node_modules/.bin/tsx"));
  const dependencyDonor = dirname(dirname(dirname(tsxTool)));
  symlinkSync(dependencyDonor, join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "scripts/lint-plan-offline.mjs"), "console.log('fixture plan lint passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('baseline');\n");
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('leaf', () => {});\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.addRemote("origin", root);
  repo.git("checkout", "-b", "run-unfiled-w1-t11583-fixture");
  const staticSource = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    mkdirSync('coverage', {recursive: true});
    writeFileSync('coverage/static-ran.json', JSON.stringify({static: true}));
  `;
  writeFileSync(join(root, "src/run-task.ts"), staticSource);
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: exercise author validation");
  return {
    root,
    receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")),
  };
}

const selection = (): Selection => ({
  fullRun: false,
  suites: ["test/leaf.test.ts"],
  narrow: ["test/leaf.test.ts"],
  reasons: ["W1-T11583 fixture"],
});

function slotEnvironment(t: TestContext): string {
  const dir = join(mkdtempSync(join(tmpdir(), "rmd-w1-t11583-")), "slots");
  mkdirSync(dir);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"] as const;
  const saved = keys.map(key => [key, process.env[key]] as const);
  process.env.RMD_TEST_SLOT_DIR = dir;
  process.env.RMD_TEST_SLOTS = "4";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });
  return dir;
}

function runAuthor(t: TestContext, input: {
  cores: number;
  load1: number;
  headroomBytes: number;
  refuse?: "pressure" | "disk";
}) {
  const f = authorFixture(t);
  const dir = slotEnvironment(t);
  const affectedArgs: string[][] = [];
  const host = { cores: input.cores, load1: input.load1, headroomBytes: input.headroomBytes };
  const spawn = (file: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
    if (args.includes("test/leaf.test.ts")) affectedArgs.push(args);
    return spawnSync(file, args, options);
  };
  const exitCode = main([], {
    root: f.root,
    select: selection,
    host: () => host,
    spawn,
    testSlot: {
      dir,
      slots: 4,
      waitBoundMs: 0,
      pollMs: 5,
      load: () => ({ cores: input.cores, load1: input.load1 }),
      memoryHeadroom: () => input.headroomBytes,
      log: () => {},
    },
    admitHost: (stage: string) => {
      if (stage === "affected-tests" && input.refuse) {
        throw new MacAuthorCapacityRefusal(stage, {
          state: "refused",
          reason: input.refuse === "pressure" ? "host memory pressure" : "disk reserve unavailable",
        });
      }
      return undefined;
    },
  });
  return { exitCode, affectedArgs, receipt: f.receipt() };
}

test("W1-T11583 criterion 1: an idle eight-core host uses more than one author test worker", (t) => {
  const { exitCode, affectedArgs, receipt } = runAuthor(t, {
    cores: 8,
    load1: 0,
    headroomBytes: 32 * 1024 ** 3,
  });
  assert.equal(exitCode, 0);
  assert.equal(receipt.verdict, "passed");
  assert.ok(receipt.executionWorkers > 1, "the measured idle host should grant more than one worker");
  assert.ok(receipt.executionWorkers <= AUTHOR_MAX_WORKERS);
  const argv = affectedArgs.find(args => args.includes("test/leaf.test.ts"));
  assert.ok(argv, "the selected affected suite must run");
  assert.ok(argv.includes(`--test-concurrency=${receipt.executionWorkers}`));
  assert.equal(receipt.capacity.workers, receipt.executionWorkers);
  assert.equal(receipt.testSlot.concurrency, receipt.executionWorkers);
});

test("W1-T11583 criterion 2: measured CPU and memory capacity still cap author test concurrency", async (t) => {
  for (const [name, input] of [
    ["CPU", { cores: 3, load1: 0, headroomBytes: 32 * 1024 ** 3 }],
    ["memory", { cores: 8, load1: 0, headroomBytes: 512 * 1024 ** 2 }],
  ] as const) {
    await t.test(name, (t) => {
      const { exitCode, affectedArgs, receipt } = runAuthor(t, input);
      assert.equal(exitCode, 0);
      assert.equal(receipt.verdict, "passed");
      assert.equal(receipt.capacity.workers, 1);
      assert.equal(receipt.executionWorkers, 1);
      const argv = affectedArgs.find(args => args.includes("test/leaf.test.ts"));
      assert.ok(argv, "the selected affected suite must run");
      assert.ok(argv.includes("--test-concurrency=1"));
    });
  }
});

test("W1-T11583 criterion 3: pressure or disk refusal does not spawn affected tests", async (t) => {
  for (const refusal of ["pressure", "disk"] as const) {
    await t.test(refusal, (t) => {
      const { exitCode, affectedArgs, receipt } = runAuthor(t, {
        cores: 8,
        load1: 0,
        headroomBytes: 32 * 1024 ** 3,
        refuse: refusal,
      });
      assert.equal(exitCode, 3);
      assert.equal(receipt.verdict, "over-capacity");
      assert.equal(affectedArgs.length, 0, "a refused host admission must never start affected tests");
    });
  }
});
