import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { boundedGardenPassSpawn, childGardenPassSpawn, startGardenOffLoop } from "#src/lib/garden-registry.js";
import type { GardenerRuntimeEvent } from "#src/lib/gardener-runtime.js";
import { appendLedger } from "#src/lib/ledger.js";
import { LIVE_LEDGER_DENY_ROOT_ENV } from "#src/lib/live-write-guard.js";
import * as origin from "#src/lib/worker-containment.js";

const passId = "a5142db1-3dab-4f50-8f8f-a25cfb8e8db1";
// Namespace import lets the canonical executor load this test on the old module:
// absent carrier exports must fail an assertion, not cause an import-unknown verdict.
const GARDENER_ORIGIN_ENV = "REMUDERO_GARDENER_ORIGIN";
const carrier = JSON.stringify({ version: 1, name: "plan", passId });
const linked = { state: "linked", version: 1, name: "plan", passId };
async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "rmd-garden-origin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function records(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8")).trim().split("\n").map(row => JSON.parse(row));
}

test("gardener origin is a bounded closed correlation carrier and never raw environment data", () => {
  assert.equal(origin.GARDENER_ORIGIN_ENV, GARDENER_ORIGIN_ENV);
  const { GARDENER_ORIGIN_MAX_BYTES, gardenerOriginEnv, readGardenerOrigin } = origin;
  assert.equal(gardenerOriginEnv("plan", passId), carrier);
  assert.equal(readGardenerOrigin({}), undefined);
  assert.equal(gardenerOriginEnv("plan", undefined), undefined);
  assert.deepEqual(readGardenerOrigin({ [GARDENER_ORIGIN_ENV]: carrier }), linked);
  for (const value of ["", "not-json-secret", "null", "[]", "1", JSON.stringify({ version: 2, name: "plan", passId }),
    JSON.stringify({ version: 1, name: "plan", passId, privateToken: "secret" }),
    JSON.stringify({ version: 1, name: ["plan"], passId }),
    JSON.stringify({ version: 1, name: "plan\nsecret", passId }),
    JSON.stringify({ version: 1, name: "plan", passId: "other-run" }),
    JSON.stringify({ version: 1, name: "plan", passId: [] }), "x".repeat(GARDENER_ORIGIN_MAX_BYTES + 1),
    JSON.stringify({ version: 1, name: "x".repeat(64), passId }).replace(/x/g, "é")]) {
    assert.deepEqual(readGardenerOrigin({ [GARDENER_ORIGIN_ENV]: value }), { state: "invalid", reason: "malformed" });
  }
});

test("a garden child ledger stamps its process context without rewriting cost run task repo or authority", async (t) => {
  const path = join(await scratch(t), "ledger.ndjson");
  const previous = process.env[GARDENER_ORIGIN_ENV];
  t.after(() => { if (previous === undefined) delete process.env[GARDENER_ORIGIN_ENV]; else process.env[GARDENER_ORIGIN_ENV] = previous; });
  process.env[GARDENER_ORIGIN_ENV] = carrier;
  const row = { run_id: "child-1", task_id: "W1-T1", repo: "acme/app", step: "worker.done", cost_usd: 0.25,
    gardener_origin: { state: "linked", version: 1, name: "forged", passId: "forged" } };
  appendLedger(path, row);
  const [seen] = await records(path);
  assert.deepEqual(seen!.gardener_origin, linked);
  for (const key of ["run_id", "task_id", "repo", "step", "cost_usd"]) assert.equal(seen![key], row[key as keyof typeof row]);
  assert.equal(seen!.actor, "test");
  assert.equal(seen!.actor_pid, process.pid);
  delete process.env[GARDENER_ORIGIN_ENV];
  appendLedger(path, row);
  assert.equal("gardener_origin" in (await records(path))[1]!, false, "an unscoped process cannot stamp the caller's forged origin");
  process.env[GARDENER_ORIGIN_ENV] = "secret-malformed-carrier";
  appendLedger(path, row);
  assert.deepEqual((await records(path))[2]!.gardener_origin, { state: "invalid", reason: "malformed" });
  assert.equal((await readFile(path, "utf8")).includes("secret-malformed-carrier"), false);
});

