import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPromotionJudgePrompt,
  computeLayerBudgetUsage,
  DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
  entryLayer,
  evaluateLayerBudgetRatchet,
  nextLayer,
  parsePromotionJudgeVerdict,
  planPromotionFromVerdict,
  promoteEntry,
  redactProvenance,
  runPromotionPass,
  scrubEntry,
  type LearningEntry,
  type PromotionJudgeDeps,
  type PromotionJudgeVerdict,
} from "../src/lib/learnings.js";

// P32/W1-T146 — layered knowledge promotion: scrub (leak-grep + PII) THEN judge (applicability
// eval); per-layer budget ratchet. These tests exercise the three acceptance criteria named in
// plan/tasks.yaml W1-T146 directly, including the two REQUIRED planted-probe falsifiers.

/** A minimal, well-formed, scrub-clean entry — the base fixture every test tweaks. */
function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "promotion-fixture",
    subsystem: "knowledge",
    lifecycle: "active",
    files: ["src/lib/learnings.ts"],
    fact: "A cross-cutting lesson that holds regardless of repo.",
    src: "operator-fleet",
    ...over,
  };
}

/** A deps.judge that always returns a fixed verdict and counts its own invocations. */
function fixedJudge(verdict: PromotionJudgeVerdict): { deps: PromotionJudgeDeps; calls: () => number } {
  let calls = 0;
  return {
    deps: {
      judge: async () => {
        calls++;
        return verdict;
      },
    },
    calls: () => calls,
  };
}

// ── Acceptance 1 (REQUIRED planted probe): a project-specific entry does NOT promote ──────────

test("W1-T146: a deliberately PROJECT-SPECIFIC entry is judged project-specific and stays at the project layer", async () => {
  const projectSpecific = entry({
    id: "repo-specific-fact",
    fact: "src/lib/worker.ts:412 special-cases W1-T146's fixture path — repo-specific, not portable.",
  });
  const { deps, calls } = fixedJudge({
    applicability: "project-specific",
    confidence: 0.95,
    rationale: "names a repo-specific file path and task id",
  });

  const result = await promoteEntry(projectSpecific, deps);

  assert.equal(result.promoted, false);
  assert.equal(result.stage, "judge");
  assert.equal(calls(), 1, "the judge WAS invoked (scrub passed) — this probe is about the judge's verdict, not scrub");
  assert.equal(result.promotedEntry, undefined);
});

test("W1-T146: after a promotion pass, a project-specific entry does NOT appear at the user-overall layer", async () => {
  const projectSpecific = entry({ id: "repo-specific-fact-2" });
  const { deps } = fixedJudge({ applicability: "project-specific", confidence: 0.9, rationale: "repo-specific" });

  const pass = await runPromotionPass([projectSpecific], deps);

  assert.equal(pass.promotedEntries.length, 0);
  assert.ok(
    !pass.promotedEntries.some((e) => entryLayer(e) === "user-overall"),
    "a project-specific entry must never appear at user-overall after a promotion pass",
  );
  assert.equal(pass.results[0].promoted, false);
});

// ── Acceptance 2 (REQUIRED planted probe): a secret-bearing entry is BLOCKED at scrub ─────────

test("W1-T146: a deliberately SECRET-BEARING entry is blocked at scrub; the judge is NEVER invoked", async () => {
  const secretBearing = entry({
    id: "leaky-fact",
    // Built via concatenation (not a literal token) so the leak-grep CI tripwire
    // doesn't flag this deliberately-planted probe string in the tracked source —
    // the runtime-assembled fact still matches scrubEntry's AKIA regex.
    fact: `Use ${"AKIA" + "ABCDEFGHIJKLMNOP"} as the deploy access key when rotating credentials.`,
  });
  const { deps, calls } = fixedJudge({ applicability: "broadly-applicable", confidence: 1, rationale: "n/a" });

  const result = await promoteEntry(secretBearing, deps);

  assert.equal(result.promoted, false);
  assert.equal(result.stage, "scrub");
  assert.equal(calls(), 0, "the scrub falsifier: the judge must NEVER be called once scrub blocks");
  assert.ok(result.scrub.blocked);
  assert.ok(result.scrub.reasons.includes("aws-access-key-id"));
});

