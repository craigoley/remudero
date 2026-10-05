import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { decideDispatchClaim, dispatchClaimRef, parseClaimAnchorMessage } from "../src/lib/dispatch-claim.js";
import { claimCommand, COMMANDS, dispatchClaimReserverFor } from "../src/run-task.js";

// W1-T5859: `rmd claim <task-id>` takes the same git-ref CAS claim the fleet's lanes take, so a
// hand-build is visible to dispatch before its branch or PR is. Driven against a REAL bare remote.

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

interface Fixture { bare: string; work: string; cleanup(): void }

function fixture(): Fixture {
  const bare = mkdtempSync(join(tmpdir(), "rmd-claim-verb-bare-"));
  const work = mkdtempSync(join(tmpdir(), "rmd-claim-verb-work-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: GIT_ENV });
  execFileSync("git", ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  writeFileSync(join(work, "seed.txt"), "seed\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "chore: seed");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "--quiet", "origin", "main");
  return {
    bare,
    work,
    cleanup() {
      rmSync(bare, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

function run(args: string[], deps: Parameters<typeof claimCommand>[1]): { code: number; out: string; err: string } {
  const out = mock.method(console, "log", () => {});
  const err = mock.method(console, "error", () => {});
  try {
    const code = claimCommand(args, deps);
    const text = (m: typeof out) => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    return { code, out: text(out), err: text(err) };
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
}

const remoteClaim = (f: Fixture, id: string): string =>
  execFileSync("git", ["-C", f.bare, "for-each-ref", "--format=%(objectname)", dispatchClaimRef(id)], { encoding: "utf8" }).trim();

test("claim is a registered verb with a claim summary", () => {
  const spec = COMMANDS.find((c) => c.name === "claim");
  assert.ok(spec, "the verb is in the command table");
  assert.match(spec.syntax, /^rmd claim <task-id> \[--drop\]$/);
});

test("rmd claim on an unclaimed planned task pushes refs/rmd-dispatch/<id> with the reserver's anchor message and exits 0", () => {
  const f = fixture();
  try {
    const reserver = dispatchClaimReserverFor(f.work);
    const r = run(["W1-T5859"], { reserver, isPlanned: () => true });
    assert.equal(r.code, 0);
    assert.equal(r.out, "claimed refs/rmd-dispatch/W1-T5859");
    const sha = remoteClaim(f, "W1-T5859");
    assert.match(sha, /^[0-9a-f]{40}$/, "the claim ref exists on the remote");
    const msg = execFileSync("git", ["-C", f.bare, "log", "-1", "--format=%B", sha], { encoding: "utf8" });
    const identity = parseClaimAnchorMessage(msg);
    assert.ok(identity, "the anchor message is the reserver's own `rmd-dispatch claim <pid>@<host> <iso>` shape");
    assert.equal(identity.host, hostname());
    assert.equal(identity.pid, process.pid);
    const fleetLane = dispatchClaimReserverFor(f.work);
    const outcome = fleetLane.attempt("W1-T5859", fleetLane.mintAnchor());
    assert.equal(outcome, "taken", "a fleet lane's own claim now meets contention");
    assert.equal(decideDispatchClaim(outcome, { taskId: "W1-T5859" }).proceed, false);
  } finally {
    f.cleanup();
  }
});

test("rmd claim a second time exits 1 naming the holder and leaves the first claim", () => {
  const f = fixture();
  try {
    const reserver = dispatchClaimReserverFor(f.work);
    assert.equal(run(["W1-T5859"], { reserver, isPlanned: () => true }).code, 0);
    const first = remoteClaim(f, "W1-T5859");
    const r = run(["W1-T5859"], { reserver, isPlanned: () => true });
    assert.equal(r.code, 1);
    assert.match(r.err, /already claimed by another lane/);
    assert.ok(r.err.includes(`held by ${first}`), "names the holder's anchor");
    assert.equal(remoteClaim(f, "W1-T5859"), first, "the first claim survives");
  } finally {
    f.cleanup();
  }
});

test("rmd claim with an unreachable origin exits 1 without claiming", () => {
  const f = fixture();
  try {
    git(f.work, "remote", "set-url", "origin", join(f.bare, "does-not-exist"));
    const r = run(["W1-T5859"], { reserver: dispatchClaimReserverFor(f.work), isPlanned: () => true });
    assert.equal(r.code, 1);
    assert.match(r.err, /cannot reach origin to claim refs\/rmd-dispatch\/W1-T5859/);
    assert.equal(remoteClaim(f, "W1-T5859"), "", "nothing was claimed");
  } finally {
    f.cleanup();
  }
});

test("rmd claim refuses an unplanned id before touching the remote", () => {
  const f = fixture();
  try {
    const r = run(["W1-T999999"], { reserver: dispatchClaimReserverFor(f.work), isPlanned: () => false });
    assert.equal(r.code, 1);
    assert.match(r.err, /not in the plan/);
    assert.equal(remoteClaim(f, "W1-T999999"), "");
    assert.equal(run([], { isPlanned: () => true }).code, 2, "no id is a usage error");
    assert.equal(run(["W1-T5859", "--bogus"], { isPlanned: () => true }).code, 2, "an unknown flag is a usage error");
  } finally {
    f.cleanup();
  }
});

test("rmd claim --drop removes only a claim minted on this host", () => {
  const f = fixture();
  try {
    const reserver = dispatchClaimReserverFor(f.work);
    assert.equal(run(["W1-T5859"], { reserver, isPlanned: () => true }).code, 0);
    const held = remoteClaim(f, "W1-T5859");

    const foreign = run(["W1-T5859", "--drop"], { reserver, isPlanned: () => true, localHost: "another-host.invalid" });
    assert.equal(foreign.code, 1);
    assert.match(foreign.err, /not by this host/);
    assert.equal(remoteClaim(f, "W1-T5859"), held, "another host's claim is never dropped");

    const own = run(["W1-T5859", "--drop"], { reserver, isPlanned: () => true });
    assert.equal(own.code, 0);
    assert.equal(own.out, "dropped refs/rmd-dispatch/W1-T5859");
    assert.equal(remoteClaim(f, "W1-T5859"), "", "this host's claim is gone");

    const none = run(["W1-T5859", "--drop"], { reserver, isPlanned: () => true });
    assert.equal(none.code, 1, "dropping an absent claim is not a success");
    assert.match(none.err, /nothing to drop/);
  } finally {
    f.cleanup();
  }
});
