import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error -- standalone .mjs tool is outside tsconfig and has no declarations.
import { attestedOpen, ownerOnlyHome, seedIsOpen } from "#scripts/dependency-seeds.mjs";
// @ts-expect-error -- standalone .mjs tool has no declarations.
import * as dependencyCli from "#scripts/dependency-seeds.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { sampleWorkspaceUsage } from "#src/lib/workspace-usage.js";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

test("W1-T10949: cleanup drops only completed owner-disposable payload while active shared and unpublished inputs remain protected", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-owned-cleanup-")));
  const cli = join(REPO_ROOT, "scripts/dependency-seeds.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, RMD_DEPENDENCY_SEED_ROOT: "" },
  });
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" }).pid;
  const make = (name: string, pid = dead) => {
    const scratch = join(root, name);
    const result = run("allocate", scratch, "--owner", "owner-a", "--kind", "coverage", "--consumers", String(pid));
    assert.equal(result.status, 0, result.stderr);
    const allocated = JSON.parse(result.stdout), payload = allocated.payload;
    writeFileSync(join(payload, "raw.json"), "disposable ranges");
    const measured = sampleWorkspaceUsage(root, { roots: [], scratchRoots: [allocated.scratchRoot], maxMs: 1000 });
    assert.equal(measured.completeness, "complete"); assert.ok(measured.generatedPathBytes! > 0);
    const receipt = join(root, `${name}-receipt.json`);
    writeFileSync(receipt, JSON.stringify({ version: 1, owner: "owner-a", scratch,
      completed: true, published: true, disposable: true, exclusive: true }), { mode: 0o600 });
    return { scratch, payload, receipt };
  };
  const clean = (f: ReturnType<typeof make>, extra = {}) => dependencyCli.cleanupOwnedScratch(f.scratch, {
    owner: "owner-a", receipt: f.receipt, apply: true, isOpen: () => false, ...extra,
  });
  try {
    const done = make("done");
    const dry = dependencyCli.cleanupOwnedScratch(done.scratch, { owner: "owner-a", receipt: done.receipt });
    assert.equal(dry.action, "would-remove"); assert.equal(existsSync(done.payload), true);
    assert.ok(dry.observedPathBytes > 0); assert.equal(dry.entries, 2);
    assert.equal(clean(done).action, "remove"); assert.equal(existsSync(done.payload), false);
    assert.equal(readFileSync(done.receipt, "utf8").includes('"published":true'), true);
    const journal = JSON.parse(readFileSync(join(done.scratch, "cleanup.json"), "utf8"));
    assert.equal(journal.action, "remove"); assert.equal(journal.receipt, done.receipt);
    assert.match(journal.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(done.scratch, ".rmd-owned-disposable.json")), true);

    const active = make("active", process.pid);
    assert.match(clean(active).reason, /consumer/); assert.equal(existsSync(active.payload), true);
    const hiddenConsumer = make("hidden-consumer");
    const deniedProbe = t.mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    try { assert.match(clean(hiddenConsumer).reason, /consumer unverified.*permission denied/); }
    finally { deniedProbe.mock.restore(); }
    assert.equal(existsSync(hiddenConsumer.payload), true);
    const lent = make("lent"); assert.match(clean(lent, { isOpen: () => true }).reason, /open/);
    assert.equal(existsSync(lent.payload), true);
    const unknown = make("unknown");
    assert.match(clean(unknown, { isOpen: () => { throw new Error("scan unavailable"); } }).reason, /scan unavailable/);
    assert.equal(existsSync(unknown.payload), true);
    assert.match(clean(unknown, { isOpen: () => undefined }).reason, /unverified/);
    assert.equal(existsSync(unknown.payload), true);
    const wrongOwner = make("wrong-owner");
    assert.throws(() => clean(wrongOwner, { owner: "owner-b" }), /owner/);
    assert.equal(existsSync(wrongOwner.payload), true);
    const foreign = make("foreign-namespace"), marker = join(foreign.scratch, ".rmd-owned-disposable.json");
    const foreignRecord = JSON.parse(readFileSync(marker, "utf8"));
    foreignRecord.namespace = "foreign mount or pid namespace"; writeFileSync(marker, JSON.stringify(foreignRecord));
    assert.throws(() => clean(foreign), /identity/); assert.equal(existsSync(foreign.payload), true);

    for (const field of ["completed", "published", "disposable", "exclusive"]) {
      const f = make(field), receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      receipt[field] = false; writeFileSync(f.receipt, JSON.stringify(receipt));
      assert.throws(() => clean(f), /receipt/); assert.equal(existsSync(f.payload), true);
    }
    const shared = make("shared"), outside = join(root, "shared-generation"); mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "immutable input");
    symlinkSync(outside, join(shared.payload, "borrowed"));
    assert.throws(() => clean(shared), /link/); assert.equal(readFileSync(join(outside, "keep"), "utf8"), "immutable input");
    const hardlinked = make("hardlinked"); linkSync(join(outside, "keep"), join(hardlinked.payload, "lent"));
    assert.throws(() => clean(hardlinked), /link/); assert.equal(existsSync(hardlinked.payload), true);
    if (process.platform === "linux") {
      const mounted = make("mounted"), originalRead = fs.readFileSync;
      const fakeMount = t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
        if (args[0] === "/proc/self/mountinfo") return `42 1 0:1 / ${mounted.payload}/borrowed rw - tmpfs tmpfs rw\n`;
        return Reflect.apply(originalRead, fs, args);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      try { assert.throws(() => clean(mounted), /mount/); assert.equal(existsSync(mounted.payload), true); }
      finally { fakeMount.mock.restore(); syncBuiltinESMExports(); }
    }
    const changed = make("changed"); renameSync(changed.payload, `${changed.payload}-old`); mkdirSync(changed.payload, { mode: 0o700 });
    assert.throws(() => clean(changed), /identity/); assert.equal(existsSync(`${changed.payload}-old/raw.json`), true);
    const evidence = make("evidence");
    const inside = join(evidence.payload, "receipt.json"); renameSync(evidence.receipt, inside);
    assert.throws(() => clean(evidence, { receipt: inside }), /outside/); assert.equal(existsSync(inside), true);
    const source = make("unpublished"); mkdirSync(join(source.payload, ".git"));
    assert.throws(() => clean(source), /protected/); assert.equal(existsSync(source.payload), true);
    const claim = make("reserved"); writeFileSync(join(claim.payload, "cash-reservation"), "held");
    assert.throws(() => clean(claim), /protected/); assert.equal(existsSync(claim.payload), true);
    const linkedReceipt = make("linked-receipt");
    const alias = join(root, "receipt-alias"); symlinkSync(linkedReceipt.receipt, alias);
    assert.throws(() => clean(linkedReceipt, { receipt: alias }), /outside/);
    const publicReceipt = make("public-receipt"); chmodSync(publicReceipt.receipt, 0o644);
    assert.throws(() => clean(publicReceipt), /unverified/);
    const bound = make("bounded");
    for (let n = 0; n < 10000; n++) writeFileSync(join(bound.payload, `range-${n}.json`), "{}");
    assert.throws(() => clean(bound), /bound/); assert.equal(existsSync(bound.payload), true);
    const swapped = make("changed-during-scan");
    assert.throws(() => clean(swapped, { isOpen: () => { writeFileSync(join(swapped.payload, "later"), "unpublished"); return false; } }), /changed/);
    assert.equal(existsSync(join(swapped.payload, "later")), true);
    assert.equal(existsSync(join(swapped.scratch, "cleanup-intent.json")), true);
    assert.equal(existsSync(join(swapped.scratch, "cleanup.json")), false);

    const real = make("real-cli");
    const outcome = run("cleanup", real.scratch, "--owner", "owner-a", "--receipt", real.receipt);
    assert.equal(outcome.status, 0, outcome.stderr); assert.equal(JSON.parse(outcome.stdout).action, "would-remove");
    assert.equal(existsSync(real.payload), true);
    const cwd = spawnSync(process.execPath, [cli, "cleanup", real.scratch, "--owner", "owner-a", "--receipt", real.receipt, "--apply"], {
      cwd: real.payload, env: { ...process.env, RMD_DEPENDENCY_SEED_ROOT: "" }, encoding: "utf8",
    });
    assert.equal(cwd.status, 1); assert.match(cwd.stderr, /current working directory/);
    const defaultScan = run("cleanup", real.scratch, "--owner", "owner-a", "--receipt", real.receipt, "--apply");
    assert.equal(defaultScan.status, 0, defaultScan.stderr);
    const scanned = JSON.parse(defaultScan.stdout);
    if (scanned.action === "keep") {
      assert.match(scanned.reason, /open|scan/); assert.equal(existsSync(real.payload), true);
    } else {
      assert.equal(scanned.action, "remove"); assert.equal(existsSync(real.payload), false);
    }
    if (process.platform === "linux") {
      const shellScan = make("real-scanner"), bin = join(root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        assert.equal(clean(shellScan, { isOpen: (path: string) => seedIsOpen(path, 0) }).action, "remove");
        assert.equal(existsSync(shellScan.payload), false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      }
    }
    assert.notEqual(run("allocate", real.scratch, "--owner", "owner-a", "--kind", "coverage", "--consumers", String(dead)).status, 0);
    const protectedParent = join(root, "seed-store"); mkdirSync(protectedParent, { mode: 0o700 });
    writeFileSync(join(protectedParent, ".rmd-dependency-seed-root.json"), '{"version":1}');
    const protectedAllocation = run("allocate", join(protectedParent, "scratch"), "--owner", "owner-a", "--kind", "coverage", "--consumers", String(dead));
    assert.equal(protectedAllocation.status, 1); assert.match(protectedAllocation.stderr, /protected/);
    assert.equal(existsSync(join(protectedParent, "scratch")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dependency seed CLI requires administrator scans and distinguishes no-open-files from unknown", () => {
  assert.throws(() => seedIsOpen("/seed", 501), /administrator/);
  const calls: unknown[][] = [];
  const exec = (...args: unknown[]) => { calls.push(args); return "node holds a file"; };
  assert.equal(seedIsOpen("/seed", 0, exec), true);
  assert.equal(calls[0]?.[0], process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof");
  assert.deepEqual(calls[0]?.[1], ["-nP", "+D", "/seed"]);
  assert.deepEqual(calls[0]?.[2], { encoding: "utf8", timeout: 30_000 });
  assert.equal(seedIsOpen("/seed", 0, () => ""), false);
  assert.equal(seedIsOpen("/seed", 0, () => { throw Object.assign(new Error("none"), { status: 1, stdout: "", stderr: "" }); }), false);
  for (const evidence of [{ status: 2 }, { status: 1, stdout: "partial" }, { status: 1, stderr: "permission denied" }]) {
    assert.throws(() => seedIsOpen("/seed", 0, () => { throw Object.assign(new Error("unknown"), evidence); }), /unknown/);
  }
});

test("dependency seed CLI enables once, preserves configuration and defaults to a dry sweep", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-cli-")));
  const home = join(root, "home"); mkdirSync(home);
  const cli = join(process.cwd(), "scripts", "dependency-seeds.mjs");
  const env = { ...process.env, HOME: home, RMD_DEPENDENCY_SEED_ROOT: "" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  try {
    const enabled = run("enable"); assert.equal(enabled.status, 0, enabled.stderr);
    const { config, root: store } = JSON.parse(enabled.stdout);
    const original = readFileSync(config, "utf8");
    assert.equal(run("enable").status, 1);
    assert.equal(readFileSync(config, "utf8"), original);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, ".rmd-dependency-seed-root.json"), '{"version":1}');
    const swept = run("sweep", "--root", store); assert.equal(swept.status, 0, swept.stderr);
    assert.deepEqual(JSON.parse(swept.stdout), []);
    const applied = run("sweep", "--apply", "--root", store); assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(JSON.parse(applied.stdout), []);
    assert.match(run("unknown").stderr, /usage:/);
    assert.match(run("enable", "--root", "relative").stderr, /must be absolute/);
    rmSync(join(home, ".config", "remudero"), { recursive: true });
    const overridden = run("enable", "--root", join(root, "explicit")); assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(JSON.parse(overridden.stdout).root, join(root, "explicit"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the dependency seed CLI sweeps a URL-encoded stray store named by --root but refuses it as configuration", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-cli-")));
  const stray = join(root, "home/Library/Application%20Support/Remudero/dependencies");
  const cli = join(process.cwd(), "scripts", "dependency-seeds.mjs");
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: join(root, "home"), ...env }, encoding: "utf8" });
  try {
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, ".rmd-dependency-seed-root.json"), '{"version":1}');
    const named = run({ RMD_DEPENDENCY_SEED_ROOT: "" }, "sweep", "--root", stray, "--apply");
    assert.equal(named.status, 0, named.stderr);
    assert.deepEqual(JSON.parse(named.stdout), []);
    const configured = run({ RMD_DEPENDENCY_SEED_ROOT: stray }, "sweep");
    assert.notEqual(configured.status, 0);
    assert.match(configured.stderr, /URL-encoded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a seed store in an owner-only macOS home is scanned with the owner's own lsof", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-home-")));
  try {
    const seed = join(home, "Library/seeds/abc"), uid = process.getuid!();
    const acl = (line: string) => () => `drwx------+ 9 me staff 288 Oct 21 10:00 ${home}\n ${line}\n`;
    chmodSync(home, 0o700);
    assert.equal(ownerOnlyHome(seed, uid, home, acl("0: group:everyone deny delete"), "darwin"), true);
    assert.equal(ownerOnlyHome(seed, uid, home, acl("0: user:other allow list,search"), "darwin"), false, "an ACL grant lets another account in");
    assert.equal(ownerOnlyHome(seed, uid, home, acl(""), "linux"), false, "Linux keeps the administrator scan");
    assert.equal(ownerOnlyHome("/elsewhere/seed", uid, home, acl(""), "darwin"), false);
    assert.equal(ownerOnlyHome(seed, uid + 1, home, acl(""), "darwin"), false);
    chmodSync(home, 0o711);
    assert.equal(ownerOnlyHome(seed, uid, home, acl(""), "darwin"), false, "others can traverse the home");
    assert.equal(seedIsOpen(seed, 501, () => "", () => true), false);
    assert.throws(() => seedIsOpen(seed, 501, () => "", () => false), /administrator/);
  } finally { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
});

