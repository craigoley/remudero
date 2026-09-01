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
    // The build-sha defect is its own subject: the image carries BOTH carriers and they disagree,
    // which means one was written and the other was not. That is the only state this probe fails
    // on - an image with neither carrier is OLD, not broken, and must stay a WARN.
    '              [ "$STUB_MODE" = build-sha-mismatch ] && { echo "  FAIL  image build sha  /etc/rmd-build-sha says aaa but the label says bbb"; exit 1; }',
    // The version-VALUE defect is its own subject: the binary is present and runs, and is the
    // WRONG ONE. That is precisely the shape `check "claude" claude --version` certified green.
    '              [ "$STUB_MODE" = claude-version-mismatch ] && { echo "  FAIL  claude version  image has 2.1.227 but deploy/Dockerfile declares 2.1.220"; exit 1; }',
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

  // A PROBE THAT NEVER ARRIVED IS THE LOUDEST DELIVERY DEFECT, AND THIS FUNCTION USED TO BE BLIND
  // TO IT — it iterates the runs that HAPPENED, so zero runs yielded zero defects, which is the
  // vacuous shape this whole suite exists to prevent, one level up. MEASURED, not theorised: with
  // the version-value check added below the anchor, the same injected apostrophe stopped the host
  // BEFORE the first `docker run` instead of truncating it, and every assertion here went silent
  // while reporting a clean delivery. Missing probes are named individually so the report says
  // WHICH sections never ran, the way the sixth defect made four of them vanish.
  for (const p of EXPECTED_PROBES) {
    if (!runs.some((argv) => (argv[argv.indexOf("-c") + 1] ?? "").includes(p.identifiedBy))) {
      defects.push(`probe "${p.key}" NEVER REACHED docker at all`);
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
    defects.some((d) => d.includes("TRUNCATED") || d.includes("stray argument") || d.includes("NEVER REACHED")),
    `the defect must be named as truncation, stray argv, or a probe that never arrived, got: ${JSON.stringify(defects)}`,
  );
});

// ── EVERY SHELLED BINARY IS INVOKED AS uid 1000, AND jq IS ONE OF THEM ───────────────────────
//
// A binary installed in the Dockerfile but never EXECUTED by a probe is the vacuous check this file
// has been corrected for seven times: `apt-get install` succeeding proves the package resolved, not
// that the runtime user can run the thing. The `binaries` probe already invokes ps/pgrep/lsof for
// exactly that reason (#1515). jq joins them here.
//
// WHY jq AT ALL: MEASURED on the published image at `3a5c677`, a full glob gave 16 failures and 14
// were `jq: command not found`, exit 127 — the three `ci-gate-*` suites extract and RUN the real
// bash+jq script out of `.github/workflows/ci-gate.yml`, which uses jq legitimately because it runs
// on ubuntu-latest. The dependency is the workflow's; the gap is the image's.

/**
 * The `binaries` probe's payload AS DELIVERED — read out of the argv the script actually handed
 * `docker run`, not out of the file. This is the form that proves delivery.
 */
function binariesProbeDelivered(): string {
  const run = runVerifier("good").argvs
    .filter((a) => a[0] === "run")
    .map((a) => a[a.indexOf("-c") + 1] ?? "")
    .find((p) => p.includes("ALL_RUNNABLE"));
  assert.ok(run, "the binaries probe must reach docker at all");
  return run;
}

/**
 * The same probe read out of a script's TEXT.
 *
 * Needed for the mutant below, and the reason is worth stating rather than working around silently:
 * the binaries probe is the LAST section of the script, and a copy running from a temp dir exits
 * before it (it has no checkout beside it). So a mutant cannot be observed through delivery — the
 * probe never arrives for reasons that have nothing to do with the mutation, which would make the
 * mutant "pass" while measuring nothing. Reading the text keeps the mutant honest about what it is
 * actually proving: that the assertion depends on the line being there.
 */
function binariesProbeText(text: string): string {
  const start = text.indexOf("fail=0");
  const end = text.indexOf("ALL_RUNNABLE", start);
  assert.ok(start !== -1 && end !== -1, "the binaries probe block must be findable in the text");
  return text.slice(start, end);
}

