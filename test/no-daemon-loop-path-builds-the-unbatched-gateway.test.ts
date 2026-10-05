/**
 * W1-T5650 — NO DAEMON-LOOP PATH BUILDS THE UNBATCHED GITHUB GATEWAY.
 *
 * `ghGateway` (src/lib/status.ts) answers every per-task query with its own synchronous `gh` spawn:
 * `findMergedByTrailer` is one search per task id. On the daemon's event loop that is a stall
 * proportional to the plan (the retro trigger's 44m52s on 2026-10-04). Each such site used to be found
 * one at a time, after it was measured on the live daemon. This census refuses the next one by name.
 *
 * THE POPULATION is every top-level function whose code (comments and string contents stripped) calls
 * `ghGateway(`, plus any function returning one of those. LOOP REACH is a name-based fixed point seeded
 * from `daemonCommand`'s DaemonDeps literal (its locals resolved to their own declarations) and the hook
 * builders it calls: a function is reachable when its identifier appears, unshadowed, in a reachable
 * function's code. A reachable member is refused unless {@link BOUNDED_PER_PASS} names why its calls are
 * bounded per pass; an entry the census no longer reaches is itself a failure, so the table only shrinks.
 *
 * @source-text-subject — the census's subject IS the source text of src/, read to find its call graph.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { ReadinessContext } from "../src/lib/inbox.js";
import { buildBatchedGithub, type BatchedPr } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildInboxDraftHook } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const ROOT = new URL("..", import.meta.url).pathname;

/** Loop-reachable gateway builders whose `gh` calls are bounded per pass — SHRINK-ONLY. */
const BOUNDED_PER_PASS: Record<string, string> = {
  retroShippedGithubGateway:
    "retroTriggerCheck's shippedSince searches one trailer per run AFTER the retro marker — the post-marker " +
    "candidates, not the plan — and only when the cadence check runs; W1-T3104 retires the entry",
  inboxCommand:
    "reached only through buildIntakeRungsDaemonHooks' `inbox` intake rung, which plan/policy.yaml's " +
    "intakeCadence.inbox ships disabled and caps at maxPerDay fires, one derivation per dependency its " +
    "drafted fragments name",
};
/** The table's size today. Raising it is the regression this file exists to refuse. */
const BOUNDED_PER_PASS_CEILING = 2;

// ── the census ────────────────────────────────────────────────────────────────────────────────────

/** Comments removed, string/template/regex contents blanked, template `${}` expressions kept as code. */
export function codeOnly(src: string): string {
  const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  // Each frame is a template literal ("t") or a `${...}` expression inside one (its brace depth).
  const frames: Array<"t" | number> = [];
  let out = "";
  let i = 0;
  let lastSig = "";
  let lastWord = "";
  while (i < src.length) {
    const top = frames[frames.length - 1];
    const c = src[i];
    if (top === "t") {
      if (c === "\\") { out += blank(src.slice(i, i + 2)); i += 2; }
      else if (c === "`") { out += c; i++; frames.pop(); lastSig = c; lastWord = ""; }
      else if (c === "$" && src[i + 1] === "{") { out += "${"; i += 2; frames.push(0); lastSig = "{"; lastWord = ""; }
      else { out += blank(c); i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || (c === "/" && (REGEX_AFTER.has(lastSig) || REGEX_KEYWORDS.has(lastWord)))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (c === "/" && src[j] === "[") inClass = true;
        else if (c === "/" && src[j] === "]") inClass = false;
        else if (src[j] === c && !inClass) break;
        j++;
      }
      out += c + blank(src.slice(i + 1, j)) + c;
      i = j + 1;
      lastSig = c;
      lastWord = "";
      continue;
    }
    if (c === "`") { out += c; i++; frames.push("t"); continue; }
    if (typeof top === "number" && c === "{") frames[frames.length - 1] = top + 1;
    if (typeof top === "number" && c === "}") {
      if (top === 0) { out += c; i++; frames.pop(); continue; }
      frames[frames.length - 1] = top - 1;
    }
    const word = /^[\w$]+/.exec(src.slice(i, i + 200))?.[0];
    if (word) {
      out += word;
      i += word.length;
      lastSig = "a";
      lastWord = word;
      continue;
    }
    if (!/\s/.test(c)) { lastSig = c; lastWord = ""; }
    out += c;
    i++;
  }
  return out;
}

interface Unit { name: string; text: string }

const DECL_RE =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|(?:type|interface|enum|import|namespace)\b)/;

/** Every named top-level declaration of one file, each running to the next column-0 declaration. */
export function topLevelUnits(source: string): Unit[] {
  const units: Unit[] = [];
  let current: { name?: string; lines: string[] } | undefined;
  const close = (): void => {
    if (current?.name) units.push({ name: current.name, text: current.lines.join("\n") });
  };
  for (const line of codeOnly(source).split("\n")) {
    const m = DECL_RE.exec(line);
    if (m) {
      close();
      current = { name: m[1] ?? m[2] ?? m[3], lines: [line] };
    } else current?.lines.push(line);
  }
  close();
  return units;
}

