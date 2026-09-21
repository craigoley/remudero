// test/capability-grant-secrets.test.ts — W1-T3880 acceptance (2):
//   "the model, browser, ledger, and ordinary logs receive no raw credential or secret value"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyRedactionPolicy,
  createCapabilityGrant,
  InMemoryCapabilityGrantStore,
  REDACTED_PLACEHOLDER,
  useCapabilityGrant,
} from "../src/lib/capability-grant.js";
import { renderCapabilityGrantContext } from "../src/lib/prompt-render.js";

const REAL_SECRET = "REAL-SECRET-do-not-leak-9f8a7c";
const FUTURE = new Date(Date.now() + 60_000).toISOString();

function issuedGrant(overrides: Partial<Parameters<typeof createCapabilityGrant>[0]> = {}) {
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant({
    targetIdentity: "browser-session:checkout",
    operations: ["checkout.pay"],
    audience: "provider:cash",
    expiresAt: FUTURE,
    useLimit: 2,
    approval: { approvedBy: "operator:alice", approvedAt: new Date(Date.now() - 1_000).toISOString() },
    revocationLink: "https://revoke.example/cap-1",
    ...overrides,
  });
  let resolveCalls = 0;
  store.issue(grant, () => {
    resolveCalls += 1;
    return REAL_SECRET;
  });
  return { store, grant, resolveCalls: () => resolveCalls };
}

test("W1-T3880 (2): a grant object never carries the real secret, and JSON.stringify of it never leaks it", () => {
  const { grant } = issuedGrant();
  assert.equal(JSON.stringify(grant).includes(REAL_SECRET), false);
});

test("W1-T3880 (2): verifying and using a grant never resolves the secret — the ledger row (the receipt) is value-free", () => {
  const { store, grant, resolveCalls } = issuedGrant();
  const { verification, receipt } = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "checkout.pay",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(verification.ok, true);
  assert.equal(resolveCalls(), 0, "verify+use must never call the secret resolver");
  assert.equal(JSON.stringify(receipt).includes(REAL_SECRET), false);
  assert.equal(receipt.outcome, "used");
});

test("W1-T3880 (2): a refused use also produces a value-free receipt, and still never resolves the secret", () => {
  const { store, grant, resolveCalls } = issuedGrant();
  const { verification, receipt } = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "checkout.refund", // not in the allowlist
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(verification.ok, false);
  assert.equal(resolveCalls(), 0);
  assert.equal(JSON.stringify(receipt).includes(REAL_SECRET), false);
  assert.equal(receipt.outcome, "refused");
});

test("W1-T3880 (2): resolveSecret is a separate, explicit call the provider adapter makes ONLY after its own verified use", () => {
  const { store, grant, resolveCalls } = issuedGrant();
  const { verification } = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "checkout.pay",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(verification.ok, true);
  const real = store.resolveSecret(grant.id);
  assert.equal(real, REAL_SECRET);
  assert.equal(resolveCalls(), 1, "resolveSecret is called exactly once, by the adapter, never by verify/use");
});

test("W1-T3880 (2): applyRedactionPolicy masks named fields for a value carried in an ordinary outcome/log record", () => {
  const raw = { status: 200, authToken: REAL_SECRET, cookie: "sid=" + REAL_SECRET, body: "ok" };
  const redacted = applyRedactionPolicy({ redactFields: ["authToken", "cookie"] }, raw);
  assert.equal(redacted.authToken, REDACTED_PLACEHOLDER);
  assert.equal(redacted.cookie, REDACTED_PLACEHOLDER);
  assert.equal(redacted.status, 200);
  assert.equal(redacted.body, "ok");
  assert.equal(JSON.stringify(redacted).includes(REAL_SECRET), false);
});

test("W1-T3880 (2): applyRedactionPolicy never invents a field the record does not have", () => {
  const redacted = applyRedactionPolicy({ redactFields: ["authToken"] }, { body: "ok" });
  assert.equal("authToken" in redacted, false);
});

test("W1-T3880 (2): the rendered prompt context for capability grant receipts never contains the real secret (the model's own view)", () => {
  const { store, grant } = issuedGrant();
  const used = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "checkout.pay",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  const refused = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "checkout.refund",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n2",
  });
  const rendered = renderCapabilityGrantContext([used.receipt, refused.receipt]);
  assert.equal(rendered.includes(REAL_SECRET), false);
  assert.match(rendered, new RegExp(grant.id));
  assert.equal(renderCapabilityGrantContext([]), "", "an empty receipt list renders nothing, byte-identical to today's prompt");
});
