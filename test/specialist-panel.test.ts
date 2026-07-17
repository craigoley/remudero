import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPECIALIST_TOOLS,
  buildSpecialistPrompt,
  buildSpecialistSpawnArgs,
  noSpecialistsTriggered,
  routeSpecialists,
  type SpecialistTaskMetadata,
} from "../src/lib/specialist-panel.js";
import type { DiffSummary } from "../src/lib/risk-score.js";

function diffOf(...files: Array<string | { path: string; content?: string }>): DiffSummary {
  return {
    files: files.map((f) => (typeof f === "string" ? { path: f, additions: 1, deletions: 0 } : { path: f.path, additions: 1, deletions: 0, content: f.content })),
  };
}

// ── ACCEPTANCE 1: a diff adding a network call to a new domain triggers
// security and NOT design ─────────────────────────────────────────────────

test("ACCEPTANCE 1: a diff adding a network call to a new domain triggers security and NOT design", () => {
  const diff = diffOf({
    path: "src/lib/fetcher.ts",
    content: 'const res = await fetch("https://new-domain.example.com/api");',
  });
  const triggers = routeSpecialists(diff);
  const names = triggers.map((t) => t.specialist);
  assert.ok(names.includes("security"), `expected security in ${JSON.stringify(names)}`);
  assert.ok(!names.includes("design"), `expected design NOT in ${JSON.stringify(names)}`);
});

// ── ACCEPTANCE 2: a docs-only diff triggers NO specialist ──────────────────

test("ACCEPTANCE 2: a docs-only diff triggers NO specialist", () => {
  const diff = diffOf("README.md", "docs/guide.md");
  assert.deepEqual(routeSpecialists(diff), []);
  assert.equal(noSpecialistsTriggered(diff), true);
});

// ── ACCEPTANCE 3: specialists are read-only and only advise ────────────────

test("ACCEPTANCE 3: buildSpecialistSpawnArgs restricts tools to Read/Grep/Glob/Bash — no Write/Edit/NotebookEdit/MultiEdit ever in context", () => {
  const args = buildSpecialistSpawnArgs({
    specialist: "security",
    reasons: ["auth path touched"],
    taskId: "W2-T1",
    prUrl: "https://github.com/craigoley/remudero/pull/999",
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
  });
  assert.deepEqual(args.tools, SPECIALIST_TOOLS);
  for (const forbidden of ["Write", "Edit", "NotebookEdit", "MultiEdit"]) {
    assert.equal(args.tools?.includes(forbidden), false, `must not include ${forbidden}`);
  }
});

test("ACCEPTANCE 3: the specialist prompt tells the worker it must never edit/modify/write and only advises via a PR comment", () => {
  const prompt = buildSpecialistPrompt({
    specialist: "containment",
    reasons: ["touches hooks/deny-floor.sh"],
    taskId: "W2-T1",
    prUrl: "https://github.com/craigoley/remudero/pull/999",
  });
  assert.match(prompt, /NEVER edit, modify, or write/i);
  assert.match(prompt, /gh pr comment/);
  assert.match(prompt, /GitHub-enforced merge gate DECIDES/i);
});

test("ACCEPTANCE 3: a specialist's only sanctioned GitHub action is an ADVISORY PR review comment — its verdict feeds remudero-review, NEVER a merge/arm call (the gate decides)", () => {
  const args = buildSpecialistSpawnArgs({
    specialist: "design",
    reasons: ["new exported surface"],
    taskId: "W2-T1",
    prUrl: "https://github.com/craigoley/remudero/pull/999",
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
  });
  // Read-only by construction: no write tool, so a specialist cannot mutate the repo.
  for (const forbidden of ["Write", "Edit", "NotebookEdit", "MultiEdit"]) {
    assert.equal(args.tools?.includes(forbidden), false, `must not include ${forbidden}`);
  }
  // Advisory by construction: the sanctioned action is a review comment; the prompt
  // NEVER instructs a merge/arm — the GitHub-enforced gate is the sole decider.
  const prompt = args.prompt;
  assert.match(prompt, /gh pr comment/, "the specialist advises via a PR review comment");
  assert.doesNotMatch(prompt, /gh pr merge/, "a specialist must never be told to merge");
  assert.doesNotMatch(prompt, /--merge\b|--auto\b|auto-?merge|\barm\b/i, "a specialist must never arm/merge — that is the gate's call");
  assert.match(prompt, /ADVISE only|gate (DECIDES|decides)/i, "the verdict is advice; the gate decides");
});