/** Identifiers that can name a top-level binding: never a property read (`x.name`) nor an object key. */
const identifiers = (text: string): Set<string> => new Set(text.match(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$]|:)/g) ?? []);

/** Names a unit binds for itself — a local, a parameter, a destructured name — shadowing a top-level one. */
function localBindings(text: string): Set<string> {
  const bound = new Set<string>();
  const add = (re: RegExp): void => {
    for (const m of text.matchAll(re)) for (const id of m[1].match(/[A-Za-z_$][\w$]*/g) ?? []) bound.add(id);
  };
  add(/\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])/g);
  add(/[(,]\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*\??\s*(?::|=(?![=>]))/g);
  add(/[(,]\s*(\{[^}]*\})\s*[:=)]/g);
  add(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g);
  return bound;
}

/** The balanced bracket group opening at `open`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if ("({[".includes(text[k])) depth++;
    else if (")}]".includes(text[k]) && --depth === 0) return text.slice(open, k + 1);
  }
  return text.slice(open);
}

/** One local `const|let NAME = ...;` statement of a function body, or undefined. */
function localDeclaration(body: string, name: string): string | undefined {
  const m = new RegExp(String.raw`\b(?:const|let)\s+${name.replace(/\$/g, "\\$")}\b[^=;]*=`).exec(body);
  if (!m) return undefined;
  let depth = 0;
  for (let k = m.index + m[0].length; k < body.length; k++) {
    if ("({[".includes(body[k])) depth++;
    else if (")}]".includes(body[k])) depth--;
    else if (body[k] === ";" && depth === 0) return body.slice(m.index, k);
  }
  return body.slice(m.index);
}

