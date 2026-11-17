import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyStaleFixDispatchRecovery,
  authorizeStaleFixDispatchRecovery,
  defaultDescendants,
  defaultProbeProcess,
  defaultRecoveryGit,
  parsePriorDispatchClaim,
  PR_OWNER_RECOVERY_AUTHORIZED_STEP,
  PR_OWNER_RECOVERY_RECEIPT_STEP,
  recoveryAuthorizationId,
  type LivePr,
  type RecoveryPorts,
  type RecoveryResult,
  type RecoveryTuple,
} from "#src/lib/stale-fix-dispatch-recovery-apply.js";
import { fixRoundClaimId } from "#src/lib/sweep.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;

const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const PUSHED = "d".repeat(40);
const REPO = "craigoley/remudero";
const PR = 4851;
const TASK = "W1-T9001";
const RUN = "SWEEP-1";
const CLAIM_MS = 1794000000000;
const ROUND_START = CLAIM_MS + 500;
const ROUND = `${RUN}:1:${ROUND_START}`;
const BRANCH = "run-W1-T9001-1";
const HOST = "host-a";
const PRIOR_PID = 4242;
const iso = (ms: number) => new Date(ms).toISOString();

const claimKeyOf = (owner: string, repo: string, branch: string) => `fix-branch--${owner}--${repo}--${branch}`.replace(/[/\\]/g, "__");

const TUPLE: RecoveryTuple = { repo: REPO, prNumber: PR, taskId: TASK, runId: RUN, roundId: ROUND, headSha: HEAD, baseSha: BASE, branch: BRANCH };

