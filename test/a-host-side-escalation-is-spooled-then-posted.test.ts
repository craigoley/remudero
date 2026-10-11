/**
 * 2026-10-10/11: the Azure host's service user has no GitHub credential, so every escalation raised
 * outside the daemon containers -- `rmd deploy-run`'s refusal issue, the `rmd live-edits` restore
 * notice -- went nowhere, and core sat stuck about six hours with nothing reaching a human. These
 * suites pin the replacement: a host-side escalation with no credential is SPOOLED under the shared
 * state dir and the daemon's drain POSTS it, de-duplicated -- never dropped.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import type { AsyncIssueGateway, Escalation, OpenIssue } from "../src/lib/escalate.js";
import {
  drainEscalationSpool,
  ESCALATION_SPOOL_DRAIN_PASS,
  escalationSpoolDir,
  escalationSpoolDrain,
  escalationSpoolKey,
  HOST_ESCALATION_STEPS,
  spoolEscalation,
  spoolingIssueVoice,
  spoolIssueAction,
  withdrawSpooledEscalation,
  withEscalationSpoolDrain,
  type SpoolEntry,
  type SpoolMeta,
} from "../src/lib/host-escalation-spool.js";
import { LIVE_EDIT_STEPS, liveEditStatePath } from "../src/lib/live-edit-ladder.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { escalationSpoolDrainWiring, liveEditsCommand } from "../src/run-task.js";
import { runBeat } from "./helpers/fleet-heartbeat-harness.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const T0 = Date.parse("2026-10-11T00:17:00Z");
const HOUR = 3_600_000;

function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-spool-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function meta(nowMs: number, directError?: string): SpoolMeta {
  return { source: "deploy-run", host: "fleet-host", clock: fixedClock(nowMs), ...(directError ? { directError } : {}) };
}

function escalation(detail = "the recycle refused on 3 windows"): Escalation {
  return {
    class: "BLOCKED",
    taskId: "DEPLOY-REFUSAL-core-abc",
    summary: "image recycle for core keeps being refused (abc)",
    detail,
    options: [{ label: "apply the remedy", detail: "fix it" }],
    recommendation: "apply the remedy",
  };
}

function pending(dir: string): SpoolEntry[] {
  const spool = escalationSpoolDir(dir);
  if (!existsSync(spool)) return [];
  return readdirSync(spool).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(spool, n), "utf8")) as SpoolEntry);
}

function steps(dir: string): Array<Record<string, unknown> & { step: string }> {
  const path = join(dir, "ledger.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown> & { step: string }) : [];
}

/** The fleet's needs-human surface, in memory: what the daemon's `gh` would do. */
function fleet(): { gateway: AsyncIssueGateway; issues: Array<OpenIssue & { open: boolean; comments: string[]; closedWith?: string }> } {
  const issues: Array<OpenIssue & { open: boolean; comments: string[]; closedWith?: string }> = [];
  return {
    issues,
    gateway: {
      create: (title, body) => {
        const url = `https://github.com/o/r/issues/${issues.length + 1}`;
        issues.push({ number: issues.length + 1, url, title, body, open: true, comments: [] });
        return url;
      },
      listOpen: async () => issues.filter((i) => i.open),
      comment: async (url, body) => { issues.find((i) => i.url === url)!.comments.push(body); },
      closeWithComment: async (url, comment) => {
        const i = issues.find((x) => x.url === url)!;
        i.open = false;
        i.closedWith = comment;
      },
    },
  };
}

function drainer(dir: string, gateway: AsyncIssueGateway, nowMs = T0 + 60_000) {
  return escalationSpoolDrain({ stateDir: dir, ledgerPath: join(dir, "ledger.ndjson"), issues: () => gateway, clock: fixedClock(nowMs) });
}

