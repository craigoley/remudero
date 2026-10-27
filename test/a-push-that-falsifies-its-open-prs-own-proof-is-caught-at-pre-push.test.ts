// @source-text-subject: hooks/pre-push is a shell script; that it CALLS the precheck is a fact about its text.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { openPrBodyVerdict, refusalsAtSha, selectBodySource } from "#scripts/open-pr-body-proof-precheck.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * 2026-10-13: a push to #11328's shards broke that PR's own stored `## Acceptance` grep proof and it surfaced only as
 * review-failed ~20 minutes later. The precheck judges the stored body's proofs at the remote's old tip and at the pushed
 * sha, over a real fixture repository with its own identity, with the body readers and floor state injected.
 */

const BODY = "Summary\n\n## Acceptance\n- the widget keeps its needle | grep: needle-text in widget.txt\n\nRemudero-Task: W1-T99999-unfiled\n";
const ZERO = "0".repeat(40);

interface Fixture {
  repoRoot: string;
  oldSha: string;
  newSha: string;
  cleanup(): void;
}

/** A repo whose first commit carries the proof's text and whose second removes it. */
function fixture(opts: { alreadyFailing?: boolean } = {}): Fixture {
  const repo = gitRepo({ kind: "open-pr-body-proof" });
  writeFileSync(join(repo.dir, "widget.txt"), opts.alreadyFailing ? "nothing here\n" : "needle-text\n");
  repo.git("add", "widget.txt");
  repo.git("commit", "--quiet", "-m", "add widget");
  const oldSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "widget.txt"), "reworded\n");
  repo.git("commit", "--quiet", "-am", "reword widget");
  return { repoRoot: repo.dir, oldSha, newSha: repo.git("rev-parse", "HEAD"), cleanup: () => repo.cleanup() };
}

function verdictFor(f: Fixture, kind: "fresh" | "cached") {
  const source = { kind, body: BODY, lines: [] as string[] };
  return openPrBodyVerdict({
    source,
    oldSha: f.oldSha,
    newSha: f.newSha,
    refusalsAt: (sha: string) => refusalsAtSha(f.repoRoot, sha, [{ claim: "the widget keeps its needle", proof: "grep: needle-text in widget.txt" }]),
  });
}

test("W1-T9235: a push that falsifies a fresh body proof is refused", () => {
  const f = fixture();
  try {
    const reads: string[] = [];
    const source = selectBodySource({
      oldSha: f.oldSha,
      newSha: f.newSha,
      floorClear: () => true,
      readFresh: () => (reads.push("fresh"), BODY),
      readCache: () => undefined,
    });
    assert.equal(source.kind, "fresh");
    assert.deepEqual(reads, ["fresh"], "exactly one read per push");
    const v = verdictFor(f, "fresh");
    assert.equal(v.exit, 1);
    const text = v.lines.join("\n");
    assert.match(text, /NEWLY FALSIFIES 1 proof/);
    assert.match(text, /grep: needle-text in widget\.txt/);
    assert.match(text, /old tip [0-9a-f]{12}: passes/);
    assert.match(text, /pushed [0-9a-f]{12}: FAILS/);
    assert.match(text, /edit the PR body's ## Acceptance first and push again/);
  } finally {
    f.cleanup();
  }
});

test("W1-T9235: a cached body or an already failing proof only reports", () => {
  const f = fixture();
  const g = fixture({ alreadyFailing: true });
  try {
    const cached = verdictFor(f, "cached");
    assert.equal(cached.exit, 0, "a cached body may have been edited elsewhere: reported, never refused");
    assert.match(cached.lines.join("\n"), /NEWLY FALSIFIES 1 proof/);
    assert.match(cached.lines.join("\n"), /REPORTED and the push goes on/);

    const already = verdictFor(g, "fresh");
    assert.equal(already.exit, 0, "a proof failing at the old tip is not this push's doing");
    assert.match(already.lines.join("\n"), /already failing at the old tip \(reported only\)/);
    assert.doesNotMatch(already.lines.join("\n"), /NEWLY FALSIFIES/);
  } finally {
    f.cleanup();
    g.cleanup();
  }
});

test("W1-T9235: a first push or a busy floor makes no GitHub read", () => {
  const calls: string[] = [];
  const seams = {
    floorClear: () => (calls.push("floor"), true),
    readFresh: () => (calls.push("fresh"), BODY),
    readCache: () => (calls.push("cache"), undefined),
  };
  const first = selectBodySource({ oldSha: ZERO, newSha: "a".repeat(40), ...seams });
  assert.equal(first.kind, "skip");
  assert.match(first.lines.join("\n"), /first push of a new branch/);
  const deletion = selectBodySource({ oldSha: "b".repeat(40), newSha: ZERO, ...seams });
  assert.equal(deletion.kind, "skip");
  assert.deepEqual(calls, [], "neither a first push nor a deletion consults the floor, the cache or GitHub");

  const busy = selectBodySource({
    oldSha: "b".repeat(40),
    newSha: "a".repeat(40),
    floorClear: () => false,
    readFresh: () => (calls.push("fresh"), BODY),
    readCache: () => (calls.push("cache"), undefined),
  });
  assert.equal(busy.kind, "unchecked");
  assert.match(busy.lines.join("\n"), /open-PR body proofs UNCHECKED: read floor busy and no cached body/);
  assert.deepEqual(calls, ["cache"], "a busy floor reads the cache only, never GitHub");
  assert.equal(openPrBodyVerdict({ source: busy, oldSha: "b".repeat(40), newSha: "a".repeat(40), refusalsAt: () => assert.fail("no body, no judgement") }).exit, 0);

  const cached = selectBodySource({ oldSha: "b".repeat(40), newSha: "a".repeat(40), floorClear: () => false, readFresh: () => assert.fail("busy"), readCache: () => BODY });
  assert.equal(cached.kind, "cached");

  // the real script, shelled out: a first push (all-zero old sha) is a named skip and exits 0 without any gh call
  const dir = mkdtempSync(join(tmpdir(), "rmd-open-pr-body-first-"));
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/open-pr-body-proof-precheck.mjs"), "--head-ref", "run-x-1", "--old-sha", ZERO, "--new-sha", "a".repeat(40)], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, RMD_GH_CACHE_HOME: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SKIP -- a first push of a new branch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9235: hooks/pre-push runs the open-PR body precheck", () => {
  const hook = readFileSync(join(REPO_ROOT, "hooks/pre-push"), "utf8");
  assert.match(hook, /open-pr-body-proof-precheck\.mjs" \\\n\s+--head-ref "\$head_ref" --old-sha "\$head_old_sha" --new-sha "\$head_sha"/);
  assert.match(hook, /\$head_old_sha" != "\$zero_sha"/, "only an update to an existing remote branch");
});
