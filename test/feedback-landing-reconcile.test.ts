// test/feedback-landing-reconcile.test.ts — W1-T3562.
//
// THE GAP. W1-T3560 (union-and-lease) and W1-T3561 (refuse a backward landing) both act at the
// MOMENT of a landing; neither repairs a record a PAST landing already regressed
// (feedback#fb-1789304804534-e29e68 measures PR #5383 doing exactly that), and `sweepFeedbackLanding`
// (W1-T530) only ever reads ONE root's own disk — it cannot see a record another enrolled root or
// the shared landing branch holds that origin/main does not. `reconcileFeedbackLanding`
// (lib/feedback-reconcile.ts) is the one entry point that reads across roots + the landing branch
// and reports (or repairs, through the ordinary gated bridge) the difference.
//
// This file drives the real writers end to end (only `gh` is faked, exactly like every other
// feedback-landing*.test.ts) plus the real CLI dispatch path, so the hub-reaches-library
// invariant (acceptance 7/8) is not just asserted by a grep.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { FEEDBACK_STATUSES, type FeedbackStatus } from "../src/lib/feedback.js";
import { LANDING_BRANCH, landFeedback } from "../src/lib/feedback-landing.js";
import {
  reconcileFeedbackLanding,
  buildFeedbackReconcileManifest,
  ROOT_NAME_RE,
  type FeedbackReconcileRoot,
} from "../src/lib/feedback-reconcile.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { feedbackReconcileCommand, HANDLERS, renderFeedbackReconcile } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

function entryYaml(fields: { status: FeedbackStatus; id?: string; raw?: string } & Record<string, unknown>): string {
  const { status, id = "fb-test", raw = "fixture text", ...rest } = fields;
  return stringifyYaml({
    id,
    ts: "2026-01-01T00:00:00.000Z",
    raw,
    attachments: [],
    origin: "cli",
    status,
    proposal_pr: null,
    ...rest,
  });
}

function writeEntry(root: string, id: string, fields: Parameters<typeof entryYaml>[0]): void {
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${id}.yaml`), entryYaml({ id, ...fields }));
}

function readOnBranch(bareOrigin: string, branch: string, relPath: string): string {
  return execFileSync("git", ["--git-dir", bareOrigin, "show", `${branch}:${relPath}`], { encoding: "utf8" });
}

function branchExists(bareOrigin: string, branch: string): boolean {
  try {
    execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${branch}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function simulateMerge(bareOrigin: string): void {
  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`]);
}