test("a host-side escalation with no credential is spooled once per condition, then posted by the daemon's drain", async (t) => {
  const dir = stateDir(t);
  assert.equal(spoolEscalation(dir, escalation(), meta(T0, "gh: To get started with GitHub CLI, please run: gh auth login")), "");
  assert.equal(spoolEscalation(dir, escalation("the recycle refused on 4 windows"), meta(T0 + HOUR)), "", "nothing is delivered yet");
  const [entry] = pending(dir);
  assert.equal(pending(dir).length, 1, "a condition re-raised every window is one entry, not a queue");
  assert.equal(entry!.key, escalationSpoolKey(escalation()));
  assert.equal(entry!.count, 2);
  assert.equal(entry!.firstAt, new Date(T0).toISOString(), "the first sighting is kept");
  assert.equal(entry!.lastAt, new Date(T0 + HOUR).toISOString());
  assert.equal(entry!.kind === "escalate" && entry!.escalation.detail, "the recycle refused on 4 windows", "the latest observation is what posts");
  assert.doesNotMatch(entry!.headline, /["\\]/, "the headline is safe for the heartbeat's grep");
  assert.equal(steps(dir).filter((s) => s.step === HOST_ESCALATION_STEPS.spooled).length, 1, "one spooled row per condition");

  const f = fleet();
  const result = await drainer(dir, f.gateway)();
  assert.deepEqual(result, { delivered: 1, failed: 0 });
  assert.equal(f.issues.length, 1, "the daemon opened the issue");
  assert.match(f.issues[0]!.body ?? "", /Raised on the host by `deploy-run` on fleet-host/);
  assert.match(f.issues[0]!.body ?? "", /seen 2 time\(s\)/);
  assert.match(f.issues[0]!.body ?? "", /gh auth login/, "the host's own failed attempt is named");
  assert.equal(pending(dir).length, 0, "a delivered entry leaves the spool");
  assert.equal(readFileSync(join(escalationSpoolDir(dir), ESCALATION_SPOOL_DRAIN_PASS), "utf8").split("\n")[0], new Date(T0 + 60_000).toISOString());
  assert.ok(steps(dir).some((s) => s.step === HOST_ESCALATION_STEPS.delivered && s.issue_url === f.issues[0]!.url));

  assert.equal(spoolEscalation(dir, escalation("the recycle refused on 4 windows"), meta(T0 + 2 * HOUR)), f.issues[0]!.url, "the producer learns the url");
  assert.equal(pending(dir).length, 0, "the same text, already delivered, is not spooled again");
  assert.equal(spoolEscalation(dir, escalation("the recycle refused on 5 windows"), meta(T0 + 3 * HOUR)), f.issues[0]!.url);
  assert.equal(pending(dir).length, 1, "a new observation is spooled");
  await drainer(dir, f.gateway)();
  assert.equal(f.issues.length, 1, "and posts onto the open issue through escalate's dedup");
  assert.equal(f.issues[0]!.comments.length, 1);
});

test("an undeliverable entry stays spooled, logs one row per distinct error, and still stamps the drain pass", async (t) => {
  const dir = stateDir(t);
  spoolEscalation(dir, escalation(), meta(T0));
  const opensNothing = drainEscalationSpool.bind(null, dir, {
    clock: fixedClock(T0 + 60_000),
    escalate: async () => "",
    close: async () => {},
    comment: async () => {},
  });
  assert.deepEqual(await opensNothing(), { delivered: 0, failed: 1 });
  assert.deepEqual(await opensNothing(), { delivered: 0, failed: 1 });
  assert.equal(pending(dir).length, 1, "never dropped");
  const failed = steps(dir).filter((s) => s.step === HOST_ESCALATION_STEPS.drainFailed);
  assert.equal(failed.length, 1, "the same error is logged once");
  assert.match(String(failed[0]!.error), /opened no issue/);
  await drainEscalationSpool(dir, { clock: fixedClock(T0), escalate: async () => { throw new Error("HTTP 502"); }, close: async () => {}, comment: async () => {} });
  assert.equal(steps(dir).filter((s) => s.step === HOST_ESCALATION_STEPS.drainFailed).length, 2, "a different error is logged again");
  assert.ok(existsSync(join(escalationSpoolDir(dir), ESCALATION_SPOOL_DRAIN_PASS)));

  writeFileSync(join(escalationSpoolDir(dir), "garbled.json"), "{not json\n");
  const r = await drainEscalationSpool(dir, { clock: fixedClock(T0), escalate: async () => "u", close: async () => {}, comment: async () => {} });
  assert.deepEqual(r, { delivered: 1, failed: 1 }, "an unreadable entry is counted, never skipped silently");
  assert.ok(steps(dir).some((s) => s.step === HOST_ESCALATION_STEPS.drainFailed && s.error === "unreadable spool entry"));
});

test("a drain with no spool yet does nothing and writes nothing", async (t) => {
  const dir = stateDir(t);
  const r = await drainer(dir, fleet().gateway)();
  assert.deepEqual(r, { delivered: 0, failed: 0 });
  assert.equal(existsSync(escalationSpoolDir(dir)), false);
});

test("an entry the host re-spools while the daemon is posting it stays for the next pass", async (t) => {
  const dir = stateDir(t);
  spoolEscalation(dir, escalation(), meta(T0));
  const r = await drainEscalationSpool(dir, {
    clock: fixedClock(T0 + 60_000),
    escalate: async () => {
      spoolEscalation(dir, escalation("a newer observation"), meta(T0 + 30_000));
      return "https://github.com/o/r/issues/9";
    },
    close: async () => {},
    comment: async () => {},
  });
  assert.equal(r.delivered, 1);
  const [left] = pending(dir);
  assert.equal(left?.kind === "escalate" && left.escalation.detail, "a newer observation");
});

test("a cleared condition withdraws a still-spooled escalation, and closes one the daemon already opened", async (t) => {
  const dir = stateDir(t);
  spoolEscalation(dir, escalation(), meta(T0));
  withdrawSpooledEscalation(dir, escalation(), "verified healthy", meta(T0 + HOUR));
  assert.equal(pending(dir).length, 0, "nobody was told, and there is nothing left to tell");
  assert.ok(steps(dir).some((s) => s.step === HOST_ESCALATION_STEPS.withdrawn));

  const f = fleet();
  spoolEscalation(dir, escalation(), meta(T0));
  await drainer(dir, f.gateway)();
  spoolEscalation(dir, escalation("observed again before the recovery"), meta(T0 + HOUR));
  withdrawSpooledEscalation(dir, escalation(), "verified healthy", meta(T0 + 2 * HOUR));
  const left = pending(dir);
  assert.deepEqual(left.map((e) => e.kind), ["close"], "the stale observation is dropped, so it can never reopen the issue");
  const cannotClose = { ...f.gateway, closeWithComment: undefined };
  assert.deepEqual(await drainer(dir, cannotClose)(), { delivered: 0, failed: 1 });
  assert.ok(steps(dir).some((s) => s.step === HOST_ESCALATION_STEPS.drainFailed && /cannot close/.test(String(s.error))));
  await drainer(dir, f.gateway)();
  assert.equal(f.issues[0]!.open, false);
  assert.equal(f.issues[0]!.closedWith, "verified healthy");
  assert.equal(pending(dir).length, 0);
  assert.equal(spoolEscalation(dir, escalation(), meta(T0 + 3 * HOUR)), "", "a closed issue's url is spent: the next episode opens afresh");
});

test("the ladder's host voice spools its comment; a close with nothing delivered spools only the close", async (t) => {
  const dir = stateDir(t);
  const voice = spoolingIssueVoice(dir, meta(T0));
  assert.equal(await voice.escalate(escalation()), "");
  await voice.comment("https://github.com/o/r/issues/3", "restored 2 tracked path(s)");
  spoolIssueAction(dir, { kind: "close", url: "https://github.com/o/r/issues/4", body: "done" }, meta(T0));
  assert.deepEqual(pending(dir).map((e) => e.kind).sort(), ["close", "comment", "escalate"]);
  const f = fleet();
  f.issues.push(
    { number: 3, url: "https://github.com/o/r/issues/3", open: true, comments: [] },
    { number: 4, url: "https://github.com/o/r/issues/4", open: true, comments: [] },
  );
  const noComment = { ...f.gateway, comment: undefined };
  assert.equal((await drainer(dir, noComment)()).failed, 1, "a gateway that cannot comment keeps the comment");
  await drainer(dir, f.gateway)();
  assert.deepEqual(f.issues[0]!.comments, ["restored 2 tracked path(s)"]);
  assert.equal(f.issues[1]!.open, false);
  assert.equal(pending(dir).length, 0);
});

test("the drain rides beside the freshness read one pass at a time, and never fails the read", async () => {
  let drains = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const read = withEscalationSpoolDrain(async () => "fresh", async () => { drains += 1; await gate; });
  const first = read();
  await new Promise((r) => setImmediate(r));
  assert.equal(await read(), "fresh", "a read during a pass does not wait for it");
  release();
  assert.equal(await first, "fresh");
  assert.equal(drains, 1, "the overlapping read started no second pass");
  const faulty = withEscalationSpoolDrain(async () => 7, async () => { throw new Error("EROFS"); });
  assert.equal(await faulty(), 7);
});

test("the daemon's spool drain posts through gh as the fleet", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-spool-wiring-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "state");
  mkdirSync(dir, { recursive: true });
  spoolEscalation(dir, escalation(), meta(T0));
  const gh = ghShim([
    { when: "issues?labels=needs-human", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/example/fleet/issues/77" },
  ], { kind: "host-spool-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  try {
    // A PATH-stubbed gh: the guard checks the call, not the destination, so the section opts in.
    await withLiveWritesAllowed(async () => {
      assert.deepEqual(await escalationSpoolDrainWiring({ root, claudeBin: "/bin/true" } as Config, fixedClock(T0))(), { delivered: 1, failed: 0 });
    });
  } finally {
    process.env.PATH = previousPath;
  }
  const seen = gh.calls().join("\n");
  assert.match(seen, /^api repos\/[^ ]+\/issues\?labels=needs-human&state=open/m, "it dedups against the open needs-human issues");
  assert.match(seen, /^issue create .*--title \[BLOCKED\] DEPLOY-REFUSAL-core-abc: image recycle for core keeps being refused \(abc\) /m);
  assert.equal(pending(dir).length, 0);
});

test("rmd live-edits on a host with no credential spools its escalation and restore notice; the daemon's drain posts them", async (t) => {
  const origin = gitRepo({ bare: true, kind: "spool-origin" });
  const author = gitRepo({ kind: "spool-author" });
  writeFileSync(join(author.dir, "app.txt"), "v1\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed");
  author.addRemote("origin", origin.dir);
  author.git("push", "--quiet", "origin", "main");
  const live = gitRepo({ cloneFrom: origin.dir, kind: "spool-live" });
  mkdirSync(join(author.dir, "src"));
  writeFileSync(join(author.dir, "src", "feature.ts"), "export const x = 1;\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "feat: main moves on");
  author.git("push", "--quiet", "origin", "main");
  writeFileSync(join(live.dir, "app.txt"), "hand edit\n");
  const dir = stateDir(t);
  t.mock.method(console, "log", () => {});
  const verb = (nowMs: number) => liveEditsCommand(["--tree", "daemon-checkout", "--checkout", live.dir, "--state-root", dir], fixedClock(nowMs));

  await verb(T0);
  await verb(T0 + HOUR);
  const [tier2] = pending(dir);
  assert.equal(tier2?.kind, "escalate", "tier 2's escalation was spooled, not dropped");
  assert.equal(tier2?.source, "live-edits");
  assert.equal(tier2?.kind === "escalate" && tier2.escalation.taskId, "LIVE-EDITS-daemon-checkout");

  await verb(T0 + 2 * HOUR);
  assert.equal(readFileSync(join(live.dir, "app.txt"), "utf8"), "v1\n", "tier 3 restored the tree");
  const [notice] = pending(dir);
  assert.equal(pending(dir).length, 1, "the notice rides the same condition's entry");
  assert.match(notice?.kind === "escalate" ? notice.escalation.detail : "", /restored 1 tracked path\(s\)/);

  const f = fleet();
  await drainer(dir, f.gateway)();
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0]!.body ?? "", /restored 1 tracked path\(s\)/);
  assert.match(f.issues[0]!.body ?? "", /Raised on the host by `live-edits`/);

  await verb(T0 + 2 * HOUR + 60_000);
  assert.equal(existsSync(liveEditStatePath(dir, "daemon-checkout")), false, "the delivered notice ends the episode");
  assert.ok(steps(dir).some((s) => s.step === LIVE_EDIT_STEPS.noticeDelivered && s.issue_url === f.issues[0]!.url));
  assert.equal(pending(dir).length, 0, "and nothing is spooled twice");
});

// ── THE OFF-HOST HALF: a spool the daemon is not draining reaches the heartbeat ────────────────
// The beat runs a REAL `date -u`, so the fixture's clock is read from the same one (see
// test/fleet-heartbeat.test.ts on why a JS clock cannot stand in for it).
const BEAT_NOW = Date.parse(String(spawnSync("date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"]).stdout).trim());
const MIN = 60_000;
const ago = (ms: number): string => new Date(BEAT_NOW - ms).toISOString();