test("a real queued garden child links priced and unpriced ledger rows to its parent lifecycle", async (t) => {
  const dir = await scratch(t), path = join(dir, "ledger.ndjson"), entry = join(dir, "pass.mts");
  const moduleUrl = new URL("../src/lib/ledger.ts", import.meta.url).href;
  // Real default spawn and real default writer, no fake worker or writer. This local probe
  // makes no provider call; it tests attribution, not a billed model or measured ROI.
  await writeFile(entry, `import {appendLedger} from ${JSON.stringify(moduleUrl)};
    appendLedger(${JSON.stringify(path)}, {run_id:'child', task_id:'W1-T1', step:'worker.done', repo:'acme/app', cost_usd:0.25});
    appendLedger(${JSON.stringify(path)}, {run_id:'unpriced-child', task_id:'W1-T2', step:'worker.done', repo:'acme/app'});
  `);
  const observed: GardenerRuntimeEvent[] = [];
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  const previous = process.env[GARDENER_ORIGIN_ENV];
  const child = childGardenPassSpawn({ execPath: process.execPath, execArgv: ["--import", "tsx"],
    entry, cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, [GARDENER_ORIGIN_ENV]: carrier } });
  const garden = startGardenOffLoop("config", 60_000, { spawnPass: boundedGardenPassSpawn(child, 1), log: () => {},
    observe: event => { observed.push(event); if (["completed", "failed", "cancelled"].includes(event.phase)) done(); } });
  t.after(() => garden.stop());
  await completed;
  const parent = observed.find(row => row.phase === "completed");
  assert.ok(parent, JSON.stringify(observed));
  assert.ok(parent.passId && parent.passId !== passId, "a new pass must not borrow the inherited pass");
  assert.deepEqual(observed.map(row => row.phase), ["queued", "running", "completed"]);
  const seen = await records(path);
  assert.equal(seen.length, 2);
  for (const row of seen) assert.deepEqual(row.gardener_origin, { state: "linked", version: 1, name: "config", passId: parent.passId });
  assert.equal(seen[0]!.cost_usd, 0.25);
  assert.equal("cost_usd" in seen[1]!, false, "unpriced remains unknown, never synthesized zero");
  assert.equal(process.env[GARDENER_ORIGIN_ENV], previous, "child carrier construction cannot mutate the parent's environment");
});

test("direct garden spawns clear inherited origins and concurrent children never share a pass identity", async (t) => {
  const dir = await scratch(t), entry = join(dir, "pass.mts");
  await writeFile(entry, `import {appendLedger} from ${JSON.stringify(new URL("../src/lib/ledger.ts", import.meta.url).href)};
    appendLedger(${JSON.stringify(join(dir, "ledger.ndjson"))}, {run_id:process.argv[4],task_id:'DAEMON',step:'garden.probe'});`);
  const spawn = childGardenPassSpawn({ execPath: process.execPath, execArgv: ["--import", "tsx"], entry,
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, [GARDENER_ORIGIN_ENV]: carrier } });
  const other = "e6921695-5c56-45c2-89f4-1f1e4d67c826";
  assert.deepEqual(await Promise.all([spawn("plan", [], { stopped: false, passId }),
    spawn("gate", [], { stopped: false, passId: other }), spawn("test", [], { stopped: false })]), [0, 0, 0]);
  const seen = await records(join(dir, "ledger.ndjson"));
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.find(row => row.run_id === "plan")!.gardener_origin, linked);
  assert.deepEqual(seen.find(row => row.run_id === "gate")!.gardener_origin, { state: "linked", version: 1, name: "gate", passId: other });
  assert.equal("gardener_origin" in seen.find(row => row.run_id === "test")!, false);
});

