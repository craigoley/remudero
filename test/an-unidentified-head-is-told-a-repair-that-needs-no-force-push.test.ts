import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * AN UNIDENTIFIED HEAD IS TOLD A REPAIR THAT NEEDS NO FORCE-PUSH.
 *
 * #9857 (`codex/serve-memo-append-oct7`) was refused by head-identity-gate, and the refusal said the only
 * repair for an open pull request was to amend the head commit and force-push. The session could not
 * force-push, so the same commits were republished as #9863 and #9857 was closed. The gate reads the
 * NEWEST author commit's trailer, so a new commit carrying `Remudero-Task: PR-<n>` (the ad-hoc identity
 * hooks/pre-push documents) admits the head with a plain push.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "head-identity-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — reached by dynamic import.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateHeadIdentityGate: (input: {
    headCommitMessage: string;
    headRef: string | undefined;
    changedPaths?: readonly string[];
  }) => { ok: boolean; defect?: string; message: string };
};

const codexHead = { headRef: "codex/serve-memo-append-oct7", changedPaths: ["src/lib/ledger.ts"] };

test("the refusal tells an open pull request to push a new trailer commit, never to force-push", () => {
  const refused = mod.evaluateHeadIdentityGate({ ...codexHead, headCommitMessage: "perf(ledger): stream archive loads\n" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /push a NEW head commit/);
  assert.match(refused.message, /Remudero-Task: PR-<n>/, "the ad-hoc identity an open pull request can still carry");
  assert.match(refused.message, /--allow-empty/, "an empty commit is enough to carry it");
  assert.doesNotMatch(refused.message, /amend the head commit|force-push the same branch/, "a force-push is never the repair");
});

test("the refusal tells an agent session on a codex/ or claude/ branch to push run-unfiled-<epochMs>", () => {
  const refused = mod.evaluateHeadIdentityGate({ ...codexHead, headCommitMessage: "perf(ledger): stream archive loads\n" });
  assert.match(refused.message, /`codex\/` or `claude\/` branch/);
  assert.match(refused.message, /git push origin HEAD:run-unfiled-\$\(date \+%s\)000/, "the exact command, not just the shape");
});

test("the trailer commit the refusal prescribes admits the same codex/ head", () => {
  const repaired = mod.evaluateHeadIdentityGate({
    ...codexHead,
    headCommitMessage: "chore: identify this pull request\n\nRemudero-Task: PR-9857\n",
  });
  assert.equal(repaired.ok, true, repaired.message);
});
