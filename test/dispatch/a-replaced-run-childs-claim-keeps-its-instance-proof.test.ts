import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  decideDispatchClaimRelease, dispatchClaimRef, findClaimMintRow,
  gitDispatchClaimReserver, gitDispatchClaimReserverAsync, parseClaimAnchorMessage,
  releaseDispatchClaim, releaseDispatchClaimAsync, releaseReplacedContainerClaims,
  type ClaimantLivenessProbe, type GitAnswer,
} from "#src/lib/dispatch-claim.js";
import { appendLedger, deriveLedgerActor, markRunChildProcessActor } from "#src/lib/ledger.js";
import { fixedClock } from "#src/lib/clock.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const TASK = "CHILD-CLAIM";
const OLD_HOST = "aaaaaaaaaaaa", NEW_HOST = "bbbbbbbbbbbb";
const MINT = "2000-01-01T00:00:00.000Z", LOCK = "2001-01-01T00:00:00.000Z";
const PROBE: ClaimantLivenessProbe = {
  localHost: OLD_HOST, namespaceBootMs: Date.parse(LOCK), namespaceBootIso: LOCK, pidPresent: false,
};

function fixture(t: TestContext) {
  const remote = gitRepo({ bare: true, scope: t }), client = gitRepo({ scope: t });
  client.addRemote("origin", remote.dir);
  const tree = client.git("rev-parse", "HEAD^{tree}");
  const old = client.git("commit-tree", tree, "-m", `rmd-dispatch claim 42@${OLD_HOST} ${MINT}`);
  const replacement = client.git("commit-tree", tree, "-m", `rmd-dispatch claim 43@${OLD_HOST} 2002-01-01T00:00:00.000Z`);
  assert.notEqual(old, replacement);
  const ref = dispatchClaimRef(TASK);
  client.git("push", "origin", `${old}:${ref}`);
  const env = { ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const run = (args: string[]): GitAnswer => {
    const r = spawnSync("git", args, { cwd: client.dir, env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 ** 2 });
    assert.equal(r.error, undefined, "fixture Git transport must complete");
    assert.equal(r.signal, null, "fixture Git transport must not be signalled");
    return { status: r.status ?? 128, stdout: r.stdout, stderr: r.stderr };
  };
  const current = () => client.git("ls-remote", "origin", ref).split(/\s+/)[0] || undefined;
  const replace = () => {
    client.git("push", `--force-with-lease=${ref}:${old}`, "origin", `${replacement}:${ref}`);
    assert.equal(current(), replacement, "a second claimant really owns the fixture remote");
  };
  const stateDir = join(client.dir, "state"); mkdirSync(stateDir);
  return { run, current, replace, old, replacement, stateDir };
}

function mintEvidence(stateDir: string, actor: "daemon" | "run_child") {
  const env: NodeJS.ProcessEnv = { REMUDERO_PROCESS_ACTOR: "daemon", REMUDERO_DAEMON_PROCESS: "1" };
  const restore = actor === "run_child" ? markRunChildProcessActor(env) : () => {};
  const observed = deriveLedgerActor(env, false);
  appendLedger(join(stateDir, "ledger.ndjson"), {
    run_id: "claim-fixture", task_id: TASK, step: "dispatch.claim", ref: dispatchClaimRef(TASK), outcome: "created",
  }, { actor: () => observed, identity: () => OLD_HOST, clock: fixedClock(Date.parse(MINT) + 100) });
  restore(); assert.equal(deriveLedgerActor(env, false), "daemon");
  return observed;
}

test("a replaced run-child claim is released from this instance's mint evidence", (t) => {
  const f = fixture(t);
  assert.equal(mintEvidence(f.stateDir, "run_child"), "run_child");
  const real = gitDispatchClaimReserver({ run: f.run });
  const results = releaseReplacedContainerClaims(real, {
    localHost: NEW_HOST, lockHeldSinceMs: Date.parse(LOCK), lockHeldSinceIso: LOCK,
    findMintRow: (id, anchor) => findClaimMintRow(f.stateDir, id, anchor),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].arm, "dead-claimant"); assert.equal(results[0].dropped, true);
  assert.match(results[0].reason, /run_child/); assert.doesNotMatch(results[0].reason, /records that daemon minting/);
  assert.match(results[0].reason, /drain\.lock/); assert.equal(f.current(), undefined);
});

test("claim control: the legacy replaced daemon still releases", (t) => {
  const f = fixture(t); mintEvidence(f.stateDir, "daemon");
  const [result] = releaseReplacedContainerClaims(gitDispatchClaimReserver({ run: f.run }), {
    localHost: NEW_HOST, lockHeldSinceMs: Date.parse(LOCK), lockHeldSinceIso: LOCK,
    findMintRow: (id, anchor) => findClaimMintRow(f.stateDir, id, anchor),
  });
  assert.equal(result.arm, "dead-claimant"); assert.equal(result.dropped, true); assert.equal(f.current(), undefined);
});

test("claim control: an adopted child in the same container remains held", (t) => {
  const f = fixture(t); mintEvidence(f.stateDir, "run_child");
  const [result] = releaseReplacedContainerClaims(gitDispatchClaimReserver({ run: f.run }), {
    localHost: OLD_HOST, lockHeldSinceMs: Date.parse(LOCK), lockHeldSinceIso: LOCK,
    findMintRow: (id, anchor) => findClaimMintRow(f.stateDir, id, anchor),
  });
  assert.equal(result.arm, "operator"); assert.equal(result.dropped, false); assert.equal(f.current(), f.old);
});

test("claim controls: unknown foreign and unproved mint identities cannot release", () => {
  const anchorIdentity = parseClaimAnchorMessage(`rmd-dispatch claim 42@${OLD_HOST} ${MINT}`)!;
  const mintRow = { host: OLD_HOST, actor: "run_child", ts: MINT, source: "ledger.ndjson" };
  const replaced = { localHost: NEW_HOST, lockHeldSinceMs: Date.parse(LOCK), lockHeldSinceIso: LOCK, mintRow };
  for (const probe of [
    { ...replaced, mintRow: undefined },
    { ...replaced, mintRow: { ...mintRow, host: "foreign-host" } },
    { ...replaced, lockHeldSinceMs: Date.parse(MINT) },
    ...["operator", "operator_ai", "worker", "unknown"].map(actor => ({ ...replaced, mintRow: { ...mintRow, actor } })),
  ]) {
    const result = decideDispatchClaimRelease({ heldByThisRun: false, evidenceObserved: false, taskId: TASK, anchorIdentity, replaced: probe });
    assert.equal(result.release, false); assert.equal(result.arm, "operator");
  }
});

for (const beforeMessage of [false, true]) {
  test(beforeMessage ? "sync death evidence reads the initially observed SHA" : "sync death evidence cannot release a replacement claim", (t) => {
    const f = fixture(t), real = gitDispatchClaimReserver({ run: f.run });
    const read = real.anchorMessage!.bind(real);
    real.anchorMessage = (id, ...args) => {
      if (beforeMessage) f.replace();
      const message = read(id, ...args);
      if (!beforeMessage) f.replace();
      return message;
    };
    const result = releaseDispatchClaim(TASK, real, { livenessProbe: () => PROBE });
    assert.equal(result.arm, "dead-claimant"); assert.equal(result.release, true);
    assert.equal(f.current(), f.replacement, "replacement must survive old death evidence"); assert.equal(result.dropped, false);
  });
  test(beforeMessage ? "async death evidence reads the initially observed SHA" : "async death evidence cannot release a replacement claim", async (t) => {
    const f = fixture(t), real = gitDispatchClaimReserverAsync({ run: async args => f.run(args) });
    const read = real.anchorMessage!.bind(real);
    real.anchorMessage = async (id, ...args) => {
      if (beforeMessage) f.replace();
      const message = await read(id, ...args);
      if (!beforeMessage) f.replace();
      return message;
    };
    const result = await releaseDispatchClaimAsync(TASK, real, { livenessProbe: () => PROBE });
    assert.equal(result.arm, "dead-claimant"); assert.equal(result.release, true);
    assert.equal(f.current(), f.replacement, "replacement must survive old death evidence"); assert.equal(result.dropped, false);
  });
}

test("claim control: unchanged sync and async dead claimants release", async (t) => {
  for (const async of [false, true]) {
    const f = fixture(t);
    const result = async
      ? await releaseDispatchClaimAsync(TASK, gitDispatchClaimReserverAsync({ run: async args => f.run(args) }), { livenessProbe: () => PROBE })
      : releaseDispatchClaim(TASK, gitDispatchClaimReserver({ run: f.run }), { livenessProbe: () => PROBE });
    assert.equal(result.arm, "dead-claimant"); assert.equal(result.dropped, true); assert.equal(f.current(), undefined);
  }
});

test("claim evidence refuses an unreadable initially selected object", async (t) => {
  const f = fixture(t), absent = "f".repeat(40);
  const sync = gitDispatchClaimReserver({ run: f.run });
  const awaited = gitDispatchClaimReserverAsync({ run: async args => f.run(args) });
  sync.holder = () => absent; awaited.holder = async () => absent;
  assert.equal(releaseDispatchClaim(TASK, sync, { livenessProbe: () => PROBE }).release, false);
  assert.equal((await releaseDispatchClaimAsync(TASK, awaited, { livenessProbe: () => PROBE })).release, false);
  assert.equal(f.current(), f.old);
});
