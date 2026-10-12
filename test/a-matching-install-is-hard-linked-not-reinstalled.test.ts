import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashInstallInputs, installHashMarkerPath } from "../src/lib/install-hash.js";
import { installEscalatedMarkerPath, stagedInstall, StagedInstallFailedError, type StagedInstallOptions } from "../src/lib/staged-install.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const proof = "test/a-matching-install-is-hard-linked-not-reinstalled.test.ts";

function fixture(body: (f: { root: string; donor: string; target: string; calls: string; rows: Record<string, unknown>[]; options: StagedInstallOptions }) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}matching-install-`));
  const savedPath = process.env.PATH;
  try {
    const donor = join(root, "donor");
    const target = join(root, "target");
    for (const dir of [donor, target]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { dep: "1.0.0" } }));
      writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    }
    mkdirSync(join(donor, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(donor, "node_modules", "dep", "package.json"), '{"name":"dep","version":"1.0.0"}');
    writeFileSync(installHashMarkerPath(donor), hashInstallInputs(donor));
    mkdirSync(join(target, "node_modules"));
    writeFileSync(join(target, "node_modules", "old.txt"), "still serving");
    const calls = join(root, "npm-calls");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
fs.mkdirSync("node_modules/dep", { recursive: true });
fs.writeFileSync("node_modules/dep/package.json", '{"name":"dep","version":"1.0.0"}');
`);
    chmodSync(join(bin, "npm"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const rows: Record<string, unknown>[] = [];
    const options: StagedInstallOptions = {
      donorDirs: [donor],
      log: (step, extra) => rows.push({ step, ...extra }),
    };
    body({ root, donor, target, calls, rows, options });
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
}

test(`${proof}: a verified matching donor is hard-linked without npm`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    const donorPackage = join(donor, "node_modules", "dep", "package.json");
    assert.equal(statSync(donorPackage).nlink, 1, "positive control: a fresh donor has one link");
    const donorMarker = readFileSync(installHashMarkerPath(donor), "utf8");
    assert.equal(stagedInstall(target, options), "refreshed");
    const installed = statSync(join(target, "node_modules", "dep", "package.json"));
    assert.equal(installed.ino, statSync(donorPackage).ino);
    assert.ok(installed.nlink > 1);
    assert.equal(existsSync(calls), false);
    assert.equal(existsSync(join(target, "node_modules", "old.txt")), false);
    assert.equal(readFileSync(installHashMarkerPath(target), "utf8"), hashInstallInputs(target));
    assert.equal(readFileSync(installHashMarkerPath(donor), "utf8"), donorMarker);
    assert.equal(statSync(installHashMarkerPath(donor)).nlink, 1, "install markers stay private");
    assert.equal(rows.at(-1)?.method, "hard-linked");
    assert.equal(rows.at(-1)?.donor, donor);
  });
});

for (const reason of ["hash mismatch", "marker mismatch", "missing marker", "unverified dependencies", "other device", "symlink donor", "stale donor inputs"]) {
  test(`${proof}: ${reason} runs npm`, () => {
    fixture(({ root, donor, target, calls, rows, options }) => {
      if (reason === "hash mismatch") writeFileSync(join(target, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
      if (reason === "marker mismatch") writeFileSync(installHashMarkerPath(donor), "stale");
      if (reason === "missing marker") rmSync(installHashMarkerPath(donor));
      if (reason === "unverified dependencies") rmSync(join(donor, "node_modules", "dep"), { recursive: true });
      if (reason === "other device") options.device = (path) => path === join(donor, "node_modules") ? 2 : 1;
      if (reason === "symlink donor") {
        const modules = join(root, "linked-modules");
        renameSync(join(donor, "node_modules"), modules);
        symlinkSync(modules, join(donor, "node_modules"));
      }
      if (reason === "stale donor inputs") writeFileSync(join(donor, "package-lock.json"), "changed after install");
      assert.equal(stagedInstall(target, options), "refreshed");
      assert.equal(readFileSync(calls, "utf8"), "ci\n");
      assert.equal(statSync(join(target, "node_modules", "dep", "package.json")).nlink, 1);
      assert.equal(rows.at(-1)?.method, "npm-ci");
      assert.equal(rows.at(-1)?.donor, null);
    });
  });
}

test(`${proof}: a failed link removes partial hard links before npm`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    const before = readFileSync(join(donor, "node_modules", "dep", "package.json"), "utf8");
    options.linkInstall = (from, stage) => {
      execFileSync("cp", ["-al", join(from, "node_modules"), join(stage, "node_modules")]);
      throw new Error("link interrupted");
    };
    assert.equal(stagedInstall(target, options), "refreshed");
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.equal(readFileSync(join(donor, "node_modules", "dep", "package.json"), "utf8"), before);
    assert.equal(statSync(join(donor, "node_modules", "dep", "package.json")).nlink, 1);
    assert.match(String(rows.at(-1)?.donor_rejections), /link interrupted/);
  });
});