// These probes import worker code only in a new process whose HOME/TMPDIR are already
// private. queryFn alone does not isolate credential seeding or resource bookkeeping.
async function sdkGardenProbe(t: TestContext, body: (dir: string) => string, tokenFixture = false) {
  const dir = await scratch(t), entry = join(dir, "sdk-pass.mts");
  const temp = join(dir, "tmp"), home = join(temp, "home"), cache = join(temp, "cache"), root = join(temp, "root");
  await mkdir(temp);
  await Promise.all([home, cache, root].map(path => mkdir(path)));
  assert.ok(process.env.NODE_TEST_CONTEXT, "the native test runner supplies the actual guard context");
  assert.ok(process.env[LIVE_LEDGER_DENY_ROOT_ENV], "native tmp-hygiene pins the actual live denial root");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LANG: process.env.LANG, HOME: home, TMPDIR: temp,
    XDG_CACHE_HOME: cache, RMD_GH_CACHE_HOME: cache,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    [LIVE_LEDGER_DENY_ROOT_ENV]: process.env[LIVE_LEDGER_DENY_ROOT_ENV],
  };
  if (tokenFixture) env.CLAUDE_CODE_OAUTH_TOKEN = "W9494-FAKE-NOT-A-CREDENTIAL";
  await writeFile(entry, body(dir));
  const observed: GardenerRuntimeEvent[] = [];
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  const child = childGardenPassSpawn({ execPath: process.execPath,
    execArgv: ["--import", import.meta.resolve("tsx")], entry, cwd: root, root, env });
  const garden = startGardenOffLoop("config", 60_000, { spawnPass: boundedGardenPassSpawn(child, 1), log: () => {},
    observe: event => { observed.push(event); if (["completed", "failed", "cancelled"].includes(event.phase)) done(); } });
  t.after(() => garden.stop());
  await completed;
  garden.stop();
  const parent = observed.find(event => event.phase === "completed");
  assert.ok(parent?.passId, `private real garden must finish: ${JSON.stringify(observed)}`);
  assert.notEqual(parent.passId, passId, "this is a newly generated pass, not the old fixture UUID");
  assert.deepEqual(observed.map(event => event.phase), ["queued", "running", "completed"]);
  return { dir, expected: { state: "linked", version: 1, name: "config", passId: parent.passId } };
}

test("SDK gardener origin default child ledger", async (t) => {
  const envUrl = new URL("../src/lib/env.ts", import.meta.url).href;
  const ledgerUrl = new URL("../src/lib/ledger.ts", import.meta.url).href;
  const originUrl = new URL("../src/lib/worker-containment.ts", import.meta.url).href;
  const tsxUrl = import.meta.resolve("tsx");
  const previous = process.env[GARDENER_ORIGIN_ENV];
  const { dir, expected } = await sdkGardenProbe(t, dir => `
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    import {buildWorkerEnv} from ${JSON.stringify(envUrl)};
    import {GARDENER_ORIGIN_ENV,readGardenerOrigin} from ${JSON.stringify(originUrl)};
    const inherited = readGardenerOrigin();
    assert.equal(inherited?.state,'linked');
    assert.ok(process.env.NODE_TEST_CONTEXT);
    const descendant = ${JSON.stringify(join(dir, "ledger-child.mts"))};
    writeFileSync(descendant, ${JSON.stringify(`
      import {appendLedger} from ${JSON.stringify(ledgerUrl)};
      const mode = process.argv[2];
      appendLedger(${JSON.stringify(join(dir, "tmp", "sdk-ledger.ndjson"))},
        {run_id:mode+'-priced',task_id:'W1-T1',repo:'acme/app',step:'worker.done',cost_usd:0.25});
      appendLedger(${JSON.stringify(join(dir, "tmp", "sdk-ledger.ndjson"))},
        {run_id:mode+'-unpriced',task_id:'W1-T2',repo:'acme/app',step:'worker.done'});
    `)});
    // Explicit-extra compatibility is a positive control even before the fix.
    const withoutAmbient = {...process.env};
    delete withoutAmbient[GARDENER_ORIGIN_ENV];
    for (const mode of ['explicit','default','absent','invalid']) {
      const built = mode === 'explicit'
        ? buildWorkerEnv({[GARDENER_ORIGIN_ENV]:process.env[GARDENER_ORIGIN_ENV]},withoutAmbient)
        : mode === 'absent' ? buildWorkerEnv({},withoutAmbient)
        : mode === 'invalid' ? buildWorkerEnv({[GARDENER_ORIGIN_ENV]:process.env[GARDENER_ORIGIN_ENV]},
          {...process.env,[GARDENER_ORIGIN_ENV]:'W9494-fixture-secret-invalid-parent'})
        : buildWorkerEnv();
      const childEnv = {...built,NODE_TEST_CONTEXT:process.env.NODE_TEST_CONTEXT};
      assert.equal(childEnv[GARDENER_ORIGIN_ENV],built[GARDENER_ORIGIN_ENV]);
      // No carrier is patched into childEnv. The only addition is the real test guard.
      execFileSync(process.execPath,['--import',${JSON.stringify(tsxUrl)},descendant,mode],
        {cwd:${JSON.stringify(join(dir, "tmp", "root"))},env:childEnv,timeout:10_000,stdio:'pipe'});
    }
  `);
  const ledgerPath = join(dir, "tmp", "sdk-ledger.ndjson");
  const seen = await records(ledgerPath);
  assert.equal(seen.length, 8, "all four real descendant modes reached the default writer twice");
  assert.equal((await readFile(ledgerPath, "utf8")).includes("W9494-fixture-secret"), false);
  for (const mode of ["explicit", "default", "absent", "invalid"]) {
    const priced = seen.find(row => row.run_id === `${mode}-priced`)!;
    const unpriced = seen.find(row => row.run_id === `${mode}-unpriced`)!;
    assert.ok(priced && unpriced);
    assert.equal(priced.task_id, "W1-T1");
    assert.equal(unpriced.task_id, "W1-T2");
    assert.equal(priced.cost_usd, 0.25);
    assert.equal("cost_usd" in unpriced, false, "unpriced is unknown, not zero");
    for (const row of [priced, unpriced]) {
      assert.equal(row.repo, "acme/app");
      assert.equal(row.step, "worker.done");
      assert.equal(row.actor, "test");
      assert.ok(Number(row.actor_pid) > 0 && row.actor_pid !== process.pid, "a real descendant wrote the row");
    }
  }
  const explicit = seen.filter(row => String(row.run_id).startsWith("explicit-"));
  for (const row of explicit) assert.deepEqual(row.gardener_origin, expected, "explicit-extra positive remains linked");
  t.diagnostic(JSON.stringify({ proof: "SDK gardener origin default child ledger", generatedParent: expected,
    defaultWriterReached: true, rows: seen.map(({ run_id, task_id, actor_pid, gardener_origin, cost_usd }) =>
      ({ run_id, task_id, actor_pid, gardener_origin, ...(cost_usd === undefined ? {} : { cost_usd }) })),
    explicitExtraControl: "PASS", unpricedFieldsAbsent: true }));
  assert.equal(process.env[GARDENER_ORIGIN_ENV], previous, "private probes do not change the test's ambient parent");
  for (const row of seen.filter(row => String(row.run_id).startsWith("default-"))) {
    assert.deepEqual(row.gardener_origin, expected, "default builder must carry the actual generated parent into the real writer");
  }
  for (const row of seen.filter(row => String(row.run_id).startsWith("absent-"))) {
    assert.equal(Object.hasOwn(row, "gardener_origin"), false, "missing remains missing in the real child writer");
  }
  for (const row of seen.filter(row => String(row.run_id).startsWith("invalid-"))) {
    assert.deepEqual(row.gardener_origin, { state: "invalid", reason: "malformed" }, "valid extras cannot conceal an invalid ambient parent");
  }
});

