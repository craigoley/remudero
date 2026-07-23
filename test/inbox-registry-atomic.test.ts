import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `updateProposalRegistry` makes: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. Same import-shape comment as
// test/worker-run-lock.test.ts (the W1-T208 precedent this file's claim 1 mirrors) and
// src/lib/inbox.ts's own `import fs from "node:fs"` comment.
import fsDefault from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseProposalRegistry, updateProposalRegistry, type Proposal, type RatifyGateway } from "../src/lib/inbox.js";
import type { Config } from "../src/lib/config.js";
import { approveCommand, inboxCommand, reframeCommand } from "../src/run-task.js";

// ── W1-T240 ──────────────────────────────────────────────────────────────────────────────
//
// state/inbox-proposals.json had FOUR independent plain readFileSync + JSON.parse +
// writeFileSync round trips -- rmd inbox's ratified-registry heal, rmd approve's
// remove-on-ratify, rmd reframe's feedback write (all three run-task.ts), and the serve
// daemon's OWN GET /v1/inbox heal (lib/panel-graph.ts) -- with no mutual exclusion and no
// atomicity between them. The fix, updateProposalRegistry (src/lib/inbox.ts), is the ONE
// writer every one of those four sites now goes through: an O_EXCL lockfile serializes
// concurrent callers (claim 2) and the write itself lands via a sibling temp file +
// rename so a reader never observes a torn file (claim 1). Claim 3 proves the coupling
// actually holds across every site, not just in this module's own unit tests.

function tmpRegistry(): { dir: string; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inbox-registry-atomic-"));
  return { dir, registryPath: join(dir, "state", "inbox-proposals.json") };
}

function proposal(id: string): Proposal {
  return { id, summary: `proposal ${id}`, evidenceAnchors: [] };
}

// ── Claim 1: a reader interleaved with a registry writer never observes a partial file ────
//
// Mirrors test/worker-run-lock.test.ts's own W1-T208 claim 1 proof verbatim in shape: seed
// a known-good, complete registry (content1) with real calls, then intercept the SECOND
// write's fs.writeFileSync/fs.renameSync calls and fire a "concurrent reader" (a genuine,
// separate parseProposalRegistry(readFileSync(...)) call) at the exact instant the target
// path is about to become visible with new bytes. Under the FIXED implementation only the
// renameSync(tmp, registryPath) branch ever fires (pre-swap, while registryPath still holds
// content1 untouched); the writeFileSync(registryPath) branch is dead code under the fix
// and only reachable again if updateProposalRegistry is reverted to write the target
// directly -- exactly the FALSIFIER the acceptance claim asks for.