test("the binaries probe INVOKES jq, rather than testing for its presence", () => {
  const payload = binariesProbeDelivered();
  assert.match(payload, /jq --version/, "jq must be executed, not `command -v`'d");
  assert.match(payload, /MISS jq/, "and a failure must name jq, so the report says which binary");
  // The whole point of this probe is that it runs as the RUNTIME user, not root.
  const argv = runVerifier("good").argvs.find((a) => a.includes("--user"));
  assert.ok(argv?.includes("1000:1000"), "the probe must run as uid 1000, or it proves nothing");
});

test("every binary the probe claims to cover is actually invoked in it — no silent drop", () => {
  const payload = binariesProbeDelivered();
  for (const bin of ["ps", "pgrep", "lsof", "jq"]) {
    assert.ok(payload.includes(`MISS ${bin}`), `the probe must be able to report a missing ${bin}`);
  }
});

test("MUTANT: drop jq's invocation from the probe and the coverage test catches it", () => {
  // The anti-vacuity guard for the two tests above: they assert a property, this proves they FAIL.
  const real = readFileSync(SCRIPT, "utf8");
  const target = '  jq --version >/dev/null 2>&1    || { echo "MISS jq";     fail=1; }\n';
  assert.equal(
    real.split(target).length - 1,
    1,
    "the substitution target must be UNIQUE, or this mutant is not injecting where it claims",
  );
  const mutant = real.replace(target, "");
  assert.notEqual(mutant, real, "the mutation must actually change the file");

  const dir = mkdtempSync(join(tmpdir(), "verify-image-jq-mutant-"));
  const path = join(dir, "verify-image.sh");
  writeFileSync(path, mutant, { mode: 0o755 });

  // Still syntactically valid — asserted, because that is exactly why `bash -n` cannot catch this.
  const lint = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  assert.equal(lint.status, 0, `bash -n must stay clean on the mutant: ${lint.stderr}`);

  const payload = binariesProbeText(readFileSync(path, "utf8"));
  assert.doesNotMatch(payload, /jq --version/, "the mutant really did remove the invocation");
  assert.ok(!payload.includes("MISS jq"), "and with it, the ability to report jq missing");
});

// ── THE DOCKERFILE MUST BOTH INSTALL IT AND VERIFY IT IN-LAYER ───────────────────────────────

test("the Dockerfile installs jq AND runs it in the same layer, so a broken package fails the build", () => {
  // "Verified in-layer for the same reason REQ 7 is: a missing sandbox binary should fail the build
  // here, not a worker later." — deploy/Dockerfile's own words about this RUN.
  const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
  const layer = dockerfile
    .split("\n")
    .join("\n")
    .match(/RUN apt-get update && apt-get install -y --no-install-recommends \\\n(?:.*\\\n)*.*/);
  assert.ok(layer, "the sandbox/process-inspection RUN layer must still be findable");
  const block = dockerfile.slice(dockerfile.indexOf("bubblewrap socat procps lsof"));
  const upToLayerEnd = block.slice(0, block.indexOf("\n#"));
  assert.match(upToLayerEnd, /bubblewrap socat procps lsof jq/, "jq must be in the install list");
  assert.match(upToLayerEnd, /jq --version/, "and INVOKED in the same RUN, not merely installed");
});

// ── THE VERSION-VALUE CHECK, EXECUTED RATHER THAN READ ───────────────────────────────────────
//
// The stub above REPLAYS canned probe output, so the verdict tests prove the script's exit-code
// arithmetic and NOT that the comparison inside the probe is correct — a limit this file's own
// header states. `check "claude" claude --version` passed on EXIT STATUS and never compared the
// VALUE, which is the seventh instance of the vacuous shape this file has been corrected for; a
// test asserting only that a MATCHED version passes would be the eighth. So the real block is
// lifted out and run, in every direction, against a `claude` whose version this test chooses.

