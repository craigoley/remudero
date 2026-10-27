import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restoreState, snapshotState } from "#src/lib/ledger.js";

const engine = `engines/${"a".repeat(64)}`;
const link = `${engine}/node_modules`;
const manifest = "state-backup-engine-links.json";
const target = "../../../missing-install/node_modules";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-engine-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  fs.mkdirSync(join(state, engine, "payload"), { recursive: true });
  fs.writeFileSync(join(state, "ledger.ndjson"), '{"step":"run.start"}\n');
  fs.writeFileSync(join(state, "inbox-proposals.json"), '{"proposals":["P45"]}\n');
  fs.writeFileSync(join(state, engine, "engine.json"), JSON.stringify({
    sha: "b".repeat(40), sourceHash: "a".repeat(64), builtAt: 123,
  }));
  fs.writeFileSync(join(state, engine, "package.json"), '{"name":"engine"}');
  fs.writeFileSync(join(state, engine, "package-lock.json"), '{"lockfileVersion":3}');
  fs.writeFileSync(join(state, engine, "payload/tree.txt"), "regenerable payload");
  fs.symlinkSync(target, join(state, link));
  return { root, state, backups: join(root, "backups") };
}

function strike(method: "realpathSync" | "readdirSync" | "lstatSync" | "openSync" | "readlinkSync" | "statSync" | "readFileSync",
  path: string, action: () => void, run: () => void) {
  const original = fs[method];
  const inode = method === "readFileSync" ? fs.statSync(path).ino : undefined;
  let struck = false;
  // Builtin exports share the real operation; only the precisely named filesystem touch is struck.
  (fs as any)[method] = (...args: any[]) => {
    const matches = inode === undefined ? String(args[0]) === path :
      typeof args[0] === "number" && fs.fstatSync(args[0]).ino === inode;
    if (!struck && matches) {
      struck = true;
      action();
    }
    return Reflect.apply(original, fs, args);
  };
  syncBuiltinESMExports();
  try {
    run();
    assert.ok(struck, `the ${method} strike must execute`);
  } finally {
    (fs as any)[method] = original;
    syncBuiltinESMExports();
  }
}

function assertReaped(live: ReturnType<typeof fixture>, snapshot: ReturnType<typeof snapshotState>) {
  assert.deepEqual(snapshot.vanished, [engine]);
  assert.equal(fs.existsSync(join(snapshot.archiveDir, engine)), false);
  assert.equal(snapshot.entries.some((rel) => rel.startsWith(`${engine}/`)), false);
  assert.equal(snapshot.entries.includes(manifest), false);
  const restored = join(live.root, "restored");
  assert.deepEqual(restoreState(snapshot.archiveDir, restored).reconstructionRequired, []);
  for (const rel of ["ledger.ndjson", "inbox-proposals.json"]) {
    assert.deepEqual(fs.readFileSync(join(restored, rel)), fs.readFileSync(join(live.state, rel)));
  }
}

test("W1-T10766: an engine reaped before the walk descends into it is recorded as vanished", (t) => {
  for (const method of ["realpathSync", "readdirSync"] as const) {
    const live = fixture(t);
    strike(method, join(live.state, engine), () => fs.rmSync(join(live.state, engine), { recursive: true }),
      () => assertReaped(live, snapshotState(live.state, live.backups)));
  }
});

test("W1-T10766: an engine reaped before its link is preserved is recorded as vanished", (t) => {
  for (const [method, rel] of [
    ["lstatSync", link], ["lstatSync", "engines"], ["lstatSync", engine],
    ["openSync", `${engine}/engine.json`], ["openSync", `${engine}/package-lock.json`],
    ["readlinkSync", link],
  ] as const) {
    const live = fixture(t);
    strike(method, join(live.state, rel), () => fs.rmSync(join(live.state, rel === "engines" ? rel : engine), { recursive: true }),
      () => assertReaped(live, snapshotState(live.state, live.backups)));
  }
  for (const rel of [`${engine}/engine.json`, `${engine}/package-lock.json`]) {
    const live = fixture(t);
    strike("openSync", join(live.state, rel), () => fs.rmSync(join(live.state, rel)),
      () => assertReaped(live, snapshotState(live.state, live.backups)));
    assert.ok(fs.lstatSync(join(live.state, link)).isSymbolicLink(), "live links are retained");
  }
});

test("W1-T10766: an engine reaped during the copy leaves no half-recorded link", (t) => {
  for (const removed of [engine, `${engine}/package-lock.json`]) {
    const live = fixture(t);
    const snapshot = snapshotState(live.state, live.backups, {
      beforeCopy: (rel) => {
        if (rel === `${engine}/package-lock.json`) fs.rmSync(join(live.state, removed), { recursive: true });
      },
    });
    assertReaped(live, snapshot);
    if (removed !== engine) assert.ok(fs.existsSync(join(live.state, engine, "engine.json")), "omission only changes staging");
  }
});