test("a fresh root-owned open-file scan stands in for the administrator scan; a stale, foreign or writable one does not", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-scan-")));
  try {
    const scans = join(root, "open-files"); mkdirSync(scans, { mode: 0o755 }); chmodSync(root, 0o755); chmodSync(scans, 0o755);
    const store = join(root, "home/Library/Application Support/Remudero/dependencies"), seed = join(store, "abc");
    const uid = process.getuid!(), now = Date.now();
    const file = join(scans, createHash("sha256").update(store.toLowerCase()).digest("hex") + ".json");
    const write = (scan: Record<string, unknown>, mode = 0o644) => {
      writeFileSync(file, JSON.stringify({ version: 1, root: store, scannedAt: Math.floor(now / 1000), open: [], ...scan })); chmodSync(file, mode);
    };
    const check = (opts: Record<string, unknown> = {}) => attestedOpen(seed, { dir: scans, now, rootUid: uid, ...opts });
    assert.equal(check(), undefined, "no scan");
    write({}); assert.equal(check(), false);
    write({ open: [join(store, "other/file.js")] }); assert.equal(check(), false, "another generation's open file");
    write({ open: [join(seed, "node_modules/x/index.js").toUpperCase()] }); assert.equal(check(), true, "case-insensitive names");
    write({ scannedAt: Math.floor(now / 1000) - 16 * 60 }); assert.equal(check(), undefined, "stale");
    write({ root: join(root, "elsewhere") }); assert.equal(check(), undefined, "another store");
    write({}, 0o666); assert.equal(check(), undefined, "writable by others");
    write({}); assert.equal(check({ rootUid: uid + 1 }), undefined, "not written by root");
    assert.equal(seedIsOpen(seed, 501, () => "", () => false, () => false), false);
    assert.equal(seedIsOpen(seed, 501, () => "", () => false, () => true), true);
    assert.throws(() => seedIsOpen(seed, 501, () => "", () => false, () => undefined), /administrator/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root's seed scan records what lsof sees, refuses a symlinked store, and its installer runs no account code", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-seed-scan-")));
  try {
    const store = join(root, "dependencies"), seed = join(store, "abc"), out = join(root, "open-files");
    mkdirSync(seed, { recursive: true }); mkdirSync(out, { mode: 0o755 }); chmodSync(root, 0o755); chmodSync(out, 0o755);
    const lsof = join(root, "lsof");
    writeFileSync(lsof, `#!/bin/bash\nprintf 'p42\\nfcwd\\nn%s\\n' '${seed}/node_modules/x/index.js'\n`, { mode: 0o755 });
    const script = join(process.cwd(), "deploy/mac/seed-open-files.py");
    const run = (...roots: string[]) => spawnSync("python3", ["-I", script, "--out", out, "--lsof", lsof, ...roots], { encoding: "utf8" });
    const ok = run(store);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(attestedOpen(seed, { dir: out, rootUid: process.getuid!() }), true);
    symlinkSync(root, join(root, "alias")); // the store itself is a real folder; its parent is a link
    const refused = run(join(root, "alias/dependencies"));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a symlink/);

    const installer = join(process.cwd(), "deploy/mac/install-seed-open-files.sh");
    const plist = spawnSync("bash", [installer, "--print-plist", store], { encoding: "utf8" });
    assert.equal(plist.status, 0, plist.stderr);
    assert.match(plist.stdout, /<string>\/usr\/bin\/python3<\/string>\s*<string>-I<\/string>\s*<string>\/Library\/Application Support\/Remudero\/libexec\/seed-open-files.py<\/string>/);
    assert.match(plist.stdout, new RegExp(`<string>${store}</string>`));
    if (process.getuid!() !== 0) assert.match(spawnSync("bash", [installer, store], { encoding: "utf8" }).stderr, /run with sudo/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
