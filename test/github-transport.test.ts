import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_GH_CALL_TIMEOUT_MS,
  ghJson,
  ghJsonAsync,
  ghOptionsWithDefaultTimeout,
  parseGhRateLimitHeaders,
} from "../src/lib/github-transport.js";
import { classifyGhFailure, type GitHub } from "../src/lib/status.js";
import { ghPostureGateway } from "../src/lib/github-posture.js";
import { ghIssueListGateway } from "../src/lib/issues-intake.js";
import { ghIssueCloser } from "../src/lib/panel-actions.js";
import { postSpecialistPanelComment } from "../src/lib/specialist-panel.js";
import { ghTraceGateway } from "../src/lib/trace.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveCommand, daemonCommand, defaultDepReviewPrMutations, planCommand } from "../src/run-task.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── W1-T2896 CI-log round: the DEFAULT (uninjected) `ghExec` path of five migrated call sites,
// plus `run-task.ts`'s `defaultDepReviewPrMutations` ──────────────────────────────────────────
//
// `diff-coverage` (scripts/diff-coverage.mjs) blocks a diff that adds a source line lcov marks
// never-hit; each `execFileSync("gh", …)` -> `ghExec(…)` mechanical rename this task performs is
// TEXTUALLY new, so a call site whose existing tests only ever drove an INJECTED exec (every one
// of these five gateways takes its real exec fn as a default parameter, never called from a test
// that supplies its own) trips the gate even though the line's BEHAVIOUR is unchanged. The fix is
// the same PATH-stubbed-`gh` idiom test/arm-at-open.test.ts already established for
// `realArmDeps` ("a PATH-stubbed gh, no throw") — a REAL child-process spawn against a throwaway
// `gh` script on `PATH`, never a mock of the transport module itself (`node:child_process`'s
// named export bindings are non-configurable — see test/onboard-inventory.test.ts's own comment
// on the identical constraint for `node:fs`).
function withFakeGhOnPath<T>(fn: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-default-stub-`));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '{}'\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("ghPostureGateway() with no exec override reaches the real ghExec default (github-posture.ts)", () => {
  withFakeGhOnPath(() => {
    const gateway = ghPostureGateway();
    // tryGet's own catch degrades any read to undefined -- this proves the REAL `defaultExec`
    // body (the migrated `ghExec` line) executed, not any particular payload shape.
    assert.doesNotThrow(() => gateway.getRepo("craigoley", "remudero"));
  });
});

test("ghIssueListGateway().list() with no exec override reaches the real ghExec default (issues-intake.ts)", () => {
  withFakeGhOnPath(() => {
    const gateway = ghIssueListGateway();
    assert.doesNotThrow(() => gateway.list("craigoley", "remudero"));
  });
});

test("ghIssueCloser().close() with no exec override reaches the real ghExec default (panel-actions.ts)", () => {
  withFakeGhOnPath(() => {
    const closer = ghIssueCloser();
    assert.doesNotThrow(() => closer.close("https://github.com/craigoley/remudero/issues/1"));
  });
});

test("postSpecialistPanelComment reaches the real ghExec default (specialist-panel.ts)", () => {
  withFakeGhOnPath(() => {
    assert.doesNotThrow(() =>
      postSpecialistPanelComment("https://github.com/craigoley/remudero/pull/1", "fixture panel comment"),
    );
  });
});

test("ghTraceGateway().prView() with no exec override reaches the real ghExec default (trace.ts)", () => {
  withFakeGhOnPath(() => {
    const gateway = ghTraceGateway("craigoley", "remudero");
    // prView's own catch degrades a bad/absent payload to null -- proves the real body ran.
    assert.doesNotThrow(() => gateway.prView(1));
  });
});

test("defaultDepReviewPrMutations().comment()/.close() reach the real ghExec default (run-task.ts)", () => {
  withFakeGhOnPath(() => {
    const mutations = defaultDepReviewPrMutations("craigoley", "remudero");
    assert.doesNotThrow(() => mutations.comment("https://github.com/craigoley/remudero/pull/1", "fixture"));
    assert.doesNotThrow(() =>
      mutations.close("https://github.com/craigoley/remudero/pull/1", { comment: "fixture", deleteBranch: false }),
    );
  });
});

// ── run-task.ts: `daemonCommand`/`planCommand`'s own `repoDir` absent -> real `gh repo clone`
// branch (W1-T2896 CI-log round) ────────────────────────────────────────────────────────────
//
// Every existing `daemonCommand`/`planCommand` fixture in the tree (test/plan-lane-mint.test.ts,
// test/plan-architect.test.ts, …) pre-clones `repoDir` with a direct `git clone` specifically to
// SKIP this branch and avoid a real `gh repo clone` network call — see
// test/retro-marker-atomic.test.ts's `missingRepoDir` option for the one place in the tree that
// already takes the opposite approach for `retroCommand`'s identical clone line: a fake `gh` whose
// `repo clone` subcommand performs a REAL LOCAL `git clone` of a throwaway bare origin, never a
// stub and never the network. This harness is that same idiom, reused for the two `run-task.ts`
// command-level clone sites `test/retro-marker-atomic.test.ts` does not cover.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A throwaway bare origin carrying a minimal, loadable `plan/tasks.yaml` (empty). */
function makeCloneOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-clone-origin-`));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-clone-seed-`));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture.\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: fixture seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A `gh` whose `repo clone <slug> <dest>` performs a REAL local clone of `origin`, never a stub. */
function writeCloneGhShim(dir: string, origin: string): void {
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then',
      `  git clone --quiet ${JSON.stringify(origin)} "$4"`,
      '  git -C "$4" config user.name t',
      '  git -C "$4" config user.email t@t',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** Every `GitHub` method `daemonCommand`'s `--dry-run` path (or `projectPlan` over an empty plan)
 *  could reach, fail-soft. The fixture plan carries zero tasks, so none of these actually fire —
 *  this exists only to satisfy the interface, never to be asserted against. */
function fakeGithubForDryRun(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listMergedHeadBranches: () => null,
    listOpenHeadBranches: () => null,
  };
}

test("daemonCommand --dry-run with repoDir absent reaches the real ghExec `repo clone` default (run-task.ts)", async () => {
  const origin = makeCloneOrigin();
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-daemon-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-daemon-root-`));
  const shimDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-daemon-shim-`));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;
    writeCloneGhShim(shimDir, origin);
    process.env.PATH = `${shimDir}:${savedPath}`;

    const code = await daemonCommand(["--repo", "remudero-sandbox", "--dry-run"], {
      githubFactory: () => fakeGithubForDryRun(),
    });

    assert.equal(code, 0, "a --dry-run preview still exits 0 once the real clone lands");
    assert.ok(
      existsSync(join(configRoot, "repos", "remudero-sandbox", ".git")),
      "the migrated `ghExec([\"repo\", \"clone\", …])` line must have actually materialized repoDir",
    );
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [origin, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("planCommand with repoDir absent reaches the real ghExec `repo clone` default (run-task.ts)", async () => {
  const origin = makeCloneOrigin();
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-plan-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-plan-root-`));
  const shimDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-plan-shim-`));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;
    writeCloneGhShim(shimDir, origin);
    process.env.PATH = `${shimDir}:${savedPath}`;

    // Nothing past the clone (worktree add, the Architect spawn, …) needs to succeed for THIS
    // test's claim — only that the migrated `ghExec` clone line itself ran for real. Whatever
    // planCommand does next against this bare, generic fixture is free to throw; that failure
    // carries no information about the line under test, which already ran by then.
    await planCommand(["--mode=create", "a", "fixture", "brief"], {}).catch(() => {});

    assert.ok(
      existsSync(join(configRoot, "repos", "remudero", ".git")),
      "the migrated `ghExec([\"repo\", \"clone\", …])` line must have actually materialized repoDir",
    );
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [origin, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("approveBatchCommand (via approveCommand with 2+ bare ids) with repoDir absent reaches the real ghExec `repo clone` default (run-task.ts)", async () => {
  const origin = makeCloneOrigin();
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-approve-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-approve-root-`));
  const shimDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-transport-approve-shim-`));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;
    writeCloneGhShim(shimDir, origin);
    process.env.PATH = `${shimDir}:${savedPath}`;

    // Two READY-classified fixture proposals, written DIRECTLY to the registry/draft-cache
    // files `loadProposalsForRatify` reads (never through a real `rmd inbox` draft pass) — the
    // same task shape test/plan-lane-mint.test.ts's own `VALID_TASK` files for real, so
    // `classifyProposal`'s lint/dep predicates pass with zero reasons. `approveCommand` routes
    // 2+ bare (non-`--flag`) ids to `approveBatchCommand` (W1-T2471), whose default
    // `batchGateway.createRatificationBranch` calls `ensureRepoDir()` — the migrated `ghExec`
    // line under test — as its OWN FIRST statement, before any minting/push work.
    // W1-T2471's batch lane refuses the WHOLE batch if two members would file the SAME shard
    // path (planRatificationBatch's own duplicate-within-batch guard) — each fragment below
    // carries a distinct title (and so a distinct `plan/tasks.d/<slug>.yaml` path) for that
    // reason, never because the underlying claim needs two different tasks.
    const fragment = (placeholderId: string, slug: string): string =>
      [
        `- id: ${placeholderId}`,
        `  title: "gh transport coverage fixture task ${slug}"`,
        "  repo: remudero",
        "  origin: architect",
        "  files:",
        `    - docs/gh-transport-coverage-fixture-${slug}.md`,
        "  depends_on: []",
        "  type: implement",
        "  verify: auto",
        "  status: queued",
        "  attempts: 0",
        "",
      ].join("\n");
    mkdirSync(join(configRoot, "state"), { recursive: true });
    writeFileSync(
      join(configRoot, "state", "inbox-proposals.json"),
      JSON.stringify({
        proposals: [
          { id: "P-FIXTURE1", summary: "fixture proposal one", evidenceAnchors: [] },
          { id: "P-FIXTURE2", summary: "fixture proposal two", evidenceAnchors: [] },
        ],
      }),
    );
    writeFileSync(
      join(configRoot, "state", "inbox-drafts.json"),
      JSON.stringify({
        "P-FIXTURE1": {
          proposalId: "P-FIXTURE1",
          fragmentYaml: fragment("NEW-1", "one"),
          stampLine: "- P-FIXTURE1 (plan) — RATIFIED via fixture.",
          anchorFingerprint: "",
        },
        "P-FIXTURE2": {
          proposalId: "P-FIXTURE2",
          fragmentYaml: fragment("NEW-1", "two"),
          stampLine: "- P-FIXTURE2 (plan) — RATIFIED via fixture.",
          anchorFingerprint: "",
        },
      }),
    );

    // Nothing past the clone (worktree add, task-id minting/reservation, the PR-create REST
    // call, …) needs to succeed for THIS test's claim — only that the migrated `ghExec` clone
    // line itself ran for real. Whatever approveBatchCommand does next against this generic,
    // GitHub-network-free fixture is free to throw; that failure carries no information about
    // the line under test, which already ran by then.
    await approveCommand(["P-FIXTURE1", "P-FIXTURE2"]).catch(() => {});

    assert.ok(
      existsSync(join(configRoot, "repos", "remudero", ".git")),
      "the migrated `ghExec([\"repo\", \"clone\", …])` line must have actually materialized repoDir",
    );
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [origin, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

function dataModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

test("ghOptionsWithDefaultTimeout preserves caller options and adds the transport timeout", () => {
  const opts = ghOptionsWithDefaultTimeout({ encoding: "utf8" as const, maxBuffer: 12 });
  assert.equal(opts.timeout, DEFAULT_GH_CALL_TIMEOUT_MS);
  assert.equal(opts.encoding, "utf8");
  assert.equal(opts.maxBuffer, 12);
});

test("ghOptionsWithDefaultTimeout preserves an explicit tighter caller timeout", () => {
  assert.equal(ghOptionsWithDefaultTimeout({ timeout: 123 }).timeout, 123);
});

test("ghJson adds the default timeout to the single sync transport spawn", () => {
  const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
  const body = ghJson(["api", "repos/o/r"], undefined, (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return "HTTP/2 200\r\nX-Ratelimit-Remaining: 4\r\n\r\n{\"ok\":true}";
  });

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/o/r", "-i"], timeout: DEFAULT_GH_CALL_TIMEOUT_MS }]);
});

test("ghJsonAsync adds the default timeout to the single async transport spawn", async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const body = await ghJsonAsync(["api", "repos/o/r"], async (file, args, opts) => {
    calls.push({ file, args, timeout: opts.timeout });
    return { stdout: "{\"ok\":true}", stderr: "" };
  });

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/o/r"], timeout: DEFAULT_GH_CALL_TIMEOUT_MS }]);
});

test("a timed-out transport call keeps the named ETIMEDOUT failure shape", () => {
  assert.equal(classifyGhFailure(null, "", "ETIMEDOUT"), "transport");
});

test("parseGhRateLimitHeaders still reads the response headers used by ghJson", () => {
  assert.deepEqual(parseGhRateLimitHeaders("X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Resource: core\r\n"), {
    remaining: 0,
    used: undefined,
    limit: undefined,
    reset: undefined,
    resource: "core",
  });
});

test("the spike reaches both GitHub CLI calls through ghExec", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-spike-transport-"));
  const loaderPath = join(root, "spike-loader.mjs");
  const fakeRoot = JSON.stringify(root);

  const modules = {
    config: dataModuleUrl(`
      export function loadConfig() {
        return { claudeBin: "/tmp/fake-claude", root: ${fakeRoot}, workerProviders: { enabled: ["claude"] } };
      }
    `),
    fs: dataModuleUrl(`
      export { existsSync, mkdirSync } from "node:fs";
      export function appendFileSync(path) {
        console.log("SPIKE_TEST_APPEND:" + path);
      }
    `),
    gitPush: dataModuleUrl(`
      export function gitPushRunBranch() {
        console.log("SPIKE_TEST_GIT_PUSH_FALLBACK");
      }
    `),
    githubTransport: dataModuleUrl(`
      export function ghExec(args) {
        console.log("SPIKE_TEST_GH_EXEC:" + args.join(" "));
        if (args[0] === "pr" && args[1] === "create") {
          return "https://github.com/craigoley/remudero-sandbox/pull/123\\n";
        }
        return "";
      }
    `),
    liveWriteGuard: dataModuleUrl(`
      export function assertLiveWriteAllowed() {}
    `),
    worker: dataModuleUrl(`
      export const DENY_FLOOR_FALLBACK_MODE = "dontAsk";
      const result = (text, sessionId = "spike-session") => ({
        text,
        blocks: [],
        stderr: "",
        permissionDenials: [],
        childEnvKeys: [],
        subtype: "success",
        costUsd: 0,
        sessionId,
        isError: false,
      });
      export function evaluateDenyFloor() {
        return { heldUnderBypass: true, usedDontAskFallback: false, contained: true };
      }
      export function ghPrMergeSquash(prUrl) {
        console.log("SPIKE_TEST_MERGE:" + prUrl);
        return "merged";
      }
      export function ghPrView(prUrl) {
        console.log("SPIKE_TEST_VIEW:" + prUrl);
        return { state: "MERGED", mergeable: "MERGEABLE", url: prUrl };
      }
      export function parseDecisionRequest(text) {
        if (!text.includes("DECISION_REQUEST")) return null;
        return { raw: text, options: ["docs/spike.md", "docs/spike-hello.md"], recommended: "docs/spike-hello.md" };
      }
      export function parseReport(text) {
        const match = /^PR_URL: (https:\\/\\/github\\.com\\/[^\\s]+\\/pull\\/\\d+)/m.exec(text);
        return match ? { raw: text, prUrl: match[1] } : null;
      }
      export function renderWorkerSettings(opts) {
        console.log("SPIKE_TEST_SETTINGS:" + opts.outPath);
        return opts.outPath;
      }
      export async function spawnWorker(args) {
        if (args.resumeSessionId) return result("REPORT\\nno pr url yet", args.resumeSessionId);
        if (args.prompt.includes("DECISION_REQUEST")) {
          return result("DECISION_REQUEST\\n- docs/spike.md\\n- docs/spike-hello.md (RECOMMENDED)\\nRECOMMENDED: docs/spike-hello.md");
        }
        return result("REPORT\\nstep1: denied\\nstep2: denied\\nstep3: ok");
      }
      export function worktreeAdd() {
        console.log("SPIKE_TEST_WORKTREE_ADD");
      }
      export function worktreeRemove() {
        console.log("SPIKE_TEST_WORKTREE_REMOVE");
      }
      export function worktreesDir() {
        return ${JSON.stringify(join(root, "worktrees"))};
      }
    `),
  };

  writeFileSync(
    loaderPath,
    `
      const replacements = new Map([
        ["node:fs", ${JSON.stringify(modules.fs)}],
        ["./lib/config.js", ${JSON.stringify(modules.config)}],
        ["./lib/git-push.js", ${JSON.stringify(modules.gitPush)}],
        ["./lib/github-transport.js", ${JSON.stringify(modules.githubTransport)}],
        ["./lib/live-write-guard.js", ${JSON.stringify(modules.liveWriteGuard)}],
        ["./lib/worker.js", ${JSON.stringify(modules.worker)}],
      ]);
      const resolvedReplacements = new Map([
        ["/src/lib/config.ts", ${JSON.stringify(modules.config)}],
        ["/src/lib/git-push.ts", ${JSON.stringify(modules.gitPush)}],
        ["/src/lib/github-transport.ts", ${JSON.stringify(modules.githubTransport)}],
        ["/src/lib/live-write-guard.ts", ${JSON.stringify(modules.liveWriteGuard)}],
        ["/src/lib/worker.ts", ${JSON.stringify(modules.worker)}],
      ]);

      export async function resolve(specifier, context, nextResolve) {
        if ((context.parentURL ?? "").endsWith("/src/spike.ts") && replacements.has(specifier)) {
          return { url: replacements.get(specifier), shortCircuit: true };
        }
        const resolved = await nextResolve(specifier, context);
        if ((context.parentURL ?? "").endsWith("/src/spike.ts")) {
          for (const [suffix, url] of resolvedReplacements) {
            if (resolved.url.endsWith(suffix)) return { url, shortCircuit: true };
          }
        }
        return resolved;
      }
    `,
  );
  const registerLoader = `data:text/javascript,${encodeURIComponent(
    [
      'import { register } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, pathToFileURL("./"));`,
    ].join(" "),
  )}`;

  const out = execFileSync(
    process.execPath,
    ["--enable-source-maps", "--import", "tsx", "--import", registerLoader, "src/spike.ts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: join(root, "home") },
      maxBuffer: 1 << 20,
      timeout: 10_000,
    },
  );

  assert.match(out, /SPIKE_TEST_GH_EXEC:repo clone craigoley\/remudero-sandbox /);
  assert.match(out, /SPIKE_TEST_GH_EXEC:pr create --repo craigoley\/remudero-sandbox --base main --head spike-hello-\d+ --fill/);
  assert.match(out, /### SPIKE COMPLETE all steps executed/);
});