// ── routeSpecialists: fixed order, evidence-carrying reasons ────────────────

test("routeSpecialists: hooks/deny-floor.sh triggers BOTH security and containment, in fixed panel order", () => {
  const diff = diffOf("hooks/deny-floor.sh");
  const triggers = routeSpecialists(diff);
  const names = triggers.map((t) => t.specialist);
  assert.deepEqual(names, ["security", "containment"]);
  for (const t of triggers) assert.ok(t.reasons.length > 0, `${t.specialist} must carry evidence`);
});

test("routeSpecialists: .env file triggers containment with evidence naming the path", () => {
  const triggers = routeSpecialists(diffOf(".env.production"));
  const containment = triggers.find((t) => t.specialist === "containment");
  assert.ok(containment);
  assert.match(containment!.reasons[0], /\.env\.production/);
});

test("routeSpecialists: package.json triggers security (new-dependency manifest)", () => {
  const triggers = routeSpecialists(diffOf("package.json"));
  assert.ok(triggers.some((t) => t.specialist === "security"));
});

// ── testing specialist ─────────────────────────────────────────────────────

test("testing: tdd:strict metadata alone triggers testing even on an empty diff", () => {
  const metadata: SpecialistTaskMetadata = { tddStrict: true };
  const triggers = routeSpecialists({ files: [] }, metadata);
  assert.deepEqual(triggers.map((t) => t.specialist), ["testing"]);
});

test("testing: a negative coverage delta triggers testing", () => {
  const triggers = routeSpecialists({ files: [] }, { coverageDelta: -0.05 });
  assert.ok(triggers.some((t) => t.specialist === "testing"));
});

test("testing: a negative mutation-score delta triggers testing", () => {
  const triggers = routeSpecialists({ files: [] }, { mutationScoreDelta: -1 });
  assert.ok(triggers.some((t) => t.specialist === "testing"));
});

test("testing: a positive coverage delta does NOT trigger testing on its own", () => {
  const triggers = routeSpecialists({ files: [] }, { coverageDelta: 0.1 });
  assert.deepEqual(triggers, []);
});

test("testing: a new src path with no matching test path triggers testing", () => {
  const diff = diffOf("src/lib/new-thing.ts");
  const triggers = routeSpecialists(diff);
  assert.ok(triggers.some((t) => t.specialist === "testing"));
});

test("testing: a src path WITH a matching co-located test path does NOT trigger testing", () => {
  const diff = diffOf("src/lib/new-thing.ts", "test/new-thing.test.ts");
  const triggers = routeSpecialists(diff);
  assert.ok(!triggers.some((t) => t.specialist === "testing"));
});

// ── design specialist ───────────────────────────────────────────────────────

test("design: a diff touching both src/ and hooks/ crosses layer boundaries", () => {
  const diff = diffOf("src/lib/worker.ts", "hooks/deny-floor.sh");
  const triggers = routeSpecialists(diff);
  assert.ok(triggers.some((t) => t.specialist === "design"));
});

test("design: a diff confined to one layer does NOT cross layer boundaries", () => {
  const diff = diffOf("src/lib/worker.ts", "src/lib/mounts.ts");
  const triggers = routeSpecialists(diff);
  assert.ok(!triggers.some((t) => t.specialist === "design"));
});

test("design: a diff adding a new exported interface triggers design", () => {
  const diff = diffOf({ path: "src/lib/thing.ts", content: "export interface Thing { id: string; }" });
  const triggers = routeSpecialists(diff);
  assert.ok(triggers.some((t) => t.specialist === "design"));
});

// ── determinism ──────────────────────────────────────────────────────────

test("routeSpecialists: the SAME diff + metadata routed twice returns identical triggers (deterministic, no clock/random)", () => {
  const diff = diffOf("src/lib/worker.ts", "package.json");
  const metadata: SpecialistTaskMetadata = { tddStrict: true };
  assert.deepEqual(routeSpecialists(diff, metadata), routeSpecialists(diff, metadata));
});
