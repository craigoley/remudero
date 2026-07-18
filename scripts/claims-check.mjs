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
// Usage:
//   node scripts/claims-check.mjs [--file plan/claims.yaml] [--cwd <repo-root>]
//
// The pure/testable pieces (loadClaims, runClaim, formatFailure) are exported so the falsifier
// fixture test can exercise both the parsing and the pass/fail reporting without touching the
// real plan/claims.yaml, plus drive the CLI directly (spawn + exit code) for the end-to-end proof.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
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
  }
  return claims;
}

/**
 * Run one claim's assertion as a shell command from `cwd` (repo root by default). The assertion
 * is executed via `sh -c` (not parsed as argv) so it can use pipes/negation/redirection, same as
 * a human would run it at a terminal to check the claim by hand.
 */
export function runClaim(claimRecord, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const result = spawnSync(claimRecord.assertion, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    id: claimRecord.id,
    claim: claimRecord.claim,
    plan_section: claimRecord.plan_section,
    assertion: claimRecord.assertion,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Render one failed claim's result as the human-readable block printed to stderr. */
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
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id} -- ${r.claim}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error("\nclaims-check: THE PLAN IS LYING ABOUT THE SYSTEM -- the following claim(s) are FALSE:\n");
    console.error(failed.map(formatFailure).join("\n\n"));
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