/** Every function building `ghGateway`, plus every function returning one of those. */
export function gatewayBuilders(units: Unit[]): Set<string> {
  const population = new Set(units.filter((u) => u.name !== "ghGateway" && /\bghGateway\s*\(/.test(u.text)).map((u) => u.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of units) {
      if (population.has(u.name) || ![...population].some((p) => new RegExp(String.raw`\breturn\s+${p}\s*\(`).test(u.text))) continue;
      population.add(u.name);
      grew = true;
    }
  }
  return population;
}

/** `daemonCommand`'s `runDaemonFn(...)` literal, its locals resolved, plus the hook builders it calls. */
export function loopSeeds(units: Unit[]): Set<string> {
  const host = units.find((u) => u.name === "daemonCommand");
  assert.ok(host, "census: no daemonCommand to seed the loop from");
  const at = host.text.search(/\brunDaemonFn\s*\(/);
  assert.ok(at >= 0, "census: daemonCommand no longer calls runDaemonFn — re-seed the census");
  const seeds = identifiers(balanced(host.text, host.text.indexOf("(", at)));
  for (const pending = [...seeds]; pending.length > 0; ) {
    const local = localDeclaration(host.text, pending.pop()!);
    for (const id of local ? identifiers(local) : []) if (!seeds.has(id)) { seeds.add(id); pending.push(id); }
  }
  for (const id of identifiers(host.text)) if (/^build\w*DaemonHooks$|^buildSweepHook$/.test(id)) seeds.add(id);
  return seeds;
}

/** The name-based fixed point: reachable when a reachable function's code names it, unshadowed. */
export function loopReachable(units: Unit[], seeds: Set<string>): Set<string> {
  const byName = new Map<string, Unit[]>();
  for (const u of units) byName.set(u.name, [...(byName.get(u.name) ?? []), u]);
  const reached = new Set<string>();
  for (const pending = [...seeds].filter((s) => byName.has(s)); pending.length > 0; ) {
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    for (const u of byName.get(name)!) {
      const shadowed = localBindings(u.text);
      shadowed.delete(u.name);
      for (const id of identifiers(u.text)) if (byName.has(id) && !shadowed.has(id) && !reached.has(id)) pending.push(id);
    }
  }
  return reached;
}

/** The census over a set of sources: every loop-reachable gateway builder the table does not bound. */
export function census(sources: string[], bounded: Record<string, string>): { offenders: string[]; staleEntries: string[]; reached: Set<string>; population: Set<string> } {
  const units = sources.flatMap(topLevelUnits);
  const population = gatewayBuilders(units);
  const reached = loopReachable(units, loopSeeds(units));
  const reachedBuilders = [...population].filter((p) => reached.has(p));
  return {
    offenders: reachedBuilders.filter((p) => !(p in bounded)).sort(),
    staleEntries: Object.keys(bounded).filter((e) => !reachedBuilders.includes(e)).sort(),
    reached,
    population,
  };
}

function srcSources(): string[] {
  return (readdirSync(join(ROOT, "src"), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => readFileSync(join(ROOT, "src", f), "utf8"));
}

// ── the census, on fixtures: it must discriminate ────────────────────────────────────────────────

const fixtureDaemon = `
export async function daemonCommand(rest: string[]) {
  const sweepOrphans = () => reapOrphans();
  // a comment naming correctCommand() is not a reference
  const summary = await runDaemonFn({ sweep: buildSweepHook("o", "r"), sweepOrphans, label: "inboxCommand" });
  return summary;
}
export function buildSweepHook(owner: string, repo: string) {
  return async () => draftRung(owner, repo);
}
function reapOrphans(main = new Map<string, string>()): void { main.clear(); }
function main() { return correctCommand(); }
function correctCommand() { const gh = ghGateway("o", "r"); return gh; }
`;

test("the census names a loop-reachable function that builds ghGateway, and passes once it is removed", () => {
  const building = `${fixtureDaemon}
function draftRung(owner: string, repo: string) { const github = ghGateway(owner, repo); return github.findMergedByTrailer("T"); }`;
  const removed = `${fixtureDaemon}
function draftRung(owner: string, repo: string, github = buildBatchedGithub(owner, repo)) { return github.findMergedByTrailer("T"); }`;
  assert.deepEqual(census([building], {}).offenders, ["draftRung"], "the loop-reachable builder is refused by name");
  const after = census([removed], {});
  assert.deepEqual(after.offenders, [], "with the construction gone the census passes");
  assert.ok(after.population.has("correctCommand"), "a CLI-only builder is still in the population");
  assert.equal(after.reached.has("correctCommand"), false, "a comment, a string, and a shadowing parameter named `main` reach nothing");
});

test("the census follows a function that RETURNS a builder, and an unreached table entry is stale", () => {
  const source = `${fixtureDaemon}
function sharedGateway() { return ghGateway("o", "r"); }
function viaWrapper() { return sharedGateway(); }
function draftRung(owner: string, repo: string) { return wrapped(); }
function wrapped() { const g = viaWrapper; return g; }`;
  const result = census([source], { sharedGateway: "bounded", correctCommand: "bounded" });
  assert.deepEqual(result.offenders, ["viaWrapper"], "a function returning a builder is a builder");
  assert.deepEqual(result.staleEntries, ["correctCommand"], "an entry for a site the loop no longer reaches is reported");
});

// ── the census, on this tree ──────────────────────────────────────────────────────────────────────

const real = census(srcSources(), BOUNDED_PER_PASS);

test("no daemon-loop path builds the unbatched gateway outside the bounded-per-pass table", () => {
  // POSITIVE CONTROL: the census can see the daemon loop and the gateway builders at all.
  for (const name of ["buildSweepHook", "buildInboxDraftHook", "retroTriggerCheck"]) assert.ok(real.reached.has(name), `the census reaches ${name}`);
  assert.ok(real.population.has("correctCommand"), "the census sees the CLI-only builders");
  assert.deepEqual(real.offenders, [], `loop-reachable functions build ghGateway — take the batched gateway instead: ${real.offenders.join(", ")}`);
});

test("every bounded-per-pass entry is still a loop-reachable builder, and the table never grows", () => {
  assert.deepEqual(real.staleEntries, [], "a table entry the census no longer reaches must be deleted");
  assert.ok(Object.keys(BOUNDED_PER_PASS).length <= BOUNDED_PER_PASS_CEILING, "the bounded-per-pass table is shrink-only");
  for (const [name, reason] of Object.entries(BOUNDED_PER_PASS)) assert.ok(reason.length >= 80, `${name} names why its calls are bounded per pass`);
});

// ── the draft rung's readiness, measured ──────────────────────────────────────────────────────────

test("the inbox-draft readiness answers isMerged for 50 plan tasks with zero unbatched trailer searches", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5650-`));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "P-W1T5650", summary: "s", evidenceAnchors: [] }] }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  // The unbatched gateway's spawn would land here: a PATH-first `gh` that records every call.
  const shim = ghShim([{ when: "search/issues", stdout: '{"items":[]}' }], { kind: "w1t5650-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  let fetches = 0;
  let merged: string[] = [];
  const github = buildBatchedGithub("o", "r", {
    fetchAll: (): BatchedPr[] => {
      fetches++;
      return merged.map((id, n) => ({ number: n + 1, url: `https://github.com/o/r/pull/${n + 1}`, state: "MERGED", headRefName: `run-${id}-1`, body: `Remudero-Task: ${id}` }));
    },
    commitTrailerIndex: () => new Map(),
  });
  const answers: boolean[] = [];
  let tasks: string[] = [];
  try {
    const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-W1T5650", () => {},
      async (due) => due.map((p) => ({ proposalId: p.id, ok: false as const, error: "ordinary failure" })),
      () => true, () => "a".repeat(40), github,
      (readiness: ReadinessContext) => {
        const fifty = readiness.plan.tasks.slice(0, 50);
        tasks = fifty.map((t) => t.id);
        merged = tasks.filter((_, n) => n % 2 === 0);
        for (const t of fifty) answers.push(readiness.isMerged(t));
      });
    await hook();
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(tasks.length, 50, "the readiness was handed the plan and asked about 50 tasks");
  const searches = shim.calls().filter((c) => c.includes("search/issues") && c.includes("Remudero-Task"));
  assert.equal(searches.length, 0, `the readiness ran ${searches.length} unbatched trailer searches`);
  assert.equal(fetches, 1, "fifty answers cost one batched fetch");
  assert.deepEqual(answers, tasks.map((_, n) => n % 2 === 0), "isMerged answers each task from the one batched fetch");
});
