/**
 * The two production entries of the live-edit ladder: `rmd live-edits` (the host watchdog's, which
 * never escalates) and the daemon's wiring, which escalates and comments through `gh` as the fleet.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { repoRoot } from "../src/lib/repo-location.js";
import { liveEditLadderWiring, liveEditsCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

test("rmd live-edits refuses a missing or unknown tree, and prints one JSON verdict for a real one", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  assert.equal(await liveEditsCommand(["--tree", "elsewhere", "--checkout", "/x", "--state-root", "/y"]), 2);
  assert.equal(await liveEditsCommand(["--checkout", "/x"]), 2);
  assert.equal(await liveEditsCommand(["--bogus"]), 2);
  assert.equal(errors.mock.callCount(), 3);

  const tree = gitRepo({ kind: "live-edits-verb" });
  writeFileSync(join(tree.dir, "app.txt"), "v1\n");
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "seed");
  writeFileSync(join(tree.dir, "app.txt"), "hand edit\n");
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}live-edits-verb-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const out = t.mock.method(console, "log", () => {});
  const args = ["--tree", "install-checkout", "--checkout", tree.dir, "--state-root", state];
  assert.equal(await liveEditsCommand([...args, "--json"], fixedClock(Date.parse("2026-10-11T00:17:00Z"))), 0);
  const verdict = JSON.parse(String(out.mock.calls[0]!.arguments[0])) as { tree: string; tier: number; restored: boolean; patch?: string };
  assert.equal(verdict.tree, "install-checkout");
  assert.equal(verdict.tier, 1, "no origin/main, so no staleness: preserved and deferred");
  assert.equal(verdict.restored, false);
  assert.match(readFileSync(join(state, verdict.patch!), "utf8"), /^\+hand edit$/m);
  assert.equal(await liveEditsCommand(args), 0);
  assert.match(String(out.mock.calls[1]!.arguments[0]), /^live-edits install-checkout: tier 1 -- /);
});

test("the daemon's live-edit wiring covers its own tree and the install tree, and speaks through gh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}live-edits-wiring-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = liveEditLadderWiring({ root, claudeBin: "/bin/true" } as Config, fixedClock(42));
  assert.equal(w.daemonRepoDir, repoRoot);
  assert.equal(w.installRepoDir, join(root, "daemon-install"));
  assert.equal(w.stateDir, join(root, "state"));
  assert.equal(w.clock.now(), 42);

  const gh = ghShim([{ when: "issues?labels=needs-human", stdout: "[]" }], { kind: "live-edits-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  try {
    // A PATH-stubbed gh: the guard checks the call, not the destination, so the section opts in.
    await withLiveWritesAllowed(async () => {
      await w.escalate!({ class: "BLOCKED", taskId: "LIVE-EDITS-daemon-checkout", summary: "s", detail: "d", options: [{ label: "a", detail: "b" }], recommendation: "a" });
      await w.comment!("https://github.com/example/fleet/issues/1", "restored");
    });
  } finally {
    process.env.PATH = previousPath;
  }
  const seen = gh.calls().join("\n");
  assert.match(seen, /^api repos\/[^ ]+\/issues\?labels=needs-human&state=open/m, "the escalation dedups against the open needs-human issues");
  assert.match(seen, /^issue create .*--title \[BLOCKED\] LIVE-EDITS-daemon-checkout: s /m, "and opens one when none matches");
  assert.match(seen, /^issue comment /m, "the restore notice is a comment on the issue");
});
