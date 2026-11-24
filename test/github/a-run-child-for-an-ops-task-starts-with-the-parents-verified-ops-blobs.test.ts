// W1-T13691: a run child is a new process with no kept ops catalog blobs, so its first lookup of an ops task read
// every blob from GitHub again (about 176 git/blobs GETs). The daemon now offers the verified blob texts it keeps
// on an inherited pipe (fd 3). The child checks each blob as it checks a GitHub answer and still reads the
// repository, the refs, the commit and the trees.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, test } from "node:test";
import type { ChildProcess } from "node:child_process";

import { configPath } from "#src/lib/config.js";
import type { Config } from "#src/lib/config-schema.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import {
  OPS_CATALOG_MAX_BLOB_BYTES, OPS_CATALOG_MAX_OFFER_BYTES, OPS_CATALOG_OFFER_MAX_PAYLOAD_BYTES, OpsCatalogAuthMissingError,
  acceptOfferedOpsCatalogBlobs, keptOpsCatalogBlobsForChild, readOpsCatalogSnapshotAsync,
  type OpsCatalogApi, type OpsCatalogSnapshot,
} from "#src/lib/ops-catalog-source.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { RUN_CHILD_OPS_BLOBS_UNSENT_STEP, spawnRunChild, type SpawnRunChildPorts } from "#src/lib/run-child.js";
import { RUN_CHILD_SCHEMA, readSpec, runDir, writeSpec, type RunChildProbe } from "#src/lib/run-child-contract.js";
import { findTaskInCatalogs } from "#src/lib/task-lookup.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { OPS_CATALOG_BLOBS_OFFERED_STEP, readOfferedOpsCatalogBlobs, runChildMain } from "#src/run-child-main.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const REPOSITORY = "acme-ops/ops-catalog";
const REPO_ID = 91;
const OPS_TASK = "OPS-T2";
const PUBLIC_TASK = "W1-T1";
const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const GEN = { containerId: "c", initStart: "i" };
const probe: RunChildProbe = { process: () => ({ state: "alive", start: "proc:1" }), generation: () => GEN };
const TASKS = [{ id: PUBLIC_TASK, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];
type Row = Record<string, unknown> & { step: string };

const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-offer-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const blobSha = (text: string): string => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
const taskYaml = (id: string, title = `title of ${id}`): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n`;

interface Catalog { monolith: string; shards: Record<string, string>; noPlanDir?: boolean }
const base = (): Catalog => ({
  monolith: taskYaml("OPS-T1"),
  shards: { "a.yaml": taskYaml(OPS_TASK), "b.yaml": taskYaml("OPS-T3"), "c.yaml": taskYaml("OPS-T4") },
});
const withShard = (c: Catalog, name: string, text: string): Catalog => ({ ...c, shards: { ...c.shards, [name]: text } });
const BLOB_TEXTS = [base().monolith, ...Object.values(base().shards)];

/** A recording GET-only fake of the git data API, whose answers can also be served by a gh shim. */
function remote(first: Catalog, opts: { id?: number } = {}) {
  const repo = `repos/${REPOSITORY}`;
  const id = opts.id ?? REPO_ID;
  const trees = new Map<string, unknown>();
  const commits = new Map<string, string>();
  const blobs = new Map<string, string>();
  const calls: string[] = [];
  let fail: ((path: string) => Error | undefined) | undefined;
  let afterBlob: ((sha: string) => void) | undefined;
  let serial = 0;
  const tree = (entries: Array<{ path: string; type: string; mode: string; sha: string }>): string => {
    const s = sha1(`tree ${serial++} ${JSON.stringify(entries)}`);
    trees.set(s, { sha: s, truncated: false, tree: entries });
    return s;
  };
  const put = (text: string): string => { const s = blobSha(text); blobs.set(s, text); return s; };
  const commitOf = (c: Catalog): string => {
    const shardTree = tree(Object.entries(c.shards).map(([path, text]) => ({ path, type: "blob", mode: "100644", sha: put(text) })));
    const planTree = tree([
      { path: "tasks.yaml", type: "blob", mode: "100644", sha: put(c.monolith) },
      { path: "tasks.d", type: "tree", mode: "040000", sha: shardTree },
    ]);
    const root = tree(c.noPlanDir ? [] : [{ path: "plan", type: "tree", mode: "040000", sha: planTree }]);
    const commit = sha1(`commit ${serial++}`);
    commits.set(commit, root);
    return commit;
  };
  let head = commitOf(first);
  const blobBody = (s: string) => {
    const text = blobs.get(s)!;
    return { sha: s, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    const injected = fail?.(path);
    if (injected) throw injected;
    if (path === repo) return { id, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${repo}/git/ref/heads/main`) return { object: { type: "commit", sha: head } };
    const commit = /\/git\/commits\/([a-f0-9]{40})$/.exec(path);
    if (commit && commits.has(commit[1])) return { sha: commit[1], tree: { sha: commits.get(commit[1]) } };
    const treeMatch = /\/git\/trees\/([a-f0-9]{40})$/.exec(path);
    if (treeMatch && trees.has(treeMatch[1])) return trees.get(treeMatch[1]);
    const blob = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (blob && blobs.has(blob[1])) {
      const body = blobBody(blob[1]);
      afterBlob?.(blob[1]);
      return body;
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return {
    api, calls,
    target: { repository: REPOSITORY },
    /** The same answers for a gh PATH shim; the repository route is last, as every other path contains it. */
    routes(): GhShimRoute[] {
      return [
        ...[...blobs.keys()].map((s) => ({ when: `${repo}/git/blobs/${s}`, stdout: JSON.stringify(blobBody(s)) })),
        ...[...trees].map(([s, body]) => ({ when: `${repo}/git/trees/${s}`, stdout: JSON.stringify(body) })),
        ...[...commits].map(([s, root]) => ({ when: `${repo}/git/commits/${s}`, stdout: JSON.stringify({ sha: s, tree: { sha: root } }) })),
        { when: `${repo}/git/ref/heads/main`, stdout: JSON.stringify({ object: { type: "commit", sha: head } }) },
        { when: repo, stdout: JSON.stringify({ id, full_name: REPOSITORY, default_branch: "main" }) },
      ];
    },
    move(c: Catalog): string { head = commitOf(c); return head; },
    setHead(commit: string): void { head = commit; },
    blobGets(): string[] { return calls.filter((p) => p.includes("/git/blobs/")).map((p) => p.slice(-40)); },
    reset(): void { calls.length = 0; },
    failWhen(f: typeof fail): void { fail = f; },
    onBlob(f: typeof afterBlob): void { afterBlob = f; },
    commitOf,
  };
}
type Remote = ReturnType<typeof remote>;
/** The same answers through a new api that has kept nothing: a fresh process's view. */
const cold = (r: Remote): OpsCatalogApi => async (path) => r.api(path);
const view = (snap: OpsCatalogSnapshot) => ({
  outcome: snap.outcome, refusalStage: snap.refusalStage, tasks: snap.plan?.tasks.map((t) => JSON.stringify(t)),
  binding: snap.binding, identityDigest: snap.identityDigest,
});

