import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { createIncrementalLedgerUnion, resolveLedgerUnion } from "#src/lib/ledger-union.js";
import { appendLedger } from "#src/lib/ledger.js";
import { parseLedger } from "#src/lib/retro.js";
import { buildSweepEffects, createEscalationTriageHistoryReader, DEFAULT_SWEEP_POLICY, type BuildSweepEffectsDeps, type OpenPrView } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const terminalStep = "sweep.fix.uncreditable_head";
const escalatedStep = "sweep.fix.uncreditable_head_escalated";
const legacyPattern = /"step":"sweep\.fix\.uncreditable_head"|"step":"sweep\.fix\.uncreditable_head_escalated"/;
const standDownReason = `terminal uncreditable head already escalated for this PR@head (${escalatedStep})`;
const unreadHistoryReason = "terminal uncreditable head history is unreadable";
const childFlag = "--terminal-heads-child";
const candidates = [1, 2, 3, 4, 5, 6, 7, 8].map((prNumber) => ({ prNumber, headSha: `sha-${prNumber}` }));
candidates.push({ prNumber: 1, headSha: "sha-new-push" });

function terminal(prNumber: number) {
  return {
    step: terminalStep, pr_number: prNumber, head_sha: `sha-${prNumber}`, head: "foreign/fix",
    reason: "not_a_run_branch", terminal: true, repair_task_id: "W1-T12271", cause: "review",
  };
}

function escalated(prNumber: number) {
  return { step: escalatedStep, pr_number: prNumber, head_sha: `sha-${prNumber}` };
}

function spacedEscalation(prNumber: number): string {
  return JSON.stringify(escalated(prNumber)).replace('"step":"', '"step": "');
}

function corruptWithoutChangingMtime(archive: string): Buffer {
  const original = readFileSync(archive);
  const before = statSync(archive);
  writeFileSync(archive, Buffer.alloc(original.length));
  utimesSync(archive, before.atime, before.mtime);
  const after = statSync(archive);
  assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
  return original;
}

function fixture(t: TestContext) {
  const { dir: root } = ownedFixtureDir(t, "terminal-head-slices");
  const firstReview = [7, 8].map((prNumber) => ({ ...terminal(prNumber), ts: "2026-10-31T00:00:00.000Z", run_id: "review-first" }));
  const ledger = writeLedger([
    escalated(2), terminal(3), escalated(3), terminal(4), terminal(6),
    { ...firstReview[0]!, run_id: "review-last" }, firstReview[1]!,
  ], {
    dir: join(root, "state"),
    rotations: [
      { at: "2026-11-01T00:00:00.000Z", gz: true, rows: [terminal(1), { step: "unrelated" }, ...firstReview] },
      { at: "2026-11-02T00:00:00.000Z", gz: true, rows: [
        escalated(1), terminal(2), { ...terminal(5), reason: "wrong_task_id" }, escalated(5),
        ...firstReview.map((row) => ({ ...row, run_id: "ci-middle", cause: "ci" })),
      ] },
    ],
  });
  const archive = join(ledger.dir, "ledger.2026-11-02T00-00-00-000Z.ndjson.gz");
  writeFileSync(ledger.path, `${spacedEscalation(4)}\n`, { flag: "a" });
  writeFileSync(archive, zlib.gzipSync(`${spacedEscalation(6)}\n`), { flag: "a" });
  return { root, ...ledger, archive };
}

interface BuildObservation {
  gunzips: number;
  stoodDown: typeof candidates;
}

function buildEffects(root: string, ledgerPath: string, deps: Partial<BuildSweepEffectsDeps> = {}) {
  return buildSweepEffects({
    owner: "acme", repo: "scratch", config: { root } as never,
    ledgerPath, runId: "SWEEP-terminal-heads", plan: { tasks: [], byId: new Map() },
    log: () => {}, policy: DEFAULT_SWEEP_POLICY, ...deps,
  });
}

