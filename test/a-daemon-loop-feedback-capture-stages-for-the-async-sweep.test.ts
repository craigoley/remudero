/**
 * W1-T9696 — every daemon-loop feedback capture stages for the async landing sweep.
 *
 * W1-T9615 staged the SRE lane, and the intake rungs when the daemon passes its state root. The rest still captured
 * through captureFeedback, whose inline landFeedback drives the SYNCHRONOUS landing and its plan-PR preflight (the
 * spawnSync checks in plan-pr-emitter's runInTree). That covered the intake's own fallback, the alert poll's status
 * flip, the issue-revalidation garden's conversion and the evidence-coverage filer's new entry. Each now stages; only
 * the CLI verbs inject the inline capture.
 *
 * The sync spawns are observed for real, as in test/the-sre-lane-files-incidents-off-the-daemon-loop.test.ts: the
 * sync primitives are wrapped for the call, so an inline landing shows up as its `git ... fetch`.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { parse as parseYaml } from "yaml";

import { feedbackEvidenceCoverageFiler } from "#src/lib/evidence-coverage-gardener.js";
import { feedbackEntryPath, stageFeedbackCapture, type FeedbackEntry } from "#src/lib/feedback.js";
import { queuedFeedbackDir, queuedFeedbackLandings } from "#src/lib/feedback-landing.js";
import { issueFeedbackId, normalizeIssue, pollIssues } from "#src/lib/issues-intake.js";
import { productionIssueRevalidationPorts } from "#src/lib/issue-revalidation-garden.js";
import { alertFeedbackId, pollAlerts, type RawAlert } from "#src/lib/ops.js";

/** A checkout and the state root whose queue the sweep drains, apart as in the daemon. */
function roots(): { root: string; stateRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "rmd-w9696-"));
  const root = join(base, "checkout");
  const stateRoot = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  return { root, stateRoot };
}

/** Every synchronous child-process spawn `run` makes, as argv (the command first). */
async function syncSpawnsDuring<T>(run: () => Promise<T> | T): Promise<{ result: T; spawns: string[][] }> {
  const spawns: string[][] = [];
  const real = { execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync, execSync: childProcess.execSync };
  const record = (file: unknown, args: unknown) => { spawns.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]); };
  mock.method(childProcess, "execFileSync", (file: string, args?: readonly string[], opts?: object) => (record(file, args), real.execFileSync(file, args, opts as never)));
  mock.method(childProcess, "spawnSync", (file: string, args?: readonly string[], opts?: object) => (record(file, args), real.spawnSync(file, args, opts as never)));
  mock.method(childProcess, "execSync", (command: string, opts?: object) => (record(command, []), real.execSync(command, opts as never)));
  syncBuiltinESMExports();
  try {
    return { result: await run(), spawns };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

/** A spawn that is part of a landing (the fetch it opens with, a push, a preflight tree or its node checks). */
function landingSpawns(spawns: readonly string[][]): string[][] {
  return spawns.filter((argv) => argv.some((a) => /^(?:fetch|push|ls-remote|worktree|commit-tree|read-tree|hash-object)$/.test(a) || /\.mjs$/.test(a)));
}

const NOW = () => Date.parse("2026-10-15T20:00:00Z");
const alert = (id: string) => ({
  source: "code-scanning", id, severity: "high", summary: `race (#${id})`,
  url: `https://github.com/o/r/security/code-scanning/${id}`, state: "open", createdAt: "2026-10-15T19:00:00Z",
}) as unknown as RawAlert;
const alertDeps = (root: string, stateRoot: string | undefined, open: RawAlert[], extra: object = {}) => ({
  alerts: { codeScanning: () => open, dependabot: () => [], secretScanning: () => [] },
  issues: { create: () => "https://github.com/o/r/issues/1" },
  ledgerPath: join(root, "..", "ledger.ndjson"),
  runId: "OPS-W9696",
  root,
  readLedger: () => [],
  now: NOW,
  ...(stateRoot === undefined ? {} : { landingStateRoot: stateRoot }),
  ...extra,
}) as never;
const ISSUE = normalizeIssue("o", "r", { number: 7, title: "t", body: "b", state: "open", created_at: "2026-10-15T19:00:00Z", html_url: "https://github.com/o/r/issues/7", labels: [] });
const issueDeps = (root: string, extra: object = {}) =>
  ({ issues: { list: () => [ISSUE] }, root, ledgerPath: join(root, "..", "ledger.ndjson"), runId: "ISSUES-W9696", now: NOW, ...extra }) as never;

test("W1-T9696: the issue intake and the alert poll stage their captures for the async sweep", async () => {
  // With no state root, a new entry stays in the checkout for the sweep; nothing lands inline.
  const bare = roots();
  const issues = await syncSpawnsDuring(() => pollIssues([{ owner: "o", repo: "r" }], issueDeps(bare.root)));
  assert.equal(issues.result.created.length, 1);
  assert.deepEqual(landingSpawns(issues.spawns), [], "the issue poll lands nothing inline");
  assert.ok(existsSync(feedbackEntryPath(bare.root, issueFeedbackId("o", "r", 7))));
  const alerts = await syncSpawnsDuring(() => pollAlerts("o", "r", alertDeps(bare.root, undefined, [alert("77")])));
  assert.equal(alerts.result.feedbackCreated.length, 1);
  assert.deepEqual(landingSpawns(alerts.spawns), [], "the alert poll lands nothing inline");

  // The daemon's alert poll closes an entry whose alert is gone by queueing the flip, never landing it inline.
  const { root, stateRoot } = roots();
  const goneId = alertFeedbackId("o", "r", alert("99"));
  stageFeedbackCapture(root, undefined, { id: goneId, raw: "race (#99)", origin: "alert#code-scanning-99" });
  const flip = await syncSpawnsDuring(() => pollAlerts("o", "r", alertDeps(root, stateRoot, [])));
  assert.deepEqual(flip.result.reconciled, [goneId]);
  assert.deepEqual(landingSpawns(flip.spawns), [], "the status flip lands nothing inline");
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [`plan/feedback/${goneId}.yaml`]);
  assert.equal(parseYaml(readFileSync(join(queuedFeedbackDir(stateRoot), `${goneId}.yaml`), "utf8")).status, "rejected");

  // The CLI verbs keep their inline capture by injecting it (positive control: the seam is the one called).
  const cli = roots();
  const captured: string[] = [];
  const capture = (_root: string, opts: { id?: string }) => (captured.push(opts.id!), { id: opts.id } as FeedbackEntry);
  await pollIssues([{ owner: "o", repo: "r" }], issueDeps(cli.root, { capture }));
  await pollAlerts("o", "r", alertDeps(cli.root, undefined, [alert("78")], { capture }));
  assert.deepEqual(captured, [issueFeedbackId("o", "r", 7), alertFeedbackId("o", "r", alert("78"))]);
});

