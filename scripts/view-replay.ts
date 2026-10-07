/**
 * Offline view replay. Modules export createReplayArm(context), returning build() and optional close().
 * A build exposes body, sources, logged rows, projection and {plan, deps} for the no-reuse oracle.
 * Keep each factory's caches private; point candidate and baseline modules at their respective builds.
 *
 * node --import tsx scripts/view-replay.ts --copies /tmp/backup --directory /tmp/replays
 *   --store read-model/core.v1.sqlite --ledger state/ledger.ndjson --snapshot board.json
 *   --plan plan/tasks.yaml --now 1791374400000 --steps steps.json
 *   --base /tmp/main-arm.mjs --arm A/A=/tmp/main-arm.mjs --arm candidate=/tmp/candidate-arm.mjs
 *
 * Inputs are relative to --copies, a checkpointed offline backup, never a serving state directory.
 * steps.json is an array of {name, now, changes?: [{path, kind, data?}]}; paths are relative to that copy.
 * The initial build and every step compare all surfaces exactly, including elapsed time and log rows.
 * Exit 1 means drift or implicit clock reads; exit 2 means replay could not be completed.
 */
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Clock } from "../src/lib/clock.js";
import type { Plan } from "../src/lib/plan.js";
import { projectPlan, SERVE_KEEPS_CREDITS_IN_MEMORY, type DeriveDeps, type StatusProjection } from "../src/lib/status.js";

export interface ReplayStep {
  name: string;
  now: number;
  changes?: Array<{ path: string; kind: "write" | "append" | "remove" | "mkdir"; data?: string }>;
}
export interface ReplayContext {
  root: string;
  store: string;
  ledger: string;
  snapshot: string;
  plan: string;
  clock: Clock;
}
export interface ReplayBuild {
  body: unknown;
  sources: unknown;
  rows: unknown;
  projection: ReadonlyMap<string, StatusProjection>;
  oracle: { plan: Plan; deps: DeriveDeps };
}
export interface ReplayArm {
  build(): ReplayBuild | Promise<ReplayBuild>;
  close?(): void | Promise<void>;
}
export type ReplayFactory = (context: ReplayContext) => ReplayArm | Promise<ReplayArm>;
export interface ReplayArmSpec { name: string; module?: string; create?: ReplayFactory }
export interface ReplayOptions {
  copies: string;
  directory: string;
  store: string;
  ledger: string;
  snapshot: string;
  plan: string;
  now: number;
  base: ReplayArmSpec;
  arms: ReplayArmSpec[];
  steps: ReplayStep[];
}
type Surface = "body" | "sources" | "rows" | "projection";
export interface ReplayReport {
  ok: boolean;
  root: string;
  noArgDates: number;
  steps: Array<{ name: string; now: number; noArgDates: Record<string, number> }>;
  divergences: Array<{ step: string; arm: string; surface: Surface; expected: string; actual: string }>;
}

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v instanceof Date) return v.toISOString();
    if (v === null || typeof v !== "object") return v;
    const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
    if (entries.some(([key]) => typeof key !== "string")) throw new Error("canonical Maps need string keys");
    return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, val]) => [k, sort(val)]));
  };
  return JSON.stringify(sort(value));
}

