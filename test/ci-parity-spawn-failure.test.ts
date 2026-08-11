import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { defaultPreflightSpawn } from "../src/lib/commit-message.js";
import { shellOut } from "../src/lib/ci-parity.js";

/**
 * `shellOut` CLAIMED TO REPORT A SIGNAL KILL AND NEVER DID — and the false comment was the sharper
 * half of the defect. Its `status === null` block was introduced by a comment reading "a signal
 * kill, a buffer ceiling hit, ENOENT, etc.", while the code rendered
 * `res.error ?? "spawn produced no exit status and no error message"`. A signalled child reports
 * `status: null` with **no error at all**, so every kill fell into that fallback, unnamed — and a
 * reader trusting the comment would conclude a kill was already distinguishable here and stop
 * looking.
 *
 * This is the independent copy of the defect #1558 fixed in `spawnFailureDetail`. The fix is
 * DELEGATION, not a second implementation: `shellOut` now calls that one function, so the
 * three-state reading cannot drift between the preflight steps and the ci-parity leaves. This repo
 * has measured that drift (emitter-checks versus commitlint, documented as unable to drift and
 * already diverged), which is why reuse beats a parallel copy even when the copy would be short.
 *
 * EVERY STATE HERE IS DRIVEN THROUGH THE REAL `shellOut` WITH THE REAL `defaultPreflightSpawn`
 * against a REAL child. `shellOut` takes its spawn as a parameter, so no mocking is needed to reach
 * the true `spawnSync` shape — and a fabricated `{status: null, signal: "SIGKILL"}` would prove only
 * that a formatter formats.
 */

// ── STATE 1: KILLED ──────────────────────────────────────────────────────────────────────────
test("shellOut names the SIGNAL when a real child is killed, instead of the anonymous fallback", () => {
  // PRECONDITION FIRST, asserted rather than assumed: this is the shape that made the old message
  // mute, so if it does not hold the rest of this test proves nothing.
  const probe = defaultPreflightSpawn("/bin/sh", ["-c", "kill -9 $$"]);
  assert.equal(probe.status, null, "a signalled child has no exit status");
  assert.equal(probe.signal, "SIGKILL", "spawnSync really reports the signal");
  assert.equal(probe.error, undefined, "and reports NO error — which is why the old fallback fired");

  const r = shellOut(defaultPreflightSpawn, "kill-probe", "/bin/sh", ["-c", "kill -9 $$"]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /SPAWN FAILURE/, "a spawn failure is still named as its own outcome");
  assert.match(r.detail, /kill-probe/, "the label survives, so the operator knows which leaf");
  assert.match(r.detail, /KILLED by SIGKILL/, "THE FIX: the signal is named");
  assert.doesNotMatch(
    r.detail,
    /no exit status, no signal and no error message/,
    "and it must NOT fall into the residual, which is what the old code did for every kill",
  );
});

test("a crash and a policy kill stay distinguishable, because the signal is named rather than generalised", () => {
  const probe = defaultPreflightSpawn("/bin/sh", ["-c", "kill -SEGV $$"]);
  assert.equal(probe.signal, "SIGSEGV", "precondition: a real SIGSEGV");

  const r = shellOut(defaultPreflightSpawn, "segv-probe", "/bin/sh", ["-c", "kill -SEGV $$"]);
  // SIGKILL under a sandbox is policy; SIGSEGV is a crash. Different findings, different fixes.
  assert.match(r.detail, /SIGSEGV/);
  assert.doesNotMatch(r.detail, /SIGKILL/);
});

// ── STATE 2: NEVER STARTED ───────────────────────────────────────────────────────────────────
test("a leaf whose binary does not exist reports its errno and is not described as killed", () => {
  const missing = "/definitely/not/here/remudero-ci-parity-probe";
  const probe = defaultPreflightSpawn(missing, []);
  assert.equal(probe.status, null, "precondition: ENOENT yields no exit status");
  assert.match(String(probe.error), /ENOENT/, "precondition: the runtime names the errno");
  assert.equal(probe.signal, undefined, "precondition: nothing signalled it — it never ran");

  const r = shellOut(defaultPreflightSpawn, "missing-binary", missing, []);
  assert.equal(r.ok, false);
  assert.match(r.detail, /ENOENT/, "ENOENT is a LINKING problem…");
  assert.doesNotMatch(r.detail, /KILLED/, "…and must never be reported as a kill, whose fix is the opposite");
});