/** An offer built by hand: the header line, then the bytes. */
function offer(repositoryId: number, blobs: Array<[string, Buffer]>): Buffer {
  const header = JSON.stringify({ repositoryId, blobs: blobs.map(([s, b]) => [s, b.length]) });
  return Buffer.concat([Buffer.from(`${header}\n`), ...blobs.map(([, b]) => b)]);
}
/** The offer a parent that read `c` makes for the ops task. */
async function parentOffer(c: Catalog = base()): Promise<Buffer> {
  const parent = remote(c);
  assert.equal((await readOpsCatalogSnapshotAsync(parent.target, parent.api)).outcome, "ok");
  const payload = keptOpsCatalogBlobsForChild(OPS_TASK, parent.api);
  assert.ok(payload, "the parent offers its kept blobs");
  return payload;
}

// ── the daemon process: its shared default api holds the blobs of an ok read through `gh` ──────────────────

const daemonRemote = remote(base());
let daemonShim: GhShim | undefined;
async function daemonHoldsBlobs(): Promise<GhShim> {
  if (daemonShim) return daemonShim;
  const shim = ghShim(daemonRemote.routes());
  scratch.push(shim.dir);
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath}`;
  try {
    assert.equal((await readOpsCatalogSnapshotAsync({ repository: REPOSITORY })).outcome, "ok");
  } finally {
    process.env.PATH = priorPath;
  }
  assert.equal(shim.calls().filter((c) => c.includes("/git/blobs/")).length, 4, "positive control: the daemon read every blob once");
  daemonShim = shim;
  return shim;
}

interface SpawnFixture {
  root: string;
  state: string;
  rows: Row[];
  input: Parameters<typeof spawnRunChild>[0];
  ports: SpawnRunChildPorts;
}
function spawnFixture(label: string, taskId: string): SpawnFixture {
  const root = tmp(label);
  const state = join(root, "state");
  mkdirSync(join(state, "engines", HASH), { recursive: true });
  writeFileSync(join(state, "engines", HASH, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  writeFileSync(planDestinationPath(state), JSON.stringify({ repository: REPOSITORY, kinds: ["task"] }));
  const rows: Row[] = [];
  const reservation = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default", bindRoot: () => {}, releaseOccupancy: () => {},
  } as unknown as LearnedReservation;
  return {
    root, state, rows,
    input: {
      taskId, stateRoot: state, repoDir: root, root, options: { skipGitSync: false },
      plan: async () => ({ plan: { tasks: TASKS } }), log: (step, extra) => { rows.push({ step, ...extra }); },
    },
    ports: { mainSha: async () => SHA, engine: { isCurrent: () => true }, reserve: async () => reservation, probe, pollMs: 20, watch: false },
  };
}

function fakeChild(fd3: Writable | undefined): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: 424_242, stdio: fd3 ? [null, null, null, fd3] : [null, null, null], unref() {} });
  return child as unknown as ChildProcess;
}

/** spawnRunChild with a stand-in child process whose fd 3 is a stream; the spawn options and what reached fd 3. */
async function spawnWithFakeChild(fx: SpawnFixture, fd3: Writable | undefined = new PassThrough()) {
  let options: Parameters<NonNullable<SpawnRunChildPorts["spawn"]>>[2] | undefined;
  const received: Buffer[] = [];
  if (fd3 instanceof PassThrough) fd3.on("data", (chunk: Buffer) => { received.push(chunk); });
  const ended = fd3 instanceof PassThrough ? new Promise<void>((resolve) => { fd3.on("end", resolve); }) : Promise.resolve();
  const launched = await spawnRunChild(fx.input, {
    ...fx.ports,
    spawn: (_command, _args, spawnOptions) => { options = spawnOptions; return fakeChild(spawnOptions.offerPipe ? fd3 : undefined); },
  });
  assert.ok(launched.started, JSON.stringify(launched));
  launched.settled.catch(() => {});
  launched.detach?.();
  return { launched, options, received, ended };
}

function stateDirFor(label: string): string {
  const state = join(tmp(label), "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(planDestinationPath(state), JSON.stringify({ repository: REPOSITORY, kinds: ["task"] }));
  return state;
}

test("W1-T13691 criterion 1: the daemon's child for an ops task gets the blobs on fd 3 and its first lookup reads no blob", async () => {
  await daemonHoldsBlobs();
  const fx = spawnFixture("c1", OPS_TASK);
  const { options, received, ended } = await spawnWithFakeChild(fx);
  assert.equal(options?.offerPipe, true, "the child is spawned with a fourth stdio pipe");
  await ended;
  const payload = Buffer.concat(received);
  const spec = readSpec(join(fx.state, "runs", readdirSync(join(fx.state, "runs"))[0]!));
  assert.ok(spec.ok && spec.value.opsCatalogBlobsOffered === true, "the spec says a pipe is offered");

  const r = remote(base());
  const child = cold(r);
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(payload, child), { offered: 4, kept: 4, refused: 0 });
  const stateDir = stateDirFor("c1-lookup");
  r.reset();
  const warm = await findTaskInCatalogs(OPS_TASK, { byId: new Map(), stateDir, api: child });
  assert.equal(warm.outcome, "found");
  assert.deepEqual(r.blobGets(), [], "the child's first lookup sends no git/blobs GET");
  assert.ok(r.calls.some((p) => p.includes("/git/commits/")) && r.calls.some((p) => p.includes("/git/trees/")));
  const coldLookup = await findTaskInCatalogs(OPS_TASK, { byId: new Map(), stateDir, api: cold(r) });
  assert.equal(r.blobGets().length, 4, "positive control: a cold child reads every blob");
  assert.equal(JSON.stringify(warm), JSON.stringify(coldLookup), "the same task as a cold read");
});

test("W1-T13691 criterion 2: an offered blob is kept only after the checks a GitHub answer passes", async () => {
  const payload = await parentOffer();
  const header = payload.subarray(0, payload.indexOf(0x0a)).toString();
  const r = remote(base());

  // A tampered text with its sha unchanged: dropped, and that one blob is read from GitHub.
  const tamperedText = base().shards["b.yaml"];
  const at = payload.indexOf(Buffer.from(tamperedText));
  assert.ok(at > header.length, "positive control: the offer holds the blob's bytes");
  const tampered = Buffer.from(payload);
  tampered[at + tamperedText.indexOf("OPS-T3") + 4] = "9".charCodeAt(0);
  const child = cold(r);
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(tampered, child), { offered: 4, kept: 3, refused: 1 });
  r.reset();
  const snap = await readOpsCatalogSnapshotAsync(r.target, child);
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(r.blobGets(), [blobSha(tamperedText)], "the refused blob is read from GitHub");
  assert.equal(snap.plan?.byId.get("OPS-T3")?.id, "OPS-T3", "the catalog holds GitHub's bytes, not the tampered ones");
  const paths = r.calls.slice(0, 7).map((p) => p.replace(/[a-f0-9]{40}$/, "<sha>"));
  assert.deepEqual(paths.slice(0, 3), [`repos/${REPOSITORY}`, `repos/${REPOSITORY}/git/ref/heads/main`, `repos/${REPOSITORY}/git/commits/<sha>`],
    "the child still reads the repository, the branch ref and the commit");
  assert.equal(r.calls.filter((p) => p.includes("/git/trees/")).length, 3, "and the trees");
  assert.equal(r.calls.filter((p) => p.endsWith("/git/ref/heads/main")).length, 2, "and the final ref");
  assert.deepEqual(view(snap), view(await readOpsCatalogSnapshotAsync(r.target, cold(r))));

  // The per-blob bound: a blob past it is dropped even with a correct SHA-1.
  const big = Buffer.alloc(OPS_CATALOG_MAX_BLOB_BYTES + 1, 0x61);
  const bigSha = createHash("sha1").update(`blob ${big.length}\0`).update(big).digest("hex");
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(offer(REPO_ID, [[bigSha, big]]), cold(r)), { offered: 1, kept: 0, refused: 1 });
  // The total bound: an offer past its payload bound keeps nothing (W1-T14368: the child reads a larger catalog from GitHub).
  const many = Array.from({ length: OPS_CATALOG_OFFER_MAX_PAYLOAD_BYTES / OPS_CATALOG_MAX_BLOB_BYTES + 1 }, (_, i) => {
    const bytes = Buffer.alloc(i === 0 ? 1024 : OPS_CATALOG_MAX_BLOB_BYTES, 0x61 + (i % 20));
    return [createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), bytes] as [string, Buffer];
  });
  assert.ok(offer(REPO_ID, many).length <= OPS_CATALOG_MAX_OFFER_BYTES, "positive control: the offer itself is within the read bound");
  const counted = acceptOfferedOpsCatalogBlobs(offer(REPO_ID, many), cold(r));
  assert.equal(counted.kept, 0);
  assert.equal(counted.refused, many.length);
  // A blob that is not UTF-8 is dropped, as readBlob refuses it.
  const binary = Buffer.from([0xff, 0xfe, 0x00]);
  const binarySha = createHash("sha1").update(`blob ${binary.length}\0`).update(binary).digest("hex");
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(offer(REPO_ID, [[binarySha, binary]]), cold(r)), { offered: 1, kept: 0, refused: 1 });
  // Blobs offered for another repository id serve no read of this one.
  const otherId = cold(r);
  const reframed = Buffer.concat([Buffer.from(header.replace(`"repositoryId":${REPO_ID}`, '"repositoryId":999') + "\n"),
    payload.subarray(header.length + 1)]);
  assert.equal(acceptOfferedOpsCatalogBlobs(reframed, otherId).kept, 4);
  r.reset();
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, otherId)).outcome, "ok");
  assert.equal(r.blobGets().length, 4, "kept blobs are keyed by the repository id the child reads");
});

test("W1-T13691 criterion 3: no blob byte is written to a file; the spec says only that a pipe is offered", async (t) => {
  await daemonHoldsBlobs();
  const fx = spawnFixture("c3", OPS_TASK);
  const { options, received, ended } = await spawnWithFakeChild(fx);
  assert.equal(options?.offerPipe, true, "positive control: the child is offered a pipe");
  await ended;
  assert.ok(Buffer.concat(received).length > 0, "positive control: the offer went to fd 3");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else files.push(path);
    }
  };
  walk(fx.root);
  assert.ok(files.some((f) => f.endsWith("spec.json")) && files.some((f) => f.includes("plan-snapshots")));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const blob of BLOB_TEXTS) assert.equal(text.includes(blob), false, `${file} holds no blob text`);
    for (const blob of BLOB_TEXTS) assert.equal(text.includes(blobSha(blob)), false, `${file} holds no blob sha`);
  }
  const specFile = files.find((f) => f.endsWith("spec.json"))!;
  const spec = JSON.parse(readFileSync(specFile, "utf8")) as Record<string, unknown>;
  assert.equal(spec.opsCatalogBlobsOffered, true);
  assert.deepEqual(Object.keys(spec).sort(),
    ["engine", "instance", "opsCatalogBlobsOffered", "options", "planSnapshotPath", "reservationId", "runId", "schema", "taskId"]);
  assert.deepEqual(spec.schema, { ...RUN_CHILD_SCHEMA });
  assert.equal(RUN_CHILD_SCHEMA.minor, 3, "a minor bump: a child built before this reads the spec and ignores the field");

  // The child side keeps the blobs in memory: accepting and reading attempt no filesystem write.
  const payload = Buffer.concat(received);
  const r = remote(base());
  const writes: string[] = [];
  const forbid = (method: string) => () => { writes.push(method); throw new Error("filesystem mutation forbidden"); };
  for (const method of ["appendFile", "copyFile", "cp", "link", "mkdir", "mkdtemp", "open", "rename",
    "rm", "rmdir", "symlink", "truncate", "unlink", "write", "writeFile", "writev"] as const) {
    t.mock.method(fs, method, forbid(method));
    t.mock.method(fs, `${method}Sync`, forbid(`${method}Sync`));
  }
  t.mock.method(fs, "createWriteStream", forbid("createWriteStream"));
  syncBuiltinESMExports();
  try {
    assert.throws(() => fs.writeFileSync("positive-control", "x"), /filesystem mutation forbidden/);
    writes.length = 0;
    const child = cold(r);
    assert.equal(acceptOfferedOpsCatalogBlobs(payload, child).kept, 4);
    assert.equal((await readOpsCatalogSnapshotAsync(r.target, child)).outcome, "ok");
    assert.deepEqual(writes, [], "taking the offer attempts no filesystem write");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("W1-T13691 criterion 4: a child with no pipe, or a bad payload, reads the catalog as before", { timeout: 60_000 }, async () => {
  const payload = await parentOffer();
  const coldView = async (): Promise<ReturnType<typeof view>> => { const r = remote(base()); return view(await readOpsCatalogSnapshotAsync(r.target, cold(r))); };
  const through = async (feed: (stream: PassThrough) => void): Promise<Buffer | undefined> => {
    const stream = new PassThrough();
    const read = readOfferedOpsCatalogBlobs(stream);
    feed(stream);
    return read;
  };
  const cases: Array<[string, () => Promise<Buffer | undefined>]> = [
    ["no pipe", async () => undefined],
    ["empty", () => through((s) => s.end())],
    ["closed", () => through((s) => { s.write(payload.subarray(0, 10)); s.destroy(); })],
    ["truncated", () => through((s) => s.end(payload.subarray(0, payload.length - 7)))],
    ["oversized", () => through((s) => { s.write(Buffer.alloc(OPS_CATALOG_MAX_OFFER_BYTES + 1)); s.end(); })],
    ["malformed", () => through((s) => s.end(Buffer.from("not a header\n{}")))],
    ["padded", () => through((s) => s.end(Buffer.concat([payload, Buffer.from("x")])))],
    ["late", () => through((s) => { s.write(payload.subarray(0, 10)); })],
  ];
  for (const [label, read] of cases) {
    const received = await read();
    const r = remote(base());
    const child = cold(r);
    const counts = acceptOfferedOpsCatalogBlobs(received, child);
    assert.equal(counts.kept, 0, label);
    const snap = await readOpsCatalogSnapshotAsync(r.target, child);
    assert.equal(r.blobGets().length, 4, `${label}: every blob is read from GitHub`);
    assert.deepEqual(view(snap), await coldView(), `${label}: the same catalog as origin/main's read`);
  }
  assert.ok((await through((s) => s.end(payload)))?.equals(payload), "positive control: a whole offer is read whole");

  // A spec with no offer: the entry never reads fd 3 and writes no offer row; the run goes on as before.
  const root = tmp("c4-no-pipe");
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
  const state = join(root, "state");
  const dir = runDir(state, "run-c4");
  mkdirSync(dir, { recursive: true });
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: OPS_TASK, runId: "run-c4", instance: "core", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: join(root, "none.json"), reservationId: "reservation-1", options: { skipGitSync: true },
  });
  let ran = 0;
  const code = await runChildMain(["--run-dir", dir], {
    signals: { on() {}, off() {} }, probe, env: {}, stderr: () => {}, loadRunPath: async () => ({}),
    runTask: async (taskId) => { ran++; return { taskId, runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" }; },
  });
  assert.equal(code, 0);
  assert.equal(ran, 1, "the task runs");
  let ledger = "";
  try { ledger = readFileSync(ledgerPathFor({ root } as Config), "utf8"); }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); }
  assert.equal(ledger.includes(OPS_CATALOG_BLOBS_OFFERED_STEP), false, "no offer row without an offer");
});