/** A real spool entry, written by the real producer at `spooledMsAgo`, as `<state>/`-relative files. */
function spoolFiles(t: TestContext, spooledMsAgo: number, drainMsAgo?: number): Record<string, string> {
  const dir = stateDir(t);
  spoolEscalation(dir, escalation(), meta(BEAT_NOW - spooledMsAgo));
  const files: Record<string, string> = {};
  for (const name of readdirSync(escalationSpoolDir(dir)).filter((n) => n.endsWith(".json"))) {
    files[`escalation-spool/${name}`] = readFileSync(join(escalationSpoolDir(dir), name), "utf8");
  }
  if (drainMsAgo !== undefined) files[`escalation-spool/${ESCALATION_SPOOL_DRAIN_PASS}`] = `${ago(drainMsAgo)}\ndelivered=0\nfailed=1\n`;
  return files;
}

function spoolVerdict(published: string): { verdict?: string; pending?: string; entries: string[] } {
  const lines = published.split("\n");
  const field = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
  return { verdict: field("escalation_spool_verdict"), pending: field("escalation_spool_pending"), entries: lines.filter((l) => l.startsWith("escalation_spool_entry=")) };
}

test("the heartbeat publishes the host's undelivered escalations, and names them UNDELIVERED only on the daemon's own evidence", (t) => {
  const empty = spoolVerdict(runBeat({}).published);
  assert.equal(empty.verdict, "ok");
  assert.equal(empty.pending, "0");
  assert.deepEqual(empty.entries, []);

  const fresh = spoolVerdict(runBeat({ prevBeatTs: ago(15 * MIN), stateFiles: spoolFiles(t, 10 * MIN) }).published);
  assert.match(fresh.verdict ?? "", /^pending — 1 /, "spooled since the previous beat: the daemon gets its tick");
  assert.equal(fresh.entries.length, 1);
  assert.match(fresh.entries[0]!, /deploy-run: image recycle for core keeps being refused \(abc\)$/, "the headline travels off-host");

  const failing = spoolVerdict(runBeat({ prevBeatTs: ago(15 * MIN), stateFiles: spoolFiles(t, 10 * MIN, 1 * MIN) }).published);
  assert.match(failing.verdict ?? "", /^UNDELIVERED — 1 .*drain pass .* ran after they were spooled/, "a drain pass ran after it and it is still there");

  const undrained = spoolVerdict(runBeat({ prevBeatTs: ago(5 * MIN), stateFiles: spoolFiles(t, 10 * MIN, 30 * MIN) }).published);
  assert.match(undrained.verdict ?? "", /^UNDELIVERED — 1 .*already pending at the previous beat; no daemon drain pass since/, "a daemon that is down or predates the drain");

  const neverDrained = spoolVerdict(runBeat({ prevBeatTs: ago(5 * MIN), stateFiles: spoolFiles(t, 10 * MIN) }).published);
  assert.match(neverDrained.verdict ?? "", /\(last: never\)$/);
});