test(`${proof}: a donor verification exception falls back with its reason`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    options.verify = (dir) => {
      if (dir === donor) throw new Error("donor unreadable");
      return [];
    };
    stagedInstall(target, options);
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.match(String(rows.at(-1)?.donor_rejections), /donor unreadable/);
  });
});

test(`${proof}: failed staged link verification falls back to npm`, () => {
  fixture(({ target, calls, options }) => {
    let verification = 0;
    options.verify = () => ++verification === 2 ? ["dep"] : [];
    stagedInstall(target, options);
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.equal(verification, 3);
  });
});

test(`${proof}: sibling discovery reuses a donor without injected discovery`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    delete options.donorDirs;
    stagedInstall(target, options);
    assert.equal(existsSync(calls), false);
    assert.equal(rows.at(-1)?.donor, donor);
    assert.ok(statSync(join(target, "node_modules", "dep", "package.json")).nlink > 1);
  });
});

test(`${proof}: no donor runs npm and an install failure preserves the live tree`, () => {
  fixture(({ target, calls, rows, options }) => {
    options.donorDirs = [];
    stagedInstall(target, options);
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.equal(rows.at(-1)?.method, "npm-ci");
    writeFileSync(join(target, "package-lock.json"), "later lock");
    options.runInstall = () => { throw new Error("npm failed"); };
    assert.throws(() => stagedInstall(target, options), StagedInstallFailedError);
    assert.ok(existsSync(join(target, "node_modules", "dep", "package.json")));
  });
});

for (const changed of ["marker", "inputs"]) {
  test(`${proof}: donor ${changed} changing during the link falls back`, () => {
    fixture(({ donor, target, calls, rows, options }) => {
      options.linkInstall = (from, stage) => {
        execFileSync("cp", ["-al", join(from, "node_modules"), join(stage, "node_modules")]);
        writeFileSync(changed === "marker" ? installHashMarkerPath(donor) : join(donor, "package-lock.json"), "changed");
      };
      stagedInstall(target, options);
      assert.equal(readFileSync(calls, "utf8"), "ci\n");
      assert.match(String(rows.at(-1)?.donor_rejections), /changed while linking/);
      assert.equal(statSync(join(donor, "node_modules", "dep", "package.json")).nlink, 1);
    });
  });
}

test(`${proof}: a real copy failure falls back to npm with its reason`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    options.verify = (dir) => {
      if (dir === donor) rmSync(join(donor, "node_modules"), { recursive: true });
      return [];
    };
    stagedInstall(target, options);
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.match(String(rows.at(-1)?.donor_rejections), /cp/);
  });
});

test(`${proof}: a donor inspection failure reports its reason and runs npm`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    options.device = (path) => {
      if (path === join(donor, "node_modules")) throw new Error("cannot stat donor");
      return 1;
    };
    stagedInstall(target, options);
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.match(String(rows.at(-1)?.donor_rejections), /cannot stat donor/);
  });
});

test(`${proof}: discovery failure reports its reason and runs npm`, (t) => {
  fixture(({ root, donor, target, calls, rows, options }) => {
    delete options.donorDirs;
    rmSync(donor, { recursive: true });
    const original = fs.readdirSync;
    const mocked = t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === root) throw new Error("donor directory unreadable");
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      stagedInstall(target, options);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(calls, "utf8"), "ci\n");
    assert.match(String(rows.at(-1)?.donor_rejections), /donor directory unreadable/);
  });
});

test(`${proof}: a donor escalation marker is not inherited or modified`, () => {
  fixture(({ donor, target, calls, options }) => {
    writeFileSync(installEscalatedMarkerPath(donor), "donor failure");
    stagedInstall(target, options);
    assert.equal(existsSync(calls), false);
    assert.equal(existsSync(installEscalatedMarkerPath(target)), false);
    assert.equal(readFileSync(installEscalatedMarkerPath(donor), "utf8"), "donor failure");
    assert.equal(statSync(installEscalatedMarkerPath(donor)).nlink, 1);
  });
});

for (const targetIsDaemon of [false, true]) {
  test(`${proof}: default discovery shares between managed repos and daemon install (${targetIsDaemon})`, () => {
    fixture(({ root, donor, target, calls, rows, options }) => {
      mkdirSync(join(root, "repos"));
      const managed = join(root, "repos", "managed");
      const daemon = join(root, "daemon-install");
      const newDonor = targetIsDaemon ? managed : daemon;
      const newTarget = targetIsDaemon ? daemon : managed;
      renameSync(donor, newDonor);
      renameSync(target, newTarget);
      delete options.donorDirs;
      stagedInstall(newTarget, options);
      assert.equal(existsSync(calls), false);
      assert.equal(rows.at(-1)?.donor, newDonor);
      assert.ok(statSync(join(newTarget, "node_modules", "dep", "package.json")).nlink > 1);
    });
  });
}

test(`${proof}: the target is never its own donor and later valid candidates are tried`, () => {
  fixture(({ donor, target, calls, rows, options }) => {
    options.donorDirs = [target, donor];
    stagedInstall(target, options);
    assert.equal(existsSync(calls), false);
    assert.equal(rows.at(-1)?.donor, donor);
  });
});