test("W1-T146: a deliberately PII-bearing entry (an email address) is blocked at scrub; the judge is never invoked", async () => {
  const piiBearing = entry({ id: "pii-fact", fact: "File complaints to craig.the.operator@example.com directly." });
  const { deps, calls } = fixedJudge({ applicability: "broadly-applicable", confidence: 1, rationale: "n/a" });

  const result = await promoteEntry(piiBearing, deps);

  assert.equal(result.promoted, false);
  assert.equal(result.stage, "scrub");
  assert.equal(calls(), 0);
  assert.ok(result.scrub.reasons.includes("email-address"));
});

test("W1-T146: scrubEntry passes an ordinary, secret-free fact clean (zero reasons, not blocked)", () => {
  const clean = entry();
  const result = scrubEntry(clean);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.reasons, []);
});

// ── Acceptance 3: provenance survives promotion redacted; per-layer budget enforced ───────────

test("W1-T146: a promoted entry retains its origin provenance with project-identifying specifics REDACTED", async () => {
  const broadlyApplicable = entry({
    id: "generalizable-fact",
    src: "PR#8, W1-T146",
    fact: "A cross-cutting lesson every worker should carry, regardless of repo.",
  });
  const { deps, calls } = fixedJudge({
    applicability: "broadly-applicable",
    confidence: 0.9,
    rationale: "holds regardless of repo",
  });

  const result = await promoteEntry(broadlyApplicable, deps);

  assert.equal(calls(), 1);
  assert.equal(result.promoted, true);
  assert.equal(result.stage, "promoted");
  assert.ok(result.promotedEntry);
  assert.equal(entryLayer(result.promotedEntry!), "user-overall");
  // The origin SHAPE survives (still names it came from a PR) but the specifics are gone.
  assert.ok(result.promotedEntry!.src.includes("PR#"));
  assert.ok(!result.promotedEntry!.src.includes("8"), "the PR number is a project-identifying specific — redacted");
  assert.ok(!result.promotedEntry!.src.includes("W1-T146"), "the task id is a project-identifying specific — redacted");
});

test("W1-T146: a low-confidence broadly-applicable verdict fails closed — does not promote", async () => {
  const uncertain = entry({ id: "uncertain-fact" });
  const { deps } = fixedJudge({ applicability: "broadly-applicable", confidence: 0.4, rationale: "not sure" });

  const result = await promoteEntry(uncertain, deps);

  assert.equal(result.promoted, false);
  assert.equal(result.stage, "judge");
  assert.ok(!planPromotionFromVerdict({ applicability: "broadly-applicable", confidence: 0.4, rationale: "" }));
});

test("W1-T146: an entry already at the top (global) layer never promotes further and never invokes the judge", async () => {
  const atTop = entry({ id: "already-global", layer: "global" });
  const { deps, calls } = fixedJudge({ applicability: "broadly-applicable", confidence: 1, rationale: "n/a" });

  const result = await promoteEntry(atTop, deps);

  assert.equal(result.promoted, false);
  assert.equal(result.stage, "top-layer");
  assert.equal(calls(), 0);
  assert.equal(nextLayer("global"), undefined);
  assert.equal(nextLayer("project"), "user-overall");
  assert.equal(nextLayer("user-overall"), "global");
});

test("W1-T146: parsePromotionJudgeVerdict parses machine-readable judge output, and fails closed on garbage", () => {
  const good = parsePromotionJudgeVerdict(
    "some prose\nPROMOTION_APPLICABILITY: broadly-applicable\nPROMOTION_CONFIDENCE: 0.85\nPROMOTION_RATIONALE: holds everywhere\n",
  );
  assert.equal(good.applicability, "broadly-applicable");
  assert.equal(good.confidence, 0.85);
  assert.equal(good.rationale, "holds everywhere");

  const garbage = parsePromotionJudgeVerdict("the model rambled and never emitted a verdict line");
  assert.equal(garbage.applicability, "project-specific");
  assert.equal(garbage.confidence, 0);
  assert.ok(!planPromotionFromVerdict(garbage), "the fail-closed default must never satisfy the promotion threshold");
});

