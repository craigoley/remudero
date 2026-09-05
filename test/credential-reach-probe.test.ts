import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  containmentProbeScript,
  credentialReachDrift,
  credentialReachTargets,
  denyRuleCovers,
  hostClassOf,
  parseCredentialReach,
  resolveCredentialReach,
  type CredentialReachResult,
  type CredentialReachTarget,
} from "../src/lib/containment.js";
import { buildWorkerEnv } from "../src/lib/env.js";
import { validateWorkerSettingsFile } from "../src/lib/settings.js";
import { WORKER_HOME_SYMLINKS } from "../src/lib/worker-home.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "credential-reach-baseline.json");
const SETTINGS_PATH = join(REPO_ROOT, "settings", "worker.json");

/**
 * test/credential-reach-probe.test.ts — W1-T2698.
 *
 * NOTHING HAD ASKED WHAT A WORKER CAN READ. Four seams describe the boundary — `buildWorkerEnv`
 * strips ANTHROPIC_* (W1-T1); W1-T2311 moved the daemon off the operator's PAT; W1-T2552 found the
 * git credential helper gated on a boot token that no longer exists; W1-T2211 found the console's
 * write token reachable under the state root — and none of them answers the operator's question.
 * This suite runs the probe, records the reach as a baseline, and refuses a widening BY NAME.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT, stated rather than implied. The live sandbox is applied by
 * the CLI (the SDK `sandbox` option `spawnWorker` passes from settings/worker.json), so it is not
 * exercisable in-process; `probeContainment` is the arm that spawns a real worker for that. What IS
 * exercisable on every host class is the pair of controls that DECIDE the reach — the env allowlist,
 * measured by RUNNING `buildWorkerEnv` rather than by reading a constant, and the settings file's own
 * deny rules, read from the file `validateWorkerSettingsFile` validates at every spawn. A target no
 * deny rule covers is never reported `refused`, so this suite cannot launder an unenforced path into
 * a clean result.
 *
 * THE ENV HALF IS MEASURED, NOT DECLARED. `ALLOWLIST` is private to env.ts. Reading it would need an
 * export this task has no business adding, and a copy of it here would be the source-text shape
 * W1-T2905 exists to refuse. Driving the real function with a fully-populated parent env answers the
 * same question strictly better: it reports what the code DOES, so a key added to the allowlist shows
 * up here whether or not anyone remembered this file.
 */

interface Baseline {
  readonly _comment: string;
  readonly classes: Record<string, { readonly reachable: string[] }>;
}

/** Candidate secrets to offer `buildWorkerEnv`'s parent env. Every one is either a credential the
 *  fleet really carries or a plausible neighbour a future allowlist edit might sweep in. */
const ENV_CANDIDATES: ReadonlyArray<{ key: string; why: string }> = [
  { key: "CLAUDE_CODE_OAUTH_TOKEN", why: "the subscription OAuth token the SDK subprocess authenticates with" },
  { key: "GH_TOKEN", why: "the GitHub token a worker pushes and opens its own PR with" },
  { key: "ANTHROPIC_API_KEY", why: "the §9 overflow valve — reachable only while opts.allowApiKey is engaged" },
  { key: "ANTHROPIC_AUTH_TOKEN", why: "a non-sanctioned ANTHROPIC_* key: the billing boundary must strip it" },
  { key: "GITHUB_TOKEN", why: "deliberately NOT allowlisted (env.ts: gh prefers GH_TOKEN)" },
  { key: "AWS_SECRET_ACCESS_KEY", why: "a cloud credential no worker has any use for" },
  { key: "OPENAI_API_KEY", why: "a third-party model credential no worker has any use for" },
  { key: "NPM_TOKEN", why: "a registry publish credential no worker has any use for" },
];

const REAL_HOME = process.env.HOME ?? homedir();
const CONFIG_ROOT = join(REAL_HOME, "Remudero");
const WORKER_HOME = join(CONFIG_ROOT, "worker-home");
const ANCHORS = { workerHome: WORKER_HOME, configRoot: CONFIG_ROOT, realHome: REAL_HOME };

/** The probe's targets come from the containment module itself (credentialReachTargets), so this
 *  suite cannot measure a boundary the module does not also render. */
function fileTargets(): CredentialReachTarget[] {
  return credentialReachTargets(ANCHORS);
}

function denyRules(settings: Record<string, unknown>): string[] {
  const perms = (settings.permissions as { deny?: unknown } | undefined)?.deny;
  const sandbox = ((settings.sandbox as { filesystem?: { denyRead?: unknown } } | undefined)?.filesystem)?.denyRead;
  const out: string[] = [];
  for (const src of [perms, sandbox]) if (Array.isArray(src)) for (const r of src) if (typeof r === "string") out.push(r);
  return out;
}

