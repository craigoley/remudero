/**
 * test/next-task-id-reserve.test.ts — W1-T1055: `rmd next-task-id --reserve`.
 *
 * EVERY ARM IS DRIVEN THROUGH AN INJECTED RESERVER, NEVER A REAL REMOTE, and every refusal arm has
 * a paired positive control. That split is why this does not block `diff-coverage`: a refusal
 * reachable only through a real `git push` is a line no test can cover.
 *
 * `openPrTexts: NO_OPEN_PRS` (W1-T2324): every `--reserve` call below now ALSO injects a
 * reachable, empty open-PR read. Before W1-T2324, `--reserve` reserved regardless of the mint's
 * `degraded` state, so these tests were unknowingly exercising the REAL `gh` open-PR read (no
 * seam existed to override it) and tolerated whatever it returned (`code === 0 || code === 1`,
 * below). W1-T2324 makes `--reserve` REFUSE when the open-PR surface specifically could not be
 * read at all — correct in production, but it turns an unauthenticated `gh` in a sandboxed test
 * run (measured: CI's `ci` job sets no `GH_TOKEN` for `npm test`, so the real read fails fast
 * with "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment
 * variable") into a hard, non-deterministic refusal for tests that are about the RESERVE
 * mechanics, not about the open-PR surface's own reachability. Injecting a deterministic reader
 * — exactly like `reserver`/`holderOf`/`runGit` are already injected two lines below — restores
 * that isolation; it changes no test's assertion, only removes its accidental network dependency.
 * The open-PR-degradation arm itself (refuses / still proceeds on a settled-surface degradation)
 * is proven in test/mint-open-pr-surface-is-rest.test.ts, against `nextTaskIdCommand` directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyReservationAnchor,
  gitRunAdapter,
  describeContestedId,
  describeReservationRefusal,
  nextTaskIdCommand,
  readReservationHolder,
  validateReserveArgs,
} from "../src/run-task.js";
import { type RemoteRefReserver, type RemoteReserveOutcome } from "../src/lib/task-id-reservation.js";

/** A reserver that rejects the ids in `taken` and creates the first one that is not. */
function stubReserver(taken: Set<string>, unreachableFor?: (id: string) => boolean): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      if (unreachableFor?.(taskId)) return "unreachable";
      return taken.has(taskId) ? "taken" : "created";
    },
  };
}

/** A reachable open-PR read that sees nothing — see this file's header for why every `--reserve`
 *  call below injects it. */
const NO_OPEN_PRS = (): string[] => [];

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  return { out, err, restore: () => { console.log = ol; console.error = oe; } };
}

// ── the anchor classifier: both shapes plus the honest unknown ─────────────────────────────────

test("W1-T1055: the two reservation anchor shapes are told apart", () => {
  assert.equal(classifyReservationAnchor("rmd-id reservation 800202@eae16667008a 2026-08-18T17:05:18.606Z"), "fleet");
  assert.equal(classifyReservationAnchor("reserve W1-T1064 Remudero-2986-1787240759041672281"), "operator");
  // POSITIVE CONTROL on the fallback: anything else is reported as unknown rather than guessed.
  assert.equal(classifyReservationAnchor("Merge pull request #2286"), "unknown");
  assert.equal(classifyReservationAnchor(""), "unknown");

  // and each shape is NAMED in the operator-facing line, not merely classified
  assert.match(describeContestedId("W1-T9", "fleet"), /HELD BY ANOTHER CALLER/);
  assert.match(describeContestedId("W1-T9", "fleet"), /rmd-id reservation/);
  assert.match(describeContestedId("W1-T9", "operator"), /hand-mint/);
  assert.match(describeContestedId("W1-T9", "unknown"), /unreadable/);
});

// ── criterion 1 — the verb reserves when asked ────────────────────────────────────────────────

test("W1-T1055: --reserve claims the id on the remote", async () => {
  const reserver = stubReserver(new Set());
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--offline"].filter(() => false).concat(["--reserve"]), {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  const text = cap.out.join("\n");
  assert.match(text, /^RESERVED W1-T\d+ on origin \(refs\/rmd-id\/W1-T\d+\) after 1 attempt\(s\)$/m);
  assert.equal(reserver.tried.length, 1, "an uncontested first candidate is claimed in one attempt");
  assert.ok(code === 0 || code === 1, "the mint's own degraded exit code is preserved");
});

// ── criterion 2 — the id actually HELD, never the one first tried ──────────────────────────────

test("W1-T1055: a contested first candidate reports the id actually held", async () => {
  // The falsifier the shard names: refuse the FIRST candidate, accept the SECOND.
  const cap0 = capture();
  let firstId = "";
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver: (() => { const r = stubReserver(new Set()); return r; })(), holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap0.restore();
  }
  firstId = /RESERVED (W1-T\d+)/.exec(cap0.out.join("\n"))?.[1] ?? "";
  assert.ok(firstId, "control: the uncontested run named an id, so the contested run has something to differ from");

  const reserver = stubReserver(new Set([firstId]));
  const cap = capture();
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver, holderOf: () => "fleet", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  const text = cap.out.join("\n");
  const heldId = /RESERVED (W1-T\d+)/.exec(text)?.[1];
  assert.ok(heldId, "the run still reported a held id");
  assert.notEqual(heldId, firstId, "the id printed is the one HELD, never the one first tried");
  assert.equal(reserver.tried[0], firstId, "…and it really did try the contested one first");
  assert.equal(reserver.tried.length, 2, "the existing loop advanced exactly once — it was not rebuilt");

  // THE REJECTION IS SURFACED, not silently skipped — the whole point of the added reporting.
  assert.match(text, /HELD BY ANOTHER CALLER/);
  assert.match(text, /rmd-id reservation/, "and it names WHICH shape holds it");
  assert.match(text, /is the id actually HELD/, "the divergence from the advisory mint is called out");
});