/** The version-value block, lifted from the real script between its own sentinels. */
function versionValueBlock(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const begin = src.indexOf("# BEGIN claude-version-value");
  const end = src.indexOf("# END claude-version-value");
  assert.ok(begin >= 0 && end > begin, "the sentinels must exist, or this test is executing nothing");
  const block = src.slice(begin, end);
  assert.ok(block.split("\n").length > 5, "the extracted block must be substantive, not an empty pair of markers");
  return block;
}

/** Run the real block with a `claude` that prints `version`, and a chosen declared pin. */
function runVersionCheck(installed: string, declared: string): { out: string; fail: string } {
  const dir = mkdtempSync(join(tmpdir(), "verify-image-claude-"));
  writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "${installed} (Claude Code)"\n`, { mode: 0o755 });
  chmodSync(join(dir, "claude"), 0o755);
  const r = spawnSync("sh", ["-c", `fail=0\n${versionValueBlock()}\nprintf "FAILVAR=%s" "$fail"`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, EXPECT_CLAUDE_VERSION: declared },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { out, fail: /FAILVAR=(\S*)/.exec(out)?.[1] ?? "?" };
}

test("the version-value check FAILS when the installed binary is not the declared pin", () => {
  // THE DIRECTION THAT MATTERS. A binary that exists, runs, and is the WRONG ONE is exactly what
  // the old exit-status check certified green.
  const r = runVersionCheck("2.1.227", "2.1.220");
  assert.match(r.out, /FAIL\s+claude version/, "a mismatch must be named as a FAIL");
  assert.match(r.out, /2\.1\.227/, "and must name what is installed…");
  assert.match(r.out, /2\.1\.220/, "…and what was declared");
  assert.equal(r.fail, "1", "and it must set the failure flag the script exits on");
});

test("the version-value check PASSES when the installed binary matches the declared pin", () => {
  const r = runVersionCheck("2.1.220", "2.1.220");
  assert.match(r.out, /PASS\s+claude version/);
  assert.equal(r.fail, "0", "a matching image must not be failed");
});

test("an ABSENT declared pin is UNKNOWN — it warns, and must never render as a match", () => {
  // The script is documented to run on a host with no checkout, where the Dockerfile cannot be
  // read. A read that did not happen must not produce a verdict in either direction.
  const r = runVersionCheck("2.1.227", "");
  assert.match(r.out, /WARN\s+claude version/);
  assert.doesNotMatch(r.out, /PASS\s+claude version/, "unknown must not be reported as a match");
  assert.equal(r.fail, "0", "and it must not fail the image either");
});

function codexVersionValueBlock(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const begin = src.indexOf("# BEGIN codex-version-value");
  const end = src.indexOf("# END codex-version-value");
  assert.ok(begin >= 0 && end > begin, "the Codex sentinels must exist");
  return src.slice(begin, end);
}

function runCodexVersionCheck(installed: string, declared: string): { out: string; fail: string } {
  const dir = mkdtempSync(join(tmpdir(), "verify-image-codex-"));
  writeFileSync(join(dir, "codex"), `#!/bin/sh\necho "codex-cli ${installed}"\n`, { mode: 0o755 });
  chmodSync(join(dir, "codex"), 0o755);
  const r = spawnSync("sh", ["-c", `fail=0\n${codexVersionValueBlock()}\nprintf "FAILVAR=%s" "$fail"`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, EXPECT_CODEX_VERSION: declared },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { out, fail: /FAILVAR=(\S*)/.exec(out)?.[1] ?? "?" };
}

test("the Codex version check fails a runnable binary whose value differs from the image pin", () => {
  const r = runCodexVersionCheck("0.153.0", "0.152.0");
  assert.match(r.out, /FAIL\s+codex version/);
  assert.equal(r.fail, "1");
});

test("the Codex version check passes the pinned CLI value", () => {
  const r = runCodexVersionCheck("0.152.0", "0.152.0");
  assert.match(r.out, /PASS\s+codex version/);
  assert.equal(r.fail, "0");
});

test("the Dockerfile installs and executes the declared Codex pin in one layer", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG CODEX_VERSION=0\.152\.0/);
  assert.match(dockerfile, /npm install -g "@openai\/codex@\$\{CODEX_VERSION\}"[\s\S]*?codex --version/);
});

