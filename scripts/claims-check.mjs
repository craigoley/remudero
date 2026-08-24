#!/usr/bin/env node
// scripts/claims-check.mjs
//
// PLAN-CLAIMS gate (W1-T29, MASTER-PLAN §12A).
//
// Plan prose is unverifiable; a FALSIFIABLE claim with a command that must exit 0 is not. This
// script reads plan/claims.yaml (a list of {id, claim, plan_section, assertion}), runs every
// `assertion` as a shell command, and fails the whole gate the moment ANY assertion exits
// non-zero -- printing the failing claim's id, prose, plan_section, and captured output so the
// CI log NAMES the false claim directly, rather than leaving a bare exit code for someone to
// chase down. A red claim means THE PLAN IS LYING ABOUT THE SYSTEM.
//
// THREE STATES, NOT TWO (W1-T2215). `ok: result.status === 0` used to collapse every non-zero
// exit into "the claim is false" -- but an assertion whose inputs are simply MISSING (a deleted
// file, an unresolvable test loader) never got to say anything true or false; it could not run at
// all. Worse, thirteen of fourteen assertions here are third-party binaries (`grep`, `test`,
// `node --test`) whose exit codes this repo does not own and cannot repurpose into a "could not
// run" convention -- `grep` already spends exit 2 on "error", `node --test` spends 1 on
// everything. So the third state is decided BEFORE the assertion ever runs, by an optional,
// declared `precondition_paths` list on the claim record: paths (relative to `cwd`) the assertion
// needs to exist. A missing precondition path yields `state: "could-not-run"` -- captured via a
// plain `fs.existsSync` check, never by inspecting an exit code -- and the assertion is never even
// spawned, so it is exactly as inert for a binary this repo does not own as for a script it does.
// This also closes a FAIL-OPEN hazard: a negated assertion like `! grep -q needle missing-file`
// exits 0 (a false PASS, no diagnostic at all) when its target is simply absent, because `!`
// negates whatever exit code the missing-file case happens to produce. Declaring that file as a
// precondition converts the silent pass into an honest could-not-run.
//
// Usage:
//   node scripts/claims-check.mjs [--file plan/claims.yaml] [--cwd <repo-root>]
//
// The pure/testable pieces (loadClaims, runClaim, formatFailure, formatCouldNotRun) are exported
// so the falsifier fixture test can exercise both the parsing and the pass/fail/could-not-run
// reporting without touching the real plan/claims.yaml, plus drive the CLI directly (spawn + exit
// code) for the end-to-end proof.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

const REQUIRED_FIELDS = ["id", "claim", "plan_section", "assertion"];

/**
 * Parse a claims YAML file into a validated list of claim records. Accepts either a bare list
 * (the format plan/claims.yaml uses, matching plan/learnings.yaml's style) or `{ claims: [...] }`.
 * Throws on a structurally invalid file (missing/blank required field) -- a claims file that
 * cannot even be parsed is itself a lie the gate must not silently pass.
 */
export function loadClaims(path) {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  const claims = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.claims) ? doc.claims : null);
  if (!Array.isArray(claims)) {
    throw new Error(`claims-check: ${path} must be a YAML list of claims (or a { claims: [...] } document)`);
  }
  for (const c of claims) {
    for (const field of REQUIRED_FIELDS) {
      if (typeof c?.[field] !== "string" || c[field].trim() === "") {
        throw new Error(
          `claims-check: ${path} has a claim missing required string field "${field}": ${JSON.stringify(c)}`,
        );
      }
    }
    if (c.precondition_paths !== undefined) {
      const isValid =
        Array.isArray(c.precondition_paths) &&
        c.precondition_paths.length > 0 &&
        c.precondition_paths.every((p) => typeof p === "string" && p.trim() !== "");
      if (!isValid) {
        throw new Error(
          `claims-check: ${path} has claim "${c.id}" with an invalid "precondition_paths" -- ` +
            `it must be a non-empty array of non-empty strings when present: ${JSON.stringify(c)}`,
        );
      }
    }
  }
  return claims;
}

/**
 * The declared `precondition_paths` (design W1-T2215-ii) that do NOT exist relative to `cwd`, in
 * declaration order. A plain `fs.existsSync` check -- no shell, no subprocess, no exit code -- so
 * the third state this decides is independent of the assertion's own exit code by construction:
 * it is computed before the assertion is ever spawned. Returns `[]` when the claim declares no
 * precondition at all (every claim is missing-precondition-free by default -- this is opt-in).
 */
export function missingPreconditionPaths(claimRecord, cwd) {
  const paths = claimRecord.precondition_paths ?? [];
  return paths.filter((p) => !existsSync(resolvePath(cwd, p)));
}

