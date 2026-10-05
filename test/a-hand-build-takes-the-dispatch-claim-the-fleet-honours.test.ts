import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";
import { decideDispatchClaim, dispatchClaimRef, parseClaimAnchorMessage } from "../src/lib/dispatch-claim.js";
import { claimCommand, COMMANDS, dispatchClaimReserverFor, plannedOnOriginMain } from "../src/run-task.js";

// W1-T5859: `rmd claim <task-id>` takes the same git-ref CAS claim the fleet's lanes take, so a
// hand-build is visible to dispatch before its branch or PR is. Driven against a REAL bare remote.

// The reserver runs git through spawnSync with the inherited environment, so the fixture's identity
// must be in process.env for `commit-tree` (the anchor mint) to succeed on a stripped runner.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
});

interface Fixture { bare: string; work: string; setOrigin(url: string): void; cleanup(): void }

function fixture(): Fixture {
  const bareRepo = gitRepo({ bare: true, kind: "claim-verb-bare" });
  const workRepo = gitRepo({ kind: "claim-verb-work" });
  workRepo.addRemote("origin", bareRepo.dir);
  workRepo.git("push", "--quiet", "origin", "main");
  return {
    bare: bareRepo.dir,
    work: workRepo.dir,
    setOrigin: (url) => workRepo.git("remote", "set-url", "origin", url),
    cleanup() {
      bareRepo.cleanup();
      workRepo.cleanup();
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
    f.setOrigin(join(f.bare, "does-not-exist"));
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

test("plannedOnOriginMain reads origin/main's shards and tasks.yaml through real git", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.work, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(f.work, "plan", "tasks.d", "W1-T9001-a-shard.yaml"), "- id: W1-T9001\n");
    writeFileSync(join(f.work, "plan", "tasks.yaml"), "- id: W1-T9002\n  title: mono\n");
    execFileSync("git", ["-C", f.work, "add", "-A"]);
    execFileSync("git", ["-C", f.work, "commit", "-q", "-m", "plan"]);
    execFileSync("git", ["-C", f.work, "push", "-q", "origin", "main"]);
    assert.equal(plannedOnOriginMain("W1-T9001", f.work), true, "a shard on origin/main is planned");
    assert.equal(plannedOnOriginMain("W1-T9002", f.work), true, "a tasks.yaml id on origin/main is planned");
    assert.equal(plannedOnOriginMain("W1-T9003", f.work), false, "an id on neither is not planned");
    assert.equal(plannedOnOriginMain("W1.T9002", f.work), false, "a dot in the id is literal, never a regex wildcard");
  } finally {
    f.cleanup();
  }
});

test("an id that is not task-shaped is refused before any plan or remote read", () => {
  const r = run(["W1 T1"], { isPlanned: () => assert.fail("never read the plan"), reserver: undefined });
  assert.equal(r.code, 2);
  assert.match(r.err, /is not a task id/);
});

test("--drop reports a claim it could not drop instead of claiming success", () => {
  const anchor = `rmd-dispatch claim 4242@${hostname()} 2026-10-05T00:00:00.000Z`;
  const reserver = {
    holder: () => "abc123",
    anchorMessage: () => anchor,
    drop: () => false,
    attempt: () => assert.fail("--drop never attempts a claim"),
    mintAnchor: () => assert.fail("--drop never mints"),
  } as unknown as NonNullable<Parameters<typeof claimCommand>[1]>["reserver"];
  const r = run(["W1-T9001", "--drop"], { isPlanned: () => true, reserver });
  assert.equal(r.code, 1);
  assert.match(r.err, /could not drop refs\/rmd-dispatch\/W1-T9001/);
});