test("W1-T10766: an engine tree is recorded by its evidence, not copied", (t) => {
  const live = fixture(t);
  const original = fs.readdirSync;
  const visited: string[] = [];
  t.mock.method(fs, "readdirSync", ((...args: any[]) => {
    visited.push(String(args[0]));
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readdirSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const touched: string[] = [];
  const snapshot = snapshotState(live.state, live.backups, { beforeCopy: (rel) => touched.push(rel) });
  assert.deepEqual(snapshot.entries.filter((rel) => rel.startsWith(`${engine}/`)), [
    `${engine}/engine.json`, link, `${engine}/package-lock.json`, `${engine}/package.json`,
  ].sort());
  assert.equal(touched.includes(`${engine}/payload/tree.txt`), false);
  assert.equal(visited.includes(join(live.state, engine, "payload")), false, "payload is never walked");
  assert.equal(fs.existsSync(join(snapshot.archiveDir, engine, "payload")), false);
  assert.equal(fs.readlinkSync(join(snapshot.archiveDir, link)), target);
  const metadata = JSON.parse(fs.readFileSync(join(snapshot.archiveDir, manifest), "utf8"));
  assert.equal(metadata.links[0].path, link);
  const restored = join(live.root, "restored");
  assert.deepEqual(restoreState(snapshot.archiveDir, restored).reconstructionRequired, [link]);
  for (const name of ["engine.json", "package.json", "package-lock.json"]) {
    assert.deepEqual(fs.readFileSync(join(restored, engine, name)), fs.readFileSync(join(live.state, engine, name)));
  }
  assert.equal(fs.readlinkSync(join(restored, link)), target);
  assert.equal(fs.existsSync(join(restored, engine, "payload")), false);
  assert.equal(fs.readFileSync(join(live.state, engine, "payload/tree.txt"), "utf8"), "regenerable payload");
});

test("a reaped engine is omitted while another engine's manifest remains restorable", (t) => {
  const live = fixture(t);
  const keptEngine = `engines/${"c".repeat(64)}`;
  fs.mkdirSync(join(live.state, keptEngine));
  fs.writeFileSync(join(live.state, keptEngine, "engine.json"), JSON.stringify({
    sha: "d".repeat(40), sourceHash: "c".repeat(64), builtAt: 123,
  }));
  fs.symlinkSync(target, join(live.state, keptEngine, "node_modules"));
  const snapshot = snapshotState(live.state, live.backups, {
    beforeCopy: (rel) => { if (rel === `${engine}/package.json`) fs.rmSync(join(live.state, engine), { recursive: true }); },
  });
  assert.deepEqual(snapshot.vanished, [engine]);
  assert.equal(fs.existsSync(join(snapshot.archiveDir, engine)), false);
  const metadata = JSON.parse(fs.readFileSync(join(snapshot.archiveDir, manifest), "utf8"));
  assert.deepEqual(metadata.links.map((entry: { path: string }) => entry.path), [`${keptEngine}/node_modules`]);
  assert.deepEqual(restoreState(snapshot.archiveDir, join(live.root, "restored")).reconstructionRequired, [`${keptEngine}/node_modules`]);
});

test("engine omission retains real dependency directories and paths outside engine hashes", (t) => {
  const live = fixture(t);
  const paths = ["engines/not-a-hash/src/payload", "node_modules/critical", `${engine}/node_modules/critical`];
  fs.rmSync(join(live.state, link));
  for (const rel of paths) {
    fs.mkdirSync(join(live.state, rel, ".."), { recursive: true });
    fs.writeFileSync(join(live.state, rel), rel);
  }
  const snapshot = snapshotState(live.state, live.backups);
  const restored = join(live.root, "restored");
  restoreState(snapshot.archiveDir, restored);
  for (const rel of paths) assert.equal(fs.readFileSync(join(restored, rel), "utf8"), rel);
});

test("engine snapshot touches refuse other errors and ENOENT while the entry still exists", (t) => {
  for (const [method, rel] of [
    ["realpathSync", engine], ["readdirSync", engine], ["lstatSync", link],
    ["lstatSync", "engines"], ["lstatSync", engine],
    ["openSync", `${engine}/engine.json`], ["readlinkSync", link],
  ] as const) {
    for (const code of ["ENOENT", "EACCES", "EIO", "ELOOP"]) {
      const live = fixture(t);
      strike(method, join(live.state, rel), () => { throw Object.assign(new Error(`fixture: ${code}`), { code }); }, () => {
        assert.throws(() => snapshotState(live.state, live.backups), new RegExp(`fixture: ${code}`));
        assert.deepEqual(fs.readdirSync(live.backups), []);
      });
    }
  }
});

test("a vanished engine evidence symlink is omitted but a dangling evidence symlink refuses", (t) => {
  const live = fixture(t);
  fs.symlinkSync("package.json", join(live.state, engine, "yarn.lock"));
  strike("statSync", join(live.state, engine, "yarn.lock"), () => fs.rmSync(join(live.state, engine, "yarn.lock")),
    () => assertReaped(live, snapshotState(live.state, live.backups)));
  fs.symlinkSync("missing", join(live.state, engine, "yarn.lock"));
  assert.throws(() => snapshotState(live.state, live.backups), /ENOENT/);
});

test("an evidence descriptor read distinguishes confirmed removal from an io failure", (t) => {
  for (const code of ["ENOENT", "EIO"]) {
    const live = fixture(t);
    const record = join(live.state, engine, "engine.json");
    strike("readFileSync", record, () => {
      if (code === "ENOENT") fs.rmSync(record);
      throw Object.assign(new Error(`fixture: ${code}`), { code });
    }, () => {
      if (code === "ENOENT") assertReaped(live, snapshotState(live.state, live.backups));
      else {
        assert.throws(() => snapshotState(live.state, live.backups), /fixture: EIO/);
        assert.deepEqual(fs.readdirSync(live.backups), []);
      }
    });
  }
});

test("losing critical state during the copy still refuses with an engine present", (t) => {
  for (const rel of ["ledger.ndjson", "inbox-proposals.json"]) {
    const live = fixture(t);
    assert.throws(() => snapshotState(live.state, live.backups, {
      beforeCopy: (entry) => { if (entry === rel) fs.rmSync(join(live.state, rel)); },
    }), /ENOENT|missing inbox-proposals.json/);
    assert.deepEqual(fs.readdirSync(live.backups), []);
  }
});
