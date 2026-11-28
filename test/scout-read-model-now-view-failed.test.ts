import assert from "node:assert/strict";
import { mkdirSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { SERVE_MOUNT_ACTION } from "#src/lib/instances-view.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { questionStorePath } from "#src/lib/now-decisions.js";
import { createNowView, NOW_REFRESH_MS, NOW_VIEW_NAME } from "#src/lib/now-view.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

test("W1-T9519: read_model.now_view_failed no longer recurs", (t) => {
  const root = readModelFixtureDir(t, "now-question-store");
  const ledger = writeLedger([], { dir: join(root, "state") });
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"));
  writeFileSync(planPath, [
    "- id: W1-T1", "  title: fixture task", "  repo: remudero", "  depends_on: []",
    "  needs_input:", "    question: Plan-level hold question", "    asked_at: 2026-10-01T08:00:00.000Z",
    "  type: implement", "  risk: medium", "  verify: auto", "  status: queued", "",
    "- id: EXT-T2", "  title: foreign task", "  repo: another/repo", "  depends_on: [W1-T404]",
    "  type: implement", "  risk: medium", "  verify: auto", "  status: queued", "",
  ].join("\n"));
  const supplied = [
    { task: "W1-T1", ts: "2026-10-01T08:00:00.000Z", question: "Already answered?" },
    null, [], false, "stray value", {},
    { task: "W1-T1", question: "Missing timestamp?" },
    { task: "W1-T1", ts: "2026-10-01T08:01:00.000Z", answer: true },
    { task: "W1-T1", ts: "2026-10-01T08:01:00.000Z", answer: "yes" },
    { task: "W1-T1", answer: "hand-edited answer without timestamp" },
    { task: "W1-T1", ts: "2026-10-01T08:02:00.000Z", question: "Still open?" },
  ];
  writeFileSync(questionStorePath(root), [...supplied.map((row) => JSON.stringify(row)), "{", ""].join("\n"));
  const start = Date.parse("2026-10-01T08:03:00.000Z");
  const db = openProjectorReadModel(join(root, "read-model"), "core", fixedClock(start));
  closeReadModelFixture(t, () => db.close());
  const logged: Array<{ step: string; error: unknown }> = [];
  const github = fakeGitHub();
  let now = start;
  const view = createNowView({
    instances: [{ name: "core", repo: "owner/remudero", ledgerDir: ledger.dir, planPath, feedbackRoot: root }],
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    github: () => ({ github, generation: "fixture", source: { asOf: null, state: "fresh" } }),
    planBehind: () => ({ commits: 0 }),
    hostProbe: { rateLimit: () => 100, diskFree: () => 1 },
    log: (step, extra) => logged.push({ step, error: extra.error }),
  });

  for (const at of [start, start + NOW_REFRESH_MS]) {
    now = at;
    const [body] = view.materialize({
      now,
      switches: { views: { [NOW_VIEW_NAME]: "serve" } },
      instances: [{ state: { instance: "core", generation: 0, lease: "held", failures: 0, newestTs: null }, db }],
    });
    assert.ok(body, JSON.stringify(logged));
    assert.equal(body.key, "instance=core");
    assert.deepEqual(body.data.decisions.map((decision) => decision.prompt), ["Still open?"]);
    assert.deepEqual(body.data.humanGates?.sources.find((source) => source.name === "task-questions"), {
      name: "task-questions", instance: "core", state: "partial", reason: "the question store has 8 malformed line(s)",
    });
  }
  unlinkSync(planPath);
  now = start + NOW_REFRESH_MS * 2;
  const [withoutPlan] = view.materialize({
    now,
    switches: { views: { [NOW_VIEW_NAME]: "serve" } },
    instances: [{ state: { instance: "core", generation: 0, lease: "held", failures: 0, newestTs: null }, db }],
  });
  assert.ok(withoutPlan, JSON.stringify(logged));
  assert.deepEqual(logged.filter(({ step }) => step === "read_model.now_view_failed"), []);
});

test("W1-T9519: unavailable instance plans fail visibly and a mounted checkout without a plan is empty", (t) => {
  const root = readModelFixtureDir(t, "now-site-plan");
  const ledger = writeLedger([], { dir: join(root, "state") });
  const checkout = join(root, "repos", "site");
  const clock = fixedClock(Date.parse("2026-10-01T08:03:00.000Z"));
  const db = openProjectorReadModel(join(root, "read-model"), "site", clock);
  closeReadModelFixture(t, () => db.close());
  const logged: Array<Record<string, unknown>> = [];
  const github = fakeGitHub();
  const view = createNowView({
    instances: [{ name: "site", repo: "owner/site", ledgerDir: ledger.dir }],
    coreInstance: "core",
    clock,
    github: () => ({ github, generation: "fixture", source: { asOf: null, state: "fresh" } }),
    planBehind: () => ({ commits: 0 }),
    hostProbe: { diskFree: () => 1 },
    log: (step, extra) => logged.push({ step, ...extra }),
  });
  const build = (offset: number) => view.materialize({
    now: clock.now() + offset,
    switches: { views: { [NOW_VIEW_NAME]: "serve" } },
    instances: [{ state: { instance: "site", generation: 0, lease: "held", failures: 0, newestTs: null }, db }],
  });
  const failures = () => logged.filter((row) => row.step === "read_model.now_view_failed");
  const recoveries = () => logged.filter((row) => row.step === "read_model.now_view_recovered");

  utimesSync(ledger.dir, 0, 0);
  assert.equal(build(0).length, 0, "a missing managed clone must not publish an empty body");
  assert.equal(failures()[0]?.class, "plan-unreadable");
  assert.match(String(failures()[0]?.error), /ENOENT/);

  writeFileSync(join(ledger.dir, "daemon-footprint.json"), "{}");
  assert.equal(build(1).length, 0);
  mkdirSync(checkout, { recursive: true });
  const [empty] = build(2);
  assert.ok(empty, "the restored checkout can publish immediately even before it has a plan");
  assert.deepEqual(empty.data.board.tasks, []);
  assert.equal(failures().length, 1);
  assert.equal(recoveries()[0]?.failures, 1, "a state directory write must not retry a missing clone");

  utimesSync(checkout, 0, 0);
  const unmounted = join(root, "offline-state");
  renameSync(ledger.dir, unmounted);
  assert.equal(build(3).length, 0, "losing the state directory invalidates the cached empty plan");
  assert.equal(failures()[1]?.class, "unmounted");
  assert.equal(failures()[1]?.action, SERVE_MOUNT_ACTION);

  writeFileSync(join(checkout, "README.md"), "site fixture");
  assert.equal(build(4).length, 0);
  renameSync(unmounted, ledger.dir);
  assert.ok(build(5)[0], "remounting state clears the failure");
  assert.equal(recoveries()[1]?.failures, 1, "a checkout directory write must not retry missing state");
  const planPath = join(checkout, "plan", "tasks.yaml");
  mkdirSync(join(checkout, "plan"));
  symlinkSync("missing.yaml", planPath);
  assert.equal(build(6).length, 0, "a dangling plan link is an unreadable plan");
  assert.deepEqual(failures().map((row) => row.class), ["plan-unreadable", "unmounted", "plan-unreadable"]);
  assert.match(String(failures()[2]?.error), /cannot read plan file/);

  unlinkSync(planPath);
  const task = (id: string, repo: string, deps: string) =>
    `- id: ${id}\n  title: ${id} title\n  repo: ${repo}\n  type: implement\n  depends_on: [${deps}]\n  status: queued\n`;
  const foreign = task("EXT-T1", "another/repo", "EXT-T404");
  writeFileSync(planPath, foreign + task("SITE-T1", "site", ""));
  const [populated] = build(7);
  assert.deepEqual(populated?.data.board.groups.queued.slice().sort(), ["EXT-T1", "SITE-T1"]);
  writeFileSync(planPath, foreign + task("SITE-T1", "site", "SITE-T404"));
  utimesSync(planPath, clock.date(), clock.date());
  assert.equal(build(8).length, 0, "an unresolved dependency on the instance's own task still fails the read");
  assert.match(String(failures()[3]?.error), /SITE-T1: depends_on unknown task 'SITE-T404'/);
});
