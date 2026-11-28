import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
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
