import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEWER_IDENTITY_ENV,
  REVIEWER_TOKEN_ENV,
  reviewGatePinPrecondition,
  reviewerIdentityPosture,
  unpinnedRequiredContexts,
  type RequiredStatusChecksSnapshot,
} from "../src/lib/review.js";

// ── W1-T2442 — THE REQUIRED REVIEW GATE IS ENFORCED BY CONVENTION, NOT BY MECHANISM ──────────
//
// `required_status_checks.contexts` lists `remudero-review` beside `ci-gate`, but `ci-gate`
// carries `app_id: 15368` (a real pin) while `remudero-review` carries `app_id: null` (NO pin —
// satisfied by any repo-scoped token). The mechanism meant to close that, `REVIEWER_TOKEN_ENV`,
// ships DARK by its own doc (src/lib/review.ts ~L4494) until an operator provisions the
// identity. This task builds the PRECONDITION READER: a pure statement of whether pinning
// `remudero-review`'s app_id is safe to apply yet — never the credential provisioning itself
// (backlogged, W1-T203/W1-T990), never a branch-protection write. Three functions, five
// criteria (task acceptance block):
//  1. unpinnedRequiredContexts — names every null-app_id required context, omits pinned ones.
//  2. reviewerIdentityPosture — resolves exactly three states, an unreadable env degrades to
//     "unknown" and can never render as "provisioned".
//  3+4. reviewGatePinPrecondition — UNSAFE while dark (naming the env var), and reports
//     credential PRESENCE only, never a value, on every arm including "unknown".
//  5. reviewGatePinPrecondition — SAFE when identity is provisioned and the context is already
//     app-pinned: the falsifier that proves the reader isn't hardcoded to always say UNSAFE.

function snapshot(checks: Array<{ context: string; app_id: number | null }>): RequiredStatusChecksSnapshot {
  return { contexts: checks.map((c) => c.context), checks };
}

// ── 1. unpinnedRequiredContexts ─────────────────────────────────────────────────────────────

test("W1-T2442: unpinnedRequiredContexts names every required context whose app_id is null and omits an app-pinned one", () => {
  const snap = snapshot([
    { context: "ci-gate", app_id: 15368 },
    { context: "remudero-review", app_id: null },
  ]);
  const unpinned = unpinnedRequiredContexts(snap);
  assert.deepEqual(unpinned, ["remudero-review"]);
  assert.ok(!unpinned.includes("ci-gate"), "an app-pinned context must never be named as unpinned");
});

test("W1-T2442: unpinnedRequiredContexts names ALL null-app_id contexts, and reports none when every context is pinned", () => {
  const allUnpinned = snapshot([
    { context: "remudero-review", app_id: null },
    { context: "second-gate", app_id: null },
  ]);
  assert.deepEqual(unpinnedRequiredContexts(allUnpinned), ["remudero-review", "second-gate"]);

  const allPinned = snapshot([
    { context: "ci-gate", app_id: 15368 },
    { context: "remudero-review", app_id: 4648213 },
  ]);
  assert.deepEqual(unpinnedRequiredContexts(allPinned), []);
});

// ── 2. reviewerIdentityPosture ──────────────────────────────────────────────────────────────

test("W1-T2442: reviewerIdentityPosture resolves \"dark\" when neither env var is set — the documented default", () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(
    reviewerIdentityPosture((name) => env[name]),
    "dark",
  );
});

test("W1-T2442: reviewerIdentityPosture resolves \"provisioned\" only when BOTH the token and login env vars are set", () => {
  const env: Record<string, string | undefined> = {
    [REVIEWER_TOKEN_ENV]: "ghp_faketoken",
    [REVIEWER_IDENTITY_ENV]: "remudero-reviewer[bot]",
  };
  assert.equal(
    reviewerIdentityPosture((name) => env[name]),
    "provisioned",
  );
});

test("W1-T2442: reviewerIdentityPosture never renders \"provisioned\" from only ONE var being set", () => {
  const tokenOnly: Record<string, string | undefined> = { [REVIEWER_TOKEN_ENV]: "ghp_faketoken" };
  assert.notEqual(reviewerIdentityPosture((name) => tokenOnly[name]), "provisioned");

  const loginOnly: Record<string, string | undefined> = { [REVIEWER_IDENTITY_ENV]: "remudero-reviewer[bot]" };
  assert.notEqual(reviewerIdentityPosture((name) => loginOnly[name]), "provisioned");
});