function runProbe(targets: readonly CredentialReachTarget[]): CredentialReachResult[] {
  const script = containmentProbeScript(targets);
  // The SAME env builder spawnWorker uses. `parent` is fully populated so the allowlist is
  // exercised rather than trusted; nothing here is a real credential.
  const env = buildWorkerEnv({}, { ...process.env, ...Object.fromEntries(ENV_CANDIDATES.map((c) => [c.key, `fake-${c.key}`])) });
  const stdout = execFileSync("sh", ["-c", script], { env, encoding: "utf8", timeout: 60_000 });
  return parseCredentialReach(stdout);
}

test("W1-T2698: every deny rule has a probe target under it, and no grant contradicts a deny rule", () => {
  // The grant half is deliberately not asserted. credentialReachTargets derives its grant targets
  // from WORKER_HOME_SYMLINKS, so "every grant has a target" holds by construction and an assertion
  // of it can never fail — it was written, measured not to redden, and removed. Derivation is the
  // stronger guarantee. What follows are the two properties it does not give: that each deny rule
  // covers something this probe measures, and that the two tables do not contradict each other.
  const rules = denyRules(validateWorkerSettingsFile(SETTINGS_PATH));
  assert.ok(rules.length > 0, "positive control: settings/worker.json must carry deny rules for this suite to mean anything");
  for (const rule of rules) {
    const covered = fileTargets().some((t) => denyRuleCovers(rule, t.subject, ANCHORS));
    assert.ok(covered, `settings/worker.json denies ${rule} and no probe target sits under it — the rule is unmeasured`);
  }
  // A grant hands a path INTO the worker home; a deny rule keeps one OUT. A path in both is a
  // contradiction between the two tables, and the settings file wins at runtime — so the grant
  // would silently deliver nothing. This is the W1-T2213 shape, pointed at the other table.
  for (const t of fileTargets()) {
    if (!t.id.startsWith("grant:")) continue;
    assert.ok(
      t.subject.startsWith(WORKER_HOME + "/"),
      `${t.id} must anchor under the redirected worker HOME, not ${t.subject} — a grant that escapes the redirection is the W1-T2213 defect`,
    );
    const clash = rules.find((r) => denyRuleCovers(r, t.subject, ANCHORS));
    assert.equal(clash, undefined, `${t.id} is granted into the worker HOME and also denied by ${clash} — the settings file wins, so the grant delivers nothing`);
  }
});

test("W1-T2698: the probe reports every target as reachable, refused or absent with a reason", () => {
  const targets = fileTargets();
  const observed = runProbe(targets);
  assert.equal(observed.length, targets.length, "the probe must report one line per file target");
  const rules = denyRules(validateWorkerSettingsFile(SETTINGS_PATH));
  const byId = new Map(observed.map((r) => [r.id, r]));
  for (const t of targets) {
    const r = resolveCredentialReach(t, byId.get(t.id), rules, ANCHORS);
    assert.ok(["reachable", "refused", "absent", "unproven"].includes(r.outcome), `${t.id}: ${r.outcome}`);
    assert.notEqual(r.reason.trim(), "", `${t.id} reported ${r.outcome} with no reason — a bare boolean is what design (i) refuses`);
    assert.notEqual(r.outcome, "unproven", `${t.id} was not reported by the probe at all`);
  }
});

test("W1-T2698: a deny rule decides refusal, and removing it stops the refusal", () => {
  const rules = denyRules(validateWorkerSettingsFile(SETTINGS_PATH));
  const token = fileTargets().find((t) => t.id === "deny:console-write-token")!;
  const withRule = resolveCredentialReach(token, { id: token.id, kind: "file", outcome: "absent", reason: "no-such-path" }, rules, ANCHORS);
  assert.equal(withRule.outcome, "refused", "the console write token must be refused by a settings rule, on every host class");
  assert.match(withRule.reason, /denied by settings rule/);
  // The falsifier, run inline: drop the rule that covers it and the refusal must disappear.
  const without = rules.filter((r) => !denyRuleCovers(r, token.subject, ANCHORS));
  assert.notEqual(without.length, rules.length, "positive control: at least one rule must have covered the token path");
  assert.notEqual(resolveCredentialReach(token, { id: token.id, kind: "file", outcome: "absent", reason: "no-such-path" }, without, ANCHORS).outcome, "refused");
});

test("W1-T2698: the env allowlist is measured through buildWorkerEnv, not declared", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: REAL_HOME };
  for (const c of ENV_CANDIDATES) parent[c.key] = `fake-${c.key}`;
  const child = buildWorkerEnv({}, parent);
  const survived = ENV_CANDIDATES.filter((c) => c.key in child).map((c) => c.key).sort();
  assert.deepEqual(survived, ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"], "the env reach changed — record it in the baseline and say why");
  // The valve is opt-in: engaged, exactly one more key survives; never any other ANTHROPIC_*.
  const valved = buildWorkerEnv({}, parent, { allowApiKey: true });
  assert.ok("ANTHROPIC_API_KEY" in valved, "the §9 overflow valve must pass its one sanctioned key when engaged");
  assert.ok(!("ANTHROPIC_AUTH_TOKEN" in valved), "a non-sanctioned ANTHROPIC_* key must never survive");
});

