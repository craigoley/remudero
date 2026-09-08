#!/usr/bin/env node
/**
 * WILL THE REVIEWER REFUSE THIS DIFF UNDER STANDING RULE 15? Ask before pushing, not after CI.
 *
 * Rule 15 makes criteria text Architect-only: a diff that ADDS or EDITS a `claim:`/`proof:`/
 * `satisfied_by:` field in `plan/tasks.yaml` or a `plan/tasks.d/*.yaml` shard is refused UNLESS the
 * PR is plan-only. A worker filing a shard beside its own implementation trips it every time.
 *
 * MEASURED 2026-09-07: three PRs (#4404, #4406, #4413) each carried a NEW shard alongside src/ and
 * test/ files. Each was refused by `remudero-review` after a full CI cycle, each was repaired the
 * same mechanical way — lift the shard into its own plan-only PR, drop it from the implementation —
 * and the gate had NAMED that remedy in its own refusal every time. Nothing executed it, and
 * nothing asked the question at the one moment it is free to ask: before the push.
 *
 * ONE PREDICATE, NEVER TWO. This imports the reviewer's OWN `criterionFieldTampered` and
 * `planOnlyDiff` rather than re-deriving either. A local check that disagreed with the gate would
 * be worse than no check: it would send an author to split a PR the reviewer would have passed, or
 * clear one it is about to refuse.
 *
 * REPORTS, NEVER REWRITES. It prints the split and exits non-zero; it moves no file. Which shard
 * belongs in which PR is the author's call, and a script that guessed would be editing the plan.
 */
import { criterionFieldTampered, planOnlyDiff } from "../src/lib/review.js";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "origin/main";

function diffAgainstBase(base) {
  // Three-dot: the merge base, so a moving base never makes this read another branch's work as
  // this diff's. Same boundary every other gate here measures against.
  return gitOrThrow(["diff", `${base}...HEAD`]);
}

function changedFiles(base) {
  return gitOrThrow(["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
}

export function judgeRule15(diff, files) {
  const tampered = criterionFieldTampered(diff);
  if (!tampered) return { ok: true, reason: "no criterion field added or edited in the plan" };
  if (planOnlyDiff(diff)) return { ok: true, reason: "criteria changed, but the diff is plan-only — the exemption applies" };
  const planPaths = files.filter((f) => f.startsWith("plan/"));
  const otherPaths = files.filter((f) => !f.startsWith("plan/"));
  return { ok: false, planPaths, otherPaths };
}

function main() {
  let diff;
  let files;
  try {
    diff = diffAgainstBase(BASE);
    files = changedFiles(BASE);
  } catch (e) {
    // An unreadable diff is NOT a pass. Saying "clean" here would be the vacuous-pass shape this
    // repo already names: a check that could not look reporting that it found nothing.
    console.error(`rule15-precheck: could not read the diff against ${BASE} (${e.message}) — REFUSING to report clean`);
    return 2;
  }
  const verdict = judgeRule15(diff, files);
  if (verdict.ok) {
    console.log(`rule15-precheck: OK -- ${verdict.reason}`);
    return 0;
  }
  console.error(
    "rule15-precheck: THIS DIFF WILL BE REFUSED under Standing rule 15 -- it adds or edits criteria " +
      "in the plan while also touching non-plan files, and remudero-review refuses that combination.",
  );
  console.error(`  plan paths  (belong in their own plan-only PR): ${verdict.planPaths.join(", ")}`);
  console.error(`  other paths (stay in this one):                 ${verdict.otherPaths.join(", ")}`);
  console.error(
    "  TO FIX, the remedy the gate itself names: open a plan-only PR carrying the shard alone, then " +
      "drop the shard from this branch. Both then pass. Doing it now costs one command; doing it " +
      "after the push costs a full CI cycle and a red board.",
  );
  return 1;
}

if (isMainModule(import.meta.url)) process.exit(main());