/**
 * Run one claim's assertion as a shell command from `cwd` (repo root by default). The assertion
 * is executed via `sh -c` (not parsed as argv) so it can use pipes/negation/redirection, same as
 * a human would run it at a terminal to check the claim by hand.
 *
 * THIRD STATE (W1-T2215): when the claim declares `precondition_paths` and one of them is
 * missing, the assertion is NEVER SPAWNED -- `state` is `"could-not-run"` and `status`/`stdout`/
 * `stderr` all read as untouched (no command ran, so there is nothing to report from one). This
 * is what makes the decision exit-code-blind: it is made from `missingPreconditionPaths` alone,
 * before `spawnSync` is ever reached, so it works identically whether the assertion underneath is
 * a script this repo owns or a third-party binary (`grep`, `test`, `node --test`) whose exit
 * codes it does not. Otherwise `state` is `"pass"` or `"fail"` from the assertion's own exit code,
 * exactly as before -- a genuinely false claim is reported false exactly as it was previously.
 */
export function runClaim(claimRecord, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const base = {
    id: claimRecord.id,
    claim: claimRecord.claim,
    plan_section: claimRecord.plan_section,
    assertion: claimRecord.assertion,
  };

  const missing = missingPreconditionPaths(claimRecord, cwd);
  if (missing.length > 0) {
    return { ...base, state: "could-not-run", ok: false, status: null, missing, stdout: "", stderr: "" };
  }

  const result = spawnSync(claimRecord.assertion, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ...base,
    state: result.status === 0 ? "pass" : "fail",
    ok: result.status === 0,
    status: result.status,
    missing: [],
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Render one FALSE claim's result as the human-readable block printed to stderr -- unchanged
 *  from before W1-T2215: a genuinely false claim is reported exactly as it always was. */
export function formatFailure(r) {
  const lines = [
    `  [${r.id}] ${r.claim}`,
    `  plan_section: ${r.plan_section}`,
    `  assertion:    ${r.assertion}`,
    `  exit code:    ${r.status}`,
  ];
  if (r.stdout.trim()) lines.push(`  stdout: ${r.stdout.trim()}`);
  if (r.stderr.trim()) lines.push(`  stderr: ${r.stderr.trim()}`);
  return lines.join("\n");
}

/** Render one COULD-NOT-RUN claim's result. Design (iv): rendering is half the defect -- the
 *  CAUSE (what precondition input is missing) must print FIRST, before the claim's own prose and
 *  `plan_section`, which are what a "THE PLAN IS LYING" reading would misleadingly foreground. */
export function formatCouldNotRun(r) {
  const lines = [
    `  COULD NOT RUN -- missing precondition input(s): ${r.missing.join(", ")}`,
    `  [${r.id}] ${r.claim}`,
    `  plan_section: ${r.plan_section}`,
    `  assertion:    ${r.assertion}`,
  ];
  return lines.join("\n");
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string", default: "plan/claims.yaml" },
      cwd: { type: "string" },
    },
  });

  let claims;
  try {
    claims = loadClaims(values.file);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (claims.length === 0) {
    console.error(`claims-check: ${values.file} has ZERO claims -- an empty gate proves nothing.`);
    process.exitCode = 1;
    return;
  }

  const results = claims.map((c) => runClaim(c, { cwd: values.cwd }));
  const STATE_LABEL = { pass: "PASS", fail: "FAIL", "could-not-run": "COULD-NOT-RUN" };
  for (const r of results) {
    console.log(`${STATE_LABEL[r.state]}  ${r.id} -- ${r.claim}`);
  }

  const couldNotRun = results.filter((r) => r.state === "could-not-run");
  const failed = results.filter((r) => r.state === "fail");

  // Design (vi), W1-T2215: the gate STAYS REQUIRED and a could-not-run claim STILL turns the
  // whole run red -- the fix corrects what a red run is NAMED, never how many reds there are. A
  // could-not-run claim neither confirms nor refutes the plan, so it gets its own banner instead
  // of "THE PLAN IS LYING", printed first: unable-to-check is reported before known-false.
  if (couldNotRun.length > 0) {
    console.error(
      "\nclaims-check: SOME CLAIM(S) COULD NOT BE CHECKED -- their inputs are missing, so they " +
        "neither confirm nor refute the plan (this is NOT a claim that the plan is lying):\n",
    );
    console.error(couldNotRun.map(formatCouldNotRun).join("\n\n"));
  }

  if (failed.length > 0) {
    console.error("\nclaims-check: THE PLAN IS LYING ABOUT THE SYSTEM -- the following claim(s) are FALSE:\n");
    console.error(failed.map(formatFailure).join("\n\n"));
  }

  if (couldNotRun.length > 0 || failed.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nclaims-check: OK -- all ${results.length} claim(s) hold.`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/claims-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