function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path would escape the copy: ${path}`);
  return target;
}

function checkCopy(opts: ReplayOptions): string {
  const copies = realpathSync(opts.copies);
  const serving = [join(process.cwd(), "state"), join(homedir(), "Remudero/state"), join(homedir(), ".config/remudero")];
  const mapping = process.env.RMD_READ_MODEL_DB_DIR;
  if (mapping) serving.push(...mapping.split(":"));
  if (copies.split(sep).some((part) => part === "state" || part === ".config") || copies.endsWith(`${sep}read-model`) ||
      serving.some((path) => copies === resolve(path) || copies.startsWith(resolve(path) + sep))) {
    throw new Error(`refusing a serving path: ${copies}`);
  }
  const walk = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`copy contains a symlink: ${path}`);
    if (st.isDirectory()) for (const name of readdirSync(path)) { if (name !== ".git") walk(join(path, name)); }
    else if (!st.isFile() || st.nlink !== 1) throw new Error(`copy contains a special file or hardlink: ${path}`);
  };
  walk(copies);
  for (const key of ["store", "ledger", "snapshot", "plan"] as const) {
    if (!lstatSync(inside(copies, opts[key])).isFile()) throw new Error(`${key} must name a copied file`);
  }
  const store = inside(copies, opts.store);
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(store + suffix))) throw new Error("store has WAL/journal sidecars; supply a closed online-backup copy");
  return copies;
}

function change(root: string, mutation: NonNullable<ReplayStep["changes"]>[number]): void {
  const path = inside(root, mutation.path);
  // Recheck ancestors: an arm must not redirect a later mutation through a symlink.
  let part = path;
  while (part !== root) {
    if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`change targets a symlink: ${part}`);
    part = dirname(part);
  }
  if (mutation.kind === "remove") rmSync(path, { recursive: true, force: true });
  else if (mutation.kind === "mkdir") mkdirSync(path, { recursive: true });
  else if ((mutation.kind === "write" || mutation.kind === "append") && typeof mutation.data === "string") {
    mkdirSync(dirname(path), { recursive: true });
    if (mutation.kind === "write") writeFileSync(path, mutation.data);
    else appendFileSync(path, mutation.data);
  } else throw new Error(`invalid change at ${mutation.path}`);
}

let replaying = false;
export async function replay(opts: ReplayOptions): Promise<ReplayReport> {
  if (replaying) throw new Error("replays must run sequentially: Date is process-wide");
  const copies = checkCopy(opts);
  const requestedDirectory = resolve(opts.directory);
  let ancestor = requestedDirectory;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const directory = resolve(realpathSync(ancestor), relative(ancestor, requestedDirectory));
  if (directory === copies || directory.startsWith(copies + sep)) throw new Error("work directory must be outside the seed copy");
  const specs = [opts.base, ...opts.arms];
  if (specs.some((s) => !s.name) || new Set(specs.map((s) => s.name)).size !== specs.length) throw new Error("arm names must be unique and nonempty");
  const steps: ReplayStep[] = [{ name: "initial", now: opts.now }, ...opts.steps];
  for (const step of steps) {
    if (!step.name || !Number.isFinite(step.now) || Math.abs(step.now) > 8.64e15) throw new Error("each step needs a name and a valid simulated clock");
    for (const mutation of step.changes ?? []) inside(copies, mutation.path);
  }
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(realpathSync(directory), "view-replay-"));
  const report: ReplayReport = { ok: false, root, noArgDates: 0, steps: [], divergences: [] };
  const realDate = Date;
  let now = opts.now;
  let noArgDates = 0;
  const clock: Clock = { now: () => now, date: () => new realDate(now), iso: () => new realDate(now).toISOString() };
  const fakeDate = new Proxy(realDate, {
    get: (target, key, receiver) => key === "now" ? clock.now : Reflect.get(target, key, receiver),
    construct(target, args) {
      if (args.length === 0) { noArgDates++; return new target(now); }
      return Reflect.construct(target, args);
    },
    apply() { noArgDates++; return new realDate(now).toString(); },
  });
  const loaded: Array<{ spec: ReplayArmSpec; context: ReplayContext; arm: ReplayArm }> = [];
  replaying = true;
  globalThis.Date = fakeDate;
  try {
    for (const [i, spec] of specs.entries()) {
      const armRoot = join(root, String(i));
      cpSync(copies, armRoot, { recursive: true, filter: (path) => !path.split(sep).includes(".git") });
      const context: ReplayContext = {
        root: armRoot, store: inside(armRoot, opts.store), ledger: inside(armRoot, opts.ledger),
        snapshot: inside(armRoot, opts.snapshot), plan: inside(armRoot, opts.plan), clock,
      };
      const factory: ReplayFactory = spec.create ?? (await import(pathToFileURL(resolve(spec.module!)).href)).createReplayArm;
      if (typeof factory !== "function") throw new Error(`arm ${spec.name} must export createReplayArm`);
      const arm = await factory(context);
      if (typeof arm?.build !== "function") throw new Error(`arm ${spec.name} must return build()`);
      loaded.push({ spec, context, arm });
    }
    const setupDates = noArgDates;
    for (const step of steps) {
      now = step.now;
      const observed = { name: step.name, now, noArgDates: {} as Record<string, number> };
      const builds: Array<Record<Surface, string>> = [];
      let oracle: string | undefined;
      for (const { spec, context, arm } of loaded) {
        for (const mutation of step.changes ?? []) change(context.root, mutation);
        const before = noArgDates;
        const build = await arm.build();
        if (["body", "sources", "rows"].some((key) => !(key in build))) throw new Error(`arm ${spec.name} must expose body, sources and rows`);
        if (!(build.projection instanceof Map) || !build.oracle?.plan || !build.oracle.deps) throw new Error(`arm ${spec.name} must expose projection and oracle inputs`);
        builds.push({ body: canonicalJson(build.body), sources: canonicalJson(build.sources), rows: canonicalJson(build.rows), projection: canonicalJson(build.projection) });
        if (oracle === undefined) {
          // The tool owns the control: even a baseline exposing a reuse callback cannot feed it to the oracle.
          const { reuseProjection: _reuse, ...deps } = build.oracle.deps;
          oracle = canonicalJson(projectPlan(build.oracle.plan, { ...deps, now: clock.now, writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY }));
        }
        observed.noArgDates[spec.name] = noArgDates - before;
      }
      if (step === steps[0]) observed.noArgDates.setup = setupDates;
      for (const [i, build] of builds.entries()) {
        for (const surface of ["body", "sources", "rows", "projection"] as const) {
          const expected = surface === "projection" ? oracle! : builds[0]![surface];
          if (build[surface] !== expected) report.divergences.push({ step: step.name, arm: specs[i]!.name, surface, expected, actual: build[surface] });
        }
      }
      report.steps.push(observed);
    }
  } finally {
    try { for (const entry of loaded.reverse()) await entry.arm.close?.(); }
    finally { globalThis.Date = realDate; replaying = false; }
  }
  report.noArgDates = noArgDates;
  report.ok = report.divergences.length === 0 && noArgDates === 0;
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

export async function replayCli(args: string[], output: (line: string) => void = console.log): Promise<number> {
  try {
    const strings = ["copies", "directory", "store", "ledger", "snapshot", "plan", "now", "steps", "base"];
    const parsed = parseArgs({ args, options: { ...Object.fromEntries(strings.map((name) => [name, { type: "string" as const }])), arm: { type: "string", multiple: true } } });
    const values = parsed.values as Record<string, string | string[] | undefined>;
    for (const flag of strings) if (typeof values[flag] !== "string") throw new Error(`--${flag} is required`);
    const get = (name: string): string => values[name] as string;
    const arms = ((values.arm ?? []) as string[]).map((text) => {
      const at = text.indexOf("=");
      if (at < 1 || at === text.length - 1) throw new Error("--arm needs name=module");
      return { name: text.slice(0, at), module: text.slice(at + 1) };
    });
    const steps: ReplayStep[] = JSON.parse(readFileSync(get("steps"), "utf8"));
    if (!Array.isArray(steps)) throw new Error("steps must be an array");
    const report = await replay({ copies: get("copies"), directory: get("directory"), store: get("store"), ledger: get("ledger"),
      snapshot: get("snapshot"), plan: get("plan"), now: Number(get("now")), base: { name: "unmodified", module: get("base") }, arms, steps });
    output(JSON.stringify(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    output(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await replayCli(process.argv.slice(2));
}