test("W1-T2698: a reachable secret absent from the baseline fails by name; a closed entry is reported", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const hostClass = hostClassOf(process.env, platform(), existsSync);
  const entry = baseline.classes[hostClass];
  assert.ok(entry, `no baseline for host class ${hostClass} — the first run on a class records it (design (ii))`);

  const targets = fileTargets();
  const rules = denyRules(validateWorkerSettingsFile(SETTINGS_PATH));
  const byId = new Map(runProbe(targets).map((r) => [r.id, r]));
  const resolved = targets.map((t) => resolveCredentialReach(t, byId.get(t.id), rules, ANCHORS));

  const { widenings, closable } = credentialReachDrift(resolved, entry.reachable);
  assert.deepEqual(
    widenings.map((w) => w.id),
    [],
    `credential reach WIDENED on ${hostClass}: ${widenings.map((w) => `${w.id} (${w.reason})`).join(", ")} — this is the widening the ratchet exists to refuse`,
  );
  for (const id of closable) {
    console.log(`# credential-reach: ${id} is in the ${hostClass} baseline and is no longer reachable — the PR that closed it should drop the entry`);
  }

  // Falsifier, run inline: an id that is reachable and unlisted MUST be named.
  const planted = [...resolved, { id: "planted:probe", kind: "file" as const, outcome: "reachable" as const, reason: "planted" }];
  assert.deepEqual(credentialReachDrift(planted, entry.reachable).widenings.map((w) => w.id), ["planted:probe"]);
});

test("W1-T2698: the seam's own edges — anchoring, quoting, parsing and the unproven arm", () => {
  const a = { workerHome: "/w", configRoot: "/c", realHome: "/h" };
  // Each of the three anchors the settings file's $comment documents, plus the bare-absolute form.
  assert.ok(denyRuleCovers("Read(~/../../.ssh/**)", "/h/.ssh/id_ed25519", a), "~/../.. must reach the operator's real home");
  assert.ok(denyRuleCovers("~/../state/service-tokens.json", "/c/state/service-tokens.json", a), "~/.. must reach config.root");
  assert.ok(denyRuleCovers("~/.config/gh/**", "/w/.config/gh/hosts.yml", a), "a bare ~ must stay inside the worker home");
  assert.ok(denyRuleCovers("/etc/shadow", "/etc/shadow", a), "an absolute rule matches itself");
  assert.ok(!denyRuleCovers("~/../../.ssh/**", "/h/.sshrc", a), "a /** rule must not match a sibling that merely shares the prefix");
  assert.ok(!denyRuleCovers("relative/path", "/h/relative/path", a), "a rule with no anchor covers nothing rather than guessing one");

  // A path carrying a single quote must survive into the script intact — the probe is rendered
  // into `sh -c`, so a naive quote would let a path terminate the command.
  const odd: CredentialReachTarget = { id: "odd", kind: "file", subject: "/tmp/it's here", why: "quoting" };
  const script = containmentProbeScript([odd]);
  assert.match(script, /'\/tmp\/it'\\''s here'/, "a single quote in a path must be escaped, not closed");
  // An env target renders no line: this script measures files, and the env half is measured by
  // running buildWorkerEnv itself (see the header).
  assert.equal(containmentProbeScript([{ id: "e", kind: "env", subject: "GH_TOKEN", why: "" }]).includes("REACH e"), false);

  // Non-REACH stdout is ignored rather than parsed into a bogus result.
  assert.deepEqual(parseCredentialReach("sh: warning\nREACH x reachable why\nnoise"), [
    { id: "x", kind: "file", outcome: "reachable", reason: "why" },
  ]);

  // A target the probe never reported is `unproven`, never quietly `absent`.
  const unreported = resolveCredentialReach({ id: "z", kind: "file", subject: "/nowhere", why: "" }, undefined, [], a);
  assert.equal(unreported.outcome, "unproven");
  assert.match(unreported.reason, /reported no line/);
  // An env target is never refused by a FILE deny rule, however the path is spelled.
  assert.equal(resolveCredentialReach({ id: "e", kind: "env", subject: "GH_TOKEN", why: "" }, undefined, ["Read(~/**)"], a).outcome, "unproven");

  // Host class: CI wins over platform, the container marker over the darwin default.
  assert.equal(hostClassOf({ GITHUB_ACTIONS: "true" }, "linux", () => false), "ci-ubuntu");
  assert.equal(hostClassOf({ CI: "true" }, "darwin", () => false), "ci-darwin");
  assert.equal(hostClassOf({}, "linux", (p) => p === "/etc/rmd-build-sha"), "azure-container");
  assert.equal(hostClassOf({}, "darwin", () => false), "mini");
  assert.equal(hostClassOf({}, "freebsd", () => false), "unknown-freebsd");
});