test("W1-T13691 criterion 4: a failed write is ledgered once, and the write never blocks the spawn", async () => {
  await daemonHoldsBlobs();
  const failing = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE: the child exited")); } });
  const fx = spawnFixture("c4-epipe", OPS_TASK);
  const { launched } = await spawnWithFakeChild(fx, failing);
  await new Promise((resolve) => { setImmediate(resolve); });
  failing.emit("error", new Error("a second failure"));
  assert.equal(launched.started, true);
  const unsent = fx.rows.filter((row) => row.step === RUN_CHILD_OPS_BLOBS_UNSENT_STEP);
  assert.equal(unsent.length, 1, JSON.stringify(fx.rows.map((row) => row.step)));
  assert.match(String(unsent[0]?.reason), /EPIPE/);

  // A child that never reads: the write waits in the stream, and spawnRunChild still returns.
  let callbacks = 0;
  const stalled = new Writable({ highWaterMark: 1, write() { callbacks++; } });
  const stalledFx = spawnFixture("c4-stalled", OPS_TASK);
  const { launched: stalledLaunch } = await spawnWithFakeChild(stalledFx, stalled);
  assert.equal(stalledLaunch.started, true);
  assert.equal(callbacks, 1, "positive control: the write is pending, not done");
  assert.equal(stalledFx.rows.some((row) => row.step === RUN_CHILD_OPS_BLOBS_UNSENT_STEP), false);
  stalled.destroy();
});