interface World {
  dir: string;
  ports: RecoveryPorts;
  rows: Row[];
  pr: LivePr;
  gitCalls: string[][];
  proc: Map<number, "dead" | "alive" | "unknown" | "reused" | "foreign_host">;
  originRefs: Map<string, string>;
  localRefs: Map<string, string>;
  state: {
    login: string | Error;
    perms: Array<string | Error>;
    actor: string;
    descendants: { state: "none" | "present" | "unknown"; pids?: number[] };
    cwd: { state: "clear" | "occupied" | "unknown" };
    dispatchRef: string;
    worktree: { path: string; dirty: string } | undefined;
    originUnreachable: boolean;
    clockMs: number;
    clockStep: number;
    nonces: number;
    failAppend?: (step: string) => boolean;
  };
  claimKeys: string[];
  priorLockPath: string;
  stateDir: string;
  writePriorLock(over?: Partial<{ pid: number; run_id: string; host: string; startedAt: string }>, raw?: string): string;
  cleanup(): void;
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12114-`));
  const stateDir = join(dir, "state");
  const inflightDir = join(stateDir, "inflight");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  const rows: Row[] = [{
    step: "fix.dispatch", ts: iso(ROUND_START + 1000), task_id: TASK, run_id: RUN, round_id: ROUND, pr_number: PR,
    head_sha: HEAD, base_sha: BASE, branch: BRANCH, repo: REPO,
  }];
  const pr: LivePr = { repo: REPO, prNumber: PR, headSha: HEAD, baseSha: BASE, branch: BRANCH };
  const gitCalls: string[][] = [];
  const proc = new Map<number, "dead" | "alive" | "unknown" | "reused" | "foreign_host">([[777, "alive"]]);
  const originRefs = new Map<string, string>();
  const localRefs = new Map<string, string>();
  const claimKeys: string[] = [];
  const state: World["state"] = {
    login: "craig", perms: [], actor: "operator_human", descendants: { state: "none" }, cwd: { state: "clear" },
    dispatchRef: "", worktree: { path: join(dir, "wt"), dirty: " M src/a.ts\0" }, originUnreachable: false,
    clockMs: Date.parse("2026-11-16T21:00:00.000Z"), clockStep: 1000, nonces: 0,
  };
  const priorLockPath = join(inflightDir, `${claimKeyOf("craigoley", "remudero", BRANCH)}.lock`);
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const ports: RecoveryPorts = {
    stateDir, inflightDir, repoDir,
    readLedger: async () => ({ ok: true, unread: [], rows: rows.map((r) => ({ ...r })) }),
    appendLedger: (step, row) => {
      if (state.failAppend?.(step)) throw new Error(`simulated crash appending ${step}`);
      rows.push({ ...row, step, actor: "operator_human", host: HOST });
    },
    readPr: async () => ({ ...pr }),
    currentLogin: async () => {
      if (state.login instanceof Error) throw state.login;
      return state.login;
    },
    permission: async () => {
      const next = state.perms.length > 1 ? state.perms.shift()! : state.perms[0] ?? "admin";
      if (next instanceof Error) throw next;
      return next;
    },
    processActor: () => state.actor,
    probeProcess: (holder) => proc.get(holder.pid) ?? "dead",
    descendants: () => state.descendants,
    cwdCensus: () => state.cwd,
    git: async (args) => {
      gitCalls.push(args);
      const [cmd] = args;
      if (cmd === "worktree") {
        const main = `worktree ${repoDir}\nHEAD ${BASE}\nbranch refs/heads/main\n`;
        return ok(state.worktree ? `${main}\nworktree ${state.worktree.path}\nHEAD ${HEAD}\nbranch refs/heads/${BRANCH}\n` : main);
      }
      if (cmd === "ls-remote" && args[2]?.startsWith("refs/rmd-dispatch/")) return ok(state.dispatchRef ? `${state.dispatchRef}\t${args[2]}\n` : "");
      if (cmd === "ls-remote") {
        if (state.originUnreachable) return { status: 128, stdout: "", stderr: "unreachable" };
        return ok([...originRefs].map(([ref, sha]) => `${sha}\t${ref}`).join("\n"));
      }
      if (cmd === "rev-parse") {
        const what = args[args.length - 1]!;
        if (what === "HEAD") return ok(`${HEAD}\n`);
        const sha = localRefs.get(what);
        return sha ? ok(`${sha}\n`) : { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "status") return ok(state.worktree?.dirty ?? "");
      if (cmd === "merge-base") return { status: args[2] === args[3] ? 0 : 1, stdout: "", stderr: "" };
      if (cmd === "write-tree") return ok(`${"f".repeat(40)}\n`);
      if (cmd === "commit-tree") return ok(`${"e".repeat(40)}\n`);
      if (cmd === "update-ref") {
        if (localRefs.has(args[1]!)) return { status: 1, stdout: "", stderr: "exists" };
        localRefs.set(args[1]!, args[2]!);
        return ok();
      }
      if (cmd === "for-each-ref") return ok([...localRefs].map(([ref, sha]) => `${sha} ${ref}`).join("\n"));
      if (cmd === "remote") return ok("/srv/origin.git\n");
      if (cmd === "push") {
        const lines = args.filter((a) => /^[0-9a-f]{40}:/.test(a)).map((spec) => {
          const [sha, ref] = spec.split(":") as [string, string];
          if (originRefs.has(ref) && originRefs.get(ref) !== sha) return `!\t${sha}:${ref}\t[rejected] (stale info)`;
          originRefs.set(ref, sha);
          return `*\t${sha}:${ref}\t[new reference]`;
        });
        return ok(lines.join("\n"));
      }
      return ok();
    },
    nowIso: () => iso((state.clockMs += state.clockStep)),
    nonce: () => (state.nonces += 1).toString(16).padStart(16, "0"),
    hostname: () => HOST,
    pid: 777,
  };
  return {
    dir, ports, rows, pr, gitCalls, proc, originRefs, localRefs, state, claimKeys, priorLockPath, stateDir,
    writePriorLock(over = {}, raw) {
      mkdirSync(inflightDir, { recursive: true });
      const bytes = raw ?? JSON.stringify({
        pid: PRIOR_PID, run_id: fixRoundClaimId(RUN, PR, CLAIM_MS), host: HOST, startedAt: iso(CLAIM_MS + 100), ...over,
      }, null, 2);
      writeFileSync(priorLockPath, bytes);
      return bytes;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function deps(w: World) {
  return {
    ports: w.ports,
    claimKeyOf: (owner: string, repo: string, branch: string) => {
      w.claimKeys.push(branch);
      return claimKeyOf(owner, repo, branch);
    },
    fixRoundClaimId,
  };
}

const authorize = (w: World, over: Partial<RecoveryTuple & { reason: string }> = {}) =>
  authorizeStaleFixDispatchRecovery({ ...TUPLE, reason: "worker died mid-round", ...over }, deps(w));
const apply = (w: World, id: string) => applyStaleFixDispatchRecovery({ authorizationId: id }, deps(w));
const authRows = (w: World) => w.rows.filter((r) => r.step === PR_OWNER_RECOVERY_AUTHORIZED_STEP);
const receipts = (w: World, outcome?: string) =>
  w.rows.filter((r) => r.step === PR_OWNER_RECOVERY_RECEIPT_STEP && (outcome === undefined || r.outcome === outcome));
const receiptFiles = (w: World) => (existsSync(join(w.stateDir, "pr-owner-recoveries")) ? readdirSync(join(w.stateDir, "pr-owner-recoveries")) : []);

async function authorized(w: World): Promise<string> {
  const res = await authorize(w);
  assert.equal(res.outcome, "authorized", JSON.stringify(res));
  return (res as Extract<RecoveryResult, { outcome: "authorized" }>).authorizationId;
}

function gate(): { wait: Promise<void>; open(): void; entered: Promise<void>; enter(): void } {
  let open!: () => void;
  let enter!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  const entered = new Promise<void>((r) => (enter = r));
  return { wait, open, entered, enter };
}

test("W1-T12114 authorize requires admin", async () => {
  // Happy path: an admin records one authorization naming the tuple, login and id, under the claim.
  const w = makeWorld();
  try {
    w.writePriorLock();
    const res = await authorize(w);
    assert.equal(res.outcome, "authorized", JSON.stringify(res));
    const [row] = authRows(w);
    assert.equal(authRows(w).length, 1);
    assert.equal(row!.login, "craig");
    assert.equal(row!.authorization_id, recoveryAuthorizationId(TUPLE, "craig", String(row!.ts)));
    assert.deepEqual([row!.repo, row!.pr_number, row!.task_id, row!.dispatch_run_id, row!.dispatch_round_id, row!.head_sha, row!.base_sha, row!.branch],
      [REPO, PR, TASK, RUN, ROUND, HEAD, BASE, BRANCH]);
    assert.equal((row!.prior_claim as Row).run_id, fixRoundClaimId(RUN, PR, CLAIM_MS), "the reclaimed prior lock is recorded");
    assert.deepEqual(w.claimKeys, [BRANCH], "the claim key comes from the live branch");
    assert.equal(existsSync(w.priorLockPath), false, "the claim is released in finally");
    // A second unconsumed authorization for the same dispatch is refused.
    const again = await authorize(w);
    assert.equal(again.outcome, "refused");
    assert.match((again as { reason: string }).reason, /^authorization_exists:/);
    assert.equal(authRows(w).length, 1);
  } finally {
    w.cleanup();
  }

  // Every failed or unreadable identity or permission lookup refuses without writing.
  const refusals: Array<[string, (w: World) => void, RegExp]> = [
    ["non-admin", (w) => (w.state.perms = ["write"]), /^not_admin:craig$/],
    ["identity lookup failure", (w) => (w.state.login = new Error("gh api user: 502")), /^identity_unreadable/],
    ["permission lookup failure", (w) => (w.state.perms = [new Error("403")]), /^not_admin/],
    ["permission revoked before the locked append", (w) => (w.state.perms = ["admin", "read"]), /^not_admin/],
    ["fleet-automation actor", (w) => (w.state.actor = "daemon"), /^fleet_automation_actor:daemon$/],
    ["bot login", (w) => (w.state.login = "remudero[bot]"), /^identity_not_operator/],
  ];
  for (const [name, arrange, reason] of refusals) {
    const v = makeWorld();
    try {
      arrange(v);
      const res = await authorize(v);
      assert.equal(res.outcome, "refused", name);
      assert.match((res as { reason: string }).reason, reason, name);
      assert.equal(authRows(v).length, 0, `${name} writes no authorization row`);
    } finally {
      v.cleanup();
    }
  }

  // A supplied branch that is not the live canonical branch is refused before any claim is chosen.
  const b = makeWorld();
  try {
    b.pr.branch = "feat/other";
    const res = await authorize(b);
    assert.equal(res.outcome, "refused");
    assert.match((res as { reason: string }).reason, /^branch_mismatch/);
    assert.deepEqual(b.claimKeys, [], "no branch-keyed claim was derived");
    assert.equal(b.state.nonces, 0, "no claim run id was minted");
    // A live branch with a slash is the one the key derives from.
    b.pr.branch = "feat/x";
    assert.equal((await authorize(b, { branch: "feat/x" })).outcome, "authorized");
    assert.deepEqual(b.claimKeys, ["feat/x"]);
    b.rows.length = 1;
    // Malformed flags and a dispatch that is not the newest are refused without a row.
    for (const over of [{ headSha: "abc" }, { baseSha: "" }, { taskId: "" }, { repo: "nope" }, { reason: "" }]) {
      assert.equal((await authorize(b, over)).outcome, "refused", JSON.stringify(over));
    }
    b.pr.branch = BRANCH;
    for (const over of [{ runId: "SWEEP-0" }, { roundId: `${RUN}:2:${ROUND_START}` }, { taskId: "W1-T1" }]) {
      const res2 = await authorize(b, over);
      assert.equal((res2 as { reason: string }).reason, "not_newest_dispatch", JSON.stringify(over));
    }
    b.pr.prNumber = PR + 1;
    assert.equal(((await authorize(b)) as { reason: string }).reason, "pr_identity_mismatch");
    assert.equal(authRows(b).length, 0);
  } finally {
    b.cleanup();
  }

  // --apply rechecks admin permission and the same authenticated login.
  const a = makeWorld();
  try {
    a.writePriorLock();
    const id = await authorized(a);
    a.state.perms = ["maintain"];
    const notAdmin = await apply(a, id);
    assert.equal(notAdmin.outcome, "refused");
    a.state.perms = ["admin"];
    a.state.login = "someone-else";
    const other = await apply(a, id);
    assert.match((other as { reason: string }).reason, /^authorization_login_mismatch/);
    assert.equal((await apply(a, "f".repeat(64))).outcome, "refused", "an unknown authorization id is refused");
    assert.equal(receipts(a).length, 0, "no refusal writes a receipt");
    a.state.login = "craig";
    const released = await apply(a, id);
    assert.equal(released.outcome, "released", JSON.stringify(released));
    // After a valid release: a new authorization is refused, and any authorization for the same
    // dispatch returns the existing receipt without writing another.
    assert.equal(((await authorize(a)) as { reason: string }).reason, "already_released");
    const ts = iso(Date.parse("2026-11-16T23:00:00.000Z"));
    const foreignId = recoveryAuthorizationId(TUPLE, "other-admin", ts);
    a.rows.push({ step: PR_OWNER_RECOVERY_AUTHORIZED_STEP, task_id: TASK, repo: REPO, pr_number: PR, dispatch_run_id: RUN,
      dispatch_round_id: ROUND, head_sha: HEAD, base_sha: BASE, branch: BRANCH, login: "other-admin", reason: "x", ts, authorization_id: foreignId });
    const before = a.rows.length;
    const existing = await apply(a, foreignId);
    assert.equal(existing.outcome, "released");
    assert.equal((existing as { existing?: true }).existing, true);
    assert.equal(a.rows.length, before, "the existing receipt is returned, nothing written");
    // Conflicting release history holds.
    a.rows.push({ ...receipts(a, "released")[0]!, recovery_id: "0".repeat(64) });
    const conflict = await apply(a, id);
    assert.deepEqual([conflict.outcome, (conflict as { reason: string }).reason], ["held", "release_history_conflict"]);
    assert.equal(((await authorize(a)) as { reason: string }).reason, "release_history_conflict");
  } finally {
    a.cleanup();
  }

  // Unreadable ledger at apply is unknown, never a decision.
  const u = makeWorld();
  try {
    const id = await authorized(u);
    u.ports.readLedger = async () => ({ ok: false, unread: ["state/ledger.1.ndjson.gz"], rows: [] });
    assert.equal((await apply(u, id)).outcome, "unknown");
    u.ports.readLedger = async () => {
      throw new Error("EIO");
    };
    assert.equal((await authorize(u)).outcome, "refused");
  } finally {
    u.cleanup();
  }
});

test("W1-T12114 apply rechecks and preserves", async () => {
  // Dirty work is preserved create-only and published before the release.
  const w = makeWorld();
  try {
    w.writePriorLock();
    const id = await authorized(w);
    const res = await apply(w, id);
    assert.equal(res.outcome, "released", JSON.stringify(res));
    const receipt = (res as { receipt: Row }).receipt;
    const preservation = receipt.preservation as { state: string; recoveryRef: string; sha: string };
    assert.equal(preservation.state, "published");
    assert.match(preservation.recoveryRef, /^refs\/rmd-recovery\/pr-owner\/[0-9a-f]{64}$/);
    assert.equal(w.originRefs.get(preservation.recoveryRef), "e".repeat(40));
    const files = receiptFiles(w);
    assert.equal(files.length, 1);
    const path = join(w.stateDir, "pr-owner-recoveries", files[0]!);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.stateDir, "pr-owner-recoveries")).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), receipt);
    assert.equal(receipts(w, "released").length, 1);
    assert.equal(receipts(w, "released")[0]!.operator_login, "craig");
    const claim = (receipt.liveness as { fix_branch_claim: Row }).fix_branch_claim;
    assert.match(String(claim.holderRunId), /^PR-OWNER-RECOVER:[0-9a-f]{64}:[0-9a-f]{16}$/);
    assert.equal((claim.reclaimedPrior as Row).run_id, fixRoundClaimId(RUN, PR, CLAIM_MS));
  } finally {
    w.cleanup();
  }

  // A clean tree whose head the PR head contains has nothing to preserve.
  const clean = makeWorld();
  try {
    clean.state.worktree = { path: join(clean.dir, "wt"), dirty: "" };
    clean.writePriorLock();
    const res = await apply(clean, await authorized(clean));
    assert.equal(((res as { receipt: Row }).receipt.preservation as Row).state, "nothing_to_preserve");
    assert.equal(clean.localRefs.size, 0);
  } finally {
    clean.cleanup();
  }

  // Any change between the two reads holds with a durable held receipt naming the reason.
  const between: Array<[string, (w: World) => void, string]> = [
    ["head push", (w) => (w.pr.headSha = PUSHED), "identity_mismatch:head"],
    ["newer dispatch", (w) => w.rows.push({ step: "fix.dispatch", ts: iso(Date.parse("2026-11-17T00:00:00Z")), task_id: TASK, run_id: "SWEEP-2",
      round_id: `SWEEP-2:1:${ROUND_START + 9}`, pr_number: PR }), "newer_dispatch"],
    ["competing dispatch claim", (w) => (w.state.dispatchRef = "9".repeat(40)), "dispatch_claim_held"],
    ["pid became live", (w) => w.proc.set(PRIOR_PID, "alive"), "process_alive"],
    ["live descendant", (w) => (w.state.descendants = { state: "present", pids: [5] }), "descendants_present"],
    ["claim replaced", (w) => writeFileSync(w.priorLockPath, JSON.stringify({ pid: 1, run_id: "other", host: HOST, startedAt: iso(1) })), "competing_branch_claim_held"],
    ["publish conflict", () => undefined, "preservation_failed"],
  ];
  for (const [name, change, reason] of between) {
    const v = makeWorld();
    try {
      v.writePriorLock();
      const id = await authorized(v);
      v.ports.beforeSecondRead = () => change(v);
      if (name === "publish conflict") {
        // origin already holds this recovery's ref at another sha: a conflict, never an overwrite.
        const g = v.ports.git;
        v.ports.git = async (args, opts) => {
          if (args[0] === "update-ref") v.originRefs.set(args[1]!, "1".repeat(40));
          return g(args, opts);
        };
      }
      const res = await apply(v, id);
      assert.equal(res.outcome, "held", `${name}: ${JSON.stringify(res)}`);
      assert.equal((res as { reason: string }).reason, reason, name);
      assert.equal((res as { durable: boolean }).durable, true, name);
      assert.equal(receipts(v, "released").length, 0, name);
      assert.equal(receipts(v, "held").length, 1, name);
      assert.equal(receipts(v, "held")[0]!.hold_reason, reason, name);
      assert.deepEqual(receiptFiles(v), [], `${name}: a held receipt never creates the file`);
    } finally {
      v.cleanup();
    }
  }

  // A mismatched identity flag holds (head, base), or is refused at authorize (see the admin test).
  for (const over of [{ headSha: PUSHED }, { baseSha: PUSHED }]) {
    const v = makeWorld();
    try {
      const res = await authorize(v, over);
      const held = await apply(v, (res as { authorizationId: string }).authorizationId);
      assert.equal(held.outcome, "held");
      assert.match((held as { reason: string }).reason, /^identity_mismatch:(head|base)$/);
    } finally {
      v.cleanup();
    }
  }

  // A stale prior dispatch lock is compare-and-reclaimed only after same-host dead pid, no
  // descendant and a clear cwd; every other lock leaves the bytes in place and holds transiently.
  const locks: Array<[string, (w: World) => string, string]> = [
    ["live pid", (w) => (w.proc.set(PRIOR_PID, "alive"), w.writePriorLock()), "process_alive"],
    ["reused pid", (w) => (w.proc.set(PRIOR_PID, "reused"), w.writePriorLock()), "process_reused"],
    ["unknown pid", (w) => (w.proc.set(PRIOR_PID, "unknown"), w.writePriorLock()), "process_unknown"],
    ["foreign host", (w) => w.writePriorLock({ host: "host-b" }), "stale_claim_foreign_host"],
    ["malformed bytes", (w) => w.writePriorLock({}, "{not json"), "branch_claim_malformed"],
    ["changed run", (w) => w.writePriorLock({ run_id: fixRoundClaimId("SWEEP-0", PR, CLAIM_MS) }), "branch_claim_held"],
    ["another PR", (w) => w.writePriorLock({ run_id: fixRoundClaimId(RUN, PR + 1, CLAIM_MS) }), "stale_claim_identity_mismatch"],
    ["live descendant", (w) => ((w.state.descendants = { state: "present" }), w.writePriorLock()), "descendants_present"],
    ["occupied cwd", (w) => ((w.state.cwd = { state: "occupied" }), w.writePriorLock()), "cwd_occupied"],
    ["unrelated stale recovery", (w) => w.writePriorLock({ pid: 999, run_id: `PR-OWNER-RECOVER:${"0".repeat(64)}:${"1".repeat(16)}` }), "branch_claim_held"],
  ];
  for (const [name, arrange, reason] of locks) {
    const v = makeWorld();
    try {
      const id = await authorized(v);
      const bytes = arrange(v);
      const before = v.rows.length;
      const res = await apply(v, id);
      assert.deepEqual([res.outcome, (res as { reason: string }).reason, (res as { durable: boolean }).durable], ["held", reason, false], name);
      assert.equal(v.rows.length, before, `${name}: a lost claim appends no row`);
      assert.equal(readFileSync(v.priorLockPath, "utf8"), bytes, `${name}: the lock is never unlinked`);
    } finally {
      v.cleanup();
    }
  }

  // A dead prior lock found at apply (none at authorize) is reclaimed; so is a dead lock of this
  // very recovery, while an unrelated stale recovery lock holds (above).
  const late = makeWorld();
  try {
    const id = await authorized(late);
    late.writePriorLock();
    const res = await apply(late, id);
    assert.equal(res.outcome, "released", JSON.stringify(res));
  } finally {
    late.cleanup();
  }
  const own = makeWorld();
  try {
    own.writePriorLock();
    const id = await authorized(own);
    own.state.originUnreachable = true;
    const held = await apply(own, id);
    assert.equal((held as { reason: string }).reason, "preservation_failed");
    const recoveryId = String((held as { receipt: Row }).receipt.recovery_id);
    own.writePriorLock({ pid: 999, run_id: `PR-OWNER-RECOVER:${recoveryId}:${"a".repeat(16)}` });
    own.state.originUnreachable = false;
    const res = await apply(own, id);
    assert.equal(res.outcome, "released", JSON.stringify(res));
  } finally {
    own.cleanup();
  }

  // The prior claim parser: the exact production shape, one round, one interval.
  const ok = { run_id: fixRoundClaimId(RUN, PR, CLAIM_MS), startedAt: iso(CLAIM_MS + 100) };
  const base: Row[] = [{ step: "fix.dispatch", run_id: RUN, round_id: ROUND, pr_number: PR }];
  assert.deepEqual(parsePriorDispatchClaim(ok, TUPLE, base, fixRoundClaimId), { ok: true, claimMs: CLAIM_MS, roundStartedAtMs: ROUND_START });
  const cases: Array<[string, { run_id: string; startedAt: string }, Row[], string]> = [
    ["another run", { ...ok, run_id: fixRoundClaimId("SWEEP-11", PR, CLAIM_MS) }, base, "stale_claim_identity_mismatch"],
    ["prefix only", { ...ok, run_id: `${fixRoundClaimId(RUN, PR, CLAIM_MS)}:extra` }, base, "stale_claim_identity_mismatch"],
    ["zero claimMs", { ...ok, run_id: `${RUN}:fix-claim:${PR}:0` }, base, "stale_claim_identity_mismatch"],
    ["unsafe claimMs", { ...ok, run_id: `${RUN}:fix-claim:${PR}:99999999999999999999` }, base, "stale_claim_identity_mismatch"],
    ["leading zero", { ...ok, run_id: `${RUN}:fix-claim:${PR}:0${CLAIM_MS}` }, base, "stale_claim_identity_mismatch"],
    ["non-finite startedAt", { ...ok, startedAt: "not-a-date" }, base, "stale_claim_started_at_invalid"],
    ["negative startedAt", { ...ok, startedAt: "1969-12-31T00:00:00.000Z" }, base, "stale_claim_started_at_invalid"],
    ["startedAt before claim", { ...ok, startedAt: iso(CLAIM_MS - 1) }, base, "stale_claim_outside_round"],
    ["startedAt after round start", { ...ok, startedAt: iso(ROUND_START + 1) }, base, "stale_claim_outside_round"],
    ["adjacent round", ok, [...base, { step: "fix.dispatch", run_id: RUN, round_id: `${RUN}:0:${CLAIM_MS + 200}`, pr_number: PR }], "stale_claim_names_another_round"],
    ["duplicated round", ok, [...base, ...base], "round_history_ambiguous"],
    ["unparseable other round", ok, [...base, { step: "fix.dispatch", run_id: RUN, round_id: "garbage", pr_number: PR }], "round_history_ambiguous"],
    ["completed round", ok, [...base, { step: "fix.done", run_id: RUN, pr_number: PR, branch_claim_run_id: ok.run_id }], "stale_claim_round_completed"],
    ["later completion", ok, [...base, { step: "fix.done", run_id: RUN, pr_number: PR, branch_claim_run_id: fixRoundClaimId(RUN, PR, CLAIM_MS + 1) }], "stale_claim_not_after_completed_round"],
    ["duplicated completion", ok, [...base, ...Array(2).fill({ step: "fix.done", run_id: RUN, pr_number: PR, branch_claim_run_id: fixRoundClaimId(RUN, PR, 5) })], "round_history_ambiguous"],
    ["unreadable completion", ok, [...base, { step: "fix.done", run_id: RUN, pr_number: PR, branch_claim_run_id: "garbage" }], "round_history_ambiguous"],
  ];
  for (const [name, stored, rows, reason] of cases) {
    assert.deepEqual(parsePriorDispatchClaim(stored, TUPLE, rows, fixRoundClaimId), { ok: false, reason }, name);
  }
  assert.equal(parsePriorDispatchClaim(ok, { ...TUPLE, roundId: `${RUN}:merge-refused:1:5` }, base, fixRoundClaimId).ok, false);
  const earlier = [...base, { step: "fix.dispatch", run_id: RUN, round_id: `${RUN}:0:${CLAIM_MS - 50}`, pr_number: PR },
    { step: "fix.done", run_id: RUN, pr_number: PR, branch_claim_run_id: fixRoundClaimId(RUN, PR, CLAIM_MS - 60) }];
  assert.equal(parsePriorDispatchClaim(ok, TUPLE, earlier, fixRoundClaimId).ok, true, "a completed earlier round bounds the interval");
});

test("W1-T12114 unknown cwd evidence holds", async () => {
  // Darwin: the cwd census answers unknown until W1-T11753, so no claim on a prior lock is taken.
  const darwin = makeWorld();
  try {
    darwin.state.cwd = { state: "unknown" };
    darwin.writePriorLock();
    const auth = await authorize(darwin);
    assert.deepEqual([auth.outcome, (auth as { reason: string }).reason], ["refused", "cwd_unknown"]);
    // With no prior lock to reclaim, apply holds durably on the unknown census.
    rmSync(darwin.priorLockPath);
    const id = await authorized(darwin);
    darwin.writePriorLock();
    const lost = await apply(darwin, id);
    assert.deepEqual([lost.outcome, (lost as { reason: string }).reason], ["held", "cwd_unknown"]);
    rmSync(darwin.priorLockPath);
    const held = await apply(darwin, id);
    assert.equal(held.outcome, "held");
    assert.equal(receipts(darwin, "released").length, 0);
    assert.deepEqual(receiptFiles(darwin), []);
  } finally {
    darwin.cleanup();
  }

  // Unknown process evidence (no recorded lock), unknown cwd and unknown descendants all hold.
  const cases: Array<[string, (w: World) => void, string]> = [
    ["unrecorded process", () => undefined, "liveness_unrecorded"],
    ["cwd becomes unknown", (w) => (w.ports.beforeSecondRead = () => void (w.state.cwd = { state: "unknown" })), "cwd_unknown"],
    ["descendants unknown", (w) => (w.ports.beforeSecondRead = () => void (w.state.descendants = { state: "unknown" })), "descendants_unknown"],
    ["process unknown", (w) => (w.ports.beforeSecondRead = () => void w.proc.set(PRIOR_PID, "unknown")), "process_unknown"],
    ["worktree list unreadable", (w) => {
      const g = w.ports.git;
      w.ports.beforeSecondRead = () => {
        w.ports.git = async (args, opts) => (args[0] === "worktree" ? { status: 128, stdout: "", stderr: "locked" } : g(args, opts));
      };
    }, "cwd_unknown"],
  ];
  for (const [name, arrange, reason] of cases) {
    const v = makeWorld();
    try {
      if (name !== "unrecorded process") v.writePriorLock();
      const id = await authorized(v);
      arrange(v);
      const res = await apply(v, id);
      assert.deepEqual([res.outcome, (res as { reason: string }).reason], ["held", reason], name);
      assert.equal(receipts(v, "released").length, 0, name);
      assert.deepEqual(receiptFiles(v), [], name);
    } finally {
      v.cleanup();
    }
  }

  // The default probes: Darwin descendants are unknown; Linux walks a /proc tree.
  assert.deepEqual(defaultDescendants(1, "/proc", "darwin"), { state: "unknown" });
  const proc = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12114-proc-`));
  try {
    for (const [pid, ppid, comm] of [[100, 1, "(daemon)"], [200, 100, "(a b) )"], [300, 200, "(c)"], [400, 1, "(x)"]] as const) {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "stat"), `${pid} ${comm} S ${ppid} 1 1 0`);
    }
    mkdirSync(join(proc, "self"));
    assert.deepEqual(defaultDescendants(100, proc, "linux"), { state: "present", pids: [200, 300] });
    assert.deepEqual(defaultDescendants(400, proc, "linux"), { state: "none" });
    mkdirSync(join(proc, "500"));
    assert.deepEqual(defaultDescendants(400, proc, "linux"), { state: "none" }, "an exited process mid-walk is skipped");
    mkdirSync(join(proc, "600", "stat"), { recursive: true });
    assert.deepEqual(defaultDescendants(400, proc, "linux"), { state: "unknown" }, "an unreadable stat is unknown");
    assert.deepEqual(defaultDescendants(400, join(proc, "missing"), "linux"), { state: "unknown" });
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
  const holder = { pid: process.pid, run_id: "r", host: HOST, startedAt: iso(Date.now() - 60_000) };
  assert.equal(defaultProbeProcess({ ...holder, host: "elsewhere" }, { hostname: () => HOST }), "foreign_host");
  assert.equal(defaultProbeProcess(holder, { hostname: () => HOST, isPidAlive: () => false }), "dead");
  assert.equal(defaultProbeProcess(holder, { hostname: () => HOST, isPidAlive: () => true, startTime: () => Date.now() }), "reused");
  assert.equal(defaultProbeProcess(holder, { hostname: () => HOST, isPidAlive: () => true, startTime: () => null }), "alive");
  assert.equal(defaultProbeProcess({ ...holder, startedAt: iso(Date.now() + 60_000) }, { hostname: () => HOST }), "alive", "this process is alive and not reused");
});