test("the image installs an immutable Codex deny-read boundary for every mounted credential and state path", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8");
  const requirements = readFileSync(join(REPO_ROOT, "deploy", "codex-requirements.toml"), "utf8");
  assert.match(dockerfile, /COPY --chown=root:root deploy\/codex-requirements\.toml \/etc\/codex\/requirements\.toml/);
  assert.match(dockerfile, /chmod 0444 \/etc\/codex\/requirements\.toml/);
  assert.match(requirements, /^\[permissions\.filesystem\]$/m);
  for (const denied of [
    "/home/node/.codex/auth.json",
    "/home/node/.claude",
    "/home/node/.ssh",
    "/home/node/.config/gh",
    "/home/node/.config/remudero",
    "/home/node/Remudero/state",
    "/run/secrets",
  ]) {
    assert.ok(requirements.includes(`  "${denied}",`), `missing deny-read path: ${denied}`);
  }
});

// ── THE IMAGE MUST BE ABLE TO SAY WHICH COMMIT BUILT IT (deploy/Dockerfile REQ 15) ───────────
//
// The published image ran 108 commits behind origin/main and no artifact carried its build
// commit, so dating it required MD5-fingerprinting the baked entrypoint against git history. The
// Dockerfile now bakes the sha twice — a LABEL for host-side readers and /etc/rmd-build-sha for
// readers INSIDE a running container — and the probe compares them.
//
// THE FILE IS THE LOAD-BEARING CARRIER, so these tests drive it through a stubbed `cat`: the
// question is asked from inside a container by something with no docker CLI, and a probe that
// read the LABEL instead would certify a path nobody can use. The mutant at the end is what makes
// that claim falsifiable rather than decorative.

function imageBuildShaBlock(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const begin = src.indexOf("# BEGIN image-build-sha");
  const end = src.indexOf("# END image-build-sha");
  assert.ok(begin >= 0 && end > begin, "the sentinels must exist, or this test is executing nothing");
  const block = src.slice(begin, end);
  assert.ok(block.split("\n").length > 5, "the extracted block must be substantive, not an empty pair of markers");
  return block;
}

/**
 * Run the extracted block with `/etc/rmd-build-sha` faked through a PATH stub for `cat` — the same
 * stub-the-binary discipline the rest of this file uses. `file: null` means the path does not
 * exist, which is EXACTLY the currently published image.
 */
