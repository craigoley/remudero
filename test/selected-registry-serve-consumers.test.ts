import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildOnboardingReadinessRoute } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import type { OnboardingReadinessGateway } from "../src/lib/onboarding-readiness.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createSelectedRegistryObserver } from "../src/lib/selected-registry-consumers.js";
import { registryFileIO } from "../src/lib/instance-registry-selection.js";

interface Row { step: string; fields: Record<string, unknown> }
const STEP = "instance_registry.consumer_shadow_observed";
const selectedText = (name = "fixture", repo = "owner/repo") =>
  `instances:\n  ${name}:\n    github_repo: ${repo}\n    mode: shadow\n    state_dir: /private/selected-material-sentinel\n`;
const gateway: OnboardingReadinessGateway = {
  listInstallationRepos: () => undefined, getRepo: () => undefined,
  getBranchProtection: () => undefined, getBranchRules: () => undefined, getContents: () => undefined,
};

async function invoke(route: Route, repo = "owner/repo"): Promise<{ code: number; body: Record<string, unknown>; raw: string }> {
  let code = 0, raw = "";
  await route.handler({ url: `/v1/onboarding/readiness?repo=${repo}` } as never,
    { writeHead: (n: number) => { code = n; }, end: (text: string) => { raw += text; } } as never, { params: {} });
  return { code, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

function fixture(t: { after(fn: () => void): void }, selected = true) {
  const root = makeTempDir("selected-serve-consumer");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "legacy.yaml"), path = join(root, "selected.yaml");
  writeFileSync(legacy, selectedText("legacy"));
  if (selected) writeFileSync(path, selectedText());
  const rows: Row[] = [];
  const options = {
    settings: { mode: "shadow" as const, instanceName: "fixture", registryPath: path },
    record: (step: string, fields: Record<string, unknown>) => { rows.push({ step, fields }); },
  };
  const input = { repoRegistryPath: legacy, gateway, selectedRegistryObservation: options };
  return { root, legacy, path, rows, options, input, route: buildOnboardingReadinessRoute(input) };
}

async function observed(rows: Row[]): Promise<Record<string, unknown> | undefined> {
  // The real selected FS reader is asynchronous and must not delay the independent HTTP effect.
  // Bound the test's observation wait, never promote timeout to successful selected evidence.
  for (let n = 0; n < 100; n++) {
    const row = rows.find(row => row.step === STEP);
    if (row) return row.fields;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return undefined;
}

test("selected readiness observer reaches the real handler without replacing legacy output", async (t) => {
  const f = fixture(t);
  const before = await invoke(buildOnboardingReadinessRoute({ repoRegistryPath: f.legacy, gateway }));
  const actual = await invoke(f.route);
  assert.equal(actual.code, 200);
  assert.deepEqual(actual.body.checks, before.body.checks, "actual healthy legacy checks remain unchanged");
  const row = await observed(f.rows);
  assert.ok(row, "the actual handler must forward the opt-in, not merely a helper fixture");
  assert.equal(row.action, "serve-readiness");
  assert.equal(row.selected_state, "ready");
  assert.equal(row.target_repo, "owner/repo");
  assert.equal(row.publication_permission, "not-granted");
  assert.ok(!actual.raw.includes("selected-material-sentinel"));
  assert.ok(!JSON.stringify(row).includes(f.root));
});

test("selected readiness missing source stays unknown beside a healthy legacy result", async (t) => {
  const f = fixture(t, false), actual = await invoke(f.route);
  assert.equal(actual.code, 200, "SHADOW is not a blocking gate");
  assert.ok((actual.body.checks as Array<{ id: string; status: string }>).some(c => c.id === "already-onboarded" && c.status === "warn"));
  const row = await observed(f.rows);
  assert.ok(row, "missing selected source must be observed independently of healthy legacy evidence");
  assert.equal(row.selected_state, "unknown");
  assert.equal(row.reason, "missing");
  assert.equal(row.publication_permission, "not-granted");
});

test("selected readiness absent opt-in preserves legacy checks without a selected read or receipt", async (t) => {
  const f = fixture(t);
  const input = { ...f.input, selectedRegistryObservation: { ...f.options, settings: undefined,
    io: { lstat: () => assert.fail("no selected read without explicit SHADOW"), open: () => assert.fail("no selected open without explicit SHADOW") } } };
  const actual = await invoke(buildOnboardingReadinessRoute(input));
  assert.equal(actual.code, 200);
  assert.equal(f.rows.length, 0);
});

test("selected consumer effects run immediately while the selected reader is pending", async (t) => {
  const f = fixture(t), pending = Promise.withResolvers<never>();
  const observer = createSelectedRegistryObserver({ ...f.options, io: { ...registryFileIO, lstat: () => pending.promise } })!;
  t.after(() => observer.close());
  let calls = 0;
  const value = observer.observe("serve-readiness", { repository: "owner/repo" }, () => { calls++; return "legacy"; });
  assert.equal(calls, 1, "SHADOW must not await selected IO before invoking the actual effect");
  assert.equal(await value, "legacy");
  assert.equal(f.rows.length, 0, "unresolved evidence is not a successful observation");
  observer.close();
  await observer.settled();
});

test("selected consumer captures its source ports capabilities and target before awaits", async (t) => {
  const f = fixture(t), capabilities = ["identity"], io = { ...registryFileIO };
  const observer = createSelectedRegistryObserver({ ...f.options, input: { requiredCapabilities: capabilities }, io })!;
  t.after(() => observer.close());
  f.options.settings.registryPath = join(f.root, "wrong.yaml");
  capabilities[0] = "unsupported";
  io.lstat = () => assert.fail("captured IO cannot retarget through caller mutation");
  const gate = Promise.withResolvers<string>(), target = { repository: "owner/repo", instanceName: "fixture" };
  const value = observer.observe("serve-readiness", target, () => gate.promise);
  target.repository = "attacker/elsewhere";
  target.instanceName = "wrong";
  gate.resolve("legacy");
  assert.equal(await value, "legacy");
  await observer.settled();
  const row = f.rows.find(row => row.step === STEP)?.fields;
  assert.equal(row?.target_repo, "owner/repo");
  assert.equal(row?.target_instance, "fixture");
  assert.equal(row?.selected_state, "ready");
  assert.match(String(row?.binding_digest), /^[a-f0-9]{64}$/);
});

test("selected consumer holds the original digest and rechecks the real source at each adoption", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy-cached-body");
  await observer.settled();
  const digest = f.rows.at(-1)?.fields.binding_digest;
  assert.equal(f.rows.at(-1)?.fields.selected_state, "ready");
  writeFileSync(f.path, selectedText().replace("mode: shadow", "mode: live"));
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy-cached-body"), "legacy-cached-body");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "revision_changed");
  assert.equal(f.rows.at(-1)?.fields.binding_digest, digest, "never silently adopt a new source revision");
});

test("selected consumer invalid cancellation input stays unknown without replacing the legacy effect", async (t) => {
  const f = fixture(t);
  const observer = createSelectedRegistryObserver({ ...f.options, input: { signal: {} as AbortSignal } })!;
  t.after(() => observer.close());
  assert.equal(await observer.observe("serve-readiness", { repository: "owner/repo" }, () => "legacy"), "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "invalid_cancellation");
});

test("selected consumer records the actual legacy exception but rethrows its original identity", async (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  const failure = new Error("legacy-private-exception-sentinel");
  await assert.rejects(observer.observe("serve-readiness", { repository: "owner/repo" }, () => { throw failure; }), error => error === failure);
  await observer.settled();
  assert.equal(f.rows.at(-1)?.fields.legacy_outcome, "threw");
  assert.ok(!JSON.stringify(f.rows).includes(failure.message));
});

test("selected consumer synchronous seams never claim fresh selected authority", (t) => {
  const f = fixture(t), observer = createSelectedRegistryObserver({ ...f.options,
    io: { lstat: () => assert.fail("sync seam performs no selected IO"), open: () => assert.fail("sync seam performs no selected IO") } })!;
  t.after(() => observer.close());
  assert.equal(observer.observeSync("inbox-discovery", { repository: "owner/repo" }, () => "legacy"), "legacy");
  assert.equal(f.rows.at(-1)?.fields.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.fields.reason, "synchronous_seam");
});