test("W1-T12114 concurrent apply releases once", async () => {
  // Two applies race on one claim: the loser appends nothing and returns a transient hold.
  const w = makeWorld();
  try {
    w.writePriorLock();
    const id = await authorized(w);
    const g = gate();
    w.ports.underClaim = async () => {
      w.ports.underClaim = undefined;
      g.enter();
      await g.wait;
    };
    const winner = apply(w, id);
    await g.entered;
    const rowsBefore = w.rows.length;
    const loser = await apply(w, id);
    assert.deepEqual([loser.outcome, (loser as { reason: string }).reason, (loser as { durable: boolean }).durable], ["held", "branch_claim_held", false]);
    assert.equal(w.rows.length, rowsBefore, "the loser appends no held row");
    // authorize racing with apply serializes on the same claim and cannot append.
    const racingAuth = await authorize(w);
    assert.equal(racingAuth.outcome, "refused");
    g.open();
    assert.equal((await winner).outcome, "released");
    assert.equal(((await authorize(w)) as { reason: string }).reason, "already_released", "no authorization after the release");
    // A repeated apply writes nothing new.
    const after = w.rows.length;
    const repeat = await apply(w, id);
    assert.deepEqual([repeat.outcome, (repeat as { existing?: true }).existing], ["released", true]);
    // A loser that finds the claim held AFTER a release returns that release.
    w.proc.set(31, "alive");
    w.writePriorLock({ pid: 31, run_id: fixRoundClaimId(RUN, PR, CLAIM_MS) });
    const lateLoser = await apply(w, id);
    assert.deepEqual([lateLoser.outcome, (lateLoser as { existing?: true }).existing], ["released", true]);
    assert.equal(w.rows.length, after);
    assert.equal(receipts(w, "released").length, 1, "exactly one released receipt");
    assert.equal(receipts(w, "held").length, 0);
    assert.equal(receiptFiles(w).length, 1);
  } finally {
    w.cleanup();
  }

  // Two authorizations race for one tuple: exactly one appends.
  const a = makeWorld();
  try {
    const g = gate();
    a.ports.underClaim = async () => {
      a.ports.underClaim = undefined;
      g.enter();
      await g.wait;
    };
    const first = authorize(a);
    await g.entered;
    const second = await authorize(a);
    assert.deepEqual([second.outcome, (second as { reason: string }).reason], ["refused", "competing_branch_claim_held"]);
    g.open();
    assert.equal((await first).outcome, "authorized");
    assert.equal(authRows(a).length, 1);
  } finally {
    a.cleanup();
  }

  // A held attempt after a successful claim, then a retry with the same authorization: a later
  // released row with the same recovery_id, the authorization consumed only on release.
  const r = makeWorld();
  try {
    r.writePriorLock();
    const id = await authorized(r);
    r.state.originUnreachable = true;
    const held = await apply(r, id);
    assert.deepEqual([held.outcome, (held as { durable: boolean }).durable], ["held", true]);
    r.state.originUnreachable = false;
    const released = await apply(r, id);
    assert.equal(released.outcome, "released", JSON.stringify(released));
    const [h] = receipts(r, "held");
    const [rel] = receipts(r, "released");
    assert.equal(rel!.recovery_id, h!.recovery_id);
    assert.ok(Date.parse(String(rel!.ts)) > Date.parse(String(h!.ts)));
  } finally {
    r.cleanup();
  }

  // A tied or backwards clock writes no release file or row and keeps the authorization reusable.
  const c = makeWorld();
  try {
    c.writePriorLock();
    const id = await authorized(c);
    c.state.clockMs = ROUND_START;
    c.state.clockStep = 0;
    const tied = await apply(c, id);
    assert.deepEqual([tied.outcome, (tied as { reason: string }).reason, (tied as { durable: boolean }).durable],
      ["held", "receipt_time_not_after_prior_evidence", false]);
    assert.equal(receipts(c).length, 0);
    assert.deepEqual(receiptFiles(c), []);
    // A held receipt at a later time also bounds the release from below, regardless of its authorization.
    c.rows.push({ step: PR_OWNER_RECOVERY_RECEIPT_STEP, outcome: "held", repo: REPO, pr_number: PR, task_id: TASK, prior_run_id: RUN,
      prior_round_id: ROUND, authorization_id: "other", recovery_id: "x", ts: iso(Date.parse("2026-11-20T00:00:00Z")) });
    c.state.clockMs = Date.parse("2026-11-19T00:00:00Z");
    c.state.clockStep = 1000;
    assert.equal(((await apply(c, id)) as { reason: string }).reason, "receipt_time_not_after_prior_evidence");
    c.state.clockMs = Date.parse("2026-11-21T00:00:00Z");
    const later = await apply(c, id);
    assert.equal(later.outcome, "released", JSON.stringify(later));
  } finally {
    c.cleanup();
  }

  // Crash after the receipt file is created, before its row: the next apply (later nowIso) appends
  // the stored canonical receipt verbatim; an unknown retry in between appends no held row.
  const k = makeWorld();
  try {
    const id = await authorized(k);
    k.writePriorLock();
    k.state.failAppend = (step) => step === PR_OWNER_RECOVERY_RECEIPT_STEP;
    await assert.rejects(apply(k, id), /simulated crash/);
    k.state.failAppend = undefined;
    const [file] = receiptFiles(k);
    const bytes = readFileSync(join(k.stateDir, "pr-owner-recoveries", file!), "utf8");
    assert.equal(receipts(k).length, 0);
    k.state.clockMs += 86_400_000;
    k.state.cwd = { state: "unknown" };
    const pending = await apply(k, id);
    assert.deepEqual([pending.outcome, (pending as { reason: string }).reason], ["held", "receipt_replay_pending"]);
    assert.equal(receipts(k).length, 0, "no held row while the canonical file exists");
    k.state.cwd = { state: "clear" };
    const replay = await apply(k, id);
    assert.deepEqual([replay.outcome, (replay as { replayed?: true }).replayed], ["released", true]);
    const [row] = receipts(k, "released");
    assert.equal(row!.ts, JSON.parse(bytes).ts, "the replay keeps the stored ts");
    assert.equal(readFileSync(join(k.stateDir, "pr-owner-recoveries", file!), "utf8"), bytes, "identical bytes");
    assert.equal(receiptFiles(k).length, 1);
    // A tampered file is unknown and never overwritten.
    writeFileSync(join(k.stateDir, "pr-owner-recoveries", file!), bytes.replace("released", "releasee"), { mode: 0o600 });
    k.rows.splice(k.rows.indexOf(row!), 1);
    assert.equal((await apply(k, id)).outcome, "unknown");
  } finally {
    k.cleanup();
  }
});