test("W1-T146: buildPromotionJudgePrompt names the entry's fields and the machine-readable output contract", () => {
  const e = entry({ id: "prompt-fixture", fact: "the fact text", src: "the src text" });
  const prompt = buildPromotionJudgePrompt(e);
  assert.ok(prompt.includes("prompt-fixture"));
  assert.ok(prompt.includes("the fact text"));
  assert.ok(prompt.includes("the src text"));
  assert.ok(prompt.includes("PROMOTION_APPLICABILITY:"));
  assert.ok(prompt.includes("PROMOTION_CONFIDENCE:"));
});

test("W1-T146: redactProvenance strips task ids and PR/issue numbers but keeps unrelated text", () => {
  assert.equal(redactProvenance("operator-fleet"), "operator-fleet");
  assert.equal(redactProvenance("PR#8"), "PR#[redacted]");
  assert.equal(redactProvenance("W1-T146"), "[task]");
  assert.equal(redactProvenance("issue #42"), "issue#[redacted]");
});

// ── per-layer budget ratchet ────────────────────────────────────────────────────────────────

test("W1-T146: computeLayerBudgetUsage buckets injectable weight by layer, always returning all three layers", () => {
  const entries: LearningEntry[] = [
    entry({ id: "p1", layer: "project" }),
    entry({ id: "u1", layer: "user-overall" }),
    entry({ id: "u2", layer: "user-overall" }),
    entry({ id: "g1", layer: "global", lifecycle: "superseded" }), // excluded — not active
  ];
  const usage = computeLayerBudgetUsage(entries);
  assert.deepEqual(
    usage.map((u) => u.layer),
    ["project", "user-overall", "global"],
  );
  const byLayer = Object.fromEntries(usage.map((u) => [u.layer, u]));
  assert.equal(byLayer.project.activeCount, 1);
  assert.equal(byLayer["user-overall"].activeCount, 2);
  assert.equal(byLayer.global.activeCount, 0, "superseded entries carry zero injectable weight");
  assert.ok(byLayer.project.chars > 0);
});

test("W1-T146: exceeding ONE layer's cap fails the ratchet without affecting another layer's evaluation", () => {
  const entries: LearningEntry[] = [
    entry({ id: "p1", layer: "project", fact: "short" }),
    entry({ id: "u1", layer: "user-overall", fact: "a much longer fact that costs many more characters than short" }),
  ];
  const usage = computeLayerBudgetUsage(entries);
  const projectChars = usage.find((u) => u.layer === "project")!.chars;
  const userChars = usage.find((u) => u.layer === "user-overall")!.chars;

  // project is comfortably under its own cap; user-overall is deliberately capped below its usage.
  const violations = evaluateLayerBudgetRatchet(entries, {
    project: projectChars + 100,
    "user-overall": userChars - 1,
  });

  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes("user-overall"));
  assert.ok(!violations[0].includes("project"));
});

test("W1-T146: a layer with no cap set in LayerBudgetCaps is never a violation", () => {
  const entries: LearningEntry[] = [entry({ id: "g1", layer: "global", fact: "x".repeat(500) })];
  const violations = evaluateLayerBudgetRatchet(entries, {});
  assert.deepEqual(violations, []);
});

test("W1-T146: DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD is exported and used as planPromotionFromVerdict's default", () => {
  assert.ok(DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD > 0 && DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD <= 1);
  const atThreshold: PromotionJudgeVerdict = {
    applicability: "broadly-applicable",
    confidence: DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
    rationale: "",
  };
  assert.ok(planPromotionFromVerdict(atThreshold));
});
