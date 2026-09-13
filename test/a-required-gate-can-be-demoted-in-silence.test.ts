/**
 * test/a-required-gate-can-be-demoted-in-silence.test.ts — W1-T3519.
 *
 * THE CENSUS CATCHES A DELETED GATE AND NOT A DEMOTED ONE, and the difference is one line.
 * `test/every-pr-check-is-required-or-advisory.test.ts` refuses a job in NEITHER list, and its own
 * falsifier covers exactly that — a name removed from REQUIRED and not added to ADVISORY. A name
 * MOVED between the two still satisfies "in exactly one list", so it passes.
 *
 * MEASURED 2026-09-13 on the real tree: moving `head-identity-gate` from REQUIRED to ADVISORY in
 * ci-gate.yml — which silently stops a required merge gate from blocking — passed that suite 9/9.
 * A PR can therefore weaken the gate set that governs its own merge. That is the second half of
 * the problem W1-T204 names; the `scripts/*-baseline.json` half is already closed by
 * baseline-monotonic-check.mjs, whose shape this check copies deliberately.
 *
 * THE REMEDY IS SELF-SERVICE, WHICH IS THE POINT. A demotion is legitimate often enough that
 * refusing it outright would stall the queue; what it must not be is SILENT. So a demotion passes
 * on a fresh `GATE_RATIONALE` naming the PR or task that reviewed it — the same escape hatch, with
 * the same staleness rule, the score-floor ratchet already uses. No operator is in the loop unless
 * they choose to be.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — the same reason
// test/acceptance-author-gate.test.ts reaches its script through a runtime import rather than a
// typed one. A dynamic specifier is not statically resolved, so this loads the REAL module.
type GateLists = { required: Set<string>; rationale: string | undefined };
type Verdict = { ok: boolean; demoted: string[]; status: string; detail: string };
const gate = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "gate-monotonic-check.mjs")).href)) as {
  evaluateGateMonotonic: (base: GateLists, head: GateLists) => Verdict;
  readGateLists: (yamlText: string) => GateLists;
  gateRationaleNamesAPr: (r: unknown) => boolean;
  CI_GATE_REL: string;
};

const lists = (required: string[], rationale?: string): GateLists => ({ required: new Set(required), rationale });

test("W1-T3519: a context that leaves REQUIRED with no rationale is REFUSED", () => {
  const v = gate.evaluateGateMonotonic(lists(["ci", "head-identity-gate"]), lists(["ci"]));
  assert.equal(v.ok, false);
  assert.equal(v.status, "unreviewed");
  assert.deepEqual(v.demoted, ["head-identity-gate"], "the refusal NAMES the gate, never just a count");
  assert.match(v.detail, /GATE_RATIONALE/, "and names the remedy, so the fix is self-service");
});

test("W1-T3519: the destination does not matter — ADVISORY, IGNORE or nowhere read the same", () => {
  // The consequence is identical however it left: it stops blocking the merge. The check compares
  // REQUIRED against REQUIRED for exactly this reason, rather than tracking where a name went.
  const v = gate.evaluateGateMonotonic(lists(["ci", "leak-grep"]), lists(["ci"]));
  assert.deepEqual(v.demoted, ["leak-grep"]);
  assert.equal(v.ok, false);
});

test("W1-T3519: a FRESH rationale naming a PR or task lets a reviewed demotion through", () => {
  const v = gate.evaluateGateMonotonic(
    lists(["ci", "old-gate"], "#1200: earlier, unrelated demotion"),
    lists(["ci"], "#5379: old-gate is superseded by ci-shard"),
  );
  assert.equal(v.ok, true, "a reviewed demotion is an ordinary outcome, not a defeat — the queue must not stall");
  assert.equal(v.status, "reviewed");
});

test("W1-T3519: a rationale carried over from an EARLIER demotion does not review this one", () => {
  const stale = "#1200: some demotion reviewed long ago";
  const v = gate.evaluateGateMonotonic(lists(["ci", "old-gate"], stale), lists(["ci"], stale));
  assert.equal(v.ok, false);
  assert.equal(v.status, "stale-rationale", "identical to the base's ⇒ it reviewed the base, not this change");
});

test("W1-T3519: a rationale naming no PR or task is not a review", () => {
  for (const bad of ["", "   ", "cleanup", "no longer needed"]) {
    assert.equal(gate.gateRationaleNamesAPr(bad), false, `"${bad}" names nothing to go read`);
  }
  assert.equal(gate.gateRationaleNamesAPr("#5379: superseded"), true);
  assert.equal(gate.gateRationaleNamesAPr("W1-T3519: superseded"), true);
});

test("W1-T3519: ADDING a gate is never a regression and needs no rationale", () => {
  const v = gate.evaluateGateMonotonic(lists(["ci"]), lists(["ci", "gate-monotonic"]));
  assert.equal(v.ok, true);
  assert.deepEqual(v.demoted, [], "this check is one-directional by design — it never taxes hardening");
});

test("W1-T3519: an unreadable ci-gate.yml THROWS rather than reporting a clean gate set", () => {
  // The caller turns this into exit 2. A run that cannot measure must never report OK — the same
  // contract baseline-monotonic-check.mjs states for its own unmeasurable case.
  for (const bad of ["", "jobs: {}", "jobs:\n  ci-gate:\n    env: {}", "jobs:\n  ci-gate:\n    env:\n      REQUIRED: 'not json'"]) {
    assert.throws(() => gate.readGateLists(bad), `"${bad.slice(0, 24)}" must not parse as a clean gate set`);
  }
});

test("W1-T3519: the REAL ci-gate.yml parses, and this check's own job is registered", () => {
  const yaml = readFileSync(join(REPO_ROOT, gate.CI_GATE_REL), "utf8");
  const real = gate.readGateLists(yaml);
  assert.ok(real.required.size >= 20, `sanity: expected a populated REQUIRED list, got ${real.required.size}`);
  const doc = parseYaml(yaml) as { jobs: Record<string, { env?: Record<string, string> }> };
  const advisory = new Set(JSON.parse(doc.jobs["ci-gate"]!.env!.ADVISORY!) as string[]);
  assert.ok(
    advisory.has("gate-monotonic") || real.required.has("gate-monotonic"),
    "the census refuses a pull_request job in neither list — this one starts ADVISORY per ci-gate.yml's own rule that a name joins REQUIRED once it is live on main",
  );
});
