// 2026-10-10 on the fleet host the backlog lane drafted the same refused change at 17:17, 17:38, 17:55 and 18:09Z. Each
// time its plan-PR preflight refused the landing, ws.land returned no PR, and the pass wrote that result like a success:
// no filing streak, no wait, and its unfinished inventory left the fingerprint untrusted, so the next changed input
// (an hour bucket, or any merge to the plan) opened a new worktree and ran the full preflight on identical bytes. This
// is the garden form of #10678: a landing whose PR never opens is a failed filing, which backs off on the doubling wait
// and escalates once, and bytes once refused are never landed again; a different draft is.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { gardenPassDue, gardenStatePath, runGarden, type GardenAction, type GardenCheckout, type GardenSpec } from "#src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NAME = "refusal-probe";
const NOTE = "notes/proposal.md";

test("a garden landing whose PR never opens backs off and escalates once, and its identical draft is never landed again", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-refused-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  let nowMs = Date.parse("2026-10-10T17:17:00Z");
  const clock: Clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  let draft = "retire W1-T5161 and W1-T6007\n";
  let cheap = 0;
  const lands: string[] = [];
  const steps: string[] = [];
  const escalations: Escalation[] = [];
  const spec: GardenSpec<"retire", undefined, GardenAction<"retire">, GardenCheckout> = {
    name: NAME,
    classes: ["retire"],
    review: { retire: "a judgement call" },
    cheapFingerprint: () => String(cheap),
    inventory: () => undefined,
    fingerprint: () => "the same candidates",
    unfinished: () => true,
    candidates: () => [{ class: "retire", target: "W1-T5161", reason: "overtaken" }],
    scorecard: () => ({}),
    apply: (ws) => {
      mkdirSync(join(ws.root, "notes"), { recursive: true });
      writeFileSync(join(ws.root, NOTE), draft);
      return { paths: [NOTE], title: "chore(plan): a proposal", body: "body" };
    },
  };
  const deps = {
    stateDir, repoRoot: root, clock, seed: 1,
    log: (step: string) => steps.push(step),
    escalate: (e: Escalation) => (escalations.push(e), "https://github.com/acme/remudero/issues/1"),
    mergedPlanLint: () => undefined,
    openWorkspace: () => ({ root, land: () => (lands.push(readFileSync(join(root, NOTE), "utf8")), undefined), dispose: () => {} }),
  };
  /** The daemon's view: a pass runs only when gardenPassDue says so, and each poll is a minute with a fresh input. */
  const poll = () => {
    nowMs += 60_000;
    cheap++;
    if (gardenPassDue(spec, deps)) runGarden(spec, deps);
  };

  runGarden(spec, deps);
  assert.equal(lands.length, 1, "the first draft is offered");
  assert.ok(steps.includes(`${NAME}.garden_filing_failed`), "a landing whose PR never opens is a failed filing");
  const state = JSON.parse(readFileSync(gardenStatePath(stateDir, NAME), "utf8"));
  assert.equal(state.filingFailures.count, 1);
  assert.equal(typeof state.refusedLanding.digest, "string");

  for (let i = 0; i < 14; i++) poll();
  assert.equal(lands.length, 1, "no pass runs inside the doubling wait, however the inputs change");

  for (let i = 0; i < 6 * 60; i++) poll();
  assert.equal(lands.length, 1, "the identical draft is never landed again");
  assert.ok(steps.includes(`${NAME}.landing_repeat_skipped`), "the repeat is ledgered as skipped");

  draft = "retire W1-T5161 and W1-T6007, parked for the judge\n";
  for (let i = 0; i < 24 * 60 && lands.length < 2; i++) poll();
  assert.deepEqual(lands, ["retire W1-T5161 and W1-T6007\n", draft], "a different draft is offered once its wait elapses");
  for (let i = 0; i < 3 * 24 * 60; i++) poll();
  assert.equal(lands.length, 2, "and once refused, it too is not landed again");
  assert.equal(escalations.length, 1, "the streak reaches a person once");
  assert.match(escalations[0]!.summary, new RegExp(`the ${NAME} gardener's filing has failed 3 times in a row`));
});