test("W1-T9696: a queued capture is not captured twice", async () => {
  const { root, stateRoot } = roots();
  const ports = productionIssueRevalidationPorts({
    owner: "o", repo: "r", stateDir: join(stateRoot, "state"), repoRoot: root, landingStateRoot: stateRoot, log: () => {},
    referentVerdicts: (() => []) as never, hasReferent: (() => false) as never, judgeText: async () => "",
    readText: async () => "", runGit: () => "", readLedgerRows: () => [],
  } as never);
  const issue = { number: 5, title: "t", body: "b", createdAt: "2026-10-15T19:00:00Z", url: "https://github.com/o/r/issues/5", labels: [] } as never;
  const id = issueFeedbackId("o", "r", 5);
  const first = await syncSpawnsDuring(() => ports.fileConversion(issue, { reason: "stale" } as never));
  assert.equal(first.result, id);
  assert.deepEqual(landingSpawns(first.spawns), [], "the conversion lands nothing inline");
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [`plan/feedback/${id}.yaml`]);
  const queuedBytes = readFileSync(join(queuedFeedbackDir(stateRoot), `${id}.yaml`), "utf8");
  assert.equal(await ports.fileConversion(issue, { reason: "a second verdict" } as never), id);
  assert.equal(readFileSync(join(queuedFeedbackDir(stateRoot), `${id}.yaml`), "utf8"), queuedBytes, "the queued record is the answer");
  assert.equal(existsSync(feedbackEntryPath(root, id)), false, "nothing is written to the checkout again");

  // The evidence-coverage filer's new entry stages, and a queued id is not written into the checkout a second time.
  const filer = feedbackEvidenceCoverageFiler(root, { stateRoot });
  const gap = { id: "evidence-coverage-fix-cost", action: "file", lane: "fix", field: "cost", raw: "first body" } as const;
  const filed = await syncSpawnsDuring(() => filer(gap));
  assert.deepEqual(landingSpawns(filed.spawns), [], "the filer lands nothing inline");
  assert.ok(queuedFeedbackLandings(stateRoot).includes(`plan/feedback/${gap.id}.yaml`));
  filer({ ...gap, raw: "second body" });
  assert.equal(existsSync(feedbackEntryPath(root, gap.id)), false, "the queued gap is not captured again into the checkout");
});