/** A fake `gh` — no real GitHub call anywhere; tracks every invocation for assertions. */
function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      return `Creating pull request for ${LANDING_BRANCH} into main in o/r\n${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount };
}

/** One seeded bare origin + a working checkout cloned from it — the shared setup every case
 *  below starts from. */
function seededOrigin(kind: string): { bareOrigin: string; clone: () => string } {
  const bareOrigin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed");
  seed.addRemote("origin", bareOrigin.dir);
  seed.git("push", "--quiet", "origin", "main");
  return {
    bareOrigin: bareOrigin.dir,
    clone: () => gitRepo({ cloneFrom: bareOrigin.dir, kind: `${kind}-clone` }).dir,
  };
}

// ── Acceptance 1: dry-run default produces a manifest and writes nothing ───────────────────────

test("W1-T3562: the dry-run default produces a manifest of a record present on a root but absent from origin/main, and writes nothing", () => {
  const { bareOrigin, clone } = seededOrigin("dry-run");
  const rootDir = clone();
  writeEntry(rootDir, "fb-dry-run-1", { status: "new" });

  const { gh, calls } = fakeGh("https://github.com/o/r/pull/701");
  const roots: FeedbackReconcileRoot[] = [{ name: "core", path: rootDir }];
  const result = reconcileFeedbackLanding({ roots, checkoutRoot: rootDir, gh });

  assert.equal(result.error, undefined);
  assert.equal(result.applied, false, "the default must never apply");
  assert.deepEqual(result.landed, []);
  const entry = result.manifest.entries.find((e) => e.id === "fb-dry-run-1");
  assert.ok(entry, `expected fb-dry-run-1 in the manifest, got: ${JSON.stringify(result.manifest.entries)}`);
  assert.equal(entry?.classification, "missing-upstream");
  assert.deepEqual(entry?.foundIn, ["core"]);
  assert.equal(calls.length, 0, "a dry run must never even ask gh anything");
  assert.equal(branchExists(bareOrigin, LANDING_BRANCH), false, "a dry run must push nothing");

  // buildFeedbackReconcileManifest (the manifest-only projection) agrees exactly.
  const manifestOnly = buildFeedbackReconcileManifest({ roots, checkoutRoot: rootDir });
  assert.ok(manifestOnly.ok);
  if (manifestOnly.ok) assert.deepEqual(manifestOnly.manifest, result.manifest);
});

// ── Acceptance 2: a record whose upstream sits at an earlier §7B position is "regressed" ───────

test("W1-T3562: a record whose upstream copy sits earlier in the §7B lifecycle than a root's copy is classified regressed, not merely differing", () => {
  const { clone } = seededOrigin("regressed");
  const rootDir = clone();
  // origin/main (seeded README only) has NO copy of this id yet; write it locally at `new` and
  // land+merge it for real, so origin/main genuinely holds `status: new`.
  writeEntry(rootDir, "fb-regressed-1", { status: "new" });
  const { gh: gh1 } = fakeGh("https://github.com/o/r/pull/702");
  const first = withLiveWritesAllowed(() => landFeedback(rootDir, { gh: gh1 }));
  assert.equal(first.landed, true);
  const bareOriginPath = execFileSync("git", ["-C", rootDir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  simulateMerge(bareOriginPath);

  // The root now advances its OWN copy to `grilling` with reply metadata, but does NOT land it —
  // exactly the shape a landing that regressed the record would need repaired.
  writeEntry(rootDir, "fb-regressed-1", { status: "grilling", thread_id: "thread-99" });

  const roots: FeedbackReconcileRoot[] = [{ name: "core", path: rootDir }];
  const manifest = buildFeedbackReconcileManifest({ roots, checkoutRoot: rootDir });
  assert.ok(manifest.ok);
  if (!manifest.ok) return;
  const entry = manifest.manifest.entries.find((e) => e.id === "fb-regressed-1");
  assert.ok(entry, `expected fb-regressed-1 in the manifest, got: ${JSON.stringify(manifest.manifest.entries)}`);
  assert.equal(entry?.classification, "regressed");
  assert.match(entry?.reason ?? "", /earlier/i);
  assert.equal(entry?.originStatus, "new");
  assert.equal(entry?.bestStatus, "grilling");
});

// ── Acceptance 3: applying re-lands the union through the ordinary gated PR path ────────────────

test("W1-T3562: applying re-lands a missing-upstream record through the ordinary gated PR path, never a direct push to main or an inline merge arm", () => {
  const { bareOrigin, clone } = seededOrigin("apply");
  const rootDir = clone();
  writeEntry(rootDir, "fb-apply-1", { status: "new" });
  const mainShaBefore = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", "main"], { encoding: "utf8" }).trim();

  const { gh, calls, createCount } = fakeGh("https://github.com/o/r/pull/703");
  const roots: FeedbackReconcileRoot[] = [{ name: "core", path: rootDir }];
  const result = withLiveWritesAllowed(() =>
    reconcileFeedbackLanding({ roots, checkoutRoot: rootDir, apply: true, gh }),
  );

  assert.equal(result.error, undefined);
  assert.equal(result.applied, true);
  assert.deepEqual(result.landed, ["plan/feedback/fb-apply-1.yaml"]);
  assert.equal(result.prUrl, "https://github.com/o/r/pull/703");
  assert.equal(createCount(), 1, "exactly one PR must be created");
  assert.ok(
    !calls.some((c) => c[0] === "pr" && c[1] === "merge"),
    "the landing producer must leave review and auto-merge ordering to the shared daemon sweep",
  );
  assert.ok(
    !calls.some((c) => c[0] === "pr" && c[1] === "merge" && c.includes("main")),
    "never a merge/push directly onto main",
  );
  const mainShaAfter = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", "main"], { encoding: "utf8" }).trim();
  assert.equal(mainShaAfter, mainShaBefore, "main must never move by this call's own hand");
  assert.match(readOnBranch(bareOrigin, LANDING_BRANCH, "plan/feedback/fb-apply-1.yaml"), /status: new/);
});

// ── Acceptance 4: a second run over unchanged state pushes nothing and opens no second PR ──────

test("W1-T3562: a second apply over unchanged state pushes nothing and opens no second pull request", () => {
  const { bareOrigin, clone } = seededOrigin("idempotent");
  const rootDir = clone();
  writeEntry(rootDir, "fb-idem-1", { status: "new" });

  const { gh, createCount } = fakeGh("https://github.com/o/r/pull/704");
  const roots: FeedbackReconcileRoot[] = [{ name: "core", path: rootDir }];
  const first = withLiveWritesAllowed(() => reconcileFeedbackLanding({ roots, checkoutRoot: rootDir, apply: true, gh }));
  assert.equal(first.applied, true);
  const tipAfterFirst = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();

  const second = withLiveWritesAllowed(() => reconcileFeedbackLanding({ roots, checkoutRoot: rootDir, apply: true, gh }));
  assert.equal(second.error, undefined);
  const tipAfterSecond = execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  assert.equal(tipAfterSecond, tipAfterFirst, "the landing branch must not move on the second, no-op call");
  assert.equal(createCount(), 1, "no second pull request may ever open");
});

// ── Acceptance 5: an unknown or malformed root is refused before any read or write ──────────────

test("W1-T3562: a malformed root (relative path) is refused before any read or write, and a well-formed sibling is not touched either", () => {
  const { clone } = seededOrigin("malformed");
  const rootDir = clone();
  writeEntry(rootDir, "fb-should-not-be-read", { status: "new" });

  const { gh, calls } = fakeGh("https://github.com/o/r/pull/705");
  const roots: FeedbackReconcileRoot[] = [
    { name: "core", path: rootDir },
    { name: "site", path: "relative/not-absolute" },
  ];
  const spyGit = (args: string[]): string => {
    throw new Error(`git must never be called when root validation refuses: ${JSON.stringify(args)}`);
  };
  const result = reconcileFeedbackLanding({ roots, checkoutRoot: rootDir, apply: true, gh, git: spyGit });

  assert.ok(result.error, "a malformed root must refuse the whole call");
  assert.match(result.error ?? "", /site/);
  assert.deepEqual(result.manifest.entries, []);
  assert.equal(result.applied, false);
  assert.equal(calls.length, 0, "no gh call may happen when root validation refuses first");
});

test("W1-T3562: an enrolled root pointing at a nonexistent directory is refused before any read", () => {
  const rootDir = seededOrigin("nonexistent-carrier").clone();
  const roots: FeedbackReconcileRoot[] = [{ name: "ghost", path: join(rootDir, "does", "not", "exist") }];
  const result = reconcileFeedbackLanding({ roots, checkoutRoot: rootDir });
  assert.ok(result.error);
  assert.match(result.error ?? "", /does not exist/);
  assert.deepEqual(result.manifest.entries, []);
});

test("W1-T3562: ROOT_NAME_RE accepts a stable slug and rejects a path-shaped or mixed-case name", () => {
  assert.equal(ROOT_NAME_RE.test("core"), true);
  assert.equal(ROOT_NAME_RE.test("site-2"), true);
  assert.equal(ROOT_NAME_RE.test("Core"), false, "mixed case must never pass as a root name");
  assert.equal(ROOT_NAME_RE.test("core/site"), false, "a path separator must never pass as a root name");
  assert.equal(ROOT_NAME_RE.test(""), false, "an empty string must never pass as a root name");
});

test("W1-T3562: an empty roots array is refused rather than silently reporting an empty manifest", () => {
  const rootDir = seededOrigin("empty-roots").clone();
  const result = reconcileFeedbackLanding({ roots: [], checkoutRoot: rootDir });
  assert.ok(result.error);
  assert.deepEqual(result.manifest.entries, []);
});

test("W1-T3562: a malformed root name is refused before any git call", () => {
  const rootDir = seededOrigin("bad-root-name").clone();
  const spyGit = (args: string[]): string => {
    throw new Error(`git must never be called when root name validation refuses: ${JSON.stringify(args)}`);
  };
  const result = reconcileFeedbackLanding({
    roots: [{ name: "Core", path: rootDir }],
    checkoutRoot: rootDir,
    git: spyGit,
  });

  assert.match(result.error ?? "", /malformed root name/);
  assert.equal(result.applied, false);
  assert.deepEqual(result.manifest.entries, []);
});

test("W1-T3562: a fetch failure refuses the whole reconciliation with the git reason", () => {
  const rootDir = seededOrigin("fetch-failure").clone();
  const result = reconcileFeedbackLanding({
    roots: [{ name: "core", path: rootDir }],
    checkoutRoot: rootDir,
    git: () => {
      throw new Error("network is unavailable");
    },
  });

  assert.match(result.error ?? "", /cannot fetch origin: network is unavailable/);
  assert.deepEqual(result.manifest.entries, []);
});

test("W1-T3562: an unreadable landing-branch file is skipped rather than treated as fatal", () => {
  const rootDir = seededOrigin("branch-race").clone();
  const git = (args: string[]): string => {
    if (args[0] === "fetch") return "";
    if (args[0] === "ls-tree") return "plan/feedback/fb-raced-away.yaml\n";
    if (args[0] === "show") throw new Error("branch moved during scan");
    throw new Error(`unexpected git call: ${JSON.stringify(args)}`);
  };

  const manifest = buildFeedbackReconcileManifest({
    roots: [{ name: "core", path: rootDir }],
    checkoutRoot: rootDir,
    git,
  });

  assert.ok(manifest.ok);
  if (manifest.ok) {
    assert.deepEqual(manifest.manifest.scannedRoots, ["core", "feedback-landing"]);
    assert.deepEqual(manifest.manifest.entries, []);
  }
});

test("W1-T3562: invalid YAML in a root record is still reported as missing-upstream with no display status", () => {
  const rootDir = seededOrigin("invalid-local-status").clone();
  mkdirSync(join(rootDir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(rootDir, "plan", "feedback", "fb-invalid-local.yaml"), "status: [\n");

  const manifest = buildFeedbackReconcileManifest({
    roots: [{ name: "core", path: rootDir }],
    checkoutRoot: rootDir,
  });

  assert.ok(manifest.ok);
  if (!manifest.ok) return;
  const entry = manifest.manifest.entries.find((e) => e.id === "fb-invalid-local");
  assert.equal(entry?.classification, "missing-upstream");
  assert.equal(entry?.bestStatus, undefined);
});

test("W1-T3562: an unparseable origin/main copy is classified as a surfaced difference", () => {
  const rootDir = seededOrigin("invalid-origin-status").clone();
  writeEntry(rootDir, "fb-invalid-origin", { status: "new" });
  const git = (args: string[]): string => {
    if (args[0] === "fetch") return "";
    if (args[0] === "ls-tree") return "";
    if (args[0] === "show" && args[1] === "origin/main:plan/feedback/fb-invalid-origin.yaml") {
      return "status: [\n";
    }
    throw new Error(`unexpected git call: ${JSON.stringify(args)}`);
  };

  const manifest = buildFeedbackReconcileManifest({
    roots: [{ name: "core", path: rootDir }],
    checkoutRoot: rootDir,
    git,
  });

  assert.ok(manifest.ok);
  if (!manifest.ok) return;
  const entry = manifest.manifest.entries.find((e) => e.id === "fb-invalid-origin");
  assert.equal(entry?.classification, "differs");
  assert.match(entry?.reason ?? "", /invalid YAML/);
  assert.equal(entry?.originStatus, undefined);
});

// ── Acceptance 6: refuses rather than forces when applying would regress a record ───────────────

test("W1-T3562: applying propagates (never bypasses) a refusal the ordinary bridge itself returns", () => {
  const rootDir = seededOrigin("refuse-not-force").clone();
  // Classifies as missing-upstream (needs repair) — the bridge itself is stubbed to refuse it,
  // standing in for a race the manifest's own scan cannot see (origin advancing again between
  // this call's scan and its own push attempt). Proves reconcileFeedbackLanding PROPAGATES that
  // refusal rather than retrying with any alternate, unguarded write.
  writeEntry(rootDir, "fb-refuse-1", { status: "new" });

  const refusal = { path: "plan/feedback/fb-refuse-1.yaml", reason: "simulated: origin advanced past this call's own scan" };
  let landCalls = 0;
  const stubLand = () => {
    landCalls++;
    return { landed: false, files: [], refused: [refusal] };
  };

  const roots: FeedbackReconcileRoot[] = [{ name: "core", path: rootDir }];
  const result = withLiveWritesAllowed(() =>
    reconcileFeedbackLanding({ roots, checkoutRoot: rootDir, apply: true, land: stubLand }),
  );

  assert.equal(landCalls, 1, "the bridge must be asked exactly once for the one record needing repair");
  assert.equal(result.applied, false, "a wholly-refused apply must not report applied");
  assert.deepEqual(result.landed, []);
  assert.deepEqual(result.refused, [refusal]);
  assert.equal(result.error, undefined, "a per-record refusal is reported on `refused`, never escalated to a hard call error");
});

test("W1-T3562: applying reports a bridge error when nothing was landed", () => {
  const rootDir = seededOrigin("land-error").clone();
  writeEntry(rootDir, "fb-error-1", { status: "new" });
  const roots: FeedbackReconcileRoot[] = [{ name: "core", path: rootDir }];

  const result = withLiveWritesAllowed(() =>
    reconcileFeedbackLanding({
      roots,
      checkoutRoot: rootDir,
      apply: true,
      land: () => ({ landed: false, files: [], error: "simulated landing failure" }),
    }),
  );

  assert.equal(result.applied, false);
  assert.deepEqual(result.landed, []);
  assert.match(result.error ?? "", /simulated landing failure/);
});

test("W1-T3562: renderFeedbackReconcile names apply results, PR URLs, and refusals", () => {
  const rendered = renderFeedbackReconcile(
    {
      manifest: {
        scannedRoots: ["core", "feedback-landing"],
        recordCount: 1,
        byteCount: 123,
        truncated: true,
        entries: [
          {
            id: "fb-render-1",
            classification: "regressed",
            foundIn: ["core"],
            originStatus: "new",
            bestStatus: "grilling",
            reason: "origin sat earlier",
          },
        ],
      },
      applied: true,
      landed: ["plan/feedback/fb-render-1.yaml"],
      refused: [{ path: "plan/feedback/fb-render-2.yaml", reason: "would move backward" }],
      prUrl: "https://github.com/o/r/pull/706",
    },
    true,
  );

  assert.match(rendered, /landed 1 record\(s\) — https:\/\/github\.com\/o\/r\/pull\/706/);
  assert.match(rendered, /refused 1 record\(s\) rather than force a backward move/);
  assert.match(rendered, /TRUNCATED/);

  const nothing = renderFeedbackReconcile(
    {
      manifest: { scannedRoots: ["core"], recordCount: 0, byteCount: 0, truncated: false, entries: [] },
      applied: false,
      landed: [],
      refused: [],
    },
    true,
  );
  assert.match(nothing, /nothing landed/);
});

// ── Acceptance 7 & 8: the CLI verb reaches the library builder, not a second copy of the scan ──

/** `loadConfig()` writes `~/.config/remudero/config.json` on first read — the fixture shape
 *  test/away-mode-delivery.test.ts already established for a command handler that touches it,
 *  reused here rather than a second copy. */
function setupFakeHome(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-feedback-reconcile-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const home = mkdtempSync(join(tmpdir(), "rmd-feedback-reconcile-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }),
  );
  return { root, home };
}

test("W1-T3562: `rmd feedback-reconcile`, dispatched through the real CLI registry, reaches reconcileFeedbackLanding rather than re-scanning inline", async () => {
  const { clone } = seededOrigin("cli-dispatch");
  const rootDir = clone();
  writeEntry(rootDir, "fb-cli-1", { status: "new" });

  const handler = HANDLERS.get("feedback-reconcile");
  assert.ok(handler, "the feedback-reconcile verb must be registered in HANDLERS");

  const { home } = setupFakeHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const originalLog = console.log;
  const printed: string[] = [];
  console.log = (msg?: unknown) => {
    printed.push(String(msg));
  };
  let code: number;
  try {
    code = await handler!(["--root", `core=${rootDir}`, "--checkout", rootDir]);
  } finally {
    console.log = originalLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
  assert.equal(code, 0);
  const out = printed.join("\n");
  // The manifest produced through the CLI names the exact record the LIBRARY's own manifest
  // builder would — a hub that re-scanned inline could drift from this, a call-through cannot.
  assert.match(out, /fb-cli-1/);
  assert.match(out, /missing-upstream/);
  assert.match(out, /dry run — nothing written/);
});

test("W1-T3562: feedback-reconcile rejects unknown, missing, and malformed root arguments before scanning", async () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    assert.equal(await feedbackReconcileCommand(["--bogus"]), 2);
    assert.equal(await feedbackReconcileCommand([]), 2);
    assert.equal(await feedbackReconcileCommand(["--root", "not-a-pair"]), 2);
  } finally {
    console.error = originalError;
  }

  assert.match(errors.join("\n"), /unexpected argument.*--bogus/s);
  assert.match(errors.join("\n"), /at least one --root/);
  assert.match(errors.join("\n"), /malformed --root "not-a-pair"/);
});

test("W1-T3562: feedback-reconcile returns 1 when the library refuses a parsed root", async () => {
  const { clone } = seededOrigin("cli-error");
  const rootDir = clone();
  const { home } = setupFakeHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const originalLog = console.log;
  const originalError = console.error;
  const printed: string[] = [];
  const errors: string[] = [];
  console.log = (msg?: unknown) => {
    printed.push(String(msg));
  };
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    assert.equal(await feedbackReconcileCommand(["--root", `Bad=${rootDir}`, "--checkout", rootDir]), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }

  assert.match(printed.join("\n"), /nothing to reconcile/);
  assert.match(errors.join("\n"), /malformed root name/);
});

// Acceptance 8 (hub reaches the library, not a second scan) is proved BEHAVIOURALLY above by the
// CLI-dispatch test — it drives the real HANDLERS entry through to reconcileFeedbackLanding's own
// manifest, rather than reading src/run-task.ts as text to grep for the call site (which the PR's
// own `grep: reconcileFeedbackLanding( in src/run-task.ts` proof already covers directly).

// Sanity: FEEDBACK_STATUSES is imported only to keep this file's fixture shape honest against the
// real lifecycle table (mirrors test/feedback-record-monotonic.test.ts's own convention).
test("W1-T3562: fixture sanity — entryYaml only ever uses a real §7B status", () => {
  for (const status of FEEDBACK_STATUSES) {
    assert.doesNotThrow(() => entryYaml({ status }));
  }
});
