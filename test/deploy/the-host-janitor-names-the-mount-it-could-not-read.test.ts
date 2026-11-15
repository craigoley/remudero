import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { age, fixture, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

interface Containers {
  /** Container ids the first `docker ps` lists, and the ids every later list shows. */
  first: string[];
  later: string[];
  /** The mount source each container reports. */
  sources: Record<string, string>;
}

/** A Docker stand-in whose container list can change between the first read and the next. */
function docker(fx: Fixture, c: Containers): string {
  const bin = join(fx.root, "docker-changing"), calls = join(fx.root, "docker.calls");
  const sources = Object.entries(c.sources).map(([id, src]) => `    ${id}) printf '%s\\n' '${src}' ;;`).join("\n");
  writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
  ps) if [ "$(grep -c '^ps' '${calls}')" -le 1 ]; then printf '%s\\n' ${c.first.join(" ")}; else printf '%s\\n' ${c.later.join(" ")}; fi ;;
  inspect)
    for id; do :; done
    case "$*" in *.Name*) printf '/worker-%s\\n' "$id"; exit 0 ;; esac
    case "$id" in
${sources}
      *) exit 1 ;;
    esac ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  fx.env.RMD_CLEANUP_DOCKER = bin;
  return calls;
}

function unit(fx: Fixture, name: string, root = fx.scratch): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "payload"), "fixture\n");
  age(p);
  return p;
}

function scope(fx: Fixture, extra: Record<string, string> = {}) {
  return run(fx, { RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "", RMD_CLEANUP_DUMP_RESUMABLE_ROOTS: "", RMD_CLEANUP_RETAIN_ROOTS: "", RMD_CLEANUP_NESTED_COVERAGE_ROOTS: "", RMD_CLEANUP_TMP_GLOBS: "rmd-idle*", ...extra });
}

const lines = (out: string, prefix: string) => out.split("\n").filter((l) => l.startsWith(prefix));

test("W1-T12269 criterion 1: an unread identity names the mount source, its container and the read error, or the candidate path whose read failed", () => {
  const fx = fixture();
  const gone = join(fx.root, "gone-mount-source");
  docker(fx, { first: ["c1"], later: ["c1"], sources: { c1: gone } });
  unit(fx, "rmd-idle");
  const r = scope(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const hold = lines(r.stdout, "HOLD ALL:");
  assert.equal(hold.length, 1, r.stdout);
  assert.match(hold[0], /^HOLD ALL: Docker mount identity unreadable: container=worker-c1 source=(\S+) read=.*No such file or directory/);
  assert.ok(hold[0].includes(`source=${gone} read=`), hold[0]);

  const fy = fixture();
  const live = join(fy.root, "live-mount"); mkdirSync(live);
  docker(fy, { first: ["c1"], later: ["c1"], sources: { c1: live } });
  const link = join(fy.scratch, "tsx-dangling");
  symlinkSync(join(fy.root, "missing-target"), link);
  const s = scope(fy);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  const keep = lines(s.stdout, `KEEP ${link}:`);
  assert.equal(keep.length, 1, s.stdout);
  assert.match(keep[0], /\(read=.*No such file or directory\)$/, keep[0]);
});

test("W1-T12269 criterion 2: a pass prints the hold cause once at its start and each held candidate refers to it", () => {
  const fx = fixture();
  docker(fx, { first: ["c1"], later: ["c1"], sources: { c1: join(fx.root, "gone-mount-source") } });
  const a = unit(fx, "rmd-idle-a"), b = unit(fx, "rmd-idle-b");
  const r = scope(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = r.stdout.split("\n");
  const hold = all.findIndex((l) => l.startsWith("HOLD ALL: Docker mount identity unreadable: container=worker-c1 source="));
  assert.equal(lines(r.stdout, "HOLD ALL:").length, 1, r.stdout);
  for (const p of [a, b]) {
    const at = all.indexOf(`KEEP ${p}: Docker mount identity unreadable (see HOLD ALL)`);
    assert.ok(at > hold && hold >= 0, `${p} refers to the one HOLD ALL line printed before it\n${r.stdout}`);
    assert.equal(readFileSync(join(p, "payload"), "utf8"), "fixture\n");
  }
  assert.equal(all.filter((l) => l.includes("(fail closed)") && l.includes("identity unreadable")).length, 0, r.stdout);
});

test("W1-T12269 criterion 3: a mount source gone with its ended container is read again once and the pass uses the second list", () => {
  const fx = fixture();
  const live = join(fx.root, "live-mount"); mkdirSync(live);
  const calls = docker(fx, { first: ["ended", "live"], later: ["live"], sources: { ended: join(fx.root, "ended-mount-source"), live } });
  const free = unit(fx, "rmd-idle"), held = unit(fx, "rmd-idle-mounted", live);
  const r = scope(fx, { RMD_CLEANUP_TMP_ROOTS: `${fx.scratch}:${live}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lines(r.stdout, "RE-READ Docker mounts: Docker mount identity unreadable: container=worker-ended source=").length, 1, r.stdout);
  assert.equal(lines(r.stdout, "HOLD ALL:").length, 0, r.stdout);
  assert.equal(readFileSync(calls, "utf8").split("\n").filter((l) => l === "ps -q").length, 2, "the list is taken exactly twice");
  assert.equal(existsSync(free), false, `an unmounted candidate is judged as usual\n${r.stdout}`);
  assert.equal(readFileSync(join(held, "payload"), "utf8"), "fixture\n", "the live container's mount is still honoured");
  assert.ok(r.stdout.includes(`KEEP ${held}: running container mount`), r.stdout);
});

test("W1-T12269 criterion 4: a candidate that is a dangling symlink is held by name and the other candidates are judged as usual", () => {
  const fx = fixture();
  const live = join(fx.root, "live-mount"); mkdirSync(live);
  docker(fx, { first: ["c1"], later: ["c1"], sources: { c1: live } });
  const link = join(fx.scratch, "tsx-dangling");
  symlinkSync(join(fx.root, "missing-target"), link);
  const free = unit(fx, "rmd-idle");
  const r = scope(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`KEEP ${link}: dangling symlink ${link} (read=`), r.stdout);
  assert.ok(lstatSync(link).isSymbolicLink(), "the dangling symlink is not removed");
  assert.equal(existsSync(free), false, `the other candidate is judged as usual\n${r.stdout}`);
  assert.equal(lines(r.stdout, "HOLD ALL:").length, 0, r.stdout);
});

test("W1-T12269 criterion 5: when the second read also fails every candidate is still held", () => {
  const fx = fixture();
  const calls = docker(fx, { first: ["c1"], later: ["c1"], sources: { c1: join(fx.root, "gone-mount-source") } });
  const a = unit(fx, "rmd-idle-a"), b = unit(fx, "rmd-idle-b");
  const r = scope(fx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(calls, "utf8").split("\n").filter((l) => l === "ps -q").length, 2, "the list was read a second time");
  assert.equal(lines(r.stdout, "RE-READ Docker mounts:").length, 1, r.stdout);
  assert.equal(lines(r.stdout, "HOLD ALL:").length, 1, r.stdout);
  for (const p of [a, b]) assert.equal(readFileSync(join(p, "payload"), "utf8"), "fixture\n", `${p} is held\n${r.stdout}`);
  assert.equal(lines(r.stdout, "REMOVE ").length, 0, r.stdout);
});