test(
  "W1-T240 claim 1: a reader interleaved with a registry writer never observes a partial " +
    "inbox-proposals.json -- FALSIFIER: reverting updateProposalRegistry to a direct " +
    "writeFileSync(registryPath) makes this fail",
  (t) => {
    const { dir, registryPath } = tmpRegistry();
    try {
      // Cycle 1: seed a known-good, complete registry (content1) with real fs calls.
      updateProposalRegistry(registryPath, () => [proposal("P1"), proposal("P2")]);
      const content1 = fsDefault.readFileSync(registryPath, "utf8");
      assert.ok(content1.length > 0, "sanity: cycle 1 actually produced a non-empty registry file");
      JSON.parse(content1); // sanity: valid JSON

      const realWriteFileSync = fsDefault.writeFileSync.bind(fsDefault);
      const realRenameSync = fsDefault.renameSync.bind(fsDefault);
      const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
      const realExistsSync = fsDefault.existsSync.bind(fsDefault);

      const observations: Array<{ label: string; content: string | undefined; read: Proposal[] }> = [];
      let probeFired = false;
      let probeArmed = true; // guards against the nested reader's own read re-firing this

      function probe(label: string) {
        if (!probeArmed) return;
        probeArmed = false;
        probeFired = true;
        const content = realExistsSync(registryPath) ? realReadFileSync(registryPath, "utf8") : undefined;
        // The "concurrent reader": a genuinely separate parse call, simulating `rmd
        // inbox`/GET /v1/inbox racing this write from another process.
        const read = parseProposalRegistry(content);
        observations.push({ label, content, read });
        probeArmed = true;
      }

      t.mock.method(fsDefault, "writeFileSync", (target: unknown, content: unknown, ...rest: unknown[]) => {
        if (target === registryPath) {
          // Reproduce a plain truncating writeFileSync's observable two-phase window --
          // only reachable if updateProposalRegistry is reverted to the pre-fix shape.
          realWriteFileSync(registryPath, "");
          probe("direct writeFileSync(registryPath) -- pre-fix shape, post-truncate pre-fill");
          return realWriteFileSync(target as string, content as string, ...(rest as []));
        }
        return realWriteFileSync(target as string, content as string, ...(rest as []));
      });
      t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
        if (to === registryPath) {
          probe("renameSync(tmp, registryPath) -- pre-swap");
        }
        return realRenameSync(from as string, to as string);
      });

      updateProposalRegistry(registryPath, () => [proposal("P1"), proposal("P2"), proposal("P3")]);

      assert.ok(probeFired, "sanity: the interleave probe must actually have fired at least once");

      for (const obs of observations) {
        assert.ok(obs.content !== undefined, `${obs.label}: registryPath must already exist by cycle 2`);
        assert.ok(obs.content!.length > 0, `${obs.label}: reader observed a ZERO-LENGTH registry file`);
        assert.doesNotThrow(() => JSON.parse(obs.content!), `${obs.label}: reader observed unparseable (torn) JSON`);
        assert.equal(obs.content, content1, `${obs.label}: reader observed something other than the complete, untouched cycle-1 registry`);
        assert.deepEqual(
          obs.read.map((p) => p.id),
          ["P1", "P2"],
          `${obs.label}: the interleaved parseProposalRegistry() call must resolve the complete cycle-1 registry, never a torn/empty one`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── Claim 2: two concurrent read-modify-write updates do not silently discard either ──────

test("W1-T240 claim 2: two 'concurrent' updateProposalRegistry calls -- B's read genuinely happens only after A's write has landed, enforced by the lock -- preserve BOTH updates, never one clobbering the other", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("seed")]);

    // B's acquire is blocked behind a pre-planted "live" lock; while B polls (via its own
    // injected `sleep` hook), A's FULL updateProposalRegistry call runs to completion --
    // reclaiming that pre-planted lock as stale (its pid is fake and unreachable), writing,
    // and releasing. B's eventual acquire is therefore guaranteed to happen strictly AFTER
    // A's write landed. Without the lock, A's write would instead silently stomp whatever B
    // already read at call time.
    fsDefault.writeFileSync(`${registryPath}.lock`, JSON.stringify({ pid: 111, startedAt: new Date(0).toISOString() }));
    let aDone = false;

    const bResult = updateProposalRegistry(
      registryPath,
      (current) => [...current, proposal("B")],
      {
        isPidAlive: () => !aDone,
        sleep: () => {
          if (aDone) return;
          updateProposalRegistry(registryPath, (current) => [...current, proposal("A")]);
          aDone = true;
        },
      },
    );

    assert.deepEqual(
      (bResult ?? []).map((p) => p.id),
      ["seed", "A", "B"],
      "B's update was computed against A's already-written result, not the stale seed -- neither update was lost",
    );
    assert.deepEqual(
      parseProposalRegistry(readFileSync(registryPath, "utf8")).map((p) => p.id),
      ["seed", "A", "B"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T240 claim 2: a DEAD holder's lock is reclaimed immediately -- a crash mid-update never wedges the registry lock for the next caller", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("seed")]);
    fsDefault.writeFileSync(`${registryPath}.lock`, JSON.stringify({ pid: 424242, startedAt: new Date(0).toISOString() }));

    const result = updateProposalRegistry(registryPath, (current) => [...current, proposal("after-reclaim")], { isPidAlive: () => false });

    assert.deepEqual((result ?? []).map((p) => p.id), ["seed", "after-reclaim"]);
    assert.ok(!fsDefault.existsSync(`${registryPath}.lock`), "the lock is released again after the reclaimed update completes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T240 claim 2: a GARBAGE (unparseable) lock file -- not merely a dead pid -- is ALSO reclaimed immediately, same as a crash mid-update, never mistaken for a live holder", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("seed")]);
    // Not valid JSON at all (a torn write of the lock file itself, or disk corruption) --
    // readRegistryLockInfo's own catch branch must treat this the same as "no valid holder",
    // never throw and never wedge the next caller behind it forever.
    fsDefault.writeFileSync(`${registryPath}.lock`, "{not json");

    const result = updateProposalRegistry(registryPath, (current) => [...current, proposal("after-garbage-reclaim")]);

    assert.deepEqual((result ?? []).map((p) => p.id), ["seed", "after-garbage-reclaim"]);
    assert.ok(!fsDefault.existsSync(`${registryPath}.lock`), "the lock is released again after the reclaimed update completes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T240 claim 2: the DEFAULT sleep (no injected `opts.sleep`) is a real, blocking wait -- a caller that never overrides it still eventually times out loud against a genuinely live holder, rather than busy-spinning or hanging forever", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("seed")]);
    // This test's OWN pid is unimpeachably alive for the whole test run, so the default
    // isPidAlive probe never reclaims it -- every poll must fall through to the REAL,
    // un-injected defaultRegistryLockSleep (execFileSync("sleep", ...)), not a test double.
    fsDefault.writeFileSync(`${registryPath}.lock`, JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }));

    assert.throws(
      () => updateProposalRegistry(registryPath, (current) => [...current, proposal("unreachable")], { maxWaitMs: 60, pollIntervalMs: 20 }),
      new RegExp(`timed out.*pid ${process.pid}`),
    );
  } finally {
    fsDefault.unlinkSync(`${registryPath}.lock`); // this test's own pid never dies -- clear its own planted lock
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T240 claim 2: a LIVE holder that outlasts maxWaitMs makes the caller throw loud, naming the holder pid -- the lost-update interleaving is LOUDLY DETECTED, never silently ignored, when a holder genuinely never releases", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("seed")]);
    fsDefault.writeFileSync(`${registryPath}.lock`, JSON.stringify({ pid: 777, startedAt: new Date(0).toISOString() }));

    assert.throws(
      () =>
        updateProposalRegistry(registryPath, (current) => [...current, proposal("unreachable")], {
          isPidAlive: () => true, // never dies
          maxWaitMs: 10,
          pollIntervalMs: 1,
          sleep: () => {}, // no real delay in the test
        }),
      /timed out.*pid 777/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T240 claim 2: `update` returning null skips the write entirely -- the common already-consistent case never touches disk (no lost-update surface to even race over)", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("P1")]);
    const before = readFileSync(registryPath, "utf8");

    const result = updateProposalRegistry(registryPath, () => null);

    assert.equal(result, null);
    assert.equal(readFileSync(registryPath, "utf8"), before, "file bytes are untouched when update opts out of writing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T240 claim 2: releasing the lock in `finally` is idempotent -- something ELSE already having removed the lock file by cleanup time (e.g. a manual `rm` while debugging a wedged run) never throws back out of an otherwise-successful update", (t) => {
  const { dir, registryPath } = tmpRegistry();
  try {
    const lockPath = `${registryPath}.lock`;
    const realUnlinkSync = fsDefault.unlinkSync.bind(fsDefault);
    t.mock.method(fsDefault, "unlinkSync", (path: unknown) => {
      if (path === lockPath) throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      return (realUnlinkSync as (...a: unknown[]) => unknown)(path);
    });

    const result = updateProposalRegistry(registryPath, () => [proposal("P1")]);

    assert.deepEqual((result ?? []).map((p) => p.id), ["P1"], "the write itself must still succeed even though releasing the lock afterward failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Claim 3: all four write sites reach the SAME single writer helper ─────────────────────
//
// A source-text reachability check, the same technique test/run-task.test.ts already uses
// for its own reachability properties (e.g. the W1-T192 draft-rung tests): each of the four
// sites must call updateProposalRegistry(, and none may retain a bare
// writeFileSync(registryPath -- which would silently reopen the exact race this task closes.

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const panelGraphSrc = readFileSync(fileURLToPath(new URL("../src/lib/panel-graph.ts", import.meta.url)), "utf8");

/** Extract one top-level function/`export function` declaration's source text, from its
 *  signature to the start of the NEXT top-level function declaration (or EOF) -- good
 *  enough for a reachability grep (mirrors test/run-task.test.ts's own local helper of the
 *  same shape, redefined here per this file's own convention of not sharing it). */
function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find '${signature}'`);
  const boundaries = [src.indexOf("\nfunction ", start + 1), src.indexOf("\nasync function ", start + 1), src.indexOf("\nexport function ", start + 1), src.indexOf("\nexport async function ", start + 1)].filter(
    (i) => i > start,
  );
  const end = boundaries.length ? Math.min(...boundaries) : src.length;
  return src.slice(start, end);
}

for (const [label, signature] of [
  ["inboxCommand's registry heal (`rmd inbox`)", "async function inboxCommand("],
  ["approveCommand's remove-on-ratify write (`rmd approve`)", "async function approveCommand("],
  ["reframeCommand's feedback write (`rmd reframe`)", "async function reframeCommand("],
] as const) {
  test(`W1-T240 claim 3: ${label} reaches updateProposalRegistry, never a bare writeFileSync(registryPath`, () => {
    const body = extractFunctionBody(runTaskSrc, signature);
    assert.match(body, /updateProposalRegistry\(/, `${label} must route its registry write through updateProposalRegistry`);
    assert.doesNotMatch(
      body,
      /writeFileSync\(registryPath/,
      `${label} must not retain a bare writeFileSync on the registry path -- it would race the other writers again`,
    );
  });
}

test("W1-T240 claim 3: the serve daemon's GET /v1/inbox heal (lib/panel-graph.ts's buildInboxRoute) reaches updateProposalRegistry, never a bare writeFileSync(registryPath -- this is the writer that runs INSIDE the long-lived daemon, making the multi-writer race genuine rather than theoretical", () => {
  const body = extractFunctionBody(panelGraphSrc, "export function buildInboxRoute(");
  assert.match(body, /updateProposalRegistry\(/, "buildInboxRoute must route its heal write through updateProposalRegistry");
  assert.doesNotMatch(body, /writeFileSync\(registryPath/, "buildInboxRoute must not retain a bare writeFileSync on the registry path");
});

test("W1-T240 claim 3: updateProposalRegistry is imported from lib/inbox.ts by BOTH run-task.ts and panel-graph.ts -- one shared helper, never two divergent re-implementations", () => {
  const runTaskImportBlock = runTaskSrc.match(/import \{([\s\S]*?)\} from "\.\/lib\/inbox\.js";/);
  assert.ok(runTaskImportBlock, "run-task.ts must import from ./lib/inbox.js");
  assert.match(runTaskImportBlock![1], /\bupdateProposalRegistry\b/, "run-task.ts must import the shared helper from lib/inbox.js");

  const panelGraphImportBlock = panelGraphSrc.match(/import \{([\s\S]*?)\} from "\.\/inbox\.js";/);
  assert.ok(panelGraphImportBlock, "panel-graph.ts must import from ./inbox.js");
  assert.match(panelGraphImportBlock![1], /\bupdateProposalRegistry\b/, "panel-graph.ts must import the SAME shared helper from ./inbox.js");
});

// ── Claim 4: the REAL dispatch path -- not just a source grep -- actually reaches the new
// lock+atomic-write critical section in each of the three run-task.ts call sites ──────────
//
// Claim 3 above is a text-reachability check only; it cannot tell a real interpreter ever
// executes those lines. These three tests drive inboxCommand/approveCommand/reframeCommand
// THEMSELVES (not just the pure lib/inbox.ts helpers claim 1/2 already cover) through their
// injectable `deps.config` (and approveCommand's `deps.gateway`) seams -- the SAME
// config/githubFactory escape-hatch shape test/run-task.test.ts's own drainCommand tests
// already use -- so every one of this task's new registry-write lines actually runs, without
// touching the real ~/.config/remudero/config.json or making a real gh/git network call.

function fixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-inbox-command-root-")) };
}

/**
 * Run `fn` with `HOME` redirected to a throwaway dir carrying an ALREADY-COMPLETE
 * `~/.config/remudero/config.json` (`claudeBin` pre-filled) -- so the REAL, un-injected
 * `loadConfig()` these commands' `deps.config ??` fallback calls when `deps` is omitted
 * entirely takes its cheap EEXIST-read branch, never the create branch that shells `which
 * claude` (the documented CI landmine: `loadConfig()` only shells out when the config file
 * is MISSING or incomplete). Returns the redirected `root` so a caller can seed state
 * under the SAME path the real `loadConfig()` will resolve.
 */
async function withRedirectedHomeConfig<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "rmd-inbox-realhome-"));
  const root = join(home, "remudero-root");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }), "utf8");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // AWAITED, not merely returned -- `fn` dispatches a real async command; releasing HOME
    // and deleting `home` before that promise settles would pull the config file (and any
    // state/ it seeded) out from under the in-flight call.
    return await fn(root);
  } finally {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function seedRegistry(config: Config, proposals: Proposal[]): string {
  const registryPath = join(config.root, "state", "inbox-proposals.json");
  mkdirSync(join(config.root, "state"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ proposals }, null, 2), "utf8");
  return registryPath;
}

function seedRatifiedLedgerLine(config: Config, proposalId: string): void {
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  mkdirSync(join(config.root, "state"), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), step: "ratify.approved", task_id: proposalId }) + "\n", "utf8");
}

test("W1-T240 claim 4: `rmd inbox`'s real dispatch (inboxCommand) actually reaches updateProposalRegistry -- a proposal the ledger already ratified is pruned from the on-disk registry, not just from this pass's in-memory classification", async () => {
  const config = fixtureConfig();
  try {
    const registryPath = seedRegistry(config, [{ id: "P-HEAL", summary: "healable", evidenceAnchors: [] }]);
    seedRatifiedLedgerLine(config, "P-HEAL");

    // --dry-run only skips the draft-synthesis SPAWN (see inboxCommand's own doc comment);
    // the ledger-derived registry heal this task added runs unconditionally either way.
    const code = await inboxCommand(["--dry-run"], { config });

    assert.equal(code, 0);
    const onDisk = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.deepEqual(onDisk, [], "the ratified proposal must be gone from the ON-DISK registry, not merely from this pass's classification");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T240 claim 4: `rmd inbox`'s real dispatch is a no-op write when nothing is ratified -- the common (already-clean) path never touches the registry file", async () => {
  const config = fixtureConfig();
  try {
    const registryPath = seedRegistry(config, [{ id: "P-CLEAN", summary: "untouched", evidenceAnchors: [] }]);
    const before = readFileSync(registryPath, "utf8");

    const code = await inboxCommand(["--dry-run"], { config });

    assert.equal(code, 0);
    assert.equal(readFileSync(registryPath, "utf8"), before, "no ratified proposal in the ledger ⇒ the registry file's bytes are untouched");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T240 claim 4: `rmd approve`'s real dispatch (approveCommand) actually reaches updateProposalRegistry -- a READY proposal is removed from the on-disk registry the moment the (faked) gateway reports success, off a FRESH read under lock, never the stale array `loadProposalForRatify` read at the top", async () => {
  const config = fixtureConfig();
  try {
    const registryPath = seedRegistry(config, [{ id: "P-APPROVE", summary: "approvable", evidenceAnchors: [] }]);
    // A lint-clean, dep-free, single-task fragment (no `files:`/acceptance criteria, so
    // neither the sizing nor headless-fitness/proof-shape/provenance checks can fire) --
    // matching anchorFingerprint([]) === "" (P-APPROVE carries no evidence anchors), so the
    // REAL classifyProposal this command runs derives state "ready" without any git/gh call.
    const draftsPath = join(config.root, "state", "inbox-drafts.json");
    writeFileSync(
      draftsPath,
      JSON.stringify({
        "P-APPROVE": {
          proposalId: "P-APPROVE",
          fragmentYaml: "- id: W1-T240-FIXTURE\n  title: fixture drafted task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n",
          stampLine: "- P-APPROVE (plan) — RATIFIED -> W1-T240-FIXTURE.",
          anchorFingerprint: "",
        },
      }),
      "utf8",
    );

    const gatewayCalls: string[] = [];
    const fakeGateway: RatifyGateway = {
      createRatificationBranch() {
        gatewayCalls.push("branch");
        return "run-fake-approve";
      },
      openPlanPr() {
        gatewayCalls.push("pr");
        return "https://github.com/craigoley/remudero/pull/999999";
      },
    };

    // The fake gateway never sets approveCommand's own repoDir/worktreePath closures (only
    // its REAL, un-injected gateway does that) -- so approveCommand throws its own loud
    // "gateway reported success but never created a ratification branch" guard right AFTER
    // the registry write this test targets. That is the expected, accepted shape of this
    // fixture: the write under test has already landed by the time this throws.
    await assert.rejects(
      () => approveCommand(["P-APPROVE"], { config, gateway: fakeGateway }),
      /gateway reported success but never created a ratification branch/,
    );

    assert.deepEqual(gatewayCalls, ["branch", "pr"], "approveProposal must have actually called both gateway methods -- the classification really resolved READY");
    const onDisk = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.deepEqual(onDisk, [], "P-APPROVE must be gone from the ON-DISK registry once the gateway reports success");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T240 claim 4: `rmd reframe`'s real dispatch (reframeCommand) actually reaches updateProposalRegistry -- the feedback lands on the on-disk registry entry, and the draft cache is invalidated, in ONE real end-to-end call", async () => {
  const config = fixtureConfig();
  try {
    const registryPath = seedRegistry(config, [{ id: "P-REFRAME", summary: "reframable", evidenceAnchors: [] }]);
    const draftsPath = join(config.root, "state", "inbox-drafts.json");
    writeFileSync(draftsPath, JSON.stringify({ "P-REFRAME": { proposalId: "P-REFRAME", fragmentYaml: "x", stampLine: "x", anchorFingerprint: "stale" } }), "utf8");

    const code = await reframeCommand(["P-REFRAME", "--feedback", "needs another pass"], { config });

    assert.equal(code, 0);
    const onDisk = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.deepEqual(onDisk[0].reframeHistory, [{ feedback: "needs another pass" }], "the feedback must land on the ON-DISK registry entry, off a FRESH read under lock");

    const drafts = JSON.parse(readFileSync(draftsPath, "utf8"));
    assert.equal(drafts["P-REFRAME"], undefined, "the cached draft must be invalidated by the same real dispatch");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T240 claim 4: `rmd reframe`'s real dispatch refuses cleanly (never throws) when the proposal vanished from the registry between loadProposalForRatify's top-level read and updateProposalRegistry's fresh read under lock -- the concurrent-removal branch this task's design added is real, reachable code, not dead", async (t) => {
  const config = fixtureConfig();
  try {
    const registryPath = seedRegistry(config, [{ id: "P-GONE", summary: "about to vanish", evidenceAnchors: [] }]);

    // loadProposalForRatify's OWN top-level read goes through run-task.ts's NAMED
    // `readFileSync` import (unaffected by mocking the DEFAULT fs export below) and still
    // finds P-GONE, so reframeCommand proceeds past its "unknown proposal" usage-error check.
    // updateProposalRegistry's re-read, however, goes through lib/inbox.ts's `fs.readFileSync`
    // PROPERTY access (its `import fs from "node:fs"` default-import discipline, this file's
    // own header comment) -- intercepting ONLY that property, ONLY for registryPath, mirrors a
    // concurrent writer (another `rmd approve`/the daemon's heal) removing P-GONE in the
    // instant between those two reads, without needing a second real OS process.
    const original = fsDefault.readFileSync.bind(fsDefault);
    t.mock.method(fsDefault, "readFileSync", (path: unknown, ...rest: unknown[]) => {
      if (path === registryPath) return JSON.stringify({ proposals: [] });
      return (original as (...a: unknown[]) => unknown)(path, ...rest);
    });

    const code = await reframeCommand(["P-GONE", "--feedback", "too late"], { config });

    assert.equal(code, 2, "the concurrent-vanish branch refuses with exit 2, not a thrown exception");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

// ── The `deps.config`/`deps.gateway` PRODUCTION-DEFAULT branch (omitted `deps`) ────────────
//
// Every test above supplies `deps.config` (and approveCommand's `deps.gateway`) explicitly --
// proving the INJECTED-seam side of `deps.config ?? loadConfig()` (and `deps.gateway ?? {...
// real gateway ...}`), never the production side an operator's real `rmd inbox`/`rmd approve`/
// `rmd reframe` invocation actually takes when `deps` is omitted entirely. These three exercise
// THAT side for real, via `withRedirectedHomeConfig` (never the real
// `~/.config/remudero/config.json`, never `which claude`).

test("W1-T240: `rmd reframe` with `deps` omitted entirely falls through to the REAL loadConfig() -- the production default this task's injectable seam wraps, not merely the seam itself", async () => {
  await withRedirectedHomeConfig(async (root) => {
    const config: Config = { claudeBin: "/bin/true", root };
    seedRegistry(config, [{ id: "P-REALCFG", summary: "real config path", evidenceAnchors: [] }]);

    const code = await reframeCommand(["P-REALCFG", "--feedback", "exercised via the real loadConfig()"]);

    assert.equal(code, 0);
    const onDisk = parseProposalRegistry(readFileSync(join(root, "state", "inbox-proposals.json"), "utf8"));
    assert.deepEqual(onDisk[0].reframeHistory, [{ feedback: "exercised via the real loadConfig()" }]);
  });
});

test("W1-T240: `rmd inbox` with `deps` omitted entirely falls through to the REAL loadConfig()", async () => {
  await withRedirectedHomeConfig(async (root) => {
    const config: Config = { claudeBin: "/bin/true", root };
    seedRegistry(config, [{ id: "P-REALCFG-INBOX", summary: "real config path", evidenceAnchors: [] }]);
    seedRatifiedLedgerLine(config, "P-REALCFG-INBOX");

    const code = await inboxCommand(["--dry-run"]);

    assert.equal(code, 0);
    const onDisk = parseProposalRegistry(readFileSync(join(root, "state", "inbox-proposals.json"), "utf8"));
    assert.deepEqual(onDisk, []);
  });
});

test("W1-T240: `rmd approve` with `deps` omitted entirely falls through to BOTH the REAL loadConfig() AND the REAL, un-injected gateway construction -- a NOT-ready classification refuses before either gateway method actually fires, so this stays git/gh-network-free while still evaluating the real `deps.gateway ?? { ... }` fallback", async () => {
  await withRedirectedHomeConfig(async (root) => {
    const config: Config = { claudeBin: "/bin/true", root };
    // No cached draft ⇒ classifyProposal derives "not_ready" (drafted predicate fails) --
    // approveProposal refuses before calling either real gateway method, so the REAL
    // gateway object this line constructs is exercised (the branch this test targets)
    // without a real git clone or `gh pr create`.
    seedRegistry(config, [{ id: "P-REALGW", summary: "real gateway construction, never invoked", evidenceAnchors: [] }]);

    const code = await approveCommand(["P-REALGW"]);

    assert.equal(code, 1, "a not-ready classification refuses (exit 1) before any gateway method is ever called");
  });
});
