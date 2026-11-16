import assert from "node:assert/strict";
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { procFdProbe, reclaimOrphanedSlotMutation } from "#src/lib/test-slot-mutation.js";

const TICKS_PER_SECOND = 100;
const BOOT_SECONDS = 1_000_000;

/** A fixture process table: a private guard file, a boot time and the named processes. */
function fixture(): { root: string; guard: string; proc: string; birthMs: number; done(): void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-guard-probe-"));
  const proc = join(root, "proc");
  mkdirSync(proc);
  const guard = join(root, ".slot-1.json.mutation");
  closeSync(openSync(guard, "wx", 0o600));
  writeFileSync(join(proc, "stat"), `cpu 1 2 3\nbtime ${BOOT_SECONDS}\n`);
  return { root, guard, proc, birthMs: lstatSync(guard).birthtimeMs, done: () => {
    for (const name of ["4101", "4102"]) try { chmodSync(join(proc, name, "fd"), 0o700); } catch { /* absent */ }
    rmSync(root, { recursive: true, force: true });
  } };
}

/** A same-uid process whose fd directory refuses to be listed and whose start time is `startMs` on the wall clock. */
function deniedProcess(proc: string, name: string, startMs: number | undefined, comm?: string): void {
  mkdirSync(join(proc, name, "fd"), { recursive: true });
  if (comm !== undefined) writeFileSync(join(proc, name, "comm"), `${comm}\n`);
  if (startMs !== undefined) {
    const ticks = Math.round((startMs - BOOT_SECONDS * 1000) / 1000 * TICKS_PER_SECOND);
    writeFileSync(join(proc, name, "stat"), `${name} (a (odd) name) S 1 1 ${"0 ".repeat(16)}${ticks} 0\n`);
  }
  chmodSync(join(proc, name, "fd"), 0o000);
}

function drop(proc: string, name: string): void {
  chmodSync(join(proc, name, "fd"), 0o700);
  rmSync(join(proc, name), { recursive: true, force: true });
}

/** Root can list a mode-000 directory, so the denial cannot be staged there. */
const deniable = (t: TestContext, proc: string): boolean => {
  const probe = join(proc, "..", "listable");
  mkdirSync(probe);
  chmodSync(probe, 0o000);
  let listable = true;
  try { readdirSync(probe); } catch { listable = false; }
  chmodSync(probe, 0o700);
  if (listable) t.skip("the fd directory stays readable to this uid");
  return !listable;
};

test("W1-T11925 criterion 1: an unreadable process that started after the guard was born, or is not a node runtime, does not make the scan unknown", t => {
  const f = fixture();
  try {
    if (!deniable(t, f.proc)) return;
    deniedProcess(f.proc, "4101", f.birthMs + 60_000, "node");
    const evidence = procFdProbe(lstatSync(f.guard), f.proc);
    assert.equal(evidence.state, "closed", evidence.reason);
    assert.equal(evidence.probe, "proc-fd");
    drop(f.proc, "4101");
    deniedProcess(f.proc, "4102", f.birthMs - 86_400_000, "sshd");
    const named = procFdProbe(lstatSync(f.guard), f.proc);
    assert.equal(named.state, "closed", `a long-running sshd cannot be the writer: ${named.reason}`);
  } finally { f.done(); }
});

test("W1-T11925 criterion 2: an unreadable node process that started before the guard, or whose name and start time are unreadable, keeps the scan unknown", t => {
  const f = fixture();
  try {
    if (!deniable(t, f.proc)) return;
    deniedProcess(f.proc, "4101", f.birthMs - 60_000, "node");
    const earlier = procFdProbe(lstatSync(f.guard), f.proc);
    assert.equal(earlier.state, "unknown");
    assert.match(earlier.reason, /unreadable for same-uid 4101/);
    deniedProcess(f.proc, "4102", undefined, "node");
    drop(f.proc, "4101");
    const unreadableStart = procFdProbe(lstatSync(f.guard), f.proc);
    assert.equal(unreadableStart.state, "unknown");
    assert.match(unreadableStart.reason, /4102/);
    deniedProcess(f.proc, "4101", f.birthMs + 1_000, "node");
    drop(f.proc, "4102");
    assert.equal(procFdProbe(lstatSync(f.guard), f.proc).state, "unknown", "inside the margin the process may be the writer");
    drop(f.proc, "4101");
    deniedProcess(f.proc, "4101", undefined);
    assert.equal(procFdProbe(lstatSync(f.guard), f.proc).state, "unknown", "no readable name and no start decides nothing");
  } finally { f.done(); }
});

test("W1-T11925 criterion 3: a readable holder still reads open and an unreadable descriptor inside a readable node process still reads unknown", t => {
  const f = fixture();
  try {
    if (!deniable(t, f.proc)) return;
    mkdirSync(join(f.proc, "4242", "fd"), { recursive: true });
    writeFileSync(join(f.proc, "4242", "comm"), "node\n");
    symlinkSync(f.guard, join(f.proc, "4242", "fd", "3"));
    const open = procFdProbe(lstatSync(f.guard), f.proc);
    assert.equal(open.state, "open");
    assert.match(open.reason, /pid 4242/);
    unlinkSync(join(f.proc, "4242", "fd", "3"));
    const sealed = join(f.root, "sealed");
    mkdirSync(sealed);
    writeFileSync(join(sealed, "target"), "");
    symlinkSync(join(sealed, "target"), join(f.proc, "4242", "fd", "5"));
    chmodSync(sealed, 0o000);
    try {
      const evidence = procFdProbe(lstatSync(f.guard), f.proc);
      assert.equal(evidence.state, "unknown");
      assert.match(evidence.reason, /4242\/fd\/5/);
    } finally { chmodSync(sealed, 0o700); }
  } finally { f.done(); }
});

test("W1-T11925 criterion 4: a guard that moved during the probe is kept even when the probe says closed", () => {
  const f = fixture();
  try {
    const rows: Record<string, unknown>[] = [];
    const st = lstatSync(f.guard);
    const verdict = reclaimOrphanedSlotMutation(join(f.root, "slot-1.json"), {
      boundMs: () => 0,
      now: () => st.mtimeMs + 10,
      probe: guardPath => {
        utimesSync(guardPath, new Date(), new Date(Date.now() + 5_000));
        return { state: "closed", probe: "proc-fd", reason: "fixture" };
      },
      log: row => { rows.push(row); },
    });
    assert.equal(verdict, "kept");
    assert.equal(rows.some(row => row.reason === "guard identity changed during the probe"), true);
    assert.equal(lstatSync(f.guard).isFile(), true);
  } finally { f.done(); }
});