test("W1-T12114 recovery preserves all work", async () => {
  // A code PR and a plan-only PR: the recorded git argv holds no destructive verb, no push but the
  // create-only recovery ref, and no fix.done or credit row is ever written.
  for (const [kind, dirty] of [["code", " M src/a.ts\0?? test/new.test.ts\0"], ["plan-only", "?? plan/tasks.d/W1-T9001.yaml\0"]] as const) {
    const w = makeWorld();
    try {
      w.state.worktree = { path: join(w.dir, "wt"), dirty };
      w.writePriorLock();
      const id = await authorized(w);
      const res = await apply(w, id);
      assert.equal(res.outcome, "released", `${kind}: ${JSON.stringify(res)}`);
      const flat = w.gitCalls.map((args) => args.join(" "));
      for (const bad of [/^update-ref -d/, /^push .*--delete/, /^branch -D/, /^worktree remove/, /^reset/, /^clean/, /^checkout/, /^worktree prune/]) {
        assert.equal(flat.some((line) => bad.test(line)), false, `${kind}: ${bad}`);
      }
      const pushes = w.gitCalls.filter((args) => args[0] === "push");
      assert.equal(pushes.length, 1, kind);
      for (const spec of pushes[0]!.filter((a) => a.includes(":"))) assert.match(spec, /refs\/rmd-recovery\/pr-owner\//, kind);
      assert.ok(pushes[0]!.some((a) => /^--force-with-lease=refs\/rmd-recovery\/pr-owner\/[0-9a-f]{64}:$/.test(a)), `${kind}: create-only lease`);
      const updates = w.gitCalls.filter((args) => args[0] === "update-ref");
      assert.deepEqual(updates.map((args) => args[3]), [""], `${kind}: update-ref is create-only`);
      assert.equal(w.rows.some((row) => row.step === "fix.done" || /credit/.test(String(row.step))), false, kind);
      assert.equal(existsSync(join(w.dir, "wt")), false, `${kind}: nothing written into the worktree`);
      assert.deepEqual(readdirSync(w.ports.repoDir), [], `${kind}: no plan or source file written`);
      assert.deepEqual(readdirSync(w.stateDir).sort(), ["inflight", "pr-owner-recoveries"], kind);
      assert.deepEqual(readdirSync(join(w.stateDir, "inflight")), [], `${kind}: the claim is released`);
    } finally {
      w.cleanup();
    }
  }

  // The steps survive ledger rotation, and the production git runner really shells out.
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(PR_OWNER_RECOVERY_AUTHORIZED_STEP));
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(PR_OWNER_RECOVERY_RECEIPT_STEP));
  const git = defaultRecoveryGit(tmpdir());
  const version = await git(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^git version/);
  // A cwd that is not a harness-cut worktree is refused by the hardened leaf, as a failed answer.
  const refused = await git(["status", "--porcelain"], { cwd: join(tmpdir(), "no-such-worktree-w1-t12114"), env: { GIT_INDEX_FILE: "x" } });
  assert.notEqual(refused.status, 0);
  assert.notEqual(refused.stderr, "");
});