test("W1-T13691 criterion 5: a child for a public plan task is spawned as before and offered no blobs", async () => {
  await daemonHoldsBlobs();
  assert.ok(keptOpsCatalogBlobsForChild(OPS_TASK), "positive control: this process holds blobs for an ops task");
  const fx = spawnFixture("c5", PUBLIC_TASK);
  const { options, received } = await spawnWithFakeChild(fx);
  assert.equal(options?.offerPipe, undefined, "no fourth stdio entry");
  assert.deepEqual(Object.keys(options ?? {}).sort(), ["cwd", "env", "stderrFd"]);
  assert.equal(received.length, 0);
  const spec = readSpec(join(fx.state, "runs", readdirSync(join(fx.state, "runs"))[0]!));
  assert.ok(spec.ok && spec.value.opsCatalogBlobsOffered === undefined, "the spec offers nothing");
  assert.equal(keptOpsCatalogBlobsForChild("OPS-T404"), undefined, "a task the newest ops read does not hold is offered nothing");
});

// ── a real child: spawnRunChild's default spawn, a tsx driver around the real runChildMain ───────────────────

const SRC = join(REPO_ROOT, "src").replace(/\\/g, "/");
const DRIVER = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChildMain } from "file://${SRC}/run-child-main.ts";
import { findTaskInCatalogs } from "file://${SRC}/lib/task-lookup.ts";

