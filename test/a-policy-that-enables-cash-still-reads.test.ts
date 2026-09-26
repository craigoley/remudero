// W1-T4562: the daemon writes a provider-routing projection whose POLICY names every configured
// worker provider, and the committed host policy enables `cash`. The reader accepted only
// claude/codex there, so every projection written after cash was enabled read back `malformed`:
// GET /v1/provider-routing showed "unknown", and every policy write refused as
// provider_policy_unavailable. The writer and the reader must agree on the policy's vocabulary.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveProviderRoutingPolicy, writeProviderRoutingPolicyOverride } from "../src/lib/provider-routing-policy.js";
import { providerRoutingStatusPath, readProviderRoutingStatus, writeProviderRoutingStatus } from "../src/lib/provider-routing-status.js";

const NOW = Date.parse("2026-09-26T14:00:00.000Z");

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4562-"));
  mkdirSync(join(root, "state"), { recursive: true });
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeWithPolicy(root: string, enabled: ("claude" | "codex" | "cash" | "openweight")[]): void {
  const policy = resolveProviderRoutingPolicy(root, { workerProviders: { enabled, reservePercent: 5 } } as never, { now: () => NOW });
  writeProviderRoutingStatus(root, {
    state: "not-probed",
    enabledProviders: ["claude", "codex"],
    reservePercent: 5,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
    policy,
  });
}

test("W1-T4562: a projection whose committed policy enables cash reads back as a policy, not malformed", () => {
  withRoot((root) => {
    writeWithPolicy(root, ["claude", "codex", "cash"]);
    const status = readProviderRoutingStatus(root, { now: () => NOW });
    assert.notEqual(status.state, "unknown", `read back ${JSON.stringify({ state: status.state, reason: status.reason })}`);
    assert.deepEqual(status.policy?.committed.enabledProviders, ["claude", "codex", "cash"]);
    assert.deepEqual(status.policy?.enabledProviders, ["claude", "codex", "cash"]);
  });
});

test("W1-T4562: a policy park for cash reads back with its configured provider id", () => {
  withRoot((root) => {
    const config = { workerProviders: { enabled: ["claude", "codex", "cash"], reservePercent: 5 } } as never;
    const parks = [{ provider: "cash" as const, until: new Date(NOW + 60_000).toISOString() }];
    writeProviderRoutingPolicyOverride(
      root,
      {
        enabledProviders: ["claude", "codex", "cash"],
        preference: "automatic",
        reservePercent: 5,
        parks,
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      { config, writerFingerprint: "unknown", now: () => NOW },
    );
    const policy = resolveProviderRoutingPolicy(root, config, { now: () => NOW });
    writeProviderRoutingStatus(root, {
      state: "not-probed",
      enabledProviders: ["claude", "codex"],
      reservePercent: 5,
      observedAtMs: NOW,
      cacheValidMs: 60_000,
      policy,
    });

    const status = readProviderRoutingStatus(root, { now: () => NOW });
    assert.notEqual(status.state, "unknown", `read back ${JSON.stringify({ state: status.state, reason: status.reason })}`);
    assert.deepEqual(status.policy?.parks, parks);
  });
});

test("W1-T4562: the openweight alias round-trips as cash, and an unknown provider is still refused", () => {
  withRoot((root) => {
    // `openweight` canonicalizes to `cash` on write (canonicalWorkerProviderId).
    writeWithPolicy(root, ["claude", "codex", "openweight"]);
    assert.deepEqual(readProviderRoutingStatus(root, { now: () => NOW }).policy?.committed.enabledProviders, ["claude", "codex", "cash"]);

    // The widening is to the CONFIGURED vocabulary, never to any string: a hand-edited unknown id
    // must still read as malformed rather than be passed through to a console.
    const path = providerRoutingStatusPath(root);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { policy: { committed: { enabledProviders: string[] } } };
    raw.policy.committed.enabledProviders = ["claude", "bogus"];
    writeFileSync(path, JSON.stringify(raw));
    const status = readProviderRoutingStatus(root, { now: () => NOW });
    assert.equal(status.state, "unknown");
    assert.equal(status.reason, "malformed");
  });
});
