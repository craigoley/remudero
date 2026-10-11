import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  HEAVY_READY_ESCALATION_MS, heavyNewBuildGate, readHeavyNewBuildHold,
  releaseHeavyNewBuilds, reserveHeavyNewBuilds, type HeavyReservationHandle,
} from "../src/lib/heavy-build-reservation.js";

function fixture(t: TestContext): string {
  // macOS /var is an alias: give the canonical-directory guard a real path.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "rmd-heavy-v2-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function pathFor(handle: HeavyReservationHandle, suffix = ""): string {
  return join(handle.dir, `heavy-build-${handle.request.id}${suffix}.json`);
}
function put(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function unknown(dir: string, now: number): void {
  const reading = readHeavyNewBuildHold({ dir, now });
  assert.equal(reading.state, "unavailable", JSON.stringify(reading));
  if (reading.state === "unavailable") assert.ok(reading.reason);
}
function clear(dir: string, now: number, observed: number, pendingEscalations = 0): void {
  assert.deepEqual(readHeavyNewBuildHold({ dir, now }), { state: "clear", observed, pendingEscalations });
}

const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname;
const runtime = new URL("../src/lib/heavy-build-reservation.ts", import.meta.url).href;
function nativeChild(dir: string, body: string, args: string[] = []): void {
  const child = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import * as api from ${JSON.stringify(runtime)};
    const dir = process.argv[1];
    ${body}
    console.log('heavy-v2-native-control-ok');
  `, dir, ...args], {
    encoding: "utf8", timeout: 9000,
    env: { ...process.env, TMPDIR: dir, TSX_DISABLE_CACHE: "1" },
  });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "heavy-v2-native-control-ok");
}

test("heavy READY v2 creates canonical private metadata with an immutable sixty-minute owner", t => {
  const dir = join(fixture(t), "state"), now = Date.now();
  const handle = reserveHeavyNewBuilds("private-ready", "gate", { dir, now });
  assert.equal(handle.owned, true);
  assert.equal(handle.request.version, 2);
  assert.equal(handle.request.expiresAtMs, now + HEAVY_READY_ESCALATION_MS);
  assert.equal(HEAVY_READY_ESCALATION_MS, 60 * 60_000);
  assert.equal(handle.request.owner.pid, process.pid);
  assert.ok(handle.request.owner.nonce);assert.ok(handle.request.owner.start);
  assert.ok(handle.request.owner.host);assert.ok(handle.request.owner.namespace);
  for (const [path, mode] of [[dir, 0o700], [pathFor(handle), 0o600]] as const) {
    assert.equal(statSync(path).mode & 0o777, mode);
    assert.equal(statSync(path).uid, process.getuid?.());
  }
  const reading = readHeavyNewBuildHold({ dir, now });
  assert.equal(reading.state, "held");
  if (reading.state !== "held") return;
  assert.equal(reading.observed, 1);assert.equal(reading.pendingEscalations, 0);
  assert.equal(reading.hold.requestId, handle.request.id);
});

test("heavy READY v2 producer retries preserve the original nonce age and label", t => {
  const dir = fixture(t), now = Date.now();
  const first = reserveHeavyNewBuilds("retry", "gate", { dir, now });
  const before = readFileSync(pathFor(first));
  const retry = reserveHeavyNewBuilds("retry", "gate", { dir, now: now + 1000 });
  assert.equal(retry.owned, false);assert.deepEqual(retry.request, first.request);
  assert.equal(releaseHeavyNewBuilds(retry, { now }), false);
  assert.throws(() => reserveHeavyNewBuilds("retry", "changed", { dir, now }), /identity changed/);
  assert.deepEqual(readFileSync(pathFor(first)), before);
});

test("heavy READY v2 release retains one immutable terminal record and never renews a closed grant", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("released", "gate", { dir, now });
  const request = readFileSync(pathFor(handle));
  assert.equal(releaseHeavyNewBuilds(handle, { now: now + 1 }), true);
  const closed = readFileSync(pathFor(handle, "-closed"));
  assert.equal(JSON.parse(closed.toString()).kind, "released");
  assert.equal(/passed|success|verdict/.test(closed.toString()), false);
  assert.equal(releaseHeavyNewBuilds(handle, { now: handle.request.expiresAtMs + 1 }), true);
  assert.deepEqual(readFileSync(pathFor(handle, "-closed")), closed);
  assert.deepEqual(readFileSync(pathFor(handle)), request);
  clear(dir, now - 1, 1); // Terminal wins even before the original READY clock.
  const replay = reserveHeavyNewBuilds("released", "gate", { dir, now: handle.request.expiresAtMs + 2 });
  assert.equal(replay.owned, false);assert.deepEqual(replay.request, handle.request);
  clear(dir, handle.request.expiresAtMs + 2, 1);
  assert.deepEqual(readdirSync(dir).sort(), [pathFor(handle), pathFor(handle, "-closed")].map(p => p.slice(dir.length + 1)).sort());
});

test("heavy READY v2 reader expires a live owner at the exact deadline without rollback resurrection", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("live-expiry", "gate", { dir, now });
  assert.equal(readHeavyNewBuildHold({ dir, now: handle.request.expiresAtMs - 1 }).state, "held");
  clear(dir, handle.request.expiresAtMs, 1, 1);
  const closed = readFileSync(pathFor(handle, "-closed"));
  assert.equal(JSON.parse(closed.toString()).kind, "escalated");
  assert.equal(JSON.parse(closed.toString()).atMs, handle.request.expiresAtMs);
  for (const rollback of [now - 1, now + 1, handle.request.expiresAtMs - 1]) clear(dir, rollback, 1, 1);
  assert.equal(releaseHeavyNewBuilds(handle, { now: handle.request.expiresAtMs + 1 }), true);
  assert.deepEqual(readFileSync(pathFor(handle, "-closed")), closed);
  const replay = reserveHeavyNewBuilds("live-expiry", "gate", { dir, now: handle.request.expiresAtMs + 2 });
  assert.equal(replay.owned, false);assert.deepEqual(replay.request, handle.request);
});

test("heavy READY v2 late release records escalation instead of suppressing the original deadline", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("late-release", "gate", { dir, now });
  assert.equal(releaseHeavyNewBuilds(handle, { now: handle.request.expiresAtMs }), true);
  const closed = JSON.parse(readFileSync(pathFor(handle, "-closed"), "utf8"));
  assert.deepEqual(closed, { version: 2, requestHash: hash(handle.request), nonce: handle.request.owner.nonce,
    kind: "escalated", atMs: handle.request.expiresAtMs });
  clear(dir, now - 1, 1, 1);
  assert.equal(existsSync(pathFor(handle, "-delivered")), false);
});

test("heavy READY v2 retries a throwing escalation sink with one stable event id and durable acknowledgement", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("retry-delivery", "gate", { dir, now });
  const events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const fail = (step: string, fields: Record<string, unknown>) => { events.push({ step, fields });throw new Error("sink EIO after observation"); };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(readHeavyNewBuildHold({ dir, now: handle.request.expiresAtMs + i, log: fail }),
      { state: "clear", observed: 1, pendingEscalations: 1 });
    assert.equal(existsSync(pathFor(handle, "-delivered")), false);
  }
  const closed = readFileSync(pathFor(handle, "-closed"));
  const log = (step: string, fields: Record<string, unknown>) => { events.push({ step, fields }); };
  assert.deepEqual(readHeavyNewBuildHold({ dir, now: now - 1, log }), { state: "clear", observed: 1, pendingEscalations: 0 });
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.step, "heavy_ready.escalated");
    assert.equal(event.fields.event_id, `${handle.request.id}:escalated`);
    assert.equal(event.fields.scope, "NEW-implement-only");
    assert.equal(event.fields.ready_at_ms, now);
    assert.equal(event.fields.expires_at_ms, handle.request.expiresAtMs);
  }
  assert.equal(statSync(pathFor(handle, "-delivered")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(pathFor(handle, "-delivered"), "utf8")), {
    version: 2, closureHash: hash(JSON.parse(closed.toString())), eventId: `${handle.request.id}:escalated`,
  });
  assert.deepEqual(readFileSync(pathFor(handle, "-closed")), closed);
  readHeavyNewBuildHold({ dir, now: handle.request.expiresAtMs + 3, log });
  assert.equal(events.length, 3, "an acknowledged outbox event is not delivered again");
});

test("heavy READY v2 a sink-free expiry stays pending while another active demand remains held", t => {
  const dir = fixture(t), now = Date.now();
  const expired = reserveHeavyNewBuilds("old-outbox", "gate", { dir, now: now - HEAVY_READY_ESCALATION_MS });
  const active = reserveHeavyNewBuilds("active-beside-outbox", "gate", { dir, now });
  const reading = readHeavyNewBuildHold({ dir, now });
  assert.equal(reading.state, "held");if (reading.state !== "held") return;
  assert.equal(reading.observed, 2);assert.equal(reading.pendingEscalations, 1);
  assert.equal(reading.hold.requestId, active.request.id);
  assert.equal(existsSync(pathFor(expired, "-closed")), true);
  assert.equal(existsSync(pathFor(expired, "-delivered")), false);
});

test("heavy READY v2 rejects copied nonces reused PID births and foreign namespaces without releasing demand", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("owner-fences", "gate", { dir, now });
  const original = readFileSync(pathFor(handle));
  assert.equal(releaseHeavyNewBuilds({ ...handle, request: { ...handle.request, owner: { ...handle.request.owner, nonce: "copied-nonce" } } }, { now }), false);
  for (const owner of [{ ...handle.request.owner, start: "reused-PID-birth" },
    { ...handle.request.owner, namespace: "foreign-namespace" }, { ...handle.request.owner, host: "foreign-host" }]) {
    // Match disk and handle so this tests the process fence, not just the request hash.
    const request = { ...handle.request, owner };
    put(pathFor(handle), request);
    assert.equal(releaseHeavyNewBuilds({ ...handle, request }, { now }), false);
    assert.equal(existsSync(pathFor(handle, "-closed")), false);
  }
  writeFileSync(pathFor(handle), original);
  assert.equal(readHeavyNewBuildHold({ dir, now }).state, "held");
  assert.equal(releaseHeavyNewBuilds(handle, { now }), true);
});

test("heavy READY v2 a separate native process cannot release a copied owned handle", { timeout: 10000 }, t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("foreign-process", "gate", { dir, now });
  nativeChild(dir, `
    const copied = JSON.parse(process.argv[2]);
    assert.notEqual(process.pid, copied.request.owner.pid);
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
    const replay = api.reserveHeavyNewBuilds('foreign-process', 'gate', {dir});
    assert.equal(replay.owned, false);
    assert.equal(api.releaseHeavyNewBuilds({...copied, owned:true}), false);
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
  `, [JSON.stringify(handle)]);
  assert.equal(existsSync(pathFor(handle, "-closed")), false);
  assert.equal(releaseHeavyNewBuilds(handle, { now }), true);
});

test("heavy READY v2 malformed empty oversized future and unknown-version requests never read clear", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("invalid-records", "gate", { dir, now });
  const original = readFileSync(pathFor(handle));
  for (const raw of ["", "{", "x".repeat(4097), JSON.stringify({ ...handle.request, version: 99 }),
    JSON.stringify({ ...handle.request, readyAtMs: now + 1, expiresAtMs: now + 1 + HEAVY_READY_ESCALATION_MS }),
    JSON.stringify({ ...handle.request, expiresAtMs: handle.request.expiresAtMs + 1 })]) {
    writeFileSync(pathFor(handle), raw);unknown(dir, now);
    assert.equal(existsSync(pathFor(handle, "-closed")), false);
    assert.equal(readFileSync(pathFor(handle), "utf8"), raw);
  }
  writeFileSync(pathFor(handle), original);
  assert.equal(readHeavyNewBuildHold({ dir, now }).state, "held");
});

test("heavy READY v2 malformed heavy prefixes and legacy receipt names refuse an incomplete interpretation", t => {
  const dir = fixture(t), now = Date.now();
  clear(dir, now, 0);
  for (const name of ["heavy-build-invalid.json", `heavy-build-${"a".repeat(64)}-released.json`, "heavy-build-unrecognized-version"]) {
    const path = join(dir, name);put(path, {});unknown(dir, now);rmSync(path);
    clear(dir, now, 0);
  }
});

test("heavy READY v2 orphan closure and delivery receipts refuse a false empty census", t => {
  const dir = fixture(t), now = Date.now();
  for (const suffix of ["-closed", "-delivered"]) {
    const path = join(dir, `heavy-build-${"b".repeat(64)}${suffix}.json`);
    put(path, {});unknown(dir, now);assert.equal(existsSync(path), true);rmSync(path);
    clear(dir, now, 0);
  }
});

test("heavy READY v2 delivery acknowledgements without an escalated closure are unavailable", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("unchecked-ack", "gate", { dir, now });
  put(pathFor(handle, "-delivered"), { version: 2, closureHash: "unproved", eventId: `${handle.request.id}:escalated` });
  unknown(dir, now);rmSync(pathFor(handle, "-delivered"));
  assert.equal(readHeavyNewBuildHold({ dir, now }).state, "held");
  assert.equal(releaseHeavyNewBuilds(handle, { now }), true);
  put(pathFor(handle, "-delivered"), { version: 2, closureHash: hash(JSON.parse(readFileSync(pathFor(handle, "-closed"), "utf8"))), eventId: `${handle.request.id}:escalated` });
  unknown(dir, now);rmSync(pathFor(handle, "-delivered"));clear(dir, now, 1);
});

test("heavy READY v2 foreign closure nonces hashes and deadline timestamps cannot close admission", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("bad-closure", "gate", { dir, now });
  const closure = { version: 2, requestHash: hash(handle.request), nonce: handle.request.owner.nonce, kind: "released", atMs: now };
  for (const bad of [{ ...closure, nonce: "foreign" }, { ...closure, requestHash: "foreign" },
    { ...closure, atMs: handle.request.expiresAtMs }, { ...closure, kind: "escalated", atMs: handle.request.expiresAtMs + 1 }]) {
    put(pathFor(handle, "-closed"), bad);unknown(dir, now);
  }
  rmSync(pathFor(handle, "-closed"));assert.equal(readHeavyNewBuildHold({ dir, now }).state, "held");
});

test("heavy READY v2 foreign delivery acknowledgements never suppress pending escalation silently", t => {
  const dir = fixture(t), now = Date.now(), handle = reserveHeavyNewBuilds("bad-delivery", "gate", { dir, now });
  readHeavyNewBuildHold({ dir, now: handle.request.expiresAtMs, log: () => {} });
  const original = readFileSync(pathFor(handle, "-delivered")), ack = JSON.parse(original.toString());
  for (const bad of [{ ...ack, version: 99 }, { ...ack, closureHash: "foreign" }, { ...ack, eventId: "foreign" }]) {
    put(pathFor(handle, "-delivered"), bad);unknown(dir, handle.request.expiresAtMs);
  }
  writeFileSync(pathFor(handle, "-delivered"), original);clear(dir, now - 1, 1);
});

test("heavy READY v2 a native reader refuses symlink and FIFO requests without blocking", { timeout: 10000 }, t => {
  const dir = fixture(t), handle = reserveHeavyNewBuilds("nonregular", "gate", { dir });
  nativeChild(dir, `
    const fs = await import('node:fs'), cp = await import('node:child_process');
    const path = process.argv[2], backup = path + '.fixture-backup';
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
    fs.renameSync(path, backup);
    fs.symlinkSync(backup, path);
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'unavailable');
    fs.unlinkSync(path);
    cp.execFileSync('mkfifo', [path], {timeout:1000});
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'unavailable');
    fs.unlinkSync(path);fs.renameSync(backup, path);
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
  `, [pathFor(handle)]);
});

test("heavy READY v2 private mode directory aliases and hardlinked records fail the real adapter", t => {
  const root = fixture(t), dir = join(root, "state"), handle = reserveHeavyNewBuilds("private-guards", "gate", { dir });
  const gate = heavyNewBuildGate(() => {}, { dir });
  assert.equal(gate()?.requestId, handle.request.id);
  chmodSync(dir, 0o755);assert.throws(gate, /unavailable/);chmodSync(dir, 0o700);
  chmodSync(pathFor(handle), 0o644);assert.throws(gate, /unavailable/);chmodSync(pathFor(handle), 0o600);
  const alias = join(root, "directory-alias");symlinkSync(dir, alias);
  assert.throws(heavyNewBuildGate(() => {}, { dir: alias }), /unavailable/);
  const hardlink = join(dir, "fixture-hardlink");linkSync(pathFor(handle), hardlink);
  assert.throws(gate, /unavailable/);rmSync(hardlink);
  assert.equal(gate()?.requestId, handle.request.id);
});

test("heavy READY v2 a native foreign UID observation throws at the default adapter without chown", { timeout: 10000 }, t => {
  const dir = fixture(t), handle = reserveHeavyNewBuilds("uid-guard", "gate", { dir });
  nativeChild(dir, `
    const fs = (await import('node:fs')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const raw = fs.fstatSync, gate = api.heavyNewBuildGate(()=>{}, {dir});
    assert.ok(gate());
    fs.fstatSync = (...args) => {
      const actual = raw(...args);
      return new Proxy(actual, {get(target, key, receiver) {
        return key === 'uid' ? target.uid + 1 : Reflect.get(target, key, receiver);
      }});
    };syncBuiltinESMExports();
    try {
      assert.equal(api.readHeavyNewBuildHold({dir}).state, 'unavailable');
      assert.throws(gate, /unavailable/);
    } finally {fs.fstatSync = raw;syncBuiltinESMExports();}
    assert.ok(gate());
  `);
  assert.equal(existsSync(pathFor(handle, "-closed")), false);
});

test("heavy READY v2 an interrupted native census closes its descriptor and never becomes clear", { timeout: 10000 }, t => {
  const dir = fixture(t);reserveHeavyNewBuilds("interrupted-census", "gate", { dir });
  nativeChild(dir, `
    const fs = (await import('node:fs')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const raw = fs.opendirSync;let closed = 0;
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
    fs.opendirSync = (...args) => {
      const actual = raw(...args), close = actual.closeSync.bind(actual);
      actual.readSync = () => {throw Object.assign(new Error('fixture census EIO'), {code:'EIO'});};
      actual.closeSync = () => {closed++;return close();};return actual;
    };syncBuiltinESMExports();
    try {
      const reading = api.readHeavyNewBuildHold({dir});
      assert.equal(reading.state, 'unavailable');assert.match(reading.reason, /census EIO/);
      assert.equal(closed, 1);assert.throws(api.heavyNewBuildGate(()=>{}, {dir}), /unavailable/);
      assert.equal(closed, 2);
    } finally {fs.opendirSync = raw;syncBuiltinESMExports();}
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
  `);
});

test("heavy READY v2 more than 256 closed requests retain history without consuming active capacity", t => {
  const dir = fixture(t), now = Date.now();
  for (let i = 0; i < 257; i++) {
    const handle = reserveHeavyNewBuilds(`closed-history-${i}`, "gate", { dir, now });
    assert.equal(releaseHeavyNewBuilds(handle, { now }), true);
  }
  clear(dir, now, 257);
  const active = reserveHeavyNewBuilds("new-after-history", "gate", { dir, now });
  const reading = readHeavyNewBuildHold({ dir, now });
  assert.equal(reading.state, "held");if (reading.state !== "held") return;
  assert.equal(reading.observed, 258);assert.equal(reading.pendingEscalations, 0);
  assert.equal(reading.hold.requestId, active.request.id);
  assert.equal(readdirSync(dir).filter(name => /^heavy-build-[a-f0-9]{64}\.json$/.test(name)).length, 258);
  const replay = reserveHeavyNewBuilds("closed-history-0", "gate", { dir, now: now + 1 });
  assert.equal(replay.owned, false);assert.equal(replay.request.readyAtMs, now);
});

test("heavy READY v2 the 257th active request makes the bounded census unavailable without deleting demand", t => {
  const dir = fixture(t), now = Date.now();
  const handles = Array.from({ length: 256 }, (_, i) => reserveHeavyNewBuilds(`active-${i}`, "gate", { dir, now }));
  assert.equal(readHeavyNewBuildHold({ dir, now }).state, "held");
  reserveHeavyNewBuilds("active-overflow", "gate", { dir, now });unknown(dir, now);
  assert.equal(readdirSync(dir).filter(name => /^heavy-build-[a-f0-9]{64}\.json$/.test(name)).length, 257);
  assert.equal(releaseHeavyNewBuilds(handles[0]!, { now }), true);
  const reading = readHeavyNewBuildHold({ dir, now });
  assert.equal(reading.state, "held");if (reading.state === "held") assert.equal(reading.observed, 257);
});

test("heavy READY v2 unset default configuration disables only this adapter in a native process", { timeout: 10000 }, t => {
  const dir = fixture(t);reserveHeavyNewBuilds("not-the-default-slot", "gate", { dir });
  nativeChild(dir, `
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
    delete process.env.RMD_HEAVY_READY_DIR;
    assert.equal(api.heavyNewBuildGate(()=>assert.fail('disabled adapter must not log'))(), undefined);
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
  `);
});

test("heavy READY v2 the native default adapter uses explicit environment while options take precedence", { timeout: 10000 }, t => {
  const dir = fixture(t), handle = reserveHeavyNewBuilds("environment-opt-in", "gate", { dir });
  nativeChild(dir, `
    process.env.RMD_HEAVY_READY_DIR = dir;
    assert.equal(api.heavyNewBuildGate(()=>{})()?.requestId, process.argv[2]);
    process.env.RMD_HEAVY_READY_DIR = dir + '/missing';
    assert.equal(api.heavyNewBuildGate(()=>{}, {dir})()?.requestId, process.argv[2]);
    assert.throws(api.heavyNewBuildGate(()=>{}), /unavailable/);
  `, [handle.request.id]);
});

test("heavy READY v2 a configured missing directory throws instead of becoming clear or creating state", t => {
  const dir = join(fixture(t), "configured-missing"), events: Array<{ step: string; fields: Record<string, unknown> }> = [];
  unknown(dir, Date.now());
  assert.throws(heavyNewBuildGate((step, fields) => events.push({ step, fields }), { dir }), /unavailable/);
  assert.equal(existsSync(dir), false);
  assert.equal(events.length, 1);assert.equal(events[0]!.step, "heavy_ready.unavailable");
  assert.equal(events[0]!.fields.scope, "NEW-implement-only");
});

test("heavy READY v2 Linux unknown filesystem types never inherit ext4 or XFS admission authority", { timeout: 10000, skip: process.platform !== "linux" }, t => {
  const dir = fixture(t);reserveHeavyNewBuilds("filesystem-guard", "gate", { dir });
  nativeChild(dir, `
    const fs = (await import('node:fs')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const raw = fs.statfsSync;
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
    fs.statfsSync = (...args) => ({...raw(...args), type:0x6969});syncBuiltinESMExports();
    try {
      const reading = api.readHeavyNewBuildHold({dir});assert.equal(reading.state, 'unavailable');
      assert.match(reading.reason, /ext4\/XFS/);
      assert.throws(api.heavyNewBuildGate(()=>{}, {dir}), /unavailable/);
    } finally {fs.statfsSync = raw;syncBuiltinESMExports();}
    assert.equal(api.readHeavyNewBuildHold({dir}).state, 'held');
  `);
});