// ── criterion 3 — an unreachable origin refuses loudly ────────────────────────────────────────

test("W1-T1055: an unreachable origin refuses instead of minting optimistically", async () => {
  const reserver = stubReserver(new Set(), () => true);
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--reserve"], {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  assert.equal(code, 2, "fail-closed: a refusal exits non-zero");
  const errText = cap.err.join("\n");
  assert.match(errText, /REFUSED — origin is unreachable/);
  assert.match(errText, /no id was claimed/);
  assert.equal(cap.out.join("\n").includes("RESERVED "), false, "nothing may claim to have been reserved");

  // POSITIVE CONTROL: the SAME stub with no failure injected reaches the ordinary claim, so the
  // refusal comes from the injected condition and not from the wiring always failing.
  const ok = stubReserver(new Set());
  const cap2 = capture();
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver: ok, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap2.restore();
  }
  assert.match(cap2.out.join("\n"), /RESERVED W1-T\d+ on origin/);
});

// ── criterion 4 — the unflagged verb is unchanged and reserves nothing ─────────────────────────

test("W1-T1055: the unflagged verb reserves nothing and its output is unchanged", async () => {
  const reserver = stubReserver(new Set());
  const cap = capture();
  try {
    await nextTaskIdCommand([], {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap.restore();
  }
  assert.equal(reserver.tried.length, 0, "WITHOUT the flag nothing is claimed — not one attempt");
  const text = cap.out.join("\n");
  assert.equal(text.includes("RESERVED "), false);
  assert.equal(text.includes("HELD BY ANOTHER CALLER"), false);

  // POSITIVE CONTROL: the same stub DOES get used when the flag is present, so the zero above is
  // the flag being absent and not a reserver that is never wired.
  const cap2 = capture();
  try {
    await nextTaskIdCommand(["--reserve"], {}, { reserver, holderOf: () => "unknown", openPrTexts: NO_OPEN_PRS });
  } finally {
    cap2.restore();
  }
  assert.equal(reserver.tried.length, 1);
});

// ── the contradiction, refused rather than silently resolved ──────────────────────────────────

test("W1-T1055: --reserve and --offline are refused together", async () => {
  assert.match(validateReserveArgs(["--reserve", "--offline"])!, /contradictory/);
  // POSITIVE CONTROL: either alone is accepted, so the refusal is not a blanket reject.
  assert.equal(validateReserveArgs(["--reserve"]), undefined);
  assert.equal(validateReserveArgs(["--offline"]), undefined);
  assert.equal(validateReserveArgs([]), undefined);

  const reserver = stubReserver(new Set());
  const cap = capture();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--reserve", "--offline"], {}, { reserver });
  } finally {
    cap.restore();
  }
  assert.equal(code, 2);
  assert.equal(reserver.tried.length, 0, "a refused argument pair must claim nothing");
});

// ── the refusal renderer and the holder reader ────────────────────────────────────────────────

test("W1-T1055: refusal text and holder reads degrade honestly", () => {
  assert.match(describeReservationRefusal("unreachable", "boom"), /origin is unreachable/);
  assert.match(describeReservationRefusal("exhausted", "boom"), /already reserved/);
  assert.match(describeReservationRefusal(undefined, "boom"), /REFUSED/);

  // the holder read is best-effort: a failed fetch or a failed log yields "unknown", never a guess
  assert.equal(readReservationHolder("W1-T1", () => ({ status: 1, stdout: "", stderr: "no" })), "unknown");
  assert.equal(
    readReservationHolder("W1-T1", (args) => (args[0] === "fetch" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "" })),
    "unknown",
  );
  // POSITIVE CONTROL: with both calls succeeding it really does classify, so the unknowns above
  // are genuine failure and not a reader that never works.
  assert.equal(
    readReservationHolder("W1-T1", () => ({ status: 0, stdout: "rmd-id reservation 1@host 2026-01-01T00:00:00Z", stderr: "" })),
    "fleet",
  );
});

// ── the real-path adapter, which no injected-reserver test can reach ──────────────────────────

test("W1-T1055: a signalled git push is a FAILURE, never a silent success", () => {
  // spawnSync reports `status: null` when the child is killed by a signal. classifyPushFailure
  // would read a null as success, so the adapter maps it to 1 — the fail-closed direction.
  const signalled = gitRunAdapter(() => ({ status: null }))(["push"]);
  assert.equal(signalled.status, 1, "a signalled push must not read as created");
  assert.equal(signalled.stdout, "", "absent streams normalise to empty strings, never undefined");
  assert.equal(signalled.stderr, "");

  // POSITIVE CONTROL: a real result passes through untouched, so the mapping above is the null
  // case and not the adapter rewriting every outcome.
  const real = gitRunAdapter(() => ({ status: 0, stdout: "ok", stderr: "warn" }))(["push"]);
  assert.deepEqual(real, { status: 0, stdout: "ok", stderr: "warn" });

  // and the argv reaches the underlying runner unchanged
  const seen: string[][] = [];
  gitRunAdapter((a) => { seen.push(a); return { status: 0 }; })(["push", "origin", "x:y"]);
  assert.deepEqual(seen, [["push", "origin", "x:y"]]);
});
