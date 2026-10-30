import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backlogGardenSpec, backlogInventory, originFeedbackPrs, readOpenBacklogState, type BacklogSources, type OpenPrs } from "#src/lib/backlog-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import type { Task } from "#src/lib/plan.js";

const ID = "W1-T11003";
const FEEDBACK = "fb-dep-review-69bc59bf88007e5e";
const REPO = "craigoley/remudero";

// The 2026-10-28 dep-review own-red feedback, cut down: its PR URL, its folded siblings, a quoted
// release-note issue reference, and another repository's pull URL.
const FEEDBACK_RAW = [
  `id: ${FEEDBACK}`,
  "raw: |-",
  "  Land the dependency bump(s) of Dependabot PR #15180, whose red is its own",
  "  PR: https://github.com/craigoley/remudero/pull/15180",
  "  Sibling Dependabot PRs folded in: #15177 (@anthropic-ai/claude-agent-sdk 0.3.303 -> 0.3.310); #15182 (actions/setup-python 7.0.0 -> 7.1.0)",
  "  <li>Fixed the sandbox warning (#15190)</li>",
  "  <a href=\"https://github.com/anthropics/claude-code/pull/15191\">upstream</a>",
  "",
].join("\n");

function fixture(t: { after: (fn: () => void) => void }, origin: string | undefined = `feedback#${FEEDBACK}`) {
  const root = mkdtempSync(join(tmpdir(), "rmd-backlog-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${FEEDBACK}.yaml`), FEEDBACK_RAW);
  const rel = `plan/tasks.d/${ID}-land-dependency-groups-with-companion-pins.yaml`;
  writeFileSync(join(root, rel), `- id: ${ID}\n  title: Land the dependency moves\n  status: queued\n`);
  const task: Task = {
    id: ID, title: "Land the dependency moves", repo: "remudero", depends_on: [], type: "implement", verify: "auto",
    risk: "high", status: "queued", attempts: 0, files: ["package.json"], rationale: "The checkout still pins the old versions.",
    ...(origin === undefined ? {} : { origin }),
  };
  const plan: PlanInventory = { open: [task], all: [task], shards: new Map([[ID, rel]]) };
  const sources: BacklogSources = {
    repoRoot: root, plan: () => plan, ledger: () => [], history: () => [], mergedLastDay: () => 2,
    clock: fixedClock(Date.parse("2026-10-30T04:04:41.730Z")), fileExists: () => true, proofsHolding: () => new Set(),
    ownProofsHold: () => false,
  };
  return { root, task, sources };
}

const open = (...numbers: number[]): OpenPrs => ({ repo: REPO, numbers: new Set(numbers) });

test("a task whose origin feedback names still-open PRs is band 2, naming them, not band 4", (t) => {
  const f = fixture(t);
  const inv = backlogInventory(f.sources, () => true, open(15176, 15177, 15180, 15182, 15190, 15191, 15621));
  assert.equal(inv.candidates.length, 1);
  const [action] = inv.candidates;
  assert.deepEqual(action!.disposition, { kind: "band", band: 2 });
  assert.deepEqual(action!.evidence.heldPrs, [15177, 15180, 15182]);
  assert.match(action!.reason, /names 3 still-open PR\(s\) waiting on it: #15177, #15180, #15182/);
});

test("the named PRs once closed, or no open-PR read at all, leave the task at band 4 as before", (t) => {
  const f = fixture(t);
  for (const read of [open(15621), undefined]) {
    const [action] = backlogInventory(f.sources, () => true, read).candidates;
    assert.deepEqual(action!.disposition, { kind: "band", band: 4 });
    assert.equal(action!.evidence.heldPrs, undefined, "no held PRs is no field, so every other task's signature is unchanged");
  }
});

test("only a feedback origin names PRs; a quoted upstream issue and another repository's pull URL do not", (t) => {
  const f = fixture(t);
  assert.deepEqual(originFeedbackPrs(f.root, f.task, REPO), [15177, 15180, 15182]);
  assert.deepEqual(originFeedbackPrs(f.root, f.task, "CraigOley/Remudero"), [15177, 15180, 15182], "the repository compares case-insensitively");
  assert.deepEqual(originFeedbackPrs(f.root, { ...f.task, origin: "operator-session#slo-ladder-recon" }, REPO), []);
  assert.deepEqual(originFeedbackPrs(f.root, { ...f.task, origin: "feedback#fb-not-filed" }, REPO), [], "a missing feedback record names none");
});

test("one open-PR read yields both the open decisions and every open PR number, and the daemon inventory uses it", async (t) => {
  const pr = (number: number, ref: string, body: string) => ({ number, head: { ref, sha: "a".repeat(40) }, body });
  const pages = [[pr(15180, "dependabot/npm_and_yarn/deploy/x", ""), pr(15700, "backlog-garden-1", "The backlog gardener (W1-T4941) proposes these plan-only changes.\n\n- **W1-T1**: band 3. x")]];
  const state = await readOpenBacklogState("/unused", { origin: async () => "https://github.com/craigoley/remudero.git", pages: async () => pages });
  assert.equal(state.openPrs.repo, REPO);
  assert.deepEqual([...state.openPrs.numbers].sort(), [15180, 15700]);
  assert.deepEqual(state.decisions.map((d) => d.target), ["W1-T1"]);

  const f = fixture(t);
  const deps = { repoRoot: f.root, stateDir: f.root, log: () => {} } as unknown as GardenerDeps;
  const spec = backlogGardenSpec(deps, { ...f.sources, openDecisions: async () => [], openPrs: async () => state.openPrs });
  const inv = await spec.inventoryAsync!();
  assert.deepEqual(inv.candidates.map((a) => [a.disposition, a.evidence.heldPrs]), [[{ kind: "band", band: 2 }, [15180]]]);
});