// ── ORDER: both can be set, and the errno is the cause ───────────────────────────────────────
test("a bounded child still leads with the errno rather than the signal it was killed with", () => {
  // MEASURED, and it is why the order is load-bearing: a runtime-enforced bound reports its errno
  // AND SIGTERM together. Leading with the signal would report the very ENOBUFS that
  // PREFLIGHT_SPAWN_MAX_BUFFER exists to prevent as a bare "killed by SIGTERM".
  //
  // A TIMEOUT, NOT A maxBuffer BREACH, and the choice is measured rather than stylistic. Both set
  // errno + SIGTERM, but `spawnSync(… { maxBuffer: 16 })` over `yes | head -c 100000` FAILED TO
  // BREACH 2 times in 200 on an idle container — a real race between the child exiting and the
  // ceiling being enforced — and that flake fired on main in a full-suite run. `sleep 5` against a
  // 120ms timeout cannot race: load only ever makes the child slower. Measured 40/40 deterministic.
  //
  // Driven through `spawnSync` DIRECTLY because `defaultPreflightSpawn` accepts neither knob.
  const raw = spawnSync("/bin/sh", ["-c", "sleep 5"], { encoding: "utf8", timeout: 120 });
  assert.equal(raw.status, null, "precondition: the bound really fired — no exit status");
  assert.match(String(raw.error?.message), /ETIMEDOUT/, "precondition: the errno is the cause");
  assert.equal(raw.signal, "SIGTERM", "precondition: AND a signal is set — both, not either");

  const r = shellOut(
    () => ({
      status: raw.status,
      stdout: raw.stdout ?? "",
      stderr: raw.stderr ?? "",
      error: raw.error ? raw.error.message : undefined,
      signal: raw.signal ?? undefined,
    }),
    "timeout-probe",
    "/bin/sh",
    ["-c", "yes"],
  );
  assert.match(r.detail, /ETIMEDOUT/, "the cause leads");
  assert.match(r.detail, /SIGTERM/, "the signal is still reported, not swallowed");
  assert.ok(
    r.detail.indexOf("ETIMEDOUT") < r.detail.indexOf("SIGTERM"),
    "the errno must come FIRST — the signal is only how the runtime carried it out",
  );
});

// ── STATE 3: the residual ────────────────────────────────────────────────────────────────────
test("neither an errno nor a signal still speaks, and now reports that no signal was seen", () => {
  // No real producer to drive — which is the point of it being residual after this change.
  const r = shellOut(() => ({ status: null, stdout: "", stderr: "" }), "residual-probe", "/bin/sh", ["-c", "true"]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no exit status, no signal and no error message/);
});

// ── THE HEALTHY CONTROLS — today's behaviour must be untouched ───────────────────────────────
test("a real exit 0 still PASSes and a real non-zero exit still FAILs with its output quoted", () => {
  const pass = shellOut(defaultPreflightSpawn, "green-leaf", "/bin/sh", ["-c", "echo fine"]);
  assert.equal(pass.ok, true);
  assert.equal(pass.detail, "PASS — green-leaf", "the PASS line is byte-identical to before");
  assert.doesNotMatch(pass.detail, /SPAWN FAILURE/);

  const fail = shellOut(defaultPreflightSpawn, "red-leaf", "/bin/sh", ["-c", "echo boom >&2; exit 3"]);
  assert.equal(fail.ok, false);
  assert.match(fail.detail, /^FAIL — red-leaf\n/, "an ordinary non-zero exit keeps the FAIL shape");
  assert.match(fail.detail, /boom/, "and still quotes the child's own output");
  assert.doesNotMatch(
    fail.detail,
    /SPAWN FAILURE/,
    "a child that RAN must never be relabelled a spawn failure — the conflation #1553 removed",
  );
});

test("a streamed step that fails still says its output went to the terminal, unchanged by this fix", () => {
  const r = shellOut(defaultPreflightSpawn, "streamed-leaf", "/bin/sh", ["-c", "exit 1"], { stream: true });
  assert.equal(r.ok, false);
  assert.match(r.detail, /output streamed above as it ran/);
});
