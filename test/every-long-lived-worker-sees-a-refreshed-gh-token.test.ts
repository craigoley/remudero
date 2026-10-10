import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SHARE_ENV, Worker } from "node:worker_threads";

// @source-text-subject: this census IS about source text — it locates every `new Worker(` in src/ and reads
// its options, because a thread spawned without `env: SHARE_ENV` copies process.env once and never sees the
// hourly GH_TOKEN refresh serve and the daemon perform (#9156 read plane, #9160 read-model threads). The
// behavioural arm below proves the claim the census protects: a SHARE_ENV thread reads a token its parent
// changed after spawn.
//
// W1-T5736. TypeScript 7 ships no JS API and @swc/core's native addon is not loadable everywhere this runs,
// so the "walk" is a small lexer that blanks comments, strings, template text and regex literals, then
// parses each `new Worker(...)` argument list by balanced brackets — comments and strings never count.

const root = fileURLToPath(new URL("..", import.meta.url));

/** Blank comments, string/template text and regex bodies (length and newlines preserved). */
function mask(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const isId = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/.test(ch);
  const code = (inTemplateExpr: boolean): void => {
    let depth = 0;
    let prev = ""; // last significant token class: "" start, "a" operand, ")" close, else the punctuator
    let prevWord = "";
    while (i < src.length) {
      const c = src[i]!;
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        const s = i;
        while (i < src.length && src[i] !== "\n") i++;
        blank(s, i);
        continue;
      }
      if (c === "/" && n === "*") {
        const s = i;
        const e = src.indexOf("*/", i + 2);
        i = e < 0 ? src.length : e + 2;
        blank(s, i);
        continue;
      }
      if (c === '"' || c === "'") {
        const s = i++;
        while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        i++;
        blank(s + 1, i - 1);
        prev = "a";
        prevWord = "";
        continue;
      }
      if (c === "`") {
        i++;
        let textStart = i;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") i += 2;
          else if (src[i] === "$" && src[i + 1] === "{") {
            blank(textStart, i);
            i += 2;
            code(true);
            textStart = i;
          } else i++;
        }
        blank(textStart, i);
        i++;
        prev = "a";
        prevWord = "";
        continue;
      }
      if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || prevWord === "return" || prevWord === "typeof")) {
        const s = i++;
        let inClass = false;
        while (i < src.length && src[i] !== "\n" && (inClass || src[i] !== "/")) {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          i++;
        }
        i++;
        blank(s + 1, i - 1);
        prev = "a";
        prevWord = "";
        continue;
      }
      if (isId(c)) {
        const s = i;
        while (i < src.length && isId(src[i])) i++;
        prev = "a";
        prevWord = src.slice(s, i);
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (depth === 0 && inTemplateExpr) {
          i++;
          return;
        }
        depth--;
      }
      if (!/\s/.test(c)) {
        prev = c === ")" || c === "]" ? ")" : c;
        prevWord = "";
      }
      i++;
    }
  };
  code(false);
  return out.join("");
}

/** Ranges of the top-level comma-separated parts of masked[start, end). */
function splitTop(masked: string, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let k = start; k < end; k++) {
    const c = masked[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push([from, k]);
      from = k + 1;
    }
  }
  if (masked.slice(from, end).trim() !== "") parts.push([from, end]);
  return parts;
}

