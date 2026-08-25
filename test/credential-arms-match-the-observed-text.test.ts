// W1-T2250: the containment preflight's two credential arms
// (`CREDENTIAL_FAILURE_RE`+`CREDENTIAL_LOGIN_HINT_RE` and
// `CREDENTIAL_EXPIRED_RE`+`CREDENTIAL_TOKEN_EXPIRED_RE`, src/lib/containment.ts)
// are each an AND of two literal fragments matched against a probe's
// transcript. Before this task, the expired-token arm was still keyed on
// W1-T292's original fixture text ("OAuth session expired and could not be
// refreshed") — a phrase the SDK no longer emits. The text it actually emits,
// observed on a real probe run and quoted verbatim in this task's own filing
// (corroborated independently by W1-T2249's ledger read), is:
//
//   "Failed to authenticate. API Error: 401 OAuth access token has expired.
//    Re-authenticate to continue"
//
// That excerpt matched neither conjunct of either arm, so every credential-dead
// probe fell through to the generic `unproven` verdict and the two named
// reasons (`spawn_credential_expired` / `spawn_credential_failure`) were never
// once recorded, even though the arms are unconditionally reachable on every
// uncontained probe. This file pins the fixed behavior directly against
// `probeContainment` (an injected `exec`, no real spawn) and is the falsifier
// this task's shard forward-references from `not_yet_built`.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContainmentError, probeContainment } from "../src/lib/containment.js";

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credential-arms-test-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const ENABLED = {
  sandbox: { enabled: true, failIfUnavailable: true },
  permissions: { deny: [], allow: [], ask: [] },
};

// The exact excerpt this task's filing quotes verbatim, attributed to a real
// probe transcript rather than re-derived here.
const OBSERVED_EXPIRED_TEXT =
  "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue";

// FINDINGS.md's verified ground truth (SDK 0.3.209 / CLI 2.1.209) for a
// headless spawn with no usable OAuth token at all — a DIFFERENT credential-
// dead shape from the expired-token one above (never logged in, vs. a copied
// token that has since expired).
const OBSERVED_NOT_LOGGED_IN_TEXT = "Not logged in · Please run /login";

async function rejectsWith(
  exec: () => Promise<{
    transcript: string;
    outsideWriteCreated: boolean;
    insideWriteCreated: boolean;
    isError?: boolean;
  }>,
): Promise<ContainmentError> {
  let caught: unknown;
  await assert.rejects(
    () => probeContainment({ settingsFile: settingsFile(ENABLED), token: "tok", exec }),
    (e: unknown) => {
      caught = e;
      return true;
    },
  );
  assert.ok(caught instanceof ContainmentError, "must fail closed with a ContainmentError");
  return caught as ContainmentError;
}

// ── Acceptance (1): the observed expired-token text classifies as expired ──

test("ACCEPTANCE: a probe transcript carrying the observed expired-token text is classified as an expired credential", async () => {
  const err = await rejectsWith(async () => ({
    transcript: OBSERVED_EXPIRED_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.equal(err.guard, "containment");
  assert.equal(err.check, "spawn-credential-expired");
  assert.equal(err.observed, "spawn_credential_expired");
  assert.match(err.message, /spawn_credential_expired/);
});

// ── Acceptance (2): the unauthenticated-worker text classifies as a failure ─

test("ACCEPTANCE: a probe transcript carrying an unauthenticated-worker text is classified as a credential failure", async () => {
  const err = await rejectsWith(async () => ({
    transcript: OBSERVED_NOT_LOGGED_IN_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.equal(err.guard, "containment");
  assert.equal(err.check, "spawn-credential-failure");
  assert.equal(err.observed, "spawn_credential_failure");
  assert.match(err.message, /spawn_credential_failure/);
});

// ── Acceptance (3): credential-shaped but not credential-dead ⇒ still unproven

test("ACCEPTANCE: a credential-shaped transcript that is not credential-dead still classifies as unproven", async () => {
  // Shares ONE fragment with the expired-token arm ("Failed to authenticate")
  // but is a transport/rate-limit error, not an expired token — the second
  // fragment ("OAuth access token has expired") never appears. A widened,
  // single-fragment arm would mislabel this; the two-fragment AND must not.
  const err = await rejectsWith(async () => ({
    transcript: "Failed to authenticate. API Error: 529 Overloaded, please retry",
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.equal(err.guard, "containment");
  assert.equal(err.check, "outside-cwd-denial");
  assert.notEqual(err.observed, "spawn_credential_expired");
  assert.notEqual(err.observed, "spawn_credential_failure");
  assert.notEqual(err.observed, "unproven"); // still NAMED (W1-T1281), just not credential
});

// ── Acceptance (4): both arms still throw and still fail closed ────────────

test("ACCEPTANCE: both credential arms still throw ContainmentError and still fail closed", async () => {
  const expired = await rejectsWith(async () => ({
    transcript: OBSERVED_EXPIRED_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.ok(expired instanceof ContainmentError);
  assert.match(expired.message, /FAIL CLOSED/);

  const failure = await rejectsWith(async () => ({
    transcript: OBSERVED_NOT_LOGGED_IN_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.ok(failure instanceof ContainmentError);
  assert.match(failure.message, /FAIL CLOSED/);
});

// ── Acceptance (5): the expired and failure reasons remain distinct symbols ─

test("ACCEPTANCE: the expired and failure reasons remain distinct symbols", async () => {
  const expired = await rejectsWith(async () => ({
    transcript: OBSERVED_EXPIRED_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  const failure = await rejectsWith(async () => ({
    transcript: OBSERVED_NOT_LOGGED_IN_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.notEqual(expired.check, failure.check);
  assert.notEqual(expired.observed, failure.observed);
  assert.equal(expired.check, "spawn-credential-expired");
  assert.equal(failure.check, "spawn-credential-failure");
});

// ── Acceptance (6): each arm still requires two independent fragments ──────

test("ACCEPTANCE: the expired arm requires BOTH fragments — either alone is not enough", async () => {
  const onlyFirst = await rejectsWith(async () => ({
    // "Failed to authenticate" present, "OAuth access token has expired" absent.
    transcript: "Failed to authenticate. API Error: 500 Internal Server Error",
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.notEqual(onlyFirst.observed, "spawn_credential_expired");

  const onlySecond = await rejectsWith(async () => ({
    // "OAuth access token has expired" present, "Failed to authenticate" absent.
    transcript: "warning: your OAuth access token has expired soon, refresh recommended",
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.notEqual(onlySecond.observed, "spawn_credential_expired");
});

test("ACCEPTANCE: the failure arm requires BOTH fragments — either alone is not enough", async () => {
  const onlyFirst = await rejectsWith(async () => ({
    // "not logged in" present, "run /login" absent.
    transcript: "you are not logged in to this service",
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.notEqual(onlyFirst.observed, "spawn_credential_failure");

  const onlySecond = await rejectsWith(async () => ({
    // "run /login" present, "not logged in" absent.
    transcript: "session unavailable — run /login to continue",
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.notEqual(onlySecond.observed, "spawn_credential_failure");
});
