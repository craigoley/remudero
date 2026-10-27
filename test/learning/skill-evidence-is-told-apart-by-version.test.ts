import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSkillEffectivenessReport,
  observeSkillSelection,
  renderSkillEffectivenessReport,
  skillContentDigest,
  skillLifecycleEvidenceFingerprint,
  skillLifecycleProposalForReport,
  type InjectableSkill,
} from "#src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// A skill's effectiveness evidence pooled every run under its NAME, so an edited skill was judged on runs
// that read its old text. A version is now the skill's body, hashed (as a published skill is versioned by
// the last change to its own files), recorded per eligible skill on every selection row and broken out by
// the report. The comparison itself is unchanged: this records what a version-scoped judgment will need.

type Row = Record<string, unknown>;

const SKILL = "fixture-skill";

/** One randomized run: `digest` undefined writes a legacy row with no recorded version. */
const run = (runId: string, selected: boolean, verdict: string | undefined, digest?: string): Row[] => [
  {
    run_id: runId, step: "skills.selection", task_type: "implement", approved_eligible_names: [SKILL],
    selected_names: selected ? [SKILL] : [], budget_omitted_names: [], withheld_names: selected ? [] : [SKILL],
    ...(digest === undefined ? {} : { skill_digests: { [SKILL]: digest, "other-skill": "ffffffffffff" } }),
  },
  ...(verdict === undefined ? [] : [{ run_id: runId, step: "verdict", verdict }]),
];

const runs = (prefix: string, selected: boolean, verdicts: readonly string[], digest?: string): Row[] =>
  verdicts.flatMap((verdict, i) => run(`${prefix}-${i}`, selected, verdict, digest));

test("a skill selection records each eligible skill's version, and only a body edit is a new version", () => {
  const skill: InjectableSkill = { name: SKILL, appliesTo: ["implement"], body: "Do the thing." };
  const edited: InjectableSkill = { ...skill, body: "Do the thing, then prove it." };
  const rescoped: InjectableSkill = { ...skill, appliesTo: ["implement", "fix"], whenPaths: ["src/**"] };
  const other: InjectableSkill = { name: "path-scoped", appliesTo: ["implement"], whenPaths: ["docs/**"], body: "x" };

  const observed = observeSkillSelection([skill, other], "implement", 10_000, ["src/a.ts"]);
  // sha256("Do the thing."), first 12 hex digits, computed independently.
  assert.deepEqual(observed.observation.skill_digests, { [SKILL]: "5f398191f09f" }, "a path-filtered skill is not eligible");
  assert.notEqual(skillContentDigest(edited), skillContentDigest(skill));
  assert.equal(skillContentDigest(rescoped), skillContentDigest(skill), "eligibility scope is not the text a worker reads");
});

test("the effectiveness report counts terminal runs per skill version, with legacy rows apart", () => {
  const rows = [
    ...runs("legacy-selected", true, ["merged", "no_diff"]),
    ...runs("legacy-control", false, ["no_diff"]),
    ...runs("v1-selected", true, ["merged", "merged", "failed"], "aaaaaaaaaaaa"),
    ...runs("v1-control", false, ["no_diff", "merged"], "aaaaaaaaaaaa"),
    ...runs("v2-selected", true, ["merged"], "bbbbbbbbbbbb"),
    ...run("v2-pending", true, undefined, "bbbbbbbbbbbb"),
  ];
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.deepEqual(report.versions, [
    { digest: null, selected_terminal_runs: 2, control_terminal_runs: 1 },
    { digest: "aaaaaaaaaaaa", selected_terminal_runs: 3, control_terminal_runs: 2 },
    { digest: "bbbbbbbbbbbb", selected_terminal_runs: 1, control_terminal_runs: 0 },
  ], "a run with no terminal verdict is not counted");
  const total = report.versions.reduce((n, v) => n + v.selected_terminal_runs + v.control_terminal_runs, 0);
  assert.equal(total, report.selected.terminal_runs + report.control.terminal_runs, "versions partition the compared runs");
  assert.deepEqual(buildSkillEffectivenessReport([], SKILL).versions, []);
});

test("the report and a retirement proposal warn when the comparison pools recorded versions", () => {
  const pooled = buildSkillEffectivenessReport([
    ...runs("v1", false, Array<string>(10).fill("no_diff"), "aaaaaaaaaaaa"),
    ...runs("v2", false, ["no_diff"], "bbbbbbbbbbbb"),
  ], SKILL);
  assert.equal(pooled.status, "RETIRE-CANDIDATE", "zero selection at the horizon");
  const line = "aaaaaaaaaaaa selected=0 control=10; bbbbbbbbbbbb selected=0 control=1 — the comparison pools 2 recorded versions";
  assert.ok(renderSkillEffectivenessReport(pooled).includes(`skill versions: ${line}`));

  const single = buildSkillEffectivenessReport(runs("v1", false, Array<string>(10).fill("no_diff"), "aaaaaaaaaaaa"), SKILL);
  assert.ok(renderSkillEffectivenessReport(single).endsWith("\nskill versions: aaaaaaaaaaaa selected=0 control=10"),
    "one recorded version carries no pooling warning");
  assert.ok(renderSkillEffectivenessReport(buildSkillEffectivenessReport([], SKILL)).includes("skill versions: none compared"));

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}skill-versions-`));
  try {
    mkdirSync(join(root, SKILL), { recursive: true });
    writeFileSync(
      join(root, SKILL, "SKILL.md"),
      ["---", `name: ${SKILL}`, "applies-to: implement", "---", "", "## Procedure", "", "- Do the thing."].join("\n"),
      "utf8",
    );
    const built = skillLifecycleProposalForReport(pooled, root);
    assert.ok(built.ok, built.ok ? "" : built.reason);
    assert.ok(built.proposal.summary.includes(`Versions: ${line}`), built.proposal.summary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recording versions does not change a staged retirement's evidence fingerprint", () => {
  const legacy = buildSkillEffectivenessReport(runs("c", false, Array<string>(10).fill("no_diff")), SKILL);
  const versioned = buildSkillEffectivenessReport(runs("c", false, Array<string>(10).fill("no_diff"), "aaaaaaaaaaaa"), SKILL);
  assert.notDeepEqual(legacy.versions, versioned.versions);
  assert.equal(skillLifecycleEvidenceFingerprint(versioned), skillLifecycleEvidenceFingerprint(legacy),
    "deploying this must not refresh every staged retirement");
});
