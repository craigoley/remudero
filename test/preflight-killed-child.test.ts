import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitlintStep,
  defaultPreflightSpawn,
  spawnFailureDetail,
  typecheckStep,
} from "../src/lib/commit-message.js";

/**
 * A KILLED CHILD IS NOT A CHILD THAT NEVER STARTED, and until this change the seam could not say
 * which. #1553 taught the preflight to distinguish "the spawn failed" from "the lint failed", but
 * `defaultPreflightSpawn` returned `{status, stdout, stderr, error}` and DROPPED `spawnSync`'s
 * `signal` — so a child the sandbox killed reported `status: null` with no error and landed in the
 * least informative branch: "no exit status and no error message", naming neither the signal nor
 * the cause.
 *
 * WHY THAT MATTERS NOW: six consecutive worker preflights failed with an EMPTY body and
 * `durationMs: 1`, and the leading explanation (an unreachable `node_modules`) is refuted — see the
 * asymmetry test at the bottom of this file, which proves `commitlintStep` CANNOT fail that way.
 * That leaves KILLED as the shape to suspect, and it was precisely the one the message could not
 * name.
 *
 * THE STATES ARE DRIVEN AGAINST REAL CHILDREN, not fabricated result objects: a hand-built
 * `{status: null, signal: "SIGKILL"}` would prove only that the formatter formats, and nothing about
 * whether `spawnSync` actually reports that shape — which is the entire claim. Stated exactly, since
 * an earlier draft of this comment overclaimed it: the kill, crash, ENOENT and both-healthy cases go
 * through the real `defaultPreflightSpawn`; the ENOBUFS case spawns a real child through `spawnSync`
 * directly because the wrapper hardcodes a 64MB ceiling with no override (see that test's own note);
 * and the residual state is a literal because it has no real producer left to drive, which is the
 * point of it being residual.
 */

// ── STATE 1: KILLED — signal set, and NO error at all ────────────────────────────────────────
test("MEASURED: a real killed child reports a signal with NO error, and the detail names the signal", () => {
  const res = defaultPreflightSpawn("/bin/sh", ["-c", "kill -9 $$"]);

  // THE PRECONDITION, asserted rather than assumed — this is the shape that made the old message
  // mute, so if it does not hold the rest of this test proves nothing.
  assert.equal(res.status, null, "a signalled child has no exit status");
  assert.equal(res.signal, "SIGKILL", "spawnSync really does report the signal");
  assert.equal(res.error, undefined, "and reports NO error — which is why the old fallback fired");

  const detail = spawnFailureDetail("typecheck", res);
  assert.ok(detail);
  assert.match(detail, /SPAWN FAILURE/);
  assert.match(detail, /KILLED by SIGKILL/, "the signal must reach the reader");
  assert.doesNotMatch(
    detail,
    /no exit status, no signal and no error message/,
    "the residual fallback must NOT claim there was no signal when there was one",
  );
});

test("a crash and a policy kill are different findings, so the signal is named rather than generalised", () => {
  const segv = defaultPreflightSpawn("/bin/sh", ["-c", "kill -SEGV $$"]);
  assert.equal(segv.signal, "SIGSEGV", "precondition: a real SIGSEGV");
  const detail = spawnFailureDetail("commitlint", segv);
  assert.ok(detail);
  // SIGKILL under a sandbox is policy; SIGSEGV is a crash. Reporting both as "killed" without the
  // name would merge two findings with entirely different remedies.
  assert.match(detail, /SIGSEGV/);
  assert.doesNotMatch(detail, /SIGKILL/);
});

// ── STATE 2: NEVER STARTED — errno set, no signal ────────────────────────────────────────────
test("a child that never started reports its errno and is NOT described as killed", () => {
  const res = defaultPreflightSpawn(join(tmpdir(), "definitely-absent-remudero-probe"), []);

  assert.equal(res.status, null, "precondition: ENOENT yields no exit status");
  assert.match(String(res.error), /ENOENT/, "precondition: the runtime names the errno");
  assert.equal(res.signal, undefined, "precondition: nothing signalled it — it never ran");

  const detail = spawnFailureDetail("typecheck", res);
  assert.ok(detail);
  assert.match(detail, /ENOENT/, "the errno must survive: ENOENT is a LINKING problem…");
  assert.doesNotMatch(detail, /KILLED/, "…and must never be reported as a kill, whose fix is the opposite");
});