/** The offset one past the bracket matching the opener at `open`. */
function closeOf(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const c = masked[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return masked.length;
}

type Env = "share" | "explicit" | "absent" | "opaque";
type Site = { file: string; line: number; kind: string; env: Env };

const SHARE = /^(?:\w+\.)?SHARE_ENV$/;

function workerSites(file: string, src: string): Site[] {
  const masked = mask(src);
  const sites: Site[] = [];
  for (const m of masked.matchAll(/\bnew\s+Worker\s*(?:<[^>(]*>)?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = splitTop(masked, open + 1, closeOf(masked, open) - 1);
    const line = masked.slice(0, m.index).split("\n").length;
    const optionsRange = args[1];
    if (!optionsRange) {
      sites.push({ file, line, kind: "no-workerData", env: "absent" });
      continue;
    }
    const optionsText = masked.slice(optionsRange[0], optionsRange[1]).trim();
    if (!optionsText.startsWith("{")) {
      // An options value passed through from elsewhere cannot be proven to carry SHARE_ENV.
      sites.push({ file, line, kind: "opaque-options", env: "opaque" });
      continue;
    }
    const optionsOpen = masked.indexOf("{", optionsRange[0]);
    let env: Env = "absent";
    let kind = "no-workerData";
    for (const [a, b] of splitTop(masked, optionsOpen + 1, closeOf(masked, optionsOpen) - 1)) {
      const prop = /^\s*(\w+)\s*(?::([\s\S]*))?$/.exec(src.slice(a, b));
      if (!prop) continue; // a spread: cannot supply a provable env
      const [, key, value = ""] = prop;
      if (key === "env") env = SHARE.test(value.trim()) ? "share" : "explicit";
      if (key === "workerData") {
        const v = value.trim() || "workerData";
        kind = /^\{/.test(v) ? (/\bkind\s*:\s*([\w.]+|"[^"]*")/.exec(v)?.[1] ?? "object-without-kind") : v;
      }
    }
    sites.push({ file, line, kind, env });
  }
  return sites;
}

type Exemption = { file: string; kind: string; why: "one-shot" | "no-github" | "proxied-to-parent" | "explicit-env"; reason: string };

/** Every Worker spawn in src/ that is not `env: SHARE_ENV`, with why it does not need to be. */
const EXEMPTIONS: Exemption[] = [
  { file: "src/lib/secret-boundary.ts", kind: "SOCKET_THREAD_KIND", why: "explicit-env", reason: "passes env: { ...process.env } and mints from the App key, not GH_TOKEN" },
  { file: "src/lib/repo-dashboard-route.ts", kind: "REPO_TELEMETRY_WORKER_KIND", why: "no-github", reason: "reads the ledger only; no GitHub call" },
  { file: "src/lib/status.ts", kind: "req", why: "one-shot", reason: "board prewarm walk: a fresh thread per walk copies the current env at each spawn" },
  { file: "src/lib/read-model-slow-lane.ts", kind: "data", why: "no-github", reason: "its header forbids a GitHub call (SlowLaneGithubRefused)" },
  { file: "src/lib/console-projection-worker.ts", kind: "CONSOLE_PROJECTION_WORKER_KIND", why: "no-github", reason: "pure feedback projection; no GitHub call" },
  { file: "src/lib/board-worker.ts", kind: "data", why: "proxied-to-parent", reason: "facts are proxied to the parent's github; the thread holds no token" },
  { file: "src/lib/worker-provider.ts", kind: "opaque-options", why: "one-shot", reason: "codex probe factory: short-lived per probe, options forwarded by the caller" },
  { file: "src/lib/read-model-worker.ts", kind: "READ_MODEL_INTEGRITY_KIND", why: "one-shot", reason: "integrity check thread copies a fresh env per spawn" },
  { file: "src/lib/read-model-worker.ts", kind: "READ_MODEL_ISSUE_KIND", why: "one-shot", reason: "issue thread copies a fresh env per spawn" },
  { file: "src/lib/ledger-union.ts", kind: "ROTATION_DIGEST_CODEC", why: "no-github", reason: "rotation digest codec; hashing only, no GitHub call" },
  { file: "src/lib/config-gardener.ts", kind: "CONFIG_MEASUREMENT_WORKER_KIND", why: "one-shot", reason: "local measurement per spawn; no GitHub call" },
  { file: "src/lib/serve-plan-reload.ts", kind: "PLAN_RELOAD_WORKER_KIND", why: "one-shot", reason: "local plan read per spawn; no GitHub call" },
];

/** Failures by file and kind: a spawn that is neither SHARE_ENV nor exempt, and an exemption naming no live site. */
function censusFailures(sites: Site[], exemptions: Exemption[]): string[] {
  const failures: string[] = [];
  const key = (file: string, kind: string): string => `${file} :: ${kind}`;
  const rows = new Set<string>();
  for (const row of exemptions) {
    if (rows.has(key(row.file, row.kind))) failures.push(`duplicate exemption row ${key(row.file, row.kind)}`);
    rows.add(key(row.file, row.kind));
    if (row.reason.trim() === "") failures.push(`exemption row ${key(row.file, row.kind)} has no reason`);
  }
  const needing = sites.filter((s) => s.env !== "share");
  for (const s of needing) {
    if (!rows.has(key(s.file, s.kind))) {
      failures.push(`${s.file}:${s.line} new Worker kind ${s.kind} has neither env: SHARE_ENV (env is ${s.env}) nor an exemption row`);
    }
  }
  const live = new Set(needing.map((s) => key(s.file, s.kind)));
  for (const row of exemptions) {
    if (!live.has(key(row.file, row.kind))) failures.push(`stale exemption row ${key(row.file, row.kind)}: no live Worker spawn needs it`);
  }
  return failures;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? tsFiles(path) : e.name.endsWith(".ts") ? [path] : [];
  });
}

const rel = (path: string): string => relative(root, path).replaceAll("\\", "/");
const recorded = (): Site[] => tsFiles(join(root, "src")).flatMap((p) => workerSites(rel(p), readFileSync(p, "utf8")));

test("the lexer counts only real Worker spawns, never comments, strings or templates", () => {
  const text = [
    "// new Worker(a, {})",
    "/* new Worker(b) */",
    'const s = "new Worker(c)";',
    "const t = `new Worker(d) ${1}`;",
    "const r = /new Worker(e)/;",
    "const w = new Worker(u, { workerData: { kind: K }, env: SHARE_ENV });",
    "const x = new Worker(u, { workerData: data, env: { ...process.env } });",
    "const y = new Worker(u, opts);",
    "const z = new Worker(u, { workerData: { kind: Z }, ...more });",
  ].join("\n");
  assert.deepEqual(workerSites("src/x.ts", text), [
    { file: "src/x.ts", line: 6, kind: "K", env: "share" },
    { file: "src/x.ts", line: 7, kind: "data", env: "explicit" },
    { file: "src/x.ts", line: 8, kind: "opaque-options", env: "opaque" },
    { file: "src/x.ts", line: 9, kind: "Z", env: "absent" },
  ]);
});

test("the census fails by file and kind on a Worker spawn with neither env SHARE_ENV nor an exemption row", () => {
  const planted = workerSites("src/lib/new-thing.ts", "const w = new Worker(url, { workerData: { kind: NEW_THING_KIND } });");
  const failures = censusFailures([...recorded(), ...planted], EXEMPTIONS);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /src\/lib\/new-thing\.ts:1 new Worker kind NEW_THING_KIND has neither env: SHARE_ENV/);
});

test("the census fails on a stale exemption row", () => {
  const stale: Exemption = { file: "src/lib/gone.ts", kind: "GONE_KIND", why: "one-shot", reason: "no longer spawns" };
  assert.deepEqual(censusFailures(recorded(), [...EXEMPTIONS, stale]), ["stale exemption row src/lib/gone.ts :: GONE_KIND: no live Worker spawn needs it"]);
  // A row for a spawn that already carries SHARE_ENV is just as stale.
  const shared = recorded().find((s) => s.env === "share")!;
  const redundant: Exemption = { file: shared.file, kind: shared.kind, why: "one-shot", reason: "pointless" };
  assert.equal(censusFailures(recorded(), [...EXEMPTIONS, redundant]).length, 1);
});

test("the census passes on the recorded tree", () => {
  const sites = recorded();
  assert.deepEqual(censusFailures(sites, EXEMPTIONS), []);
  // Not vacuous: the two fixed sites are seen as SHARE_ENV.
  for (const file of ["src/lib/read-plane.ts", "src/lib/read-model-worker.ts"]) {
    assert.ok(sites.some((s) => s.file === file && s.env === "share"), `${file} must be seen spawning with env: SHARE_ENV`);
  }
});

test("removing env SHARE_ENV from read-plane.ts makes the census name read-plane.ts", () => {
  const path = join(root, "src/lib/read-plane.ts");
  const stripped = readFileSync(path, "utf8").replaceAll(", env: SHARE_ENV", "");
  const sites = [...recorded().filter((s) => s.file !== "src/lib/read-plane.ts"), ...workerSites("src/lib/read-plane.ts", stripped)];
  const failures = censusFailures(sites, EXEMPTIONS);
  assert.ok(failures.length >= 1 && failures.every((f) => f.startsWith("src/lib/read-plane.ts:")), failures.join("\n"));
});

test("a SHARE_ENV fixture thread reads a GH_TOKEN its parent changed after spawn", async () => {
  const body = "const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => parentPort.postMessage(process.env.GH_TOKEN ?? null));";
  const ask = (worker: Worker): Promise<string | null> => new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage("token?");
  });
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "token-at-spawn";
  const shared = new Worker(body, { eval: true, env: SHARE_ENV });
  const copied = new Worker(body, { eval: true });
  try {
    process.env.GH_TOKEN = "token-refreshed-hourly";
    assert.equal(await ask(shared), "token-refreshed-hourly");
    // Control: without env the thread keeps the spawn-time copy, which is the 401 the census prevents.
    assert.equal(await ask(copied), "token-at-spawn");
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = before;
    await Promise.all([shared.terminate(), copied.terminate()]);
  }
});
