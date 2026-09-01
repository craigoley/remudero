// W1-T2571: `check()` in deploy/verify-image.sh turned EVERY non-zero exit into
// `FAIL <semantic label>`. The label names what the check MEANS, so a command that never got to
// test anything — because the host disk was full — was reported as the PRODUCT being broken in
// exactly that way.
//
// MEASURED 2026-09-01, host disk at 100%: one run produced THREE confident, specific, WRONG
// diagnoses. The sharpest was "every worker in this image writes files and commits NOTHING" — a
// precise claim about the image's containment and git wiring. The true cause was
// `no space left on device` in every case. The image was fine; the operator's next moves were
// aimed at the product and the disk went unexamined.
//
// ⚠ THE SCRIPT ALREADY STATES THE RULE THAT FORBIDS THIS, TWO SCREENS UP, AND APPLIED IT IN ONLY
// ONE DIRECTION: on an absent version pin it "reports UNKNOWN rather than a verdict", because
// "a read that did not happen must never render as a match". A check that could not RUN is the
// same class in the FAIL direction.
//
// THE THIRD STATE CHANGES THE DIAGNOSIS AND NEVER THE DISPOSITION — an unverifiable run still
// exits non-zero, so an unverifiable image can never be reported as a verified one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "verify-image.sh");

/**
 * The REAL `infra_fault` + `check` text, lifted out of the container probe inside
 * deploy/verify-image.sh and run directly — the same "extract and execute the shipped script text"
 * technique test/ci-gate-reaggregate.test.ts uses on ci-gate.yml's embedded run block. A
 * re-implementation here would be a shadow copy free to drift from the thing that ships.
 */
function embeddedCheckFns(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("  infra_fault() {");
  const endMarker = "  check() {";
  const checkStart = src.indexOf(endMarker, start);
  assert.ok(start > 0 && checkStart > start, "expected infra_fault() and check() inside the checks probe");
  const checkEnd = src.indexOf("\n  }\n", checkStart);
  assert.ok(checkEnd > checkStart, "expected check() to close");
  return src.slice(start, checkEnd + 4);
}

/** Run the extracted functions against one fake command, in a shell, and return what an operator
 *  would see plus the flags the script itself would act on. */
function runCheck(label: string, stubBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verify-check-"));
  const stub = join(dir, "probe");
  writeFileSync(stub, `#!/usr/bin/env bash\n${stubBody}\n`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const script = ["fail=0", "infra=0", embeddedCheckFns(), `check "${label}" "${stub}"`, 'printf "flags fail=%s infra=%s\\n" "$fail" "$infra"'].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

// ── (1) an infrastructure fault is not a product verdict ─────────────────────────────────────

test("a check whose command died of no space left on device is NOT reported as a failure of the thing the label names", () => {
  const { out } = runCheck("commit identity", 'echo "fatal: cannot write: No space left on device" >&2; exit 1');
  assert.match(out, /INFRA\s+commit identity/, "the label must be named as unverifiable, not accused");
  assert.equal(/FAIL\s+commit identity/.test(out), false, "the exact wrong diagnosis this task exists to stop");
  assert.match(out, /could not run:/, "and it must say the check could not run");
  assert.match(out, /flags fail=0 infra=1/, "counted as infrastructure, not as a product failure");
});

test("the other host-fault signatures are recognised too, and all keep the label unaccused", () => {
  for (const sig of ["Read-only file system", "Too many open files", "Cannot allocate memory", "Resource temporarily unavailable"]) {
    const { out } = runCheck("claude", `echo "error: ${sig}" >&2; exit 1`);
    assert.match(out, /INFRA\s+claude/, `${sig} must classify as infrastructure`);
    assert.match(out, /flags fail=0 infra=1/, `${sig} must not set the product-failure flag`);
  }
});

// ── (2) the carve-out must not swallow the failures the script exists to catch ───────────────

test("⚠ an ORDINARY product failure is still FAIL under its own label — the carve-out is narrow by construction", () => {
  const { out } = runCheck("claude", 'echo "claude: command not found" >&2; exit 127');
  assert.match(out, /FAIL\s+claude/, "a genuinely missing binary is exactly what this script is for");
  assert.equal(/INFRA\s+claude/.test(out), false);
  assert.match(out, /flags fail=1 infra=0/);
});

test("a real failure whose text merely MENTIONS disks is still a product failure — only the host signatures count", () => {
  const { out } = runCheck("snapshot", 'echo "the image ships no disk cache directory" >&2; exit 1');
  assert.match(out, /FAIL\s+snapshot/, "prose about disks is not a host fault");
  assert.match(out, /flags fail=1 infra=0/);
});

test("a passing check is untouched by any of this", () => {
  const { out } = runCheck("claude", 'echo "1.2.3"; exit 0');
  assert.match(out, /PASS\s+claude\s+1\.2\.3/);
  assert.match(out, /flags fail=0 infra=0/);
});

// ── (3) the disposition never changes ────────────────────────────────────────────────────────

test("an infrastructure fault still exits NON-ZERO and says UNVERIFIED — diagnosis changes, disposition does not", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // The probe exits 2 for infra-only, which the host side turns into UNVERIFIED + a non-zero RC.
  assert.match(src, /\[ "\$fail" -ne 0 \] \|\| exit 2/, "an infra-only probe must exit non-zero (2), never 0");
  assert.match(src, /if \[ "\$RC" -eq 2 \]; then UNVERIFIED=1; RC=1; fi/, "and the host side must keep RC non-zero");
  assert.match(src, /verify-image: UNVERIFIED on \$\{AFTER\}/, "the summary must say UNVERIFIED rather than FAILURES");
  assert.match(
    src,
    /This is a fault on the HOST running this script, not a finding about the image\./,
    "and must point the operator at the host — the 2026-09-01 run aimed them at the product for hours",
  );
  // The UNVERIFIED branch must sit BEFORE the generic failure branch, or it can never be reached.
  assert.ok(
    src.indexOf('UNVERIFIED on ${AFTER}') < src.indexOf("verify-image: FAILURES above"),
    "the UNVERIFIED branch must precede the generic FAILURES branch",
  );
});

test("the shipped script still parses — this file rewrites embedded shell, where a stray quote is silent", () => {
  const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash -n must be clean: ${r.stderr}`);
});
