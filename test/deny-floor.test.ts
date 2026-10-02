import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T203 acceptance criterion 4: "the deny-floor refuses a worker attempt to
// POST a commit status, and that refusal is asserted against the floor script
// itself rather than described." So this test spawns the ACTUAL hook script
// (hooks/deny-floor.sh) as the real PreToolUse hook JSON contract does — never
// a description of what the script is supposed to do, never a re-implemented
// stand-in of its regex.

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

// W1-T3275 — EVERY CASE GETS ITS OWN CACHE ROOT. Rule 9 paces read-shaped `gh` calls using a stamp
// under `$XDG_CACHE_HOME`. Without isolation these cases would read and WRITE the developer's real
// `~/.cache/remudero` stamp: the suite would become order-dependent (the second bare-`gh` case
// refused by the first), and running the tests would silently consume the session's own cadence
// budget. A fresh root per call keeps each case a statement about the hook, not about what ran
// before it.
function runDenyFloor(command: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({ tool_input: { command } });
  const cacheHome = mkdtempSync(join(tmpdir(), "rmd-denyfloor-cache-"));
  try {
    const result = spawnSync("bash", [HOOK_PATH], {
      input,
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}

// Rule 8 (W1-T2312) keys off the PROJECT directory, not the hook process's own
// $PWD, so these calls carry the real PreToolUse payload shape: a top-level `cwd`
// alongside `tool_input.command` (BaseHookInput.cwd, sdk.d.ts).
function runDenyFloorAt(command: string, cwd: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({ cwd, tool_input: { command } });
  const cacheHome = mkdtempSync(join(tmpdir(), "rmd-denyfloor-cache-"));
  try {
    const result = spawnSync("bash", [HOOK_PATH], {
      input,
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}

test("deny-floor: refuses a worker POSTing the remudero-review commit status via `gh api`", () => {
  const { status, stderr } = runDenyFloor(
    "gh api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success",
  );
  assert.equal(status, 2);
  assert.match(stderr, /blocked/i);
});

test("deny-floor: refuses a hostile FAIL post identically to a forged PASS post — the floor blocks the ACT of posting, not a particular state", () => {
  const pass = runDenyFloor("gh api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success");
  const fail = runDenyFloor("gh api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=failure");
  assert.equal(pass.status, 2);
  assert.equal(fail.status, 2);
});

test("deny-floor: refuses regardless of flag spelling (--method POST) or argument order", () => {
  const longFlag = runDenyFloor(
    "gh api --method POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success",
  );
  assert.equal(longFlag.status, 2);

  const reordered = runDenyFloor(
    "gh api repos/o/r/statuses/abc123 -X POST -f context=remudero-review -f state=success",
  );
  assert.equal(reordered.status, 2);
});

test("deny-floor: refuses a POST to ANY commit-status context, not only remudero-review — the endpoint is the forge surface, not one context name", () => {
  const { status } = runDenyFloor("gh api -X POST repos/o/r/statuses/abc123 -f context=some-other-check -f state=success");
  assert.equal(status, 2);
});

test("deny-floor: does NOT block reading commit statuses (GET, no -X POST) — the floor owns POSTing, not observing", () => {
  const { status } = runDenyFloor("gh api repos/o/r/commits/abc123/statuses");
  assert.equal(status, 0);
});

test("deny-floor: does NOT collaterally block ordinary, unrelated gh usage", () => {
  const view = runDenyFloor("gh pr view 42 --json state");
  assert.equal(view.status, 0);
  const diff = runDenyFloor("gh pr diff https://github.com/o/r/pull/42");
  assert.equal(diff.status, 0);
});

test("deny-floor: refuses every ordinary worker route that merges or arms a pull request", () => {
  const commands = [
    "gh pr merge 42 --squash",
    "gh pr merge https://github.com/o/r/pull/42 --auto --squash",
    "gh --repo o/r pr merge 42 --squash",
    "gh -R=o/r pr merge 42 --auto --squash",
    "gh api -X PUT repos/o/r/pulls/42/merge -f merge_method=squash",
    "gh api repos/o/r/pulls/42/merge --method=PUT -f merge_method=squash",
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { pullRequest { merged } } }'`,
    `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_x"}) { pullRequest { autoMergeRequest { enabledAt } } }'`,
  ];
  for (const command of commands) {
    const { status, stderr } = runDenyFloor(command);
    assert.equal(status, 2, `expected refusal for: ${command}`);
    assert.match(stderr, /only the orchestrator|merge endpoint|GraphQL mutation/i);
  }
});

test("deny-floor: still permits the PR writes a worker owns", () => {
  for (const command of [
    "gh pr create --title 'fix(test): repair' --fill --base main",
    "gh pr edit 42 --body-file /tmp/body.md",
    "gh api -X PATCH repos/o/r/pulls/42 -f body='updated'",
  ]) {
    assert.equal(runDenyFloor(command).status, 0, `expected worker-owned write to remain allowed: ${command}`);
  }
});

test("deny-floor: pre-existing rules still hold (regression) — force-push to main is still blocked", () => {
  const { status, stderr } = runDenyFloor("git push --force origin main");
  assert.equal(status, 2);
  assert.match(stderr, /force/i);
});

// W1-T1066 — a lane polled `gh` 80 times at a 45-second cadence against an 8-13
// minute CI cycle and locked the operator out of his own repo for ~90 minutes,
// tripping the SECONDARY rate limit (cadence, not volume). Rule 6 refuses the
// observed shape at the tool boundary: a single command carrying a loop keyword
// AND `sleep` AND a `gh` invocation.

test("W1-T1066: a gh call inside a loop with a sleep is refused", () => {
  const forLoop = runDenyFloor(
    'for i in $(seq 1 25); do gh pr view 42 --json state; sleep 20; done',
  );
  assert.equal(forLoop.status, 2);
  assert.match(forLoop.stderr, /blocked/i);

  const untilLoop = runDenyFloor(
    'until [ "$(gh run view 123 --json status -q .status)" = "completed" ]; do sleep 20; done',
  );
  assert.equal(untilLoop.status, 2);
  assert.match(untilLoop.stderr, /blocked/i);
});

test("W1-T1066: a bare gh call is still allowed", () => {
  const { status } = runDenyFloor("gh pr view 42 --json state");
  assert.equal(status, 0);
});

test("W1-T1066: a loop with a sleep and no gh call is still allowed", () => {
  const localFileWait = runDenyFloor(
    "until [ -f coverage/lcov.info ]; do sleep 30; done",
  );
  assert.equal(localFileWait.status, 0);

  const noGhForLoop = runDenyFloor(
    'for f in *.ts; do echo "$f"; done',
  );
  assert.equal(noGhForLoop.status, 0);

  const bareSleep = runDenyFloor("sleep 30");
  assert.equal(bareSleep.status, 0);
});

test("W1-T1066: the refusal names cadence rather than a bare blocked", () => {
  const { status, stderr } = runDenyFloor(
    'while :; do gh pr view 42 --json state; sleep 45; done',
  );
  assert.equal(status, 2);
  assert.match(stderr, /polling/i);
  assert.match(stderr, /gh/i);
  assert.notEqual(stderr.trim(), "deny-floor: blocked");
});

// W1-T2312 — THE WORKTREE INSTALL HAD NO TOOL-BOUNDARY REFUSAL. `linkWorktreeNodeModules`
// symlinks every worker worktree's `node_modules` to the canonical checkout on purpose, so
// an `npm ci`/`npm install` typed straight into a Bash tool call empties the SHARED tree
// through that link (the 2026-08-05/08-11 outages) — `SymlinkInstallRefusal` guards only
// rmd's own install path, never a raw Bash command. Rule 8 is the tool-boundary refusal;
// these tests spawn the real hook script against a real symlinked/real/absent
// `node_modules`, never a description of the regex.

test("W1-T2312: an install is refused when the project's node_modules is a symlink", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    const { status, stderr } = runDenyFloorAt("npm ci", worktree);
    assert.equal(status, 2);
    assert.match(stderr, /empties the shared node_modules through the symlink/);

    const install = runDenyFloorAt("npm install", worktree);
    assert.equal(install.status, 2);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

test("W1-T2312: an install is allowed when node_modules is real or absent — the symlink test is the discriminator", () => {
  const realTree = mkdtempSync(join(tmpdir(), "deny-floor-real-"));
  mkdirSync(join(realTree, "node_modules"));
  const noTree = mkdtempSync(join(tmpdir(), "deny-floor-none-"));

  try {
    assert.equal(runDenyFloorAt("npm ci", realTree).status, 0);
    assert.equal(runDenyFloorAt("npm install", realTree).status, 0);
    assert.equal(runDenyFloorAt("npm ci", noTree).status, 0);
    assert.equal(runDenyFloorAt("npm install", noTree).status, 0);
  } finally {
    rmSync(realTree, { recursive: true, force: true });
    rmSync(noTree, { recursive: true, force: true });
  }
});

test("W1-T2312: non-installing npm verbs are never blocked, even with a symlinked node_modules", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    assert.equal(runDenyFloorAt("npm run build", worktree).status, 0);
    assert.equal(runDenyFloorAt("npm test", worktree).status, 0);
    assert.equal(runDenyFloorAt("npm ls", worktree).status, 0);
    assert.equal(runDenyFloorAt("npm run typecheck", worktree).status, 0);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

test("W1-T2312: pnpm/yarn install equivalents are refused too when node_modules is a symlink", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    assert.equal(runDenyFloorAt("pnpm install", worktree).status, 2);
    assert.equal(runDenyFloorAt("yarn install", worktree).status, 2);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

test("W1-T2312: the refusal names the shared-tree mechanism and the remedy, not a bare blocked", () => {
  const canonical = mkdtempSync(join(tmpdir(), "deny-floor-canonical-"));
  mkdirSync(join(canonical, "node_modules"));
  const worktree = mkdtempSync(join(tmpdir(), "deny-floor-worktree-"));
  symlinkSync(join(canonical, "node_modules"), join(worktree, "node_modules"));

  try {
    const { stderr } = runDenyFloorAt("npm ci", worktree);
    assert.match(stderr, /refreshing the canonical checkout/);
    assert.match(stderr, /typecheck\/test/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
  }
});

// W1-T5016 — WORKER FILE TOOLS STAY IN THE ASSIGNED WORKTREE. Workers run under bypassPermissions, so the
// deny-floor is the only per-call check a Read/Write/Edit/MultiEdit/NotebookEdit reaches. Before this task
// the hook read `file_path` and `cwd` and never compared them, and settings/worker.json's matcher omitted
// Read entirely. These cases run the hook through the EXACT command settings/worker.json configures
// (`${HOOKS_DIR}` rendered the way renderWorkerSettings renders it), with the env the CLI hands a hook:
// CLAUDE_PROJECT_DIR is the session's launch directory, i.e. spawnWorker's cwd — the assigned worktree.

const WORKER_SETTINGS_PATH = fileURLToPath(new URL("../settings/worker.json", import.meta.url));
const HOOKS_DIR = fileURLToPath(new URL("../hooks", import.meta.url));

interface WorkerHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

function workerFloorEntry(): WorkerHookEntry {
  const settings = JSON.parse(readFileSync(WORKER_SETTINGS_PATH, "utf8")) as {
    hooks: { PreToolUse: WorkerHookEntry[] };
  };
  const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("deny-floor.sh")));
  assert.ok(entry, "settings/worker.json must route PreToolUse through hooks/deny-floor.sh");
  return entry;
}

function workerFloorCommand(): string {
  const hook = workerFloorEntry().hooks.find((h) => h.command.includes("deny-floor.sh"));
  assert.ok(hook);
  return hook.command.split("${HOOKS_DIR}").join(HOOKS_DIR);
}

interface FileToolFixture {
  root: string;
  worktree: string;
  sibling: string;
  scratch: string;
  home: string;
}

// Every path lives under one fixture root, and the hook's TMPDIR is a dedicated `scratch` child of it, so
// the sibling checkout is NOT under the scratch root the floor legitimately allows.
function fileToolFixture(): FileToolFixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5016-`));
  const worktree = join(root, "worktree");
  const sibling = join(root, "sibling-checkout");
  const scratch = join(root, "scratch");
  const home = join(root, "worker-home-run1");
  for (const dir of [join(worktree, "src"), join(sibling, "src"), scratch, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(sibling, "src", "a.ts"), "export const a = 1;\n");
  return { root, worktree, sibling, scratch, home };
}

function runWorkerFileTool(
  fx: FileToolFixture,
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: { cwd?: string; projectDir?: string | null; command?: string } = {},
): { status: number | null; stderr: string } {
  const payload: Record<string, unknown> = { tool_name: toolName, tool_input: toolInput };
  if (opts.cwd !== "") payload.cwd = opts.cwd ?? fx.worktree;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.home,
    TMPDIR: fx.scratch,
    XDG_CACHE_HOME: join(fx.root, "cache"),
    CLAUDE_PROJECT_DIR: opts.projectDir ?? fx.worktree,
  };
  if (opts.projectDir === null) delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync("bash", ["-c", opts.command ?? workerFloorCommand()], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  return { status: result.status, stderr: result.stderr };
}

test("W1-T5016: file tools refuse paths outside the assigned worktree", () => {
  const fx = fileToolFixture();
  try {
    const matcher = workerFloorEntry().matcher.split("|");
    for (const tool of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      assert.ok(matcher.includes(tool), `the worker matcher must route ${tool} through the floor`);
    }

    const outside = join(fx.sibling, "src", "a.ts");
    for (const tool of ["Read", "Write", "Edit", "MultiEdit"]) {
      const { status, stderr } = runWorkerFileTool(fx, tool, { file_path: outside });
      assert.equal(status, 2, `${tool} of a sibling checkout must be refused`);
      assert.match(stderr, /outside the assigned worktree/);
      assert.match(stderr, /W1-T5016/);
    }
    assert.equal(runWorkerFileTool(fx, "NotebookEdit", { notebook_path: join(fx.sibling, "n.ipynb") }).status, 2);
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: "../sibling-checkout/src/a.ts" }).status, 2);
    assert.equal(
      runWorkerFileTool(fx, "Edit", { file_path: `${fx.worktree}/../sibling-checkout/src/a.ts` }).status,
      2,
      "a `..` component never reaches outside the worktree",
    );

    // In-worktree work stays available, including a new file under directories that do not exist yet.
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: join(fx.worktree, "src", "a.ts") }).status, 0);
    assert.equal(runWorkerFileTool(fx, "Edit", { file_path: join(fx.worktree, "src", "a.ts") }).status, 0);
    assert.equal(runWorkerFileTool(fx, "MultiEdit", { file_path: join(fx.worktree, "src", "a.ts") }).status, 0);
    assert.equal(runWorkerFileTool(fx, "Write", { file_path: join(fx.worktree, "src", "new", "deep.ts") }).status, 0);
    assert.equal(runWorkerFileTool(fx, "NotebookEdit", { notebook_path: join(fx.worktree, "n.ipynb") }).status, 0);
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: "src/a.ts" }).status, 0, "a relative path resolves against cwd");

    // The enumerated scratch and worker-home roots.
    assert.equal(runWorkerFileTool(fx, "Write", { file_path: join(fx.scratch, "pr-body.md") }).status, 0);
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: join(fx.home, "notes.txt") }).status, 0);
    // The CLI persists large tool output under $HOME/.claude/projects/<sanitized project dir>/; a worker home's
    // `.claude` is a symlink to a shared credential tree, so only this session's own project dir is reachable.
    const fleetClaude = join(fx.root, "fleet-claude");
    const projectSlug = fx.worktree.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(fleetClaude, "projects", projectSlug, "session-1", "tool-results"), { recursive: true });
    writeFileSync(join(fleetClaude, ".credentials.json"), "{}\n");
    symlinkSync(fleetClaude, join(fx.home, ".claude"));
    assert.equal(
      runWorkerFileTool(fx, "Read", {
        file_path: join(fx.home, ".claude", "projects", projectSlug, "session-1", "tool-results", "out.txt"),
      }).status,
      0,
    );
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: join(fx.home, ".claude", ".credentials.json") }).status, 2);

    // Fail closed: no path, or no assigned worktree to compare against.
    assert.equal(runWorkerFileTool(fx, "Write", { content: "x" }).status, 2);
    assert.equal(
      runWorkerFileTool(fx, "Read", { file_path: join(fx.worktree, "src", "a.ts") }, { cwd: "", projectDir: null }).status,
      2,
    );

    // The confinement is the WORKER lane's: the interactive lane's bare invocation is unchanged.
    assert.equal(
      runWorkerFileTool(fx, "Edit", { file_path: outside }, { command: `bash ${join(HOOKS_DIR, "deny-floor.sh")}` }).status,
      0,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("W1-T5016: file tool confinement resolves symlink parents", () => {
  const fx = fileToolFixture();
  try {
    // A directory link inside the worktree that leads to a sibling checkout.
    symlinkSync(fx.sibling, join(fx.worktree, "escape"));
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: join(fx.worktree, "escape", "src", "a.ts") }).status, 2);
    assert.equal(runWorkerFileTool(fx, "Write", { file_path: join(fx.worktree, "escape", "new", "b.ts") }).status, 2);

    // A dangling link: Write would create its target outside the worktree.
    symlinkSync(join(fx.sibling, "created-by-write.ts"), join(fx.worktree, "src", "dangling.ts"));
    const dangling = runWorkerFileTool(fx, "Write", { file_path: join(fx.worktree, "src", "dangling.ts") });
    assert.equal(dangling.status, 2);
    assert.match(dangling.stderr, /outside the assigned worktree/);

    // The harness-linked node_modules: readable through the worktree's own link, never writable through it.
    const sharedDeps = join(fx.root, "shared-deps", "node_modules");
    mkdirSync(join(sharedDeps, "pkg"), { recursive: true });
    writeFileSync(join(sharedDeps, "pkg", "index.d.ts"), "export {};\n");
    symlinkSync(sharedDeps, join(fx.worktree, "node_modules"));
    const dts = join(fx.worktree, "node_modules", "pkg", "index.d.ts");
    assert.equal(runWorkerFileTool(fx, "Read", { file_path: dts }).status, 0);
    assert.equal(runWorkerFileTool(fx, "Write", { file_path: dts }).status, 2);
    assert.equal(runWorkerFileTool(fx, "Edit", { file_path: dts }).status, 2);

    // The worktree itself named through a link: both sides are canonicalized before they are compared.
    const worktreeLink = join(fx.root, "worktree-link");
    symlinkSync(fx.worktree, worktreeLink);
    const viaLink = { projectDir: worktreeLink, cwd: worktreeLink };
    assert.equal(runWorkerFileTool(fx, "Edit", { file_path: join(fx.worktree, "src", "a.ts") }, viaLink).status, 0);
    assert.equal(runWorkerFileTool(fx, "Edit", { file_path: join(worktreeLink, "src", "a.ts") }, viaLink).status, 0);
    assert.equal(runWorkerFileTool(fx, "Edit", { file_path: join(fx.sibling, "src", "a.ts") }, viaLink).status, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