function runBuildShaCheck(
  opts: { file: string | null; label: string },
  block: string = imageBuildShaBlock(),
): { out: string; fail: string } {
  const dir = mkdtempSync(join(tmpdir(), "verify-image-sha-"));
  const catStub =
    opts.file === null
      ? '#!/bin/sh\nif [ "$1" = "/etc/rmd-build-sha" ]; then exit 1; fi\nexec /bin/cat "$@"\n'
      : `#!/bin/sh\nif [ "$1" = "/etc/rmd-build-sha" ]; then printf '%s\\n' "${opts.file}"; exit 0; fi\nexec /bin/cat "$@"\n`;
  writeFileSync(join(dir, "cat"), catStub, { mode: 0o755 });
  chmodSync(join(dir, "cat"), 0o755);
  const r = spawnSync("sh", ["-c", `fail=0\n${block}\nprintf "FAILVAR=%s" "$fail"`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, EXPECT_BUILD_SHA: opts.label },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { out, fail: /FAILVAR=(\S*)/.exec(out)?.[1] ?? "?" };
}

test("the build-sha check PASSES and REPORTS the sha when the baked file and the label agree", () => {
  const r = runBuildShaCheck({ file: "6bc4288aaaa", label: "6bc4288aaaa" });
  assert.match(r.out, /PASS\s+image build sha/);
  assert.match(r.out, /6bc4288aaaa/, "the whole point is that the sha is REPORTED, not merely judged");
  assert.equal(r.fail, "0");
});

test("the build-sha check FAILS when the two carriers DISAGREE, naming both values", () => {
  // THE ONLY FAILING STATE, and it is never a healthy one: both carriers are written from one
  // build-arg, so a disagreement means one was written and the other was not.
  const r = runBuildShaCheck({ file: "aaaaaaa", label: "bbbbbbb" });
  assert.match(r.out, /FAIL\s+image build sha/);
  assert.match(r.out, /aaaaaaa/, "must name what the image actually carries…");
  assert.match(r.out, /bbbbbbb/, "…and what the label claimed");
  assert.equal(r.fail, "1", "and it must set the failure flag the script exits on");
});

test("an image with NO baked sha is UNKNOWN — it warns, and must NOT fail", () => {
  // THE CURRENTLY PUBLISHED IMAGE IS EXACTLY THIS. A check that failed here would fire on a
  // healthy condition the day it landed, which is the defect class this repo already has four of.
  const r = runBuildShaCheck({ file: null, label: "6bc4288aaaa" });
  assert.match(r.out, /WARN\s+image build sha/);
  assert.doesNotMatch(r.out, /PASS\s+image build sha/, "absent must never render as a match");
  assert.equal(r.fail, "0", "an old image is OLD, not broken");
});

test("a build with no --build-arg bakes the literal `unknown`, which is UNKNOWN and not a value", () => {
  // `ARG RMD_BUILD_SHA=unknown` is the Dockerfile default, so a plain `docker build` produces this.
  // Treating the sentinel as a real sha would report `unknown` as the build commit.
  const r = runBuildShaCheck({ file: "unknown", label: "6bc4288aaaa" });
  assert.match(r.out, /WARN\s+image build sha/);
  assert.equal(r.fail, "0");
});

test("a baked sha with NO label still REPORTS the sha rather than going silent", () => {
  // The host half can be missing on its own — `docker inspect` renders an absent label as
  // `<no value>`, which the script normalises to empty. The in-image answer is still the useful
  // one, so it must be printed rather than swallowed for want of something to compare against.
  const r = runBuildShaCheck({ file: "6bc4288aaaa", label: "" });
  assert.match(r.out, /WARN\s+image build sha/);
  assert.match(r.out, /6bc4288aaaa/, "the sha must be reported even when it cannot be compared");
  assert.equal(r.fail, "0");
});

test("MUTANT: a probe that reads the LABEL instead of the baked FILE certifies an image that carries nothing", () => {
  // THE SECOND TRAP, made falsifiable. The label is readable only with `docker inspect` on the
  // host; the file is the carrier an agent inside a running container can actually read. A probe
  // sourcing its value from the label would pass every test above that compares two equal strings
  // — and would report a build sha for an image that has no such file at all, which is precisely
  // the state that let 108 commits of drift go unnoticed.
  const mutant = imageBuildShaBlock().replace(
    'got_sha="$(cat /etc/rmd-build-sha 2>/dev/null | head -1)"',
    'got_sha="${EXPECT_BUILD_SHA:-}"',
  );
  assert.notEqual(mutant, imageBuildShaBlock(), "the mutation target must exist, or this proves nothing");

  const r = runBuildShaCheck({ file: null, label: "6bc4288aaaa" }, mutant);
  assert.match(r.out, /PASS\s+image build sha/, "the mutant must PASS an image with no baked file…");
  assert.equal(r.fail, "0");
  // …while the real block WARNs on that identical input, which is the difference the file carries.
  const real = runBuildShaCheck({ file: null, label: "6bc4288aaaa" });
  assert.match(real.out, /WARN\s+image build sha/, "…and the real probe must not");
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
  { mode: "binaries-missing", why: "a shelled binary is absent for the runtime user", says: /a shelled binary is missing or unrunnable/ },
  { mode: "claude-version-mismatch", why: "claude runs but is not the version the Dockerfile declares", says: /FAILURES above/ },
  { mode: "build-sha-mismatch", why: "the image label and the baked build-sha file disagree", says: /FAILURES above/ },
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