// ── ORDER: both can be set, and the errno is the cause ───────────────────────────────────────
test("a buffer-ceiling breach leads with the errno and mentions the signal second", () => {
  // MEASURED: `maxBuffer` and `timeout` breaches set errno AND SIGTERM. This is why the branch
  // order is load-bearing — leading with the signal would report the very ENOBUFS that
  // PREFLIGHT_SPAWN_MAX_BUFFER exists to prevent as a bare "killed by SIGTERM".
  //
  // DRIVEN THROUGH `spawnSync` DIRECTLY, and the reason is worth stating: `defaultPreflightSpawn`
  // hardcodes PREFLIGHT_SPAWN_MAX_BUFFER (64MB) and accepts no override, so reaching a real breach
  // through it would mean generating 64MB of output in a unit test. The CHILD and the RESULT SHAPE
  // are still real — only the 16-byte ceiling is substituted — and the two fields are mapped here
  // exactly as `defaultPreflightSpawn` maps them, which its own body shows is a straight forward.
  // An earlier draft passed `maxBuffer` through the wrapper instead; the precondition below caught
  // that it was silently ignored and the child exited 0, so the test would have proved nothing.
  const raw = spawnSync("/bin/sh", ["-c", "yes | head -c 100000"], { encoding: "utf8", maxBuffer: 16 });
  const res = {
    status: raw.status,
    error: raw.error ? raw.error.message : undefined,
    signal: raw.signal ?? undefined,
  };

  assert.equal(res.status, null, "precondition: a breach yields no exit status");
  assert.match(String(res.error), /ENOBUFS/, "precondition: the errno is the cause");
  assert.equal(res.signal, "SIGTERM", "precondition: AND a signal is set — both, not either");

  const detail = spawnFailureDetail("commitlint", res);
  assert.ok(detail);
  assert.match(detail, /ENOBUFS/, "the cause leads");
  assert.match(detail, /SIGTERM/, "the signal is still reported, not swallowed");
  assert.ok(
    detail.indexOf("ENOBUFS") < detail.indexOf("SIGTERM"),
    "the errno must come FIRST — it is the cause; the signal is only how the runtime carried it out",
  );
});

// ── STATE 3: the residual ────────────────────────────────────────────────────────────────────
test("neither an errno nor a signal still speaks, and now says the signal was absent too", () => {
  // The one state with no real producer to drive — which is the point: after this change it should
  // be genuinely rare, and a reader who sees it should suspect the seam rather than guess a cause.
  const detail = spawnFailureDetail("emitter-checks", { status: null });
  assert.ok(detail);
  assert.match(detail, /no exit status, no signal and no error message/);
});

// ── THE HEALTHY CONTROL ──────────────────────────────────────────────────────────────────────
test("a healthy spawn is untouched — no spawn-failure detail, and a real nonzero exit stays a real verdict", () => {
  const ok = defaultPreflightSpawn("/bin/sh", ["-c", "echo fine"]);
  assert.equal(ok.status, 0);
  assert.equal(ok.signal, undefined, "a clean exit carries no signal");
  assert.equal(spawnFailureDetail("commitlint", ok), undefined, "a passing child is not a spawn failure");

  const nonzero = defaultPreflightSpawn("/bin/sh", ["-c", "echo bad >&2; exit 3"]);
  assert.equal(nonzero.status, 3);
  assert.equal(nonzero.signal, undefined);
  assert.equal(
    spawnFailureDetail("commitlint", nonzero),
    undefined,
    "an ordinary nonzero exit is a RESULT about the code and must not be relabelled",
  );
});

// ── THE ASYMMETRY, PRESERVED ─────────────────────────────────────────────────────────────────
test("typecheck can ENOENT on a missing node_modules but commitlint cannot, and they report differently", () => {
  // `typecheckStep` spawns `<repoRoot>/node_modules/.bin/tsc` — the symlinked path ITSELF — so an
  // unreachable node_modules is a spawn-level ENOENT. `commitlintStep` spawns `process.execPath`
  // with the bin as an ARGUMENT, so node starts fine and exits NONZERO with its own loader error.
  // That is why the six empty-bodied preflights are evidence AGAINST the symlink hypothesis: had
  // commitlint's bin been unreachable, node's "Cannot find module" would have been printed.
  const root = mkdtempSync(join(tmpdir(), "preflight-asym-"));

  const tc = typecheckStep(root);
  assert.equal(tc.ok, false);
  assert.match(tc.detail, /SPAWN FAILURE/, "typecheck: the child never started");
  assert.match(tc.detail, /ENOENT/, "…and says so with the errno");

  const cl = commitlintStep(root);
  assert.equal(cl.ok, false);
  assert.doesNotMatch(
    cl.detail,
    /SPAWN FAILURE/,
    "commitlint: node RAN, so this is an ordinary failure — reporting it as a spawn failure would be the same conflation #1553 fixed",
  );
  assert.notEqual(tc.detail, cl.detail, "two different failures must not render identically");
});
