import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";

// @ts-expect-error — the executable script has no declaration output.
import * as workflowGuard from "../scripts/workflow-guard-mutation-ratchet.mjs";

interface Guard { line: number; text: string }
interface Scratch { root: string; cleanup(): void }
const { main, enumerateSkipGuards, mutateGuardLine, createScratchCopy, scratchPrefix } = workflowGuard as {
  main(argv: string[], io: Record<string, unknown>): number;
  enumerateSkipGuards(text: string): Guard[];
  mutateGuardLine(text: string, guard: Guard): string;
  createScratchCopy(root: string, suites: string[], parent: string): Scratch;
  scratchPrefix(root: string): string;
};

const PROOF = "test/a-ci-yml-mutant-never-touches-the-working-tree.test.ts";
const WORKFLOW = ".github/workflows/ci.yml";
const ORIGINAL = 'jobs:\n  j:\n    steps:\n      - run: |\n          if [ "$A" = "1" ]; then\n            exit 0\n          fi\n          [ "$B" = "1" ] || {\n            exit 0\n          }\n';
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function fixture() {
  const repo = gitRepo({ kind: "workflow-mutant" });
  const parent = mkdtempSync(join(tmpdir(), "rmd-workflow-mutant-test-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  write(WORKFLOW, ORIGINAL.replace('$A', '$COMMITTED'));
  write("test/reader.test.ts", "committed reader\n");
  write("test/deleted.test.ts", "deleted after commit\n");
  write("test/helpers/value.ts", "committed helper\n");
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "seed workflow");
  write(WORKFLOW, ORIGINAL);
  write("test/reader.test.ts", "working reader\n");
  write("test/helpers/value.ts", "working helper\n");
  repo.git("add", "test/helpers/value.ts");
  write("test/new.test.ts", "untracked reader\n");
  rmSync(join(repo.dir, "test/deleted.test.ts"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"), "dir");
  const path = join(repo.dir, WORKFLOW);
  const bytes = readFileSync(path);
  const mtime = statSync(path, { bigint: true }).mtimeNs;
  const unchanged = () => {
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path, { bigint: true }).mtimeNs, mtime);
  };
  const io = {
    root: repo.dir, scratchParent: parent,
    readBaseline: () => ({ guards: {} }),
    suites: () => ["test/reader.test.ts", "test/new.test.ts"],
    log: () => {}, err: () => {},
  };
  return { repo, parent, path, io, unchanged, write, cleanup: () => { repo.cleanup(); rmSync(parent, { recursive: true, force: true }); } };
}

function installRatchet(f: ReturnType<typeof fixture>) {
  for (const path of ["scripts/workflow-guard-mutation-ratchet.mjs", "scripts/comment-load-ratchet.mjs",
    "scripts/lib/argv.mjs", "scripts/lib/json-duplicate-keys.mjs", "scripts/lib/git.mjs"]) {
    f.write(path, readFileSync(join(REPO_ROOT, path), "utf8"));
  }
  f.write("test/reader.test.ts", `// ${WORKFLOW}\n`);
  return pathToFileURL(join(f.repo.dir, "scripts/workflow-guard-mutation-ratchet.mjs")).href;
}

test(`${PROOF}: every mutant is read in one scratch copy and checkout bytes and mtime never change`, () => {
  const f = fixture();
  const reads: Array<{ root: string; text: string }> = [];
  try {
    f.write("scripts/workflow-guard-mutation-ratchet.mjs", "working ratchet\n");
    const code = main(["--all"], {
      ...f.io,
      runSuite: (_suite: string, root: string) => {
        assert.notEqual(root, f.repo.dir);
        f.unchanged();
        assert.equal(readFileSync(join(root, "test/reader.test.ts"), "utf8"), "working reader\n");
        assert.equal(readFileSync(join(root, "test/new.test.ts"), "utf8"), "untracked reader\n");
        assert.equal(readFileSync(join(root, "test/helpers/value.ts"), "utf8"), "working helper\n");
        assert.equal(readFileSync(join(root, "scripts/workflow-guard-mutation-ratchet.mjs"), "utf8"), "working ratchet\n");
        assert.equal(existsSync(join(root, "test/deleted.test.ts")), false);
        assert.equal(realpathSync(join(root, "node_modules")), realpathSync(join(f.repo.dir, "node_modules")));
        const text = readFileSync(join(root, WORKFLOW), "utf8");
        reads.push({ root, text });
        return { failed: text !== ORIGINAL };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(reads.map(r => r.text), [ORIGINAL, ORIGINAL, ...enumerateSkipGuards(ORIGINAL).map(g => mutateGuardLine(ORIGINAL, g))]);
    assert.equal(new Set(reads.map(r => r.root)).size, 1);
    assert.equal(existsSync(reads[0].root), false);
    assert.equal(f.repo.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    f.unchanged();
  } finally { f.cleanup(); }
});

test(`${PROOF}: a throwing mutant runner leaves checkout bytes and mtime unchanged and removes the scratch copy`, () => {
  const f = fixture();
  let scratch = "";
  const failure = new Error("runner crashed under mutant");
  try {
    assert.throws(() => main(["--all"], {
      ...f.io,
      runSuite: (_suite: string, root: string) => {
        scratch = root;
        f.unchanged();
        if (readFileSync(join(root, WORKFLOW), "utf8") !== ORIGINAL) throw failure;
        return { failed: false };
      },
    }), error => error === failure);
    assert.ok(scratch);
    assert.equal(existsSync(scratch), false);
    assert.equal(f.repo.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    f.unchanged();
  } finally { f.cleanup(); }
});

test(`${PROOF}: the next run reclaims a dead owner's scratch copy and retains a live owner's copy`, () => {
  const f = fixture();
  const staleDir = join(f.parent, `${scratchPrefix(f.repo.dir)}2147483647-stale`);
  const staleRoot = join(staleDir, "checkout");
  let live: Scratch | undefined;
  try {
    mkdirSync(staleDir);
    f.repo.git("worktree", "add", "--quiet", "--detach", staleRoot, "HEAD");
    writeFileSync(join(staleRoot, WORKFLOW), "abandoned mutant\n");
    assert.ok(existsSync(staleRoot));
    live = createScratchCopy(f.repo.dir, [], f.parent);
    assert.equal(existsSync(staleDir), false);
    assert.doesNotMatch(f.repo.git("worktree", "list", "--porcelain"), /2147483647-stale/);
    assert.equal(main(["--all"], { ...f.io, runSuite: () => ({ failed: false }) }), 0);
    assert.ok(existsSync(live.root));
    f.unchanged();
  } finally { live?.cleanup(); f.cleanup(); }
});

test(`${PROOF}: the real suite process reads the scratch workflow and the working test`, () => {
  const f = fixture();
  const testContext = process.env.NODE_TEST_CONTEXT;
  try {
    f.write("test/reader.test.ts", [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      `test("working reader notices mutation", () => assert.equal(readFileSync("${WORKFLOW}", "utf8"), ${JSON.stringify(ORIGINAL)}));`,
    ].join("\n"));
    f.write("test/setup/tmp-hygiene.ts", "export {};\n");
    const logs: string[] = [];
    // Node otherwise refuses a child test runner invoked from a test file.
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(main(["--all"], { ...f.io, suites: () => ["test/reader.test.ts"], log: (m: string) => logs.push(m) }), 0);
    assert.equal(logs.filter(l => l.startsWith("COVERED")).length, enumerateSkipGuards(ORIGINAL).length);
    f.unchanged();
  } finally {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
    f.cleanup();
  }
});

test(`${PROOF}: scratch setup failure removes the worktree registration and directory`, () => {
  const f = fixture();
  try {
    rmSync(join(f.repo.dir, "node_modules"));
    assert.throws(() => createScratchCopy(f.repo.dir, [], f.parent), { code: "ENOENT" });
    assert.deepEqual(readdirSync(f.parent), []);
    assert.equal(f.repo.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    f.unchanged();
  } finally { f.cleanup(); }
});

test(`${PROOF}: standalone withMutant defaults to scratch and cleans up after a throwing callback`, async () => {
  const f = fixture();
  try {
    const { withMutant } = await import(installRatchet(f)) as {
      withMutant(guard: Guard, original: string, callback: (root: string) => void): void;
    };
    const guard = enumerateSkipGuards(ORIGINAL)[0];
    let scratch = "";
    const failure = new Error("standalone runner failure");
    assert.throws(() => withMutant(guard, ORIGINAL, root => {
      scratch = root;
      assert.notEqual(root, f.repo.dir);
      assert.equal(readFileSync(join(root, WORKFLOW), "utf8"), mutateGuardLine(ORIGINAL, guard));
      f.unchanged();
      throw failure;
    }), error => error === failure);
    assert.ok(scratch);
    assert.equal(existsSync(dirname(scratch)), false);
    f.unchanged();
  } finally { f.cleanup(); }
});

test(`${PROOF}: process exit cleans up and a sigkill leaves only a reclaimable scratch mutant`, () => {
  const f = fixture();
  let survivor = "";
  try {
    const moduleUrl = installRatchet(f);
    for (const shutdown of ["process.exit(7)", 'process.kill(process.pid, "SIGKILL")']) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { withMutant, enumerateSkipGuards } from ${JSON.stringify(moduleUrl)};
        import { readFileSync, writeSync } from "node:fs";
        const original = readFileSync(${JSON.stringify(f.path)}, "utf8");
        withMutant(enumerateSkipGuards(original)[0], original, root => {
          writeSync(1, root + "\\n");
          ${shutdown};
        });
      `], { encoding: "utf8" });
      assert.equal(result.stderr, "");
      survivor = result.stdout.trim();
      assert.ok(survivor);
      f.unchanged();
      if (result.signal === "SIGKILL") {
        assert.equal(readFileSync(join(survivor, WORKFLOW), "utf8"), mutateGuardLine(ORIGINAL, enumerateSkipGuards(ORIGINAL)[0]));
        const next = createScratchCopy(f.repo.dir, [], tmpdir());
        next.cleanup();
      } else assert.equal(result.status, 7);
      assert.equal(existsSync(dirname(survivor)), false);
      survivor = "";
    }
    assert.equal(f.repo.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  } finally {
    if (survivor) rmSync(dirname(survivor), { recursive: true, force: true });
    f.cleanup();
  }
});
