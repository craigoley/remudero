// W1-T12940 — a dependency pull request is judged against its OWN repository's required checks.
//
// 2026-11-15: nine Dependabot bumps on remudero-console and remudero-site were green on GitHub and held by the
// dependency lane on every pass ("selected check evidence is pending": 1,315 rows on console, 208 on site). The lane
// read ci-gate's REQUIRED list from the checkout the daemon's own code runs from, so a console pull request was
// judged against remudero's checks, none of which exists in console. These tests pin the per-repository source.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readCiGateRequiredChecks } from "#src/lib/ci-gate-required.js";
import {
  decideDepReview,
  depReviewRequiredChecksSource,
  depReviewRequiredReader,
  depReviewRequiredSet,
  depReviewRequiredSetFrom,
  readDepReviewCiGateRequired,
  type DepReviewCheck,
} from "#src/lib/dep-review.js";
import { checksStateFromRollup } from "#src/lib/sweep.js";

const SELF_ROOT = "/fleet/remudero";
const CONFIG_ROOT = "/fleet/state-console";
const MANAGED_ROOT = join(CONFIG_ROOT, "repos", "remudero-console");
const workflow = (required: string[]): string =>
  `jobs:\n  ci-gate:\n    env:\n      REQUIRED: '${JSON.stringify(required)}'\n`;
const SELF_REQUIRED = ["ci", "lint-plan", "depcruise", "coverage-ratchet"];
const files: Record<string, string> = {
  [join(SELF_ROOT, ".github", "workflows", "ci-gate.yml")]: workflow(SELF_REQUIRED),
  [join(MANAGED_ROOT, ".github", "workflows", "ci-gate.yml")]: workflow(["console-ci"]),
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return text;
};
const CONSOLE_PROTECTION = { kind: "contexts" as const, contexts: ["Vercel", "ci-gate", "console-ci", "remudero-review"] };
const CONSOLE_GREEN: DepReviewCheck[] = [
  { name: "console-ci", conclusion: "SUCCESS" },
  { name: "ci-gate", conclusion: "SUCCESS" },
  { context: "Vercel", state: "SUCCESS" },
];
const bump = (checks: DepReviewCheck[], required: ReturnType<typeof depReviewRequiredSet>) => decideDepReview({
  author: { login: "app/dependabot" },
  title: "chore(deps): bump example from 1.0.0 to 1.1.0",
  body: "",
  diff: "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
  checks,
  required,
});
const managed = () => depReviewRequiredChecksSource({ repo: "remudero-console", selfRepo: "remudero", selfRoot: SELF_ROOT, configRoot: CONFIG_ROOT });
// The reader the dependency lane itself builds: it is given the pull request's repository and chooses the source.
const laneReader = (repo: string) => depReviewRequiredReader({
  repo, selfRepo: "remudero", selfRoot: SELF_ROOT, configRoot: CONFIG_ROOT,
  readProtection: async () => (repo === "remudero" ? { kind: "contexts" as const, contexts: ["ci-gate", "remudero-review"] } : CONSOLE_PROTECTION),
  readWorkflow: read,
});
const self = () => depReviewRequiredChecksSource({ repo: "remudero", selfRepo: "remudero", selfRoot: SELF_ROOT, configRoot: CONFIG_ROOT });

test("W1-T12940 criterion 1: a managed repository's required set comes from its own ci-gate workflow, never the daemon's", async () => {
  const lane = laneReader("remudero-console");
  assert.deepEqual(lane.source, { root: MANAGED_ROOT, self: false });
  assert.deepEqual(managed(), lane.source);
  const required = await lane.read("main");
  assert.deepEqual(required, { kind: "required", names: ["Vercel", "ci-gate", "console-ci", "remudero-review"] });
  for (const name of SELF_REQUIRED) {
    assert.equal(required.kind === "required" && required.names.includes(name), false, `${name} is remudero's check, not console's`);
  }
  // Case does not make a managed repository the daemon's own.
  assert.equal(depReviewRequiredChecksSource({ repo: "Remudero-Console", selfRepo: "remudero", selfRoot: SELF_ROOT, configRoot: CONFIG_ROOT }).self, false);
});

test("W1-T12940 criterion 2: a managed bump whose own required checks are green arms, where the daemon's list held it pending", async () => {
  const own = await laneReader("remudero-console").read("main");
  assert.equal(own.kind, "required");
  const ownNames = own.kind === "required" ? own.names : [];
  assert.equal(checksStateFromRollup(CONSOLE_GREEN, ownNames), "green");
  assert.equal(bump(CONSOLE_GREEN, own).decision, "arm");
  // The defect: the same head judged against the list of the checkout the daemon's code runs from.
  const borrowed = depReviewRequiredSet(CONSOLE_PROTECTION, readCiGateRequiredChecks(SELF_ROOT, read));
  const borrowedNames = borrowed.kind === "required" ? borrowed.names : [];
  assert.equal(checksStateFromRollup(CONSOLE_GREEN, borrowedNames), "pending", "remudero's checks never register on a console head");
});

test("W1-T12940 criterion 3: the daemon's own repository keeps origin/main's required set, and an unregistered required check is still pending", async () => {
  const source = self();
  assert.deepEqual(source, { root: SELF_ROOT, self: true });
  const protection = { kind: "contexts" as const, contexts: ["ci-gate", "remudero-review"] };
  const now = await laneReader("remudero").read("main");
  assert.deepEqual(now, depReviewRequiredSet(protection, readCiGateRequiredChecks(SELF_ROOT, read)));
  const names = now.kind === "required" ? now.names : [];
  const partial: DepReviewCheck[] = [{ name: "ci-gate", conclusion: "SUCCESS" }, { name: "ci", conclusion: "SUCCESS" }];
  assert.equal(checksStateFromRollup(partial, names), "pending", "lint-plan, depcruise and coverage-ratchet have not registered");
  // An unreadable workflow in the daemon's own checkout keeps today's answer (an empty list, then the existing rule).
  const missingSelf = readDepReviewCiGateRequired({ root: "/fleet/absent", self: true }, read);
  assert.deepEqual(missingSelf, { kind: "names", names: [] });
  assert.deepEqual(depReviewRequiredSetFrom(protection, missingSelf), depReviewRequiredSet(protection, []));
});

test("W1-T12940 criterion 4: an unreadable managed checkout judges every reported check and never borrows another repository's list", () => {
  const source = depReviewRequiredChecksSource({ repo: "remudero-site", selfRepo: "remudero", selfRoot: SELF_ROOT, configRoot: CONFIG_ROOT });
  const ciGate = readDepReviewCiGateRequired(source, read);
  const path = join(CONFIG_ROOT, "repos", "remudero-site", ".github", "workflows", "ci-gate.yml");
  assert.deepEqual(ciGate, { kind: "unreadable", path });
  const required = depReviewRequiredSetFrom({ kind: "contexts", contexts: ["Vercel", "ci-gate", "remudero-review"] }, ciGate);
  assert.deepEqual(required, { kind: "all-checks", fallback: `ci-gate-required-unreadable:${path}` });
  // Every reported check is judged: an advisory red now holds, and all-green still arms.
  assert.equal(bump([...CONSOLE_GREEN, { name: "Scan", conclusion: "FAILURE" }], required).decision, "hold");
  assert.equal(bump(CONSOLE_GREEN, required).decision, "arm");
  // Unreadable protection keeps its own fallback reason; the unreadable workflow does not mask it.
  assert.deepEqual(depReviewRequiredSetFrom({ kind: "unreadable", reason: "http-500" }, ciGate),
    { kind: "all-checks", fallback: "protection-unreadable:http-500" });
});
