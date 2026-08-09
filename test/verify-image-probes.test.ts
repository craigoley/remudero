/**
 * `deploy/verify-image.sh` HAS NOW BEEN CORRECTED SIX TIMES, AND NEVER ONCE HAD A TEST.
 *
 * The prior five were all the same shape: a check that reported a verdict it had not earned. The
 * browser check tested where the installer WROTE rather than where a stripped worker READS; the
 * cache check tested the top directory, which is node-owned on a broken image; the entrypoint
 * currency check passed on the broken entrypoint; a `git config --get` guard read local config; and
 * the sixth — the one this suite is written for — was an APOSTROPHE.
 *
 * THE SIXTH DEFECT, because it is the one that shows why reading cannot be the control. Every probe
 * in that file is ONE single-quoted `-c` argument, so the first `'` inside it ends the argument. The
 * word `version's`, in a COMMENT, truncated the main probe from 194 source lines to 76, handed
 * docker two stray positional arguments, and left every line after the apostrophe executing ON THE
 * HOST instead of in the image. MEASURED against the published image: `playwright pin` and
 * `bootstrap entrypoint` reported FAIL because the HOST has no `/opt/pw-pin` and no
 * `/usr/local/bin/rmd-entrypoint`, `runtime user` reported PASS naming the host operator's own
 * account, and a backtick pair from that comment was EXECUTED by the host shell. Four whole
 * sections never ran at all, silently, because the host reached a stray `exit $fail` first.
 *
 * `bash -n` WAS CLEAN THROUGHOUT. The stray quotes re-balanced, so the file was never syntactically
 * broken — only addressed to the wrong machine. That is precisely why the linter this repo already
 * runs could not have caught it, and why a test that watches WHAT REACHES DOCKER is the control.
 *
 * WHAT THIS SUITE ASSERTS, AND WHY EACH IS NOT VACUOUS.
 *   1. DELIVERY — every probe arrives whole, ending in its own terminator, with NOTHING after it in
 *      argv. Stray trailing arguments are the fingerprint of a leaked quote, and truncation is the
 *      damage; both are checked because a leak can produce either.
 *   2. THE MUTANT IS CAUGHT — assertion 1 is re-run against a copy of the real file with an
 *      apostrophe injected into a probe comment, and must FAIL. Without this, assertion 1 could be
 *      passing for reasons unrelated to the property it names. This is the anti-vacuity guard, and
 *      given this file's history it is the single most important test here.
 *   3. VERDICTS — a correct subject exits 0 and each broken subject exits non-zero, one variant per
 *      defect the script claims to detect.
 *
 * NO DOCKER DAEMON IS REQUIRED. `az` and `docker` are stubbed on PATH: the stub records argv and
 * replays canned probe output, so the script under test runs its REAL control flow — its real
 * argument construction, its real sentinel greps, its real exit-code arithmetic — against a subject
 * this suite controls. What is NOT covered, and is not claimed: whether the probe scripts ask the
 * right questions of a real image. That needs an image and is the operator check.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The subject. Overridable ONLY so a deliberately-broken copy can be driven through the identical
 * harness — see the mutant test. Unset, it is the real file, which is what CI measures.
 */
const SCRIPT = process.env.VERIFY_IMAGE_SCRIPT ?? join(REPO_ROOT, "deploy", "verify-image.sh");

/**
 * Each probe the script is expected to send, keyed by a substring the stub identifies it with, and
 * the LAST line its payload must carry.
 *
 * THE TERMINATOR IS THE LOAD-BEARING HALF. A leaked quote can truncate a payload without producing
 * stray argv words — if the next `'` falls on a later line, the shell swallows lines into the
 * argument instead of ending the command — so "nothing follows it in argv" alone would not catch
 * every shape. Pinning the final line catches truncation directly.
 */
