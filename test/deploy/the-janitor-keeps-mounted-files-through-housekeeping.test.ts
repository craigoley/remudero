import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { age, fixture, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

function mount(fx: Fixture, path: string): void {
  const docker = join(fx.root, "docker-mounted");
  writeFileSync(docker, `#!/usr/bin/env bash
case "$1" in
  ps) printf 'fixture-container\\n' ;;
  inspect) printf '%s\\n' '${path}' ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  fx.env.RMD_CLEANUP_DOCKER = docker;
}

function file(path: string, body = "fixture\n", hours = 13): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  age(path, hours);
}

function scope(fx: Fixture): Record<string, string> {
  return { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "", RMD_CLEANUP_DUMP_RESUMABLE_ROOTS: "", RMD_CLEANUP_RETAIN_ROOTS: "", RMD_CLEANUP_NESTED_COVERAGE_ROOTS: "" };
}

test("container mounts keep generic temp units, tsx entries and nested coverage while unmounted peers are reaped", () => {
  const fx = fixture();
  const mounted = join(fx.root, "mounted"), peer = join(fx.root, "peer"), locks = join(fx.root, "locks");
  mkdirSync(locks);
  for (const root of [mounted, peer]) {
    for (const unit of ["rmd-idle", "tsx-1000", "rmd-c-123456789abc"]) {
      file(join(root, unit, "payload"));
      age(join(root, unit));
    }
  }
  mount(fx, mounted);
  const r = run(fx, { ...scope(fx), RMD_CLEANUP_TMP_ROOTS: `${mounted}:${peer}`, RMD_CLEANUP_TMP_GLOBS: "rmd-idle", RMD_CLEANUP_NESTED_COVERAGE_ROOTS: `${mounted}:${peer}`, RMD_CLEANUP_COVERAGE_LOCK_DIR: locks });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const unit of ["rmd-idle", "tsx-1000", "rmd-c-123456789abc"]) {
    assert.equal(readFileSync(join(mounted, unit, "payload"), "utf8"), "fixture\n", unit);
    assert.equal(existsSync(join(peer, unit, "payload")), false, `unmounted ${unit} is a positive cleanup control`);
  }
});

test("container mounts keep expiring and compressible dumps and retained archives while unmounted peers are reclaimed", () => {
  const fx = fixture();
  const mounted = join(fx.root, "mounted"), peer = join(fx.root, "peer");
  const body = JSON.stringify({ fixture: "x".repeat(6 * 1024 * 1024) }) + "\n";
  for (const root of [mounted, peer]) {
    file(join(root, "dumps", "idle.json"), body);
    file(join(root, "dumps", "expired.log"), body, 20 * 24);
    file(join(root, "retained", "old.txt"), "saved evidence\n", 20 * 24);
    mkdirSync(join(root, "retained", "empty")); age(join(root, "retained", "empty"));
    file(join(root, "preserved", ".incoming-idle", "payload")); age(join(root, "preserved", ".incoming-idle"));
  }
  mount(fx, mounted);
  const r = run(fx, { ...scope(fx), RMD_CLEANUP_PRESERVE_ROOT: join(mounted, "preserved"), RMD_CLEANUP_DUMP_ROOTS: `${mounted}:${peer}`, RMD_CLEANUP_RETAIN_ROOTS: `${join(mounted, "retained")}:${join(peer, "retained")}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ["idle.json", "expired.log"]) assert.equal(readFileSync(join(mounted, "dumps", name), "utf8"), body);
  assert.equal(existsSync(join(mounted, "dumps", "idle.json.gz")), false);
  assert.equal(readFileSync(join(mounted, "retained", "old.txt"), "utf8"), "saved evidence\n");
  assert.equal(existsSync(join(peer, "dumps", "idle.json")), false);
  assert.equal(existsSync(join(peer, "dumps", "idle.json.gz")), true, "unmounted compression control");
  assert.equal(existsSync(join(peer, "dumps", "expired.log")), false, "unmounted dump-expiry control");
  assert.equal(existsSync(join(peer, "retained", "old.txt")), false, "unmounted retention control");
  assert.equal(existsSync(join(mounted, "retained", "empty")), true, "mounted empty directory is kept");
  assert.equal(existsSync(join(peer, "retained", "empty")), false, "unmounted empty directory control");
  assert.equal(readFileSync(join(mounted, "preserved", ".incoming-idle", "payload"), "utf8"), "fixture\n");
  const next = run(fx, { ...scope(fx), RMD_CLEANUP_PRESERVE_ROOT: join(peer, "preserved") });
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(existsSync(join(peer, "preserved", ".incoming-idle")), false, "unmounted interrupted-copy control");
});

test("container mounts keep source transcripts while unmounted transcripts are archived", () => {
  const fx = fixture();
  const mounted = join(fx.home, "mounted-agent", ".claude"), peer = join(fx.home, "peer-agent", ".claude");
  const a = join(mounted, "projects", "session", "history.jsonl"), b = join(peer, "projects", "session", "history.jsonl");
  file(a, "{}\n"); file(b, "{}\n"); mount(fx, mounted);
  const r = run(fx, scope(fx));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(a, "utf8"), "{}\n");
  assert.equal(existsSync(join(fx.archive, relative(fx.home, a))), false);
  assert.equal(existsSync(b), false, "unmounted source was archived");
  assert.equal(readFileSync(join(fx.archive, relative(fx.home, b)), "utf8"), "{}\n");
});

test("container mounts keep archive destinations untouched and leave source transcripts in place", () => {
  const fx = fixture(); const source = join(fx.home, "agent", ".claude", "projects", "session", "history.jsonl");
  file(source, "{}\n"); mkdirSync(fx.archive); mount(fx, fx.archive);
  const r = run(fx, scope(fx));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(source, "utf8"), "{}\n");
  assert.equal(existsSync(join(fx.archive, relative(fx.home, source))), false);
});

test("an unavailable Docker snapshot keeps temp units, tsx files and nested coverage", () => {
  const fx = fixture(); const locks = join(fx.root, "locks"); mkdirSync(locks);
  for (const unit of ["rmd-idle", "tsx-1000", "rmd-c-123456789abc"]) { file(join(fx.scratch, unit, "payload")); age(join(fx.scratch, unit)); }
  const docker = join(fx.root, "docker-unavailable"); writeFileSync(docker, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const r = run(fx, { ...scope(fx), RMD_CLEANUP_DOCKER: docker, RMD_CLEANUP_TMP_GLOBS: "rmd-idle", RMD_CLEANUP_NESTED_COVERAGE_ROOTS: fx.scratch, RMD_CLEANUP_COVERAGE_LOCK_DIR: locks });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const unit of ["rmd-idle", "tsx-1000", "rmd-c-123456789abc"]) assert.equal(readFileSync(join(fx.scratch, unit, "payload"), "utf8"), "fixture\n");
  assert.match(r.stdout, /Docker mount snapshot failed \(fail closed\)/);
});