function observeBuild(root: string, ledgerPath: string, expectedReason = standDownReason): BuildObservation {
  const gunzip = zlib.gunzipSync;
  let gunzips = 0;
  zlib.gunzipSync = (...args) => {
    gunzips++;
    return gunzip(...args);
  };
  syncBuiltinESMExports();
  try {
    const effects = buildEffects(root, ledgerPath);
    assert.ok(effects.terminalFixStandDown);
    const standDown = effects.terminalFixStandDown;
    const stoodDown = candidates.filter((candidate) => {
      const answer = standDown(candidate as OpenPrView);
      if (answer === undefined) return false;
      assert.equal(answer, expectedReason, `unexpected stand-down reason: ${answer}`);
      return true;
    });
    return { gunzips, stoodDown };
  } finally {
    zlib.gunzipSync = gunzip;
    syncBuiltinESMExports();
  }
}

function buildInNewProcess(root: string, ledgerPath: string, expectedReason = standDownReason, eioArchive?: string): BuildObservation {
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
    fileURLToPath(import.meta.url), childFlag, root, ledgerPath, expectedReason,
    ...(eioArchive === undefined ? [] : [eioArchive]),
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as BuildObservation;
}

function interceptRotationRead(archive: string, readArchive: () => Buffer): () => void {
  const read = fs.readFileSync;
  fs.readFileSync = new Proxy(read, {
    apply(target, receiver, args) {
      return args[0] === archive ? readArchive() : Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  return () => {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  };
}

function failRotationRead(archive: string, code: "EACCES" | "EIO"): () => void {
  return interceptRotationRead(archive, () => {
    throw Object.assign(new Error(`rotation read failed: ${code}`), { code });
  });
}

function unionStandDowns(rows: ReturnType<typeof parseLedger>): typeof candidates {
  return candidates.filter(({ prNumber, headSha }) => {
    const headRows = rows.filter((row) => row.pr_number === prNumber && row.head_sha === headSha);
    return headRows.some((row) => row.step === terminalStep && row.reason === "not_a_run_branch" && row.terminal === true)
      && headRows.some((row) => row.step === escalatedStep);
  });
}

if (process.argv[2] === childFlag) {
  const archive = process.argv[6];
  const restore = archive === undefined ? undefined : failRotationRead(archive, "EIO");
  try {
    process.stdout.write(JSON.stringify(observeBuild(process.argv[3]!, process.argv[4]!, process.argv[5])));
  } finally {
    restore?.();
  }
} else {
  test("W1-T12271 criterion 1: a fresh sweep process reuses the shared snapshot without rotation digests", (t) => {
    const { root, dir, path } = fixture(t);
    const first = buildInNewProcess(root, path);
    assert.equal(first.gunzips, 2, "a cold build decompresses both rotations");
    assert.deepEqual(first.stoodDown, candidates.slice(0, 3));

    rmSync(join(dir, "cache", "rotation-digests"), { recursive: true, force: true });
    const second = buildInNewProcess(root, path);
    assert.equal(second.gunzips, 0);
    assert.deepEqual(second.stoodDown, first.stoodDown);
  });

  test("a failed snapshot write preserves the terminal heads and the next build can publish", (t) => {
    const { root, dir, path } = fixture(t);
    const snapshotDir = join(dir, "cache", "rotation-slices");
    mkdirSync(join(dir, "cache"));
    writeFileSync(snapshotDir, "");
    assert.deepEqual(observeBuild(root, path), { gunzips: 2, stoodDown: candidates.slice(0, 3) });

    unlinkSync(snapshotDir);
    assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 3) });
    rmSync(join(dir, "cache", "rotation-digests"), { recursive: true, force: true });
    assert.deepEqual(buildInNewProcess(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 3) });
  });

  test("W1-T12271 criterion 2: sweep stand-down and retry decisions match the ledger union", async (t) => {
    const { root, dir, path } = fixture(t);
    const union = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(union.ok, true);
    assert.equal(union.archiveCount, 2);
    const rows = parseLedger(union.matches.join("\n"));
    const expected = unionStandDowns(rows);
    assert.deepEqual(expected, candidates.slice(0, 3));
    assert.deepEqual(observeBuild(root, path).stoodDown, expected);

    const issueBodies: string[] = [];
    const { dispatchFix } = buildEffects(root, path, {
      issuesImpl: { create: (_title, body) => {
        issueBodies.push(body);
        return `https://github.com/acme/scratch/issues/${issueBodies.length}`;
      } },
      dispatchFixPreflightStandDownImpl: async () => false,
    });
    assert.ok(dispatchFix);
    const retries = candidates.filter(({ prNumber }) => prNumber === 7 || prNumber === 8);
    const expectedCauses = retries.map(({ prNumber, headSha }) => rows.findLast((row) =>
      row.step === terminalStep && row.pr_number === prNumber && row.head_sha === headSha)?.cause);
    // PR 7 has a distinct final review row. PR 8 replays the exact first review row.
    assert.deepEqual(expectedCauses, ["review", "ci"]);
    for (const retry of retries) {
      await dispatchFix({ ...retry, checksState: "red" } as OpenPrView, { unmetCriteria: [] });
    }
    assert.deepEqual(issueBodies.map((body) => /^\*\*Cause:\*\* (.+)$/m.exec(body)?.[1]), expectedCauses);
  });

  test("W1-T12271 criterion 2: an escalation recorded by one build holds sibling and fresh builds", async (t) => {
    const { root, dir, path } = fixture(t);
    const pr = { ...candidates[3]!, checksState: "red" } as OpenPrView;
    const issueUrl = "https://github.com/acme/scratch/issues/4";
    let siblingPreflights = 0;
    const buildSibling = () => buildEffects(root, path, {
      dispatchFixPreflightStandDownImpl: async () => {
        siblingPreflights++;
        return true;
      },
    });
    const sibling = buildSibling();
    assert.equal(sibling.terminalFixStandDown!(pr), undefined);

    let duringDelivery: ReturnType<typeof buildEffects> | undefined;
    const writer = buildEffects(root, path, {
      dispatchFixPreflightStandDownImpl: async () => false,
      issuesImpl: { create: () => {
        duringDelivery = buildSibling();
        return issueUrl;
      } },
      log: (step, fields) => appendLedger(path, { ...fields, step, run_id: "SWEEP-terminal-heads", task_id: "SWEEP" }),
    });
    await writer.dispatchFix!(pr, { unmetCriteria: [] });
    assert.ok(duringDelivery, "the fix dispatch delivered the escalation");

    const union = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(union.ok, true);
    assert.equal(union.archiveCount, 2);
    const rows = parseLedger(union.matches.join("\n"));
    assert.ok(rows.some((row) => row.step === escalatedStep && row.pr_number === pr.prNumber
      && row.head_sha === pr.headSha && row.issue_url === issueUrl));
    const expected = unionStandDowns(rows);
    assert.deepEqual(expected, candidates.slice(0, 4));
    assert.deepEqual(buildInNewProcess(root, path).stoodDown, expected);

    for (const effects of [sibling, duringDelivery]) {
      await effects.dispatchFix!(pr, { unmetCriteria: [] });
    }
    assert.deepEqual({
      standDowns: [sibling, duringDelivery].map((effects) => effects.terminalFixStandDown!(pr)),
      preflights: siblingPreflights,
    }, { standDowns: [standDownReason, standDownReason], preflights: 0 });
  });

  for (const [change, suffix] of [["same-size edit", ""], ["edit followed by growth", '{"step":"unrelated"}\n']] as const) {
    test(`W1-T12271 criterion 2: a live ${change} before the cached tail matches the ledger union`, (t) => {
      const { root, dir, path } = fixture(t);
      const live = readFileSync(path, "utf8");
      const escalation = JSON.stringify(escalated(4));
      writeFileSync(path, `${'{"step":"ignored"}'.padEnd(escalation.length)}\n${live}`);
      utimesSync(path, 1, 1);
      const before = statSync(path);
      const tail = readFileSync(path).subarray(before.size - 64);
      assert.ok(Buffer.byteLength(live) > tail.length);
      assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));

      const fd = openSync(path, "r+");
      try {
        assert.equal(writeSync(fd, escalation, 0), Buffer.byteLength(escalation));
      } finally {
        closeSync(fd);
      }
      if (suffix) writeFileSync(path, suffix, { flag: "a" });
      utimesSync(path, 2, 2);
      const after = statSync(path);
      assert.deepEqual([after.ino, after.size], [before.ino, before.size + Buffer.byteLength(suffix)]);
      assert.deepEqual(readFileSync(path).subarray(before.size - tail.length, before.size), tail);

      const union = resolveLedgerUnion(dir, legacyPattern);
      assert.equal(union.ok, true);
      assert.equal(union.archiveCount, 2);
      const expected = unionStandDowns(parseLedger(union.matches.join("\n")));
      assert.deepEqual(expected, candidates.slice(0, 4));
      assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: expected });
    });
  }

  test("an incremental union distinguishes raw pattern sources and flags in rotation digests", (t) => {
    const { dir: root } = ownedFixtureDir(t, "terminal-head-digest-pattern");
    const { dir } = writeLedger([], { dir: root, rotations: [{ at: "2026-11-01T00:00:00.000Z", gz: true,
      rows: ["first", "second", "SECOND"].map((marker) => ({ ...escalated(1), marker })),
    }] });
    const read = (rawPattern: RegExp) => {
      const union = createIncrementalLedgerUnion({ holder: "test.terminal-digest-pattern", reducerVersion: "1", rawPattern })(
        dir, { step: escalatedStep, refuseIncomplete: true, requireArchives: true },
      );
      assert.equal(union.ok, true);
      return union.rows.map(({ marker }) => marker);
    };
    assert.deepEqual(read(/"marker":"first"/), ["first"]);
    assert.deepEqual(read(/"marker":"second"/), ["second"]);
    assert.deepEqual(read(/"marker":"second"/i), ["second", "SECOND"]);
  });

  test("W1-T12271 criterion 3: a cold build holds dispatch while a rotation is unreadable", (t) => {
    const { root, dir, path, archive } = fixture(t);
    const original = readFileSync(archive);
    writeFileSync(archive, "unreadable gzip");

    const unread = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(unread.ok, false);
    assert.deepEqual(unread.unread, [archive]);
    assert.deepEqual(unread.matches, []);
    assert.deepEqual(buildInNewProcess(root, path, unreadHistoryReason), { gunzips: 2, stoodDown: candidates });

    writeFileSync(archive, original);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
  });

  test("W1-T12271 criterion 3: same-size, same-mtime corruption holds warm and restarted dispatch", async (t) => {
    const { root, dir, path, archive } = fixture(t);
    utimesSync(archive, 1, 1);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
    const sibling = buildEffects(root, path);
    const previouslyFree = candidates[3] as OpenPrView;
    assert.equal(sibling.terminalFixStandDown!(previouslyFree), undefined);
    const original = corruptWithoutChangingMtime(archive);
    const unread = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(unread.ok, false);
    assert.deepEqual(unread.unread, [archive]);

    assert.deepEqual(observeBuild(root, path, unreadHistoryReason), { gunzips: 1, stoodDown: candidates });
    assert.deepEqual(buildInNewProcess(root, path, unreadHistoryReason), { gunzips: 1, stoodDown: candidates });
    assert.equal(sibling.terminalFixStandDown!(previouslyFree), unreadHistoryReason);
    assert.deepEqual(await sibling.dispatchFix!(previouslyFree, { unmetCriteria: [] }), {
      roundNotRun: true, reason: unreadHistoryReason,
    });

    writeFileSync(archive, original);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
    assert.equal(sibling.terminalFixStandDown!(previouslyFree), undefined);
  });

  test("a raw-pattern slice preserves replay identity and rejects a stale shared snapshot", async (t) => {
    const { dir, archive } = fixture(t);
    const slice = {
      holder: "test.terminal-snapshot", steps: [terminalStep, escalatedStep], rawPattern: legacyPattern,
      sharedSnapshot: true, strictFileIdentity: true,
      project: ({ step, pr_number, cause }: Record<string, unknown>) => ({ step, pr_number, cause }),
    };
    utimesSync(archive, 1, 1);
    const read = await createEscalationTriageHistoryReader({ slice })(dir);
    assert.equal(read.ok, true);
    const union = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(union.ok, true);
    const expected = parseLedger(union.matches.join("\n")).map(slice.project);
    assert.deepEqual(read.rows.map(slice.project), expected);

    const warm = createEscalationTriageHistoryReader({ slice });
    assert.deepEqual(warm.current(dir).rows.map(slice.project), expected);
    assert.equal(warm.lastLoad().snapshotHit, true);
    assert.equal(warm.lastLoad().rotationsRead, 0);

    corruptWithoutChangingMtime(archive);
    const fresh = createEscalationTriageHistoryReader({ slice });
    const unread = fresh.current(dir);
    assert.equal(unread.ok, false);
    assert.deepEqual(unread.unread, [archive]);
    assert.equal(fresh.lastLoad().rotationsRead, 1);
  });

  test("W1-T12271 criterion 4: production sweep effects hold dispatch when the live read fails", async (t) => {
    const { root, dir, path } = fixture(t);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
    unlinkSync(path);
    mkdirSync(path);

    const union = resolveLedgerUnion(dir, legacyPattern);
    assert.equal(union.ok, true);
    assert.deepEqual(observeBuild(root, path, unreadHistoryReason), { gunzips: 0, stoodDown: candidates });
    const { dispatchFix } = buildEffects(root, path);
    assert.ok(dispatchFix);
    assert.deepEqual(await dispatchFix(candidates[2] as OpenPrView, { unmetCriteria: [] }), {
      roundNotRun: true, reason: unreadHistoryReason,
    });
  });

  test("an unreadable rotation holds dispatch even when its slice is cached", (t) => {
    const { root, path, archive } = fixture(t);
    assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));
    const restore = failRotationRead(archive, "EACCES");
    try {
      assert.deepEqual(observeBuild(root, path, unreadHistoryReason), { gunzips: 0, stoodDown: candidates });
    } finally {
      restore();
    }
  });

  test("W1-T12271 criterion 3: cached rotation read EIO holds dispatch even when stat and R_OK succeed", async (t) => {
    const { root, dir, path, archive } = fixture(t);
    assert.deepEqual(observeBuild(root, path), { gunzips: 2, stoodDown: candidates.slice(0, 3) });
    rmSync(join(dir, "cache", "rotation-digests"), { recursive: true, force: true });
    const previouslyFree = candidates[3] as OpenPrView;
    const restore = failRotationRead(archive, "EIO");
    try {
      assert.ok(statSync(archive).isFile());
      fs.accessSync(archive, fs.constants.R_OK);
      const union = resolveLedgerUnion(dir, legacyPattern);
      assert.equal(union.ok, false);
      assert.deepEqual(union.unread, [archive]);
      assert.deepEqual(union.matches, []);

      let preflights = 0;
      const effects = buildEffects(root, path, {
        dispatchFixPreflightStandDownImpl: async () => {
          preflights++;
          return true;
        },
      });
      assert.equal(effects.terminalFixStandDown!(previouslyFree), unreadHistoryReason);
      assert.deepEqual(await effects.dispatchFix!(previouslyFree, { unmetCriteria: [] }), {
        roundNotRun: true, reason: unreadHistoryReason,
      });
      assert.equal(preflights, 0);
      assert.deepEqual(buildInNewProcess(root, path, unreadHistoryReason, archive), { gunzips: 0, stoodDown: candidates });
    } finally {
      restore();
    }
    assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 3) });
  });

  for (const [waitAt, standDown] of [["admission", true], ["preflight", true], ["preflight", false]] as const) {
    test(`W1-T12271 criterion 3: a sibling rotation EIO holds dispatch after ${waitAt} (preflight stand-down: ${standDown})`, async (t) => {
      const { root, path, archive } = fixture(t);
      const pr = candidates[4] as OpenPrView;
      assert.deepEqual(observeBuild(root, path).stoodDown, candidates.slice(0, 3));

      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      let resume!: () => void;
      const released = new Promise<void>((resolve) => { resume = resolve; });
      const pause = () => {
        entered();
        return released;
      };
      let preflights = 0;
      const effects = buildEffects(root, path, {
        contributorAdmissionImpl: waitAt === "admission" ? pause : undefined,
        dispatchFixPreflightStandDownImpl: async () => {
          preflights++;
          if (waitAt === "preflight") await pause();
          return standDown;
        },
        ghJsonImpl: () => assert.fail("a held dispatch must not look up the head"),
      });
      const dispatch = Promise.resolve(effects.dispatchFix!(pr, { unmetCriteria: [] }));
      await Promise.race([waiting, dispatch.then(() => assert.fail(`dispatch returned before ${waitAt}`))]);

      const restore = failRotationRead(archive, "EIO");
      try {
        const sibling = buildEffects(root, path);
        assert.equal(sibling.terminalFixStandDown!(pr), unreadHistoryReason);
        resume();
        assert.deepEqual(await dispatch, { roundNotRun: true, reason: unreadHistoryReason });
        assert.equal(preflights, waitAt === "admission" ? 0 : 1);
      } finally {
        resume();
        restore();
      }
    });
  }

  test("W1-T12271 criterion 3: rotation EIO during preflight holds dispatch without a sibling build", async (t) => {
    const { root, path, archive } = fixture(t);
    const pr = candidates[4] as OpenPrView;
    let restore: (() => void) | undefined;
    let headLookups = 0;
    const effects = buildEffects(root, path, {
      dispatchFixPreflightStandDownImpl: async () => {
        restore = failRotationRead(archive, "EIO");
        return false;
      },
      ghJsonImpl: () => {
        headLookups++;
        return {};
      },
    });
    assert.equal(effects.terminalFixStandDown!(pr), undefined);

    try {
      const dispatch = await effects.dispatchFix!(pr, { unmetCriteria: [] });
      assert.ok(restore, "preflight ran and made the rotation unreadable");
      assert.deepEqual({ dispatch, headLookups }, {
        dispatch: { roundNotRun: true, reason: unreadHistoryReason },
        headLookups: 0,
      });
      assert.equal(effects.terminalFixStandDown!(pr), unreadHistoryReason);
    } finally {
      restore?.();
    }
  });

  for (const siblingReads of [true, false]) {
    test(`W1-T12271 criterion 3: rotation EIO during head lookup holds before the branch claim (sibling reads: ${siblingReads})`, async (t) => {
      const { root, path, archive } = fixture(t);
      const pr = { ...candidates[4], prUrl: "https://github.com/acme/scratch/pull/5", priorStrikes: 0 } as OpenPrView;
      const head = { headRefName: "run-unfiled-1", headRefOid: pr.headSha, body: "", files: [] };
      const claimKey = "terminal-head-lookup";
      const holder = acquireInflightLock(join(root, "state", "inflight"), claimKey, { run_id: "OTHER-ROUND" });
      t.after(() => holder.release());

      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      let resume!: (identity: typeof head) => void;
      const pending = new Promise<typeof head>((resolve) => { resume = resolve; });
      const claims: unknown[] = [];
      const build = () => buildEffects(root, path, {
        dispatchFixPreflightStandDownImpl: async () => false,
        readJsonImpl: async (args) => {
          assert.deepEqual(args, ["pr", "view", pr.prUrl, "--json", "headRefName,headRefOid,body,files"]);
          entered();
          return pending;
        },
        registeredWorktreeOwnerImpl: () => undefined,
        fixBranchClaimKeyImpl: () => claimKey,
        log: (step, fields) => {
          if (step === "sweep.fix.checkout_claim_declined") claims.push(fields?.holder_run_id);
        },
      });
      const effects = build();
      assert.equal(effects.terminalFixStandDown!(pr), undefined);
      const dispatch = Promise.resolve(effects.dispatchFix!(pr, { unmetCriteria: [] }));
      await Promise.race([waiting, dispatch.then(() => assert.fail("dispatch returned before head lookup"))]);

      const restore = failRotationRead(archive, "EIO");
      try {
        if (siblingReads) assert.equal(buildEffects(root, path).terminalFixStandDown!(pr), unreadHistoryReason);
        resume(head);
        assert.deepEqual({ result: await dispatch, claims }, {
          result: { roundNotRun: true, reason: unreadHistoryReason }, claims: [],
        });
      } finally {
        resume(head);
        restore();
      }

      await build().dispatchFix!(pr, { unmetCriteria: [] });
      assert.deepEqual(claims, ["OTHER-ROUND"], "readable history reaches the same branch's existing claim");
    });
  }

  test("W1-T12271 criterion 3: stand-down checks cached rotation readability without rebuilding effects", (t) => {
    const { root, path, archive } = fixture(t);
    const effects = buildEffects(root, path);
    const pr = candidates[4] as OpenPrView;
    assert.equal(effects.terminalFixStandDown!(pr), undefined);
    const restore = failRotationRead(archive, "EIO");
    try {
      assert.equal(effects.terminalFixStandDown!(pr), unreadHistoryReason);
    } finally {
      restore();
    }
    assert.equal(buildEffects(root, path).terminalFixStandDown!(pr), undefined);
    assert.equal(effects.terminalFixStandDown!(pr), undefined);
  });

  test("W1-T12271 criterion 3: corrupt bytes returned after a rotation cache lookup hold dispatch", async (t) => {
    const { root, dir, path, archive } = fixture(t);
    const previouslyFree = candidates[3] as OpenPrView;
    assert.deepEqual(observeBuild(root, path), { gunzips: 2, stoodDown: candidates.slice(0, 3) });
    assert.equal(observeBuild(root, path).gunzips, 0);

    const corrupt = readFileSync(archive);
    // Damage the final gzip member's CRC while keeping its header, length and file metadata intact.
    const crcByte = corrupt.length - 8;
    corrupt[crcByte] = corrupt[crcByte]! ^ 1;
    const restore = interceptRotationRead(archive, () => corrupt);
    let preflights = 0;
    try {
      const union = resolveLedgerUnion(dir, legacyPattern);
      assert.equal(union.ok, false);
      assert.deepEqual(union.unread, [archive]);
      assert.deepEqual(union.matches, []);

      const effects = buildEffects(root, path, {
        dispatchFixPreflightStandDownImpl: async () => {
          preflights++;
          return true;
        },
      });
      assert.deepEqual({
        standDown: effects.terminalFixStandDown!(previouslyFree),
        dispatch: await effects.dispatchFix!(previouslyFree, { unmetCriteria: [] }),
        preflights,
      }, {
        standDown: unreadHistoryReason,
        dispatch: { roundNotRun: true, reason: unreadHistoryReason },
        preflights: 0,
      });
      assert.deepEqual(observeBuild(root, path, unreadHistoryReason), { gunzips: 0, stoodDown: candidates });
    } finally {
      restore();
    }
    assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 3) });
  });

  test("without rotations the sweep uses the caller's live ledger path", (t) => {
    const { dir: root } = ownedFixtureDir(t, "terminal-head-live-only");
    const { path: livePath } = writeLedger([terminal(1)], { dir: root });
    writeFileSync(livePath, `${spacedEscalation(1)}\n`, { flag: "a" });
    assert.deepEqual(observeBuild(root, livePath), { gunzips: 0, stoodDown: candidates.slice(0, 1) });
    const path = join(root, "custom.ndjson");
    renameSync(livePath, path);

    assert.deepEqual(observeBuild(root, path), { gunzips: 0, stoodDown: candidates.slice(0, 1) });
  });
}