test("W1-T12114 every unreadable read fails closed", async () => {
  const reason = (r: RecoveryResult) => (r as { reason?: string }).reason ?? "";
  // An unreadable claim file holds without a row.
  const lockDir = makeWorld();
  try {
    const id = await authorized(lockDir);
    mkdirSync(lockDir.priorLockPath, { recursive: true });
    const res = await apply(lockDir, id);
    assert.equal(res.outcome, "held");
    assert.match(reason(res), /^branch_claim_unreadable/);
  } finally {
    lockDir.cleanup();
  }
  // A claim that vanishes under the apply is unknown, and releasing it is a no-op.
  const vanished = makeWorld();
  try {
    vanished.writePriorLock();
    const id = await authorized(vanished);
    vanished.ports.underClaim = () => rmSync(vanished.priorLockPath);
    const res = await apply(vanished, id);
    assert.deepEqual([res.outcome, reason(res)], ["held", "branch_claim_unknown"]);
  } finally {
    vanished.cleanup();
  }
  // No registered worktree and no local branch: nothing to preserve.
  const none = makeWorld();
  try {
    none.state.worktree = undefined;
    none.writePriorLock();
    const res = await apply(none, await authorized(none));
    assert.equal(((res as { receipt: Row }).receipt.preservation as Row).state, "nothing_to_preserve");
  } finally {
    none.cleanup();
  }
  // A receipt file with the wrong mode, or unparseable bytes, is unknown and never overwritten.
  for (const tamper of ["mode", "bytes"] as const) {
    const t = makeWorld();
    try {
      t.writePriorLock();
      const id = await authorized(t);
      assert.equal((await apply(t, id)).outcome, "released");
      const path = join(t.stateDir, "pr-owner-recoveries", receiptFiles(t)[0]!);
      if (tamper === "mode") chmodSync(path, 0o644);
      else writeFileSync(path, "{garbage", { mode: 0o600 });
      t.rows.splice(t.rows.indexOf(receipts(t, "released")[0]!), 1);
      const res = await apply(t, id);
      assert.equal(res.outcome, "unknown", tamper);
      assert.match(reason(res), tamper === "mode" ? /mode mismatch/ : /unparseable/);
    } finally {
      t.cleanup();
    }
  }
  // An unreadable PR at either authorize read, or at apply, writes nothing.
  for (const failAt of [1, 2]) {
    const p = makeWorld();
    try {
      let calls = 0;
      const live = p.ports.readPr;
      p.ports.readPr = async (repo, n) => {
        calls += 1;
        if (calls === failAt) throw new Error("gh: 502");
        return live(repo, n);
      };
      const res = await authorize(p);
      assert.deepEqual([res.outcome, reason(res).startsWith("pr_unreadable")], ["refused", true], `read ${failAt}`);
      assert.equal(authRows(p).length, 0);
    } finally {
      p.cleanup();
    }
  }
  const atApply = makeWorld();
  try {
    const id = await authorized(atApply);
    atApply.ports.readPr = async () => {
      throw new Error("gh: 502");
    };
    const res = await apply(atApply, id);
    assert.equal(res.outcome, "unknown");
    assert.match(reason(res), /^pr_unreadable/);
  } finally {
    atApply.cleanup();
  }
  // A receipt directory that cannot be created releases nothing.
  const blocked = makeWorld();
  try {
    blocked.writePriorLock();
    const id = await authorized(blocked);
    blocked.ports.beforeSecondRead = () => writeFileSync(join(blocked.stateDir, "pr-owner-recoveries"), "not a directory");
    const res = await apply(blocked, id);
    assert.equal(res.outcome, "unknown");
    assert.match(reason(res), /^receipt_file_not_created/);
    assert.equal(receipts(blocked).length, 0);
  } finally {
    blocked.cleanup();
  }
});