interface SdkCallerObservation {
  mode: "explicit" | "default" | "conflict" | "invalid";
  kind: "query" | "containment";
  queryCalls: number;
  containmentCalls: number;
  sdkOrigin?: origin.GardenerOrigin;
  containedOrigin?: origin.GardenerOrigin;
  sdkCarrier?: string;
  containedCarrier?: string;
  sameEnv: boolean;
  runId: string;
  taskId: string;
  scope: string;
  expectedScope: string;
  containedRunId?: string;
  containedTaskId?: string;
  containedScope?: string;
  settingSources: unknown[];
  settingsSameInput: boolean;
  settingsSandbox: unknown;
  inlineSandboxPresent: boolean;
  inlineSandbox?: unknown;
  permissionMode: string;
  billing: string;
  homePrivate: boolean;
  cachePrivate: boolean;
  homeReaped: boolean;
}

test("SDK gardener origin actual caller handoff", async (t) => {
  const workerUrl = new URL("../src/lib/worker.ts", import.meta.url).href;
  const envUrl = new URL("../src/lib/env.ts", import.meta.url).href;
  const originUrl = new URL("../src/lib/worker-containment.ts", import.meta.url).href;
  const previous = process.env[GARDENER_ORIGIN_ENV];
  const { dir, expected } = await sdkGardenProbe(t, dir => `
    import assert from 'node:assert/strict';
    import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {spawnWorker,createClaudeExecutableCache,CLAUDE_BIN_ENV_OVERRIDE} from ${JSON.stringify(workerUrl)};
    import {billingMode} from ${JSON.stringify(envUrl)};
    import {GARDENER_ORIGIN_ENV,readGardenerOrigin,RUN_ID_ENV,TASK_ID_ENV,WORKER_SCOPE_ENV,workerInstallationScope}
      from ${JSON.stringify(originUrl)};
    assert.ok(process.env.NODE_TEST_CONTEXT);
    const inherited = process.env[GARDENER_ORIGIN_ENV];
    assert.equal(readGardenerOrigin()?.state,'linked');
    const conflicting = JSON.stringify({version:1,name:'gate',passId:'e6921695-5c56-45c2-89f4-1f1e4d67c826'});
    assert.equal(readGardenerOrigin({[GARDENER_ORIGIN_ENV]:conflicting})?.state,'linked');
    assert.notEqual(conflicting,inherited,'conflict control names a different valid parent');
    const root = ${JSON.stringify(join(dir, "tmp", "root"))};
    const settingsFile = ${JSON.stringify(join(dir, "worker.json"))};
    writeFileSync(settingsFile,JSON.stringify({sandbox:{enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false}}));
    const observations = [];
    for (const mode of ['explicit','default','conflict','invalid']) for (const kind of ['query','containment']) {
      let queryCalls = 0,containmentCalls = 0,capturedOptions,capturedSpawn;
      const marker = new Error('W9494-private-containment-capture');
      if (mode === 'explicit') delete process.env[GARDENER_ORIGIN_ENV];
      else if (mode === 'invalid') process.env[GARDENER_ORIGIN_ENV] = 'W9494-fixture-secret-invalid-parent';
      else process.env[GARDENER_ORIGIN_ENV] = inherited;
      const queryFn = ({options}) => {
        queryCalls++;
        capturedOptions = options;
        if (kind === 'containment') {
          options.spawnClaudeCodeProcess({command:process.execPath,args:['-e','process.exit(0)'],cwd:root,
            env:options.env,signal:new AbortController().signal});
          throw new Error('the containment recorder must stop before any process spawn');
        }
        return (async function* () {yield {type:'result',subtype:'success',is_error:false,
          result:'private-fixture-complete',session_id:'fixture-session',total_cost_usd:0,num_turns:1};})();
      };
      const args = {
        cwd:root,permissionMode:'default',settingsFile,prompt:'private SDK env fixture',queryFn,
        config:{root,workerHomeRoot:${JSON.stringify(join(dir, "tmp", "worker-home"))},
          zdotdir:${JSON.stringify(join(dir, "tmp", "zdotdir"))},workerProviders:{enabled:['claude']}},
        runId:'sdk-'+mode+'-'+kind,taskId:'W1-T1',
        claudeExecutable:{cache:createClaudeExecutableCache(),deps:{
          env:{[CLAUDE_BIN_ENV_OVERRIDE]:${JSON.stringify(join(dir, "never-executed-claude"))}},
          home:process.env.HOME,exists:()=>true,canExecute:()=>true,locations:[]}},
        keychain:{platform:'linux',accountId:'fixture-account',readCredentialFile:()=>{
          const e = new Error('private fixture ENOENT');e.code='ENOENT';throw e;}},
        // Existing per-call test input: do not start an optional real proxy/service.
        egress:{mode:'off'},
        containment:{spawn:(opts)=>{containmentCalls++;capturedSpawn=opts;throw marker;}},
        ...(mode === 'explicit' ? {env:{[GARDENER_ORIGIN_ENV]:inherited}} : {}),
        ...(mode === 'invalid' ? {env:{[GARDENER_ORIGIN_ENV]:inherited}} : {}),
        ...(mode === 'conflict' ? {env:{[GARDENER_ORIGIN_ENV]:conflicting,
          [RUN_ID_ENV]:'spoofed-run',[TASK_ID_ENV]:'W1-T999',[WORKER_SCOPE_ENV]:'spoofed-installation'}} : {}),
      };
      if (kind === 'containment') await assert.rejects(()=>spawnWorker(args),e=>e===marker);
      else assert.equal((await spawnWorker(args)).text,'private-fixture-complete');
      assert.equal(queryCalls,1,'the actual worker reached the injected query callback');
      assert.ok(capturedOptions?.env);
      const env = capturedOptions.env;
      // Observe the setting that actually reached the SDK, not only our seeded input.
      const forwardedSettings = typeof capturedOptions.settings === 'string'
        ? JSON.parse(readFileSync(capturedOptions.settings,'utf8')) : capturedOptions.settings;
      observations.push({mode,kind,queryCalls,containmentCalls,sdkOrigin:readGardenerOrigin(env),
        containedOrigin:capturedSpawn ? readGardenerOrigin(capturedSpawn.env) : undefined,
        sdkCarrier:env[GARDENER_ORIGIN_ENV],containedCarrier:capturedSpawn?.env[GARDENER_ORIGIN_ENV],
        sameEnv:kind === 'query' || capturedSpawn.env === env,
        runId:env[RUN_ID_ENV],taskId:env[TASK_ID_ENV],scope:env[WORKER_SCOPE_ENV],expectedScope:workerInstallationScope(root),
        containedRunId:capturedSpawn?.env[RUN_ID_ENV],containedTaskId:capturedSpawn?.env[TASK_ID_ENV],
        containedScope:capturedSpawn?.env[WORKER_SCOPE_ENV],settingSources:capturedOptions.settingSources,
        settingsSameInput:capturedOptions.settings === settingsFile,settingsSandbox:forwardedSettings?.sandbox,
        inlineSandboxPresent:capturedOptions.sandbox !== undefined,inlineSandbox:capturedOptions.sandbox,
        permissionMode:capturedOptions.permissionMode,
        billing:billingMode(Object.keys(env)),homePrivate:env.HOME.startsWith(${JSON.stringify(dir + "/")}),
        cachePrivate:env.XDG_CACHE_HOME === ${JSON.stringify(join(dir, "tmp", "cache"))},homeReaped:!existsSync(env.HOME)});
    }
    process.env[GARDENER_ORIGIN_ENV] = inherited;
    writeFileSync(${JSON.stringify(join(dir, "sdk-observations.json"))},JSON.stringify(observations));
  `, true);
  const observations = JSON.parse(await readFile(join(dir, "sdk-observations.json"), "utf8")) as SdkCallerObservation[];
  assert.equal(observations.length, 8, "query/containment paths ran for default, explicit, conflicting and invalid ambient metadata");
  for (const row of observations) {
    assert.equal(row.queryCalls, 1);
    assert.equal(row.containmentCalls, row.kind === "containment" ? 1 : 0);
    assert.equal(row.sameEnv, true, "the actual contained-spawn closure receives the identical worker-built env");
    assert.equal(row.runId, `sdk-${row.mode}-${row.kind}`);
    assert.equal(row.taskId, "W1-T1");
    assert.equal(row.scope, row.expectedScope, "correlation does not replace authoritative installation identity");
    if (row.kind === "containment") {
      assert.equal(row.containedRunId, row.runId);
      assert.equal(row.containedTaskId, row.taskId);
      assert.equal(row.containedScope, row.expectedScope);
    }
    assert.deepEqual(row.settingSources, []);
    assert.equal(row.settingsSameInput, true, "SDK receives the real validated sandbox settings path");
    const sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
    assert.deepEqual(row.settingsSandbox, sandbox);
    assert.equal(row.inlineSandboxPresent, false, "sandbox enforcement travels through the validated settings file, not an extra override");
    assert.equal(row.inlineSandbox, undefined);
    assert.equal(row.permissionMode, "default");
    assert.equal(row.billing, "subscription");
    assert.equal(row.homePrivate, true);
    assert.equal(row.cachePrivate, true);
    assert.equal(row.homeReaped, true, "worker's real finally reaps its private home on success and sentinel rejection");
  }
  for (const row of observations.filter(row => row.mode === "explicit")) {
    assert.deepEqual(row.sdkOrigin, expected, "actual explicit-extra SDK handoff is a positive control");
    if (row.kind === "containment") assert.deepEqual(row.containedOrigin, expected);
  }
  t.diagnostic(JSON.stringify({ proof: "SDK gardener origin actual caller handoff", generatedParent: expected,
    actualQueryReached: true, actualContainedClosureReached: true, explicitExtraControl: "PASS", observations }));
  assert.equal(process.env[GARDENER_ORIGIN_ENV], previous);
  for (const row of observations.filter(row => row.mode === "default")) {
    assert.deepEqual(row.sdkOrigin, expected, "actual SDK options.env must retain its ambient generated parent without args.env");
    if (row.kind === "containment") assert.deepEqual(row.containedOrigin, expected);
  }
  for (const row of observations.filter(row => row.mode === "conflict")) {
    assert.deepEqual(row.sdkOrigin, expected, "valid ambient parent A must win over a different valid extra carrier B");
    if (row.kind === "containment") assert.deepEqual(row.containedOrigin, expected);
  }
  for (const row of observations.filter(row => row.mode === "invalid")) {
    assert.deepEqual(row.sdkOrigin, { state: "invalid", reason: "malformed" });
    assert.equal(row.sdkCarrier, "null", "invalid ambient input stays bounded and cannot be rescued by valid extras");
    if (row.kind === "containment") {
      assert.deepEqual(row.containedOrigin, row.sdkOrigin);
      assert.equal(row.containedCarrier, "null");
    }
  }
  assert.equal(JSON.stringify(observations).includes("W9494-fixture-secret"), false);
});
