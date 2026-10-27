import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSweepEffects } from "../src/lib/sweep.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { createSelectedModeQualification } from "../src/lib/instance-mode.js";
import { mergeDirectViaRestAsync, realArmDeps, realArmDepsAsync, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { ghShim } from "./helpers/gh-shim.js";
import { registryFileIO } from "../src/lib/instance-registry-selection.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OBSERVED = "instance_mode.shadow_observed";
type Settings = { mode: "shadow"; instanceName: string; registryPath?: string; timeoutMs?: number };
const registry = (mode: string | undefined, privateValue = "/private/selected-mode-sentinel") => [
  "instances:", "  fixture:", "    github_repo: owner/repo",
  ...(mode === undefined ? [] : [`    mode: ${mode}`]),
  `    state_dir: ${privateValue}`, "",
].join("\n");
const pr = { prUrl: "https://github.com/owner/repo/pull/1", prNumber: 1,
  taskId: "W1-T9572", headSha: "a".repeat(40) } as OpenPrView;

function fixture(mode: string | null = "shadow", legacy: "shadow" | "live" = "live", optedIn = true,
  physical?: "armAuto" | "mergeDirect" | "enqueue") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selected-mode-consumer-`));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  writeFileSync(join(root, "ledger.ndjson"), "");
  const selected = join(root, "selected.yaml"), other = join(root, "other.yaml");
  writeFileSync(selected, registry(mode === null ? undefined : mode, root)); writeFileSync(other, registry("live", root));
  const prior = { path: process.env.RMD_INSTANCE_REGISTRY, name: process.env.RMD_INSTANCE_NAME };
  delete process.env.RMD_INSTANCE_REGISTRY; delete process.env.RMD_INSTANCE_NAME;
  const settings: Settings = { mode: "shadow", instanceName: "fixture", registryPath: selected, timeoutMs: 1500 };
  const config = { root, claudeBin: "/bin/true", installRoot: REPO_ROOT,
    ...(optedIn ? { selectedRegistryMode: settings } : {}) };
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let arms = 0;
  const deps = { owner: "owner", repo: "repo", config, ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-selected-mode-fixture", plan: loadPlanFromYaml("[]", "selected-mode consumer fixture"),
    repoMode: legacy,
    log: (step: string, fields: Record<string, unknown> = {}) => logs.push({ step, fields }),
    armImpl: async (url?: string, _task?: string, ports?: ArmDeps<true>) => {
      arms += 1;
      if (physical) { assert.ok(ports); await ports[physical]!(url!); }
      return "armed" as const;
    },
  };
  const effects = buildSweepEffects(deps);
  return { root, selected, other, settings, config, effects, logs, arms: () => arms,
    rows: () => logs.filter(row => row.step === OBSERVED).map(row => row.fields),
    cleanup: () => {
      if (prior.path === undefined) delete process.env.RMD_INSTANCE_REGISTRY;
      else process.env.RMD_INSTANCE_REGISTRY = prior.path;
      if (prior.name === undefined) delete process.env.RMD_INSTANCE_NAME;
      else process.env.RMD_INSTANCE_NAME = prior.name;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("selected mode sweep observations and actual physical defaults preserve legacy results", async (t) => {
  // The canonical run/sweep proof lives in the existing real-entrypoint shadow safety suite.
  // This narrow suite drives the production sweep and physical defaults without importing the CLI.
  for (const mode of ["shadow", "live"] as const) {
    const fx = fixture(mode);
    try {
      assert.equal(await fx.effects.arm!(pr), "armed");
      assert.equal(fx.arms(), 1, "SHADOW must preserve the real legacy result");
      assert.equal(fx.rows().at(-1)?.selected_outcome, `would-${mode}`);
      assert.equal(fx.rows().at(-1)?.legacy_outcome, "armed");
    } finally { fx.cleanup(); }
  }
  for (const method of ["armAuto", "mergeDirect", "enqueue"] as const) await t.test(`actual async ${method} transport`, async () => {
    const fx = fixture("shadow"), shim = ghShim();
    const path = process.env.PATH;
    process.env.PATH = `${shim.dir}:${path}`;
    try {
      const qualification = createSelectedModeQualification(fx.settings, "owner/repo", {},
        (step, fields) => fx.logs.push({ step, fields }));
      assert.ok(qualification);
      // The second constructor argument is deliberately ignored by the pre-fix production
      // default. Reflect.apply lets this behavioral red reach that real method without a fake.
      const deps = Reflect.apply(realArmDepsAsync, undefined, [() => fx.config, qualification]) as ArmDeps<true>;
      await withLiveWritesAllowed(async () => { await deps[method]!(pr.prUrl); });
      assert.equal(shim.calls().length, 1, "exactly one real default child, contained by the PATH shim");
      const action = method === "armAuto" ? "arm" : method === "mergeDirect" ? "direct-merge" : "queue";
      assert.equal(fx.rows().find(row => row.action === action)?.selected_outcome, "would-shadow");
      assert.equal(fx.rows().find(row => row.action === action)?.publication_permission, "not-granted");
    } finally { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); fx.cleanup(); }
  });
});

test("selected mode evidence never falls back after explicit failure", async () => {
  const fx = fixture(null);
  try {
    assert.equal(/^\s+mode:/m.test(readFileSync(fx.selected, "utf8")), false, "actual missing-mode input control");
    assert.equal(await fx.effects.arm!(pr), "armed", "healthy legacy effects remain unchanged");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "mode_missing");
    assert.equal(fx.arms(), 1);
  } finally { fx.cleanup(); }
});

test("selected mode revisions invalidate deferred arm observations", async () => {
  const fx = fixture("live");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    const original = fx.rows().at(-1)?.binding_digest;
    assert.equal(typeof original, "string");
    writeFileSync(fx.selected, registry("shadow", fx.root));
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "revision_changed");
    assert.equal(fx.rows().at(-1)?.binding_digest, original, "do not retarget the original binding");
    assert.equal(fx.arms(), 2);
  } finally { fx.cleanup(); }
});

test("selected mode recheck preserves a real reader refusal cause", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    const original = fx.rows().at(-1)?.binding_digest;
    const current = readFileSync(fx.selected, "utf8");
    assert.ok(current.includes("    state_dir:"), "the actual selected row is present");
    writeFileSync(fx.selected, current.replace("    state_dir:", "    future_field: unexpected\n    state_dir:"));
    assert.equal(await fx.effects.arm!(pr), "armed", "SHADOW must preserve the independent legacy effect");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "unsupported_field", "retain the real reader's cause, not a generic revision change");
    assert.equal(fx.rows().at(-1)?.binding_digest, original);
    assert.equal(fx.arms(), 2);
  } finally { fx.cleanup(); }
});

test("selected mode snapshots survive caller and transport mutation", async () => {
  const fx = fixture("shadow");
  try {
    fx.settings.registryPath = fx.other;
    fx.settings.instanceName = "another-instance";
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-shadow");
    assert.equal(fx.rows().at(-1)?.legacy_outcome, "armed");
  } finally { fx.cleanup(); }
});

test("selected mode shadow unknown preserves owner and trusted legacy effects", async () => {
  for (const legacy of ["shadow", "live"] as const) {
    const fx = fixture(null, legacy);
    try {
      assert.equal(/^\s+mode:/m.test(readFileSync(fx.selected, "utf8")), false, "actual missing-mode input control");
      const outcome = await fx.effects.arm!(pr);
      assert.equal(outcome, legacy === "shadow" ? "shadow-refused" : "armed");
      assert.equal(fx.arms(), legacy === "shadow" ? 0 : 1);
      assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
      assert.equal(fx.rows().at(-1)?.legacy_outcome, outcome);
    } finally { fx.cleanup(); }
  }
});

test("selected mode defaults stay bounded asynchronous and private", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(readFileSync(fx.selected, "utf8").includes(fx.root), true, "private-value control");
    let pulsed = false;
    const pulse = new Promise<void>(resolve => setImmediate(() => { pulsed = true; resolve(); }));
    assert.equal(await fx.effects.arm!(pr), "armed"); await pulse;
    assert.equal(pulsed, true);
    assert.ok(fx.rows().length > 0, "real default selected filesystem read must reach this consumer");
    assert.equal(JSON.stringify(fx.rows()).includes(fx.root), false);
    assert.equal(JSON.stringify(fx.rows()).includes("selected.yaml"), false);
    assert.equal(fx.rows().at(-1)?.publication_permission, "not-granted");
  } finally { fx.cleanup(); }
});

test("selected mode shadow qualification never activates selected permissions", async () => {
  const legacy = fixture("shadow", "live", false);
  try {
    process.env.RMD_INSTANCE_REGISTRY = legacy.selected;
    assert.equal(await legacy.effects.arm!(pr), "armed");
    assert.equal(legacy.arms(), 1); assert.equal(legacy.rows().length, 0, "environment alone is not opt-in");
  } finally { legacy.cleanup(); }
  const observed = fixture("shadow");
  try {
    assert.equal(await observed.effects.arm!(pr), "armed");
    assert.equal(observed.rows().at(-1)?.selected_outcome, "would-shadow");
    assert.equal(observed.rows().at(-1)?.publication_permission, "not-granted");
    assert.equal(observed.arms(), 1, "a would-shadow observation is not an enforced hold");
  } finally { observed.cleanup(); }
});

test("selected mode production sweep roots forward to each real physical default", async (t) => {
  for (const physical of ["armAuto", "mergeDirect", "enqueue"] as const) await t.test(physical, async () => {
    const fx = fixture("shadow", "live", true, physical), shim = ghShim(), path = process.env.PATH;
    process.env.PATH = `${shim.dir}:${path}`;
    try {
      assert.equal(await withLiveWritesAllowed(() => fx.effects.arm!(pr)), "armed");
      const action = physical === "armAuto" ? "arm" : physical === "mergeDirect" ? "direct-merge" : "queue";
      const row = fx.rows().find(row => row.action === action);
      assert.equal(row?.selected_outcome, "would-shadow", "the actual composition root must forward to the actual write");
      assert.equal(row?.publication_permission, "not-granted");
      assert.equal(shim.calls().length, 1, "one contained real default transport");
    } finally { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); fx.cleanup(); }
  });
});

test("selected mode observations bind each real target and never dedupe another PR", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(await fx.effects.arm!({ ...pr, prUrl: "https://github.com/owner/repo/pull/2", prNumber: 2 }), "armed");
    assert.equal(fx.rows().length, 2, "distinct PR effects cannot disappear behind an identical mode/result");
    assert.deepEqual(fx.rows().map(row => [row.target_repo, row.target_pr]), [["owner/repo", 1], ["owner/repo", 2]]);
    assert.equal(await fx.effects.arm!({ ...pr, prUrl: "https://github.com/other/repo/pull/3", prNumber: 3 }), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "target_mismatch");
    assert.equal(fx.arms(), 3, "mismatched observation never blocks the independent SHADOW effect");
  } finally { fx.cleanup(); }
});

test("selected mode hostile opt-in and receipt mutation never change legacy effects", async () => {
  const fx = fixture("shadow");
  try {
    const settings = Object.defineProperty({}, "mode", { get() { throw new Error(fx.root); } }) as Settings;
    let row: Record<string, unknown> | undefined, calls = 0;
    const q = createSelectedModeQualification(settings, "owner/repo", {}, (_step, fields) => { row = fields; });
    assert.ok(q, "unreadable opt-in is unknown, not an uncaught effect failure");
    assert.equal(await Reflect.apply(q.observe, q, ["arm", () => { calls++; return "armed"; }, pr.prUrl]), "armed");
    assert.equal(row?.reason, "input_unreadable");
    assert.equal(Object.isFrozen(row), true, "sinks cannot mutate the immutable redacted observation");
    assert.equal(Reflect.set(row!, "publication_permission", "granted"), false);
    assert.equal(calls, 1); assert.equal(JSON.stringify(row).includes(fx.root), false);
  } finally { fx.cleanup(); }
});


test("selected mode unknown catches and sinks preserve the exact independent operation", async (t) => {
  const fx = fixture("shadow");
  try {
    const rows: Array<Record<string, unknown>> = [];
    const record = (_step: string, row: Record<string, unknown>) => { rows.push(row); };
    await t.test("input port getter", async () => {
      const io = Object.defineProperty({}, "lstat", { get() { throw new Error(fx.root); } }) as typeof registryFileIO;
      const q = createSelectedModeQualification(fx.settings, "owner/repo", {}, record, io)!;
      assert.equal(await q.observe("arm", () => "armed", pr.prUrl), "armed");
      assert.equal(rows.at(-1)?.reason, "input_unreadable");
    });
    await t.test("initial rejection", async () => {
      const signal = Object.defineProperty({}, "aborted", { get() { throw new Error(fx.root); } }) as AbortSignal;
      const q = createSelectedModeQualification(fx.settings, "owner/repo", { signal }, record)!;
      assert.equal(await q.observe("arm", () => "armed", pr.prUrl), "armed");
      assert.equal(rows.at(-1)?.reason, "read_failed");
    });
    await t.test("recheck rejection", async () => {
      let unreadable = false;
      const signal = { get aborted() { if (unreadable) throw new Error(fx.root); return false; },
        addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
      const q = createSelectedModeQualification(fx.settings, "owner/repo", { signal }, record)!;
      await q.observe("arm", () => "armed", pr.prUrl);
      assert.equal(rows.at(-1)?.selected_outcome, "would-shadow", "the initial real file read is a positive control");
      unreadable = true;
      await q.observe("arm", () => "armed", pr.prUrl);
      assert.equal(rows.at(-1)?.reason, "recheck_failed");
    });
    await t.test("hostile result and original throw", async () => {
      const q = createSelectedModeQualification(fx.settings, "owner/repo", {}, record)!;
      const result = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(fx.root); } });
      assert.equal(await q.observe("arm", () => result, pr.prUrl), result);
      assert.equal(rows.at(-1)?.legacy_outcome, "result-unreadable");
      const error = new Error("actual operation identity");
      await assert.rejects(q.observe("arm", () => { throw error; }, pr.prUrl), caught => caught === error);
      assert.equal(rows.at(-1)?.legacy_outcome, "threw");
    });
    await t.test("rejected async sink", async () => {
      const errors: unknown[][] = [], consoleSpy = t.mock.method(console, "error", (...values: unknown[]) => { errors.push(values); });
      try {
        const q = createSelectedModeQualification(fx.settings, "owner/repo", {}, async () => { throw new Error(fx.root); })!;
        assert.equal(await q.observe("arm", () => "armed", pr.prUrl), "armed");
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(errors, [["instance_mode.shadow_observation_unrecorded"]]);
      } finally { consoleSpy.mock.restore(); }
    });
    await t.test("unavailable sink diagnostic", async () => {
      const consoleSpy = t.mock.method(console, "error", () => { throw new Error("diagnostic unavailable"); });
      try {
        const q = createSelectedModeQualification(fx.settings, "owner/repo", {}, () => { throw new Error(fx.root); })!;
        assert.equal(await q.observe("arm", () => "armed", pr.prUrl), "armed");
        const original = new Error("independent operation");
        await assert.rejects(q.observe("arm", () => { throw original; }, pr.prUrl), error => error === original);
      } finally { consoleSpy.mock.restore(); }
    });
    assert.equal(JSON.stringify(rows).includes(fx.root), false);
  } finally { fx.cleanup(); }
});

test("selected mode refuses missing invalid and retired evidence without changing shadow effects", async (t) => {
  for (const item of [
    { label: "no selection", settings: { registryPath: undefined }, reason: "selection_missing" },
    { label: "explicit empty path", settings: { registryPath: "" }, reason: "invalid_path" },
    { label: "missing instance", settings: { instanceName: undefined }, reason: "invalid_instance" },
    { label: "wrong instance", settings: { instanceName: "another" }, reason: "instance_missing_or_ambiguous" },
    { label: "retired instance", content: registry("shadow").replace("    github_repo:", "    retired: true\n    github_repo:"), reason: "instance_retired" },
    { label: "unsupported contract", settings: { contractVersion: 99 }, reason: "unsupported_contract" },
    { label: "invalid deadline", settings: { timeoutMs: 0 }, reason: "invalid_bounds" },
    { label: "malformed bytes", content: "instances: not-a-row\n", reason: "malformed" },
  ]) await t.test(item.label, async () => {
    const fx = fixture("shadow"), rows: Array<Record<string, unknown>> = [];
    try {
      if (item.content !== undefined) writeFileSync(fx.selected, item.content);
      const q = createSelectedModeQualification({ ...fx.settings, ...item.settings }, "owner/repo", {}, (_step, row) => { rows.push(row); })!;
      assert.equal(await q.observe("arm", () => "armed", pr.prUrl), "armed");
      assert.equal(rows.at(-1)?.selected_outcome, "would-refuse");
      assert.equal(rows.at(-1)?.reason, item.reason); assert.equal(rows.at(-1)?.publication_permission, "not-granted");
    } finally { fx.cleanup(); }
  });
});

test("selected mode synchronous seams remain unknown and never create a selected read", async () => {
  const fx = fixture("shadow"), rows: Array<Record<string, unknown>> = [];
  let reads = 0, effects = 0;
  try {
    const q = createSelectedModeQualification(fx.settings, "owner/repo", {}, (_step, row) => { rows.push(row); },
      { lstat: async path => { reads++; return registryFileIO.lstat(path); }, open: registryFileIO.open }, "sync")!;
    assert.equal(q.observeSync("arm", () => { effects++; return "armed"; }, pr.prUrl), "armed");
    assert.equal(await q.observe("arm", () => { effects++; return "armed"; }, pr.prUrl), "armed");
    assert.equal(reads, 0); assert.equal(effects, 2); assert.equal(rows.length, 1, "unchanged cause stays quiet");
    assert.equal(rows[0]?.reason, "synchronous_seam");
    await q.observe("arm", () => "armed", "https://github.com/owner/repo/pull/0");
    assert.equal(rows.at(-1)?.reason, "target_unavailable");
    const original = new Error("sync effect");
    assert.throws(() => q.observeSync("arm", () => { throw original; }, pr.prUrl), error => error === original);
  } finally { fx.cleanup(); }
});

test("selected mode snapshots real input and handle methods across pending filesystem work", { timeout: 30_000 }, async () => {
  const fx = fixture("shadow"), rows: Array<Record<string, unknown>> = [];
  let release!: () => void, entered!: () => void, handle: Awaited<ReturnType<typeof registryFileIO.open>> | undefined, closed = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const io = { ...registryFileIO, open: async (path: string) => {
    const real = await registryFileIO.open(path);
    handle = { stat: async () => { entered(); await barrier; return real.stat(); }, read: real.read,
      close: async () => { closed++; await real.close(); } };
    return handle;
  } };
  const caps = ["identity"], input = { requiredCapabilities: caps };
  try {
    const q = createSelectedModeQualification(fx.settings, "owner/repo", input, (_step, row) => { rows.push(row); }, io)!;
    const pending = q.observe("arm", () => "armed", pr.prUrl);
    await started;
    caps.push("unsupported"); fx.settings.registryPath = fx.other;
    io.open = async () => { throw new Error(fx.root); };
    handle!.read = async () => { throw new Error(fx.root); }; handle!.close = async () => { throw new Error(fx.root); };
    release(); assert.equal(await pending, "armed");
    assert.equal(rows.at(-1)?.selected_outcome, "would-shadow"); assert.equal(closed, 2, "initial read and final recheck close their captured real handles");
  } finally { release(); fx.cleanup(); }
});

test("selected mode cancellation returns unknown while late real handles still close", { timeout: 30_000 }, async () => {
  const fx = fixture("shadow"), rows: Array<Record<string, unknown>> = [], controller = new AbortController();
  let release!: () => void, entered!: () => void, didClose!: () => void, closed = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const closing = new Promise<void>(resolve => { didClose = resolve; });
  try {
    const q = createSelectedModeQualification(fx.settings, "owner/repo", { signal: controller.signal }, (_step, row) => { rows.push(row); },
      { ...registryFileIO, open: async path => {
        const real = await registryFileIO.open(path); entered(); await barrier;
        return { ...real, close: async () => { closed++; await real.close(); didClose(); } };
      } })!;
    const pending = q.observe("arm", () => "armed", pr.prUrl);
    await started; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, 0, "real default filesystem handle is demonstrably in flight");
    controller.abort(); assert.equal(await pending, "armed"); assert.equal(rows.at(-1)?.reason, "cancelled");
    release(); await closing; assert.equal(closed, 1);
  } finally { release(); fx.cleanup(); }
});

test("selected mode armed-idle root carries its binding through the independent REST merge", async () => {
  const fx = fixture("shadow", "live", true, "mergeDirect"), shim = ghShim(), path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  try {
    assert.equal(await withLiveWritesAllowed(() => fx.effects.arm!(pr, "armed-idle")), "armed");
    assert.equal(fx.rows().find(row => row.action === "direct-merge")?.selected_outcome, "would-shadow");
    assert.equal(shim.calls().length, 1);
    assert.match(shim.calls()[0]!, /repos\/owner\/repo\/pulls\/1\/merge/);
    assert.ok(shim.calls()[0]!.includes(pr.headSha!), "the original real expected-head guard survives the custom direct path");
  } finally { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); fx.cleanup(); }
});

test("selected mode rechecks after actual asynchronous security admission before the REST effect", async () => {
  const fx = fixture("shadow"), rows: Array<Record<string, unknown>> = [];
  const url = "https://github.com/craigoley/remudero/pull/11468", head = "a".repeat(40), base = "b".repeat(40);
  const content = (mode: string) => registry(mode, fx.root).replace("owner/repo", "craigoley/remudero");
  writeFileSync(fx.selected, content("shadow"));
  let writes = 0, reads = 0;
  try {
    const q = createSelectedModeQualification(fx.settings, "craigoley/remudero", {}, (_step, row) => { rows.push(row); })!;
    await q.observe("arm", () => "armed", url);
    assert.equal(rows.at(-1)?.selected_outcome, "would-shadow", "real selected source is initially bound");
    const original = rows.at(-1)?.binding_digest;
    await mergeDirectViaRestAsync(url, async (_file, args) => {
      writes++; assert.ok(args.includes(`sha=${head}`));
    }, async path => {
      reads++; await new Promise<void>(resolve => setImmediate(resolve));
      writeFileSync(fx.selected, content("live"));
      if (path.includes("/files?")) return [{ filename: "src/a.ts" }];
      if (path.includes("/check-runs?")) return { total_count: 1, check_runs: [{ id: 1, name: "CodeQL", head_sha: head,
        status: "completed", conclusion: "success", app: { id: 57789, slug: "github-advanced-security", owner: { login: "github" } },
        output: { title: "No new alerts in code changed by this pull request",
          summary: "[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen)." } }] };
      return { state: "open", head: { sha: head }, base: { sha: base, ref: "main", repo: { full_name: "craigoley/remudero" } }, changed_files: 1 };
    }, head, q, () => {});
    assert.ok(reads > 0); assert.equal(writes, 1, "SHADOW observes, it does not deny the security-approved independent effect");
    assert.equal(rows.at(-1)?.selected_outcome, "would-refuse"); assert.equal(rows.at(-1)?.reason, "revision_changed");
    assert.equal(rows.at(-1)?.binding_digest, original); assert.equal(rows.at(-1)?.publication_permission, "not-granted");
  } finally { fx.cleanup(); }
});

test("selected mode actual synchronous defaults preserve unknown and absent-context writes", async (t) => {
  for (const optedIn of [false, true]) for (const method of ["armAuto", "mergeDirect", "enqueue"] as const) {
    await t.test(`${method} opt-in ${optedIn}`, () => {
      const fx = fixture("shadow"), shim = ghShim(), path = process.env.PATH;
      process.env.PATH = `${shim.dir}:${path}`;
      try {
        const q = optedIn ? createSelectedModeQualification(fx.settings, "owner/repo", {},
          (step, fields) => { fx.logs.push({ step, fields }); }, registryFileIO, "sync") : undefined;
        const ports = realArmDeps(() => fx.config, q);
        withLiveWritesAllowed(() => ports[method]!(pr.prUrl));
        assert.equal(shim.calls().length, 1, "the same real synchronous transport, contained by the PATH fixture");
        if (optedIn) {
          assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
          assert.equal(fx.rows().at(-1)?.reason, "synchronous_seam");
          assert.equal(fx.rows().at(-1)?.publication_permission, "not-granted");
        } else assert.equal(fx.rows().length, 0, "absent context adds neither selected reads nor receipts");
      } finally { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); fx.cleanup(); }
    });
  }
});