const EXPECTED_PROBES: ReadonlyArray<{ key: string; identifiedBy: string; endsWith: string }> = [
  { key: "checks", identifiedBy: 'check "claude"', endsWith: "exit $fail" },
  { key: "entrypoint", identifiedBy: "echo entrypoint-reached", endsWith: "echo entrypoint-reached" },
  { key: "identity", identifiedBy: "identity probe", endsWith: "COMMITTED-AS %an <%ae>" },
  { key: "bootstrap", identifiedBy: "COLLIDE-", endsWith: "UNPINNED got=" },
  { key: "binaries", identifiedBy: "ALL_RUNNABLE", endsWith: "echo ALL_RUNNABLE" },
];

/**
 * `az` and `docker`, as the script resolves them: by bare name, off PATH.
 *
 * WRITTEN IN BASH, NOT NODE, deliberately — an extensionless stub named `docker` would have its
 * module system inferred from a package.json that is not there, and this suite must not depend on
 * that inference. argv is recorded NUL-separated because an argument here legitimately contains
 * newlines, quotes and `%` formats, and every other separator is inside the data.
 */
function writeStubs(dir: string): void {
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const docker = [
    "#!/usr/bin/env bash",
    'n=$(( $(cat "$STUB_REC/seq" 2>/dev/null || echo 0) + 1 ))',
    'printf %s "$n" > "$STUB_REC/seq"',
    ': > "$STUB_REC/argv.$n"',
    'for a in "$@"; do printf %s\'\\0\' "$a" >> "$STUB_REC/argv.$n"; done',
    'case "$1" in',
    // The first inspect predates the pull, so it must report NO local copy — otherwise the script
    // takes its "digest did not change" branch and this suite would be exercising a re-run.
    '  image) [ -e "$STUB_REC/pulled" ] && printf %s\\\\n "$STUB_DIGEST"; exit 0 ;;',
    '  pull)  : > "$STUB_REC/pulled"; exit 0 ;;',
    "  run)   ;;",
    "  *)     exit 0 ;;",
    "esac",
    'payload=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "-c" ]; then payload="$a"; break; fi; prev="$a"; done',
    "probe=unknown",
    'case "$payload" in',
    // Ordered most-specific first: the main probe also mentions rmd-entrypoint, and the bootstrap
    // probe also mentions git, so a looser matcher would misroute them.
    "  *'check \"claude\"'*) probe=checks ;;",
    '  "echo entrypoint-reached") probe=entrypoint ;;',
    '  *"identity probe"*) probe=identity ;;',
    '  *"COLLIDE-"*) probe=bootstrap ;;',
    "  *ALL_RUNNABLE*) probe=binaries ;;",
    "esac",
    'printf %s\\\\n "$probe" >> "$STUB_REC/probes"',
    'case "$probe" in',
    '  checks)     [ "$STUB_MODE" = checks-fail ] && { echo "  FAIL  claude (not found)"; exit 1; }',
    '              echo "  PASS  claude 1.2.3"; exit 0 ;;',
    '  entrypoint) [ "$STUB_MODE" = entrypoint-silent ] && { echo "tini: exec failed"; exit 0; }',
    "              echo entrypoint-reached; exit 0 ;;",
    '  identity)   [ "$STUB_MODE" = identity-missing ] && { echo "Author identity unknown"; exit 128; }',
    '              echo "COMMITTED-AS Remudero Agent <agent@example.invalid>"; exit 0 ;;',
    '  bootstrap)  case "$STUB_MODE" in',
    '                boot-stale)           echo "STALE head=aaa tip=bbb"; echo "COLLIDE-ADVANCED bbb"; echo "PINNED ccc" ;;',
    '                collide-silent-stale) echo "CURRENT aaa"; echo "COLLIDE-SILENT-STALE head=aaa tip=bbb"; echo "PINNED ccc" ;;',
    '                unpinned)             echo "CURRENT aaa"; echo "COLLIDE-ADVANCED bbb"; echo "UNPINNED got=x want=y" ;;',
    '                boot-crash)           echo "git: not found"; exit 3 ;;',
    '                *)                    echo "CURRENT aaa"; echo "COLLIDE-ADVANCED bbb"; echo "PINNED ccc" ;;',
    "              esac; exit 0 ;;",
    '  binaries)   [ "$STUB_MODE" = binaries-missing ] && { echo "MISS ps"; exit 1; }',
    "              echo ALL_RUNNABLE; exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  // mkdtemp honours the umask, so the mode above is a request. Make it a fact.
  chmodSync(join(dir, "az"), 0o755);
  chmodSync(join(dir, "docker"), 0o755);
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  /** argv of every stubbed `docker` invocation, in order. */
  argvs: string[][];
  /** The probe key the stub matched, per `docker run`. */
  probes: string[];
}

function runVerifier(mode: string, scriptPath = SCRIPT): Run {
  const dir = mkdtempSync(join(tmpdir(), "verify-image-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "verify-image-rec-"));
  writeStubs(dir);
  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: mode,
      STUB_DIGEST: "reg.azurecr.io/remudero@sha256:feed",
    },
  });
  const argvs = readdirSync(rec)
    .filter((f) => f.startsWith("argv."))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((f) => readFileSync(join(rec, f), "utf8").split("\0").slice(0, -1));
  let probes: string[] = [];
  try {
    probes = readFileSync(join(rec, "probes"), "utf8").split("\n").filter(Boolean);
  } catch {
    probes = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", argvs, probes };
}

/**
 * Every way a probe can fail to ARRIVE, as human-readable defects. Empty means every probe reached
 * docker exactly as written.
 */
function deliveryDefects(run: Run): string[] {
  const defects: string[] = [];
  const runs = run.argvs.filter((a) => a[0] === "run");
  for (const [i, argv] of runs.entries()) {
    const c = argv.indexOf("-c");
    if (c === -1) {
      defects.push(`run #${i + 1}: no -c argument at all`);
      continue;
    }
    const payload = argv[c + 1];
    if (payload === undefined) {
      defects.push(`run #${i + 1}: -c is the last argument, so no script was passed`);
      continue;
    }
    // NOTHING MAY FOLLOW THE PAYLOAD. Stray words here are the direct signature of a quote that
    // closed early: the remainder of the line becomes separate arguments, which `sh -c` silently
    // accepts as $0, $1 ... and never reports.
    if (c + 1 !== argv.length - 1) {
      defects.push(`run #${i + 1}: ${argv.length - c - 2} stray argument(s) after the script: ${JSON.stringify(argv.slice(c + 2))}`);
    }
    const expected = EXPECTED_PROBES.find((p) => payload.includes(p.identifiedBy));
    if (!expected) {
      defects.push(`run #${i + 1}: payload matches no known probe (first line: ${JSON.stringify(payload.split("\n")[0])})`);
      continue;
    }
    const lastLine = payload.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "";
    if (!lastLine.includes(expected.endsWith)) {
      defects.push(
        `probe "${expected.key}" is TRUNCATED: last line is ${JSON.stringify(lastLine)}, expected it to carry ${JSON.stringify(expected.endsWith)}`,
      );
    }
  }
  return defects;
}

test("every probe reaches docker whole, with nothing trailing it in argv", () => {
  const run = runVerifier("good");
  assert.deepEqual(
    deliveryDefects(run),
    [],
    "a probe was truncated or leaked stray arguments — an apostrophe inside a single-quoted -c payload is the cause this has had before",
  );
});

test("the verifier sends all five of its probes, so none can silently stop running", () => {
  // THE SIXTH DEFECT MADE FOUR SECTIONS VANISH WITHOUT SAYING SO. The host reached a stray
  // `exit $fail` and the script ended after ONE container, still printing plausible-looking
  // results. Counting the probes is what makes that visible.
  const run = runVerifier("good");
  assert.deepEqual(
    run.probes,
    EXPECTED_PROBES.map((p) => p.key),
    "the probes actually sent, in order, must be exactly the ones this file claims to run",
  );
});

test("MUTANT: one apostrophe in a probe comment breaks delivery, and the delivery check catches it", () => {
  // THE ANTI-VACUITY GUARD, and the reason this suite exists rather than a sixth manual correction.
  // The two tests above assert a property; this one proves they can FAIL, by reproducing the exact
  // defect that shipped — a single apostrophe, inside a comment, in the middle of a probe.
  const real = readFileSync(SCRIPT, "utf8");
  const anchor = '  check "claude"';
  const at = real.indexOf(anchor);
  assert.notEqual(at, -1, "anchor line must exist, or this mutant is injecting into nothing");
  const eol = real.indexOf("\n", at);
  const mutant =
    real.slice(0, eol + 1) + "  # a comment naming the image's own layout, exactly as before\n" + real.slice(eol + 1);
  assert.notEqual(mutant, real, "the mutation must actually change the file");

  const dir = mkdtempSync(join(tmpdir(), "verify-image-mutant-"));
  const path = join(dir, "verify-image.sh");
  writeFileSync(path, mutant, { mode: 0o755 });

  // The mutant is still SYNTACTICALLY VALID — asserted, not assumed, because it is the whole point:
  // the linter this repo already runs cannot see this class of defect.
  const lint = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  assert.equal(lint.status, 0, `bash -n must stay clean on the mutant, else the linter would already catch it: ${lint.stderr}`);

  const defects = deliveryDefects(runVerifier("good", path));
  assert.ok(defects.length > 0, "the delivery check must FAIL on the mutant — if it passes, it is measuring nothing");
  assert.ok(
    defects.some((d) => d.includes("TRUNCATED") || d.includes("stray argument")),
    `the defect must be named as truncation or stray argv, got: ${JSON.stringify(defects)}`,
  );
});

test("a correct subject exits 0", () => {
  const run = runVerifier("good");
  assert.equal(run.status, 0, `expected a clean verdict, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /verify-image: OK — every check passed/);
});

/**
 * One deliberately-broken subject per defect the script claims to catch. Each flips exactly ONE
 * probe result and leaves the rest correct, so a non-zero exit is attributable to that defect and
 * not to collateral.
 */
const BROKEN: ReadonlyArray<{ mode: string; why: string; says: RegExp }> = [
  { mode: "checks-fail", why: "a toolchain binary is missing inside the image", says: /FAILURES above/ },
  { mode: "entrypoint-silent", why: "the entrypoint runs but never execs the command", says: /entrypoint ran but the command did not execute/ },
  { mode: "identity-missing", why: "no git identity, so every worker commits nothing", says: /a commit could NOT be made as uid 1000/ },
  { mode: "boot-stale", why: "a second boot does not land on the moved remote tip", says: /did NOT land on the remote tip/ },
  { mode: "collide-silent-stale", why: "an untracked-file collision leaves the tree stale but reports success", says: /stayed on the old sha and reported success/ },
  { mode: "unpinned", why: "a sha ref stops pinning exactly", says: /sha ref did NOT pin exactly/ },
  { mode: "boot-crash", why: "the bootstrap probe itself dies", says: /bootstrap-currency probe did not complete/ },
  { mode: "binaries-missing", why: "a process-inspection binary is absent for the runtime user", says: /process-inspection binary is missing or unrunnable/ },
];

for (const { mode, why, says } of BROKEN) {
  test(`a broken subject exits non-zero: ${why}`, () => {
    const run = runVerifier(mode);
    assert.notEqual(run.status, 0, `a verifier that certifies a broken image is worse than none (mode ${mode})`);
    assert.match(
      run.stdout + run.stderr,
      says,
      `the failure must NAME the defect rather than exiting quietly (mode ${mode})`,
    );
  });
}