const runTask = async (taskId) => {
  const found = await findTaskInCatalogs(taskId, { byId: new Map(), stateDir: process.env.DRIVER_STATE });
  writeFileSync(join(process.env.DRIVER_OUT, "found.json"), JSON.stringify({ outcome: found.outcome, title: found.task?.title }));
  return { taskId, runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" };
};
process.exit(await runChildMain(process.argv.slice(2), { loadRunPath: async () => ({}), runTask, env: {} }));
`;

let realChildRun: Promise<{ fx: SpawnFixture; out: string; blobCallsAfterSpawn: number; callsAfterSpawn: string[] }> | undefined;
function realChild(): NonNullable<typeof realChildRun> {
  realChildRun ??= (async () => {
    const shim = await daemonHoldsBlobs();
    const fx = spawnFixture("c7", OPS_TASK);
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root: fx.root }, null, 2) + "\n");
    const out = tmp("c7-out");
    const driver = join(fx.root, "driver.mjs");
    writeFileSync(driver, DRIVER);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, DRIVER_STATE: fx.state, DRIVER_OUT: out };
    delete env.NODE_TEST_CONTEXT;
    env.NODE_V8_COVERAGE = undefined;
    delete env.REMUDERO_WORKER_SCOPE;
    const before = shim.calls().length;
    const launched = await spawnRunChild(fx.input, {
      ...fx.ports, env, probe: undefined,
      launch: (engine, args) => ({ kind: "tsx", reason: "test driver", argv: ["--import", "tsx", driver, ...args], cwd: REPO_ROOT, engineRoot: engine.root }),
    });
    assert.ok(launched.started, JSON.stringify(launched));
    const result = await launched.settled;
    assert.equal(result.verdict, "no_pr");
    const callsAfterSpawn = shim.calls().slice(before);
    return { fx, out, callsAfterSpawn, blobCallsAfterSpawn: callsAfterSpawn.filter((c) => c.includes("/git/blobs/")).length };
  })();
  return realChildRun;
}

test("W1-T13691 criterion 6: the child writes one ops_catalog.blobs_offered row with counts only", { timeout: 180_000 }, async () => {
  const { fx } = await realChild();
  const rows = readFileSync(ledgerPathFor({ root: fx.root } as Config), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Row).filter((row) => row.step === OPS_CATALOG_BLOBS_OFFERED_STEP);
  assert.equal(rows.length, 1, "one row");
  const row = rows[0]!;
  assert.deepEqual([row.offered, row.kept, row.refused], [4, 4, 0]);
  assert.equal(row.task_id, OPS_TASK);
  const text = JSON.stringify(row);
  assert.equal(/[a-f0-9]{40}/.test(text), false, "no sha");
  assert.equal(text.includes("tasks.d") || text.includes("tasks.yaml") || text.includes(REPOSITORY), false, "no path");
  for (const blob of BLOB_TEXTS) assert.equal(text.includes(blob.split("\n")[1]!), false, "no blob byte");
  for (const value of Object.values(row)) assert.notEqual(typeof value, "object", "no nested payload");
});

test("W1-T13691 criterion 7: through the default spawn and the real child entry, the child's catalog read spawns no gh blob read", { timeout: 180_000 }, async () => {
  const { out, callsAfterSpawn, blobCallsAfterSpawn } = await realChild();
  const found = JSON.parse(readFileSync(join(out, "found.json"), "utf8")) as { outcome: string; title?: string };
  assert.deepEqual(found, { outcome: "found", title: `title of ${OPS_TASK}` }, "the child found the ops task");
  assert.equal(blobCallsAfterSpawn, 0, "the child spawned no gh api .../git/blobs/...");
  assert.ok(callsAfterSpawn.some((c) => c.includes("/git/commits/")), "positive control: the child read the catalog through gh");
  assert.ok(callsAfterSpawn.some((c) => c.includes("/git/trees/")) && callsAfterSpawn.some((c) => c.includes("/git/ref/heads/main")));
});

/** runChildMain in this process for a spec that says a pipe is offered; the stderr text, the exit code and the offer rows. */
async function offeredRun(label: string, offerPipe: (() => PassThrough) | undefined, breakLedger = false) {
  const root = tmp(`offer-${label}`);
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
  const ledgerFile = ledgerPathFor({ root } as Config);
  if (breakLedger) mkdirSync(ledgerFile, { recursive: true });
  const dir = runDir(join(root, "state"), `run-${label}`);
  mkdirSync(dir, { recursive: true });
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: OPS_TASK, runId: `run-${label}`, instance: "core", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: join(root, "none.json"), reservationId: "reservation-1", options: { skipGitSync: true },
    opsCatalogBlobsOffered: true,
  });
  let ran = 0;
  const errors: string[] = [];
  const code = await runChildMain(["--run-dir", dir], {
    signals: { on() {}, off() {} }, probe, env: {}, stderr: (text) => { errors.push(text); }, loadRunPath: async () => ({}),
    ...(offerPipe ? { offerPipe } : {}),
    runTask: async (taskId) => { ran++; return { taskId, runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" }; },
  });
  let rows: Row[] = [];
  if (!breakLedger) {
    rows = readFileSync(ledgerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
      .filter((row) => row.step === OPS_CATALOG_BLOBS_OFFERED_STEP);
  }
  return { code, ran, errors: errors.join(""), rows };
}

test("W1-T13691 criterion 6: the entry reads the offer, keeps the verified blobs and ledgers the counts before the task runs", async () => {
  const payload = await parentOffer();
  const { code, ran, errors, rows } = await offeredRun("taken", () => {
    const stream = new PassThrough();
    stream.end(payload);
    return stream;
  });
  assert.equal(code, 0);
  assert.equal(ran, 1, "the task runs");
  assert.equal(errors, "");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.offered, rows[0]?.kept, rows[0]?.refused], [4, 4, 0]);
  assert.equal(rows[0]?.task_id, OPS_TASK);
});

test("W1-T13691 criterion 4: an entry whose fd 3 cannot be opened still runs the task and ledgers an empty offer", async () => {
  const { code, ran, errors, rows } = await offeredRun("no-fd", () => { throw new Error("EBADF: no fd 3"); });
  assert.equal(code, 0);
  assert.equal(ran, 1, "the task runs");
  assert.match(errors, /no ops catalog offer pipe on fd 3: Error: EBADF/);
  assert.deepEqual([rows[0]?.offered, rows[0]?.kept, rows[0]?.refused], [0, 0, 0]);
});

test("W1-T13691 criterion 4: an entry that cannot write the offer row still runs the task", async () => {
  const payload = await parentOffer();
  const { code, ran, errors } = await offeredRun("ledger", () => {
    const stream = new PassThrough();
    stream.end(payload);
    return stream;
  }, true);
  assert.equal(code, 0);
  assert.equal(ran, 1, "the task runs");
  assert.match(errors, /the offered ops catalog blobs were not taken/);
});

test("W1-T13691 criterion 4: the entry's default offer pipe is fd 3, and whatever fd 3 is, the task runs", { skip: process.channel !== undefined }, async () => {
  const { code, ran, rows } = await offeredRun("default", undefined);
  assert.equal(code, 0);
  assert.equal(ran, 1, "the task runs");
  assert.equal(rows.length, 1, "one offer row, with whatever counts the pipe gave");
});

test("W1-T13691 criterion 8: a child that took offered blobs refuses as a child that took none", async () => {
  const payload = await parentOffer();
  type Scenario = { label: string; outcome: string; stage: string; arrange(r: Remote): void };
  const scenarios: Scenario[] = [
    { label: "auth_missing", outcome: "auth_missing", stage: "commit",
      arrange: (r) => r.failWhen((p) => (p.includes("/git/commits/") ? new OpsCatalogAuthMissingError() : undefined)) },
    { label: "unreadable", outcome: "unreadable", stage: "shard_tree",
      arrange: (r) => { let n = 0; r.failWhen((p) => (p.includes("/git/trees/") && ++n === 3 ? new Error("HTTP 502") : undefined)); } },
    { label: "malformed", outcome: "malformed", stage: "strict_parse",
      arrange: (r) => r.move(withShard(base(), "a.yaml", "- id: OPS-T2\n  title: [")) },
    { label: "source_absent", outcome: "source_absent", stage: "plan_tree",
      arrange: (r) => r.move({ ...base(), noPlanDir: true }) },
    { label: "duplicate_task_id", outcome: "duplicate_task_id", stage: "strict_parse",
      arrange: (r) => r.move(withShard(base(), "d.yaml", taskYaml(OPS_TASK, "a second OPS-T2"))) },
    { label: "ref_moved", outcome: "ref_moved", stage: "final_ref",
      arrange: (r) => {
        const monolith = taskYaml("OPS-T1", "new monolith");
        const later = r.commitOf(base());
        const first = r.move({ monolith, shards: { "a.yaml": taskYaml(OPS_TASK, "new shard") } });
        r.onBlob((s) => { if (s === blobSha(monolith)) r.setHead(later); });
        r.failWhen((p) => { if (p.endsWith(`/git/commits/${later}`)) r.setHead(first); return undefined; });
      } },
  ];
  for (const s of scenarios) {
    const warmRemote = remote(base());
    const child = cold(warmRemote);
    assert.equal(acceptOfferedOpsCatalogBlobs(payload, child).kept, 4, s.label);
    s.arrange(warmRemote);
    const warm = await readOpsCatalogSnapshotAsync(warmRemote.target, child);
    const coldRemote = remote(base());
    s.arrange(coldRemote);
    const fresh = await readOpsCatalogSnapshotAsync(coldRemote.target, cold(coldRemote));
    assert.equal(warm.outcome, s.outcome, s.label);
    assert.equal(warm.refusalStage, s.stage, s.label);
    assert.deepEqual(view(warm), view(fresh), `${s.label}: same as a child that took no blobs`);
  }

  // A read that ends ref_moved keeps the offered blobs and the blob it verified, and nothing else.
  const r = remote(base());
  const child = cold(r);
  const tamperedOffer = Buffer.from(payload);
  const cText = base().shards["c.yaml"];
  tamperedOffer[tamperedOffer.indexOf(Buffer.from(cText)) + cText.indexOf("OPS-T4") + 4] = "8".charCodeAt(0);
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(tamperedOffer, child), { offered: 4, kept: 3, refused: 1 });
  const changedA = taskYaml(OPS_TASK, "verified during a moved read");
  const changedB = taskYaml("OPS-T3", "the commit the ref moved to");
  const later = r.commitOf(withShard(withShard(base(), "a.yaml", changedA), "b.yaml", changedB));
  r.move(withShard(base(), "a.yaml", changedA));
  r.onBlob((s) => { if (s === blobSha(changedA)) r.setHead(later); });
  r.failWhen((p) => p.endsWith(`/git/commits/${later}`) ? new Error("HTTP 502") : undefined);
  const moved = await readOpsCatalogSnapshotAsync(r.target, child);
  assert.equal(moved.outcome, "ref_moved");
  assert.equal(moved.refusalStage, "final_ref");
  r.onBlob(undefined);
  r.failWhen(undefined);
  r.reset();
  const next = await readOpsCatalogSnapshotAsync(r.target, child);
  assert.equal(next.outcome, "ok");
  assert.deepEqual(r.blobGets(), [blobSha(changedB)], "only the blob no check passed for is read again");
});