test("W1-T2442: reviewerIdentityPosture degrades to \"unknown\" (never \"dark\", never \"provisioned\") when the environment itself is unreadable", () => {
  const throwingRead = (): string | undefined => {
    throw new Error("EACCES: /proc/<pid>/environ unreadable");
  };
  const posture = reviewerIdentityPosture(throwingRead);
  assert.equal(posture, "unknown");
  assert.notEqual(posture, "dark");
  assert.notEqual(posture, "provisioned");
});

test("W1-T2442: reviewerIdentityPosture resolves exactly three states and never a boolean-shaped two", () => {
  const states = new Set<string>();
  states.add(reviewerIdentityPosture(() => undefined));
  states.add(
    reviewerIdentityPosture((name) => ({ [REVIEWER_TOKEN_ENV]: "t", [REVIEWER_IDENTITY_ENV]: "l" })[name]),
  );
  states.add(
    reviewerIdentityPosture(() => {
      throw new Error("unreadable");
    }),
  );
  assert.deepEqual([...states].sort(), ["dark", "provisioned", "unknown"]);
});

// ── 3+4. reviewGatePinPrecondition — UNSAFE while dark, credential PRESENCE only ────────────

test("W1-T2442: reviewGatePinPrecondition reports the pin UNSAFE while the reviewer identity is dark, naming the env var it looked for", () => {
  const snap = snapshot([
    { context: "ci-gate", app_id: 15368 },
    { context: "remudero-review", app_id: null },
  ]);
  const result = reviewGatePinPrecondition(snap, "dark");
  assert.equal(result.verdict, "unsafe");
  assert.equal(result.reviewerIdentity, "dark");
  assert.ok(
    result.reason.includes(REVIEWER_TOKEN_ENV),
    `reason must name the env var (${REVIEWER_TOKEN_ENV}) it looked for; got: ${result.reason}`,
  );
});

test("W1-T2442: reviewGatePinPrecondition also reports UNSAFE while the reviewer identity is unknown, naming the env var", () => {
  const snap = snapshot([{ context: "remudero-review", app_id: null }]);
  const result = reviewGatePinPrecondition(snap, "unknown");
  assert.equal(result.verdict, "unsafe");
  assert.ok(result.reason.includes(REVIEWER_TOKEN_ENV));
});

test("W1-T2442: reviewGatePinPrecondition reports presence of the reviewer credential and NEVER its value, on every arm including the unknown one", () => {
  const snap = snapshot([{ context: "remudero-review", app_id: null }]);

  const dark = reviewGatePinPrecondition(snap, "dark");
  const unknown = reviewGatePinPrecondition(snap, "unknown");
  const provisioned = reviewGatePinPrecondition(
    snapshot([{ context: "remudero-review", app_id: 4648213 }]),
    "provisioned",
  );

  assert.equal(dark.reviewerCredentialPresent, "absent");
  assert.equal(unknown.reviewerCredentialPresent, "unknown");
  assert.equal(provisioned.reviewerCredentialPresent, "present");

  // Never the value: this reader is never handed a token in the first place (posture is the
  // only input), so no field of its output can carry one — assert the shape stays that way.
  const secretToken = "ghp_SUPER_SECRET_VALUE_MUST_NEVER_APPEAR";
  for (const result of [dark, unknown, provisioned]) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secretToken), "output must never carry a credential value");
    assert.ok(
      ["present", "absent", "unknown"].includes(result.reviewerCredentialPresent),
      "credential presence must always be one of the three named states, on every arm",
    );
  }
});

// ── 5. reviewGatePinPrecondition — SAFE falsifier ───────────────────────────────────────────

test("W1-T2442: reviewGatePinPrecondition reports the pin SAFE when a provisioned identity is paired with an app-pinned context — the falsifier that keeps UNSAFE load-bearing", () => {
  const snap = snapshot([
    { context: "ci-gate", app_id: 15368 },
    { context: "remudero-review", app_id: 4648213 },
  ]);
  const result = reviewGatePinPrecondition(snap, "provisioned");
  assert.equal(result.verdict, "safe");
  assert.equal(result.unpinnedContexts.length, 0);
  assert.equal(result.reviewerCredentialPresent, "present");
});

test("W1-T2442: reviewGatePinPrecondition is not hardcoded UNSAFE — SAFE and UNSAFE are both reachable outcomes from the SAME function", () => {
  const snap = snapshot([{ context: "remudero-review", app_id: null }]);
  const unsafe = reviewGatePinPrecondition(snap, "dark");
  const safe = reviewGatePinPrecondition(
    snapshot([{ context: "remudero-review", app_id: 4648213 }]),
    "provisioned",
  );
  assert.equal(unsafe.verdict, "unsafe");
  assert.equal(safe.verdict, "safe");
  assert.notEqual(unsafe.verdict, safe.verdict);
});
