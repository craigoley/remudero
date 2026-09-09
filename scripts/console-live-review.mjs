#!/usr/bin/env node
// console-live-review — look at the RUNNING operator console and report what it actually renders.
//
// WHY (W1-T3185). This repo has a mature browser-test capability pointed entirely at synthetic
// data: 31 files under test/ import Playwright, 22 of them stand up their own fixture server, and
// `grep -rn 'CONSOLE_URL|BASE_URL' test/*.ts` finds no suite that can be aimed at a running
// console. `test/serve.shell-ux.test.ts` runs @axe-core/playwright and passes 18/18 against its
// fixture while the LIVE console at the same commit reports 2 SERIOUS axe violations across 10
// nodes, 5 unlabelled controls, 17 sub-24x24 targets and 67 elements at 11px. Both are true: the
// defects are properties of REAL VOLUME. Five escalations make five reply boxes; a fixture with one
// makes one and trips nothing.
//
// AND THE LARGEST FINDING WAS INVISIBLE TO A FIXTURE ENTIRELY — the live board rendered 66 NEEDS ME
// rows of which ~53 were queued `verify: human` shards. Nobody hand-writing a fixture gives it 53
// rows of one class, because nobody believed the board looked like that.
//
// IT REPORTS; IT DOES NOT GATE. This runs against a console that may be up, down, stale or
// mid-deploy. A `node --test` case that fails while the daemon restarts is a false alarm in the one
// place this repo has already been burned: W1-T3018, where a missing Chromium made eleven suites
// look like 189 real failures and the false claim reached two merged PR bodies.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The three shapes an operator actually reads the console at. Fixed, not configurable: a viewport
 *  list that drifts per invocation cannot be compared across runs. */
export const VIEWPORTS = [
  { name: "laptop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "phone", width: 390, height: 844 },
];

/** Below this, a tap target is too small — the WCAG 2.2 target-size minimum, in CSS px. */
export const MIN_TARGET_PX = 24;

/** Body text below this reads as fine print; the live console had 67 elements at 11px. */
export const SMALL_TEXT_PX = 12;

/** THE ONLY WAY AUTH REACHES THIS SCRIPT IS INSIDE THE BASE URL. A token on a command line lands in
 *  shell history, in `ps`, and in any transcript that captured the invocation; a token in a named
 *  env var gets echoed by every debug dump. So the script REFUSES to accept one at all rather than
 *  accepting and redacting it — there is then no shape in which it can leak. The operator points it
 *  at something that already carries auth: a loopback proxy or an SSH-forwarded port. */
export const TOKEN_SURFACE_RE = /token|bearer|secret|password|api[-_]?key|credential|^gh_|^pat_/i;

/** A refusal sentence when a token reached this process by ANY surface, or undefined when clean. */
export function refuseTokenSurface({ argv = [], env = {} } = {}) {
  const badArg = argv.find((a) => TOKEN_SURFACE_RE.test(String(a)));
  if (badArg) {
    return (
      `console-live-review: REFUSED — the argument ${JSON.stringify(String(badArg))} looks like a credential. ` +
      "This script takes no token, by design: an argument lands in shell history and in `ps`. Point " +
      "CONSOLE_BASE_URL at something that already carries auth (a loopback proxy, an SSH-forwarded port)."
    );
  }
  // Only variables this script would READ are refused. The ambient environment is full of unrelated
  // secrets and refusing on those would make the script unusable on any real machine.
  const badEnv = Object.keys(env).find((k) => k.startsWith("CONSOLE_") && TOKEN_SURFACE_RE.test(k));
  if (badEnv) {
    return (
      `console-live-review: REFUSED — the environment variable ${badEnv} looks like a credential. ` +
      "This script reads no token: auth reaches it only inside CONSOLE_BASE_URL."
    );
  }
  return undefined;
}

/** THREE OUTCOMES, NEVER TWO — the polarity test/browser-absence.ts already establishes. "I could
 *  not look" must never collapse into "I looked and found nothing". */
export function notLookedAt(reason, detail) {
  return { lookedAt: false, reason, detail: detail ?? null, findings: null };
}

/** Group rendered font sizes into the scale actually in use, commonest first. A design defect lives
 *  in "67 elements at 11px", which no axe rule reports. */
export function typeScale(sizesPx) {
  const counts = new Map();
  for (const px of sizesPx) counts.set(px, (counts.get(px) ?? 0) + 1);
  return [...counts.entries()]
    .map(([px, count]) => ({ px, count, small: px < SMALL_TEXT_PX }))
    .sort((a, b) => b.count - a.count || a.px - b.px);
}

/** Interactive boxes below the target minimum, largest dimension first so the worst reads first. */
export function smallTargets(boxes, min = MIN_TARGET_PX) {
  return boxes
    .filter((b) => Math.min(b.width, b.height) < min)
    .sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
}

/** Row COMPOSITION, not just row count. The 53-of-66 finding came from counting what the board
 *  rendered, and a list dominated by one class is a design problem a violation list cannot see. */
export function composition(rows) {
  const byClass = new Map();
  for (const r of rows) byClass.set(r.kind, (byClass.get(r.kind) ?? 0) + 1);
  const entries = [...byClass.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  const total = rows.length;
  const dominant = entries[0];
  return {
    total,
    byClass: entries,
    dominant: dominant ? { ...dominant, share: total > 0 ? dominant.count / total : 0 } : null,
  };
}

/** One viewport's outcome folded into the run. A THROWN viewport is a FINDING, not an abort: the
 *  other viewports still have something to say, and "the phone layout crashed the run" is itself
 *  the most interesting line in the report. */
export function foldViewport(report, name, outcome) {
  report.viewports.push({ name, ...outcome });
  return report;
}

/** Did this run actually see the console at all? Used for the exit code and the headline, so a
 *  run that could not look never prints as a clean bill of health. */
export function everLooked(report) {
  return report.viewports.some((v) => v.lookedAt);
}

export function formatReport(report) {
  const out = [];
  out.push(`console-live-review — ${report.target} at ${report.startedAt}`);
  if (!everLooked(report)) {
    out.push("");
    out.push("NOT LOOKED AT — this run saw nothing. This is NOT a clean bill of health.");
    for (const v of report.viewports) out.push(`  ${v.name}: ${v.reason}${v.detail ? ` — ${v.detail}` : ""}`);
    return out.join("\n");
  }
  for (const v of report.viewports) {
    out.push("");
    out.push(`  ── ${v.name} (${v.width}x${v.height})`);
    if (!v.lookedAt) {
      out.push(`     NOT LOOKED AT: ${v.reason}${v.detail ? ` — ${v.detail}` : ""}`);
      continue;
    }
    const f = v.findings;
    out.push(`     axe            : ${f.axe.violations} violation(s), ${f.axe.serious} serious, across ${f.axe.nodes} node(s)`);
    if (f.composition.dominant) {
      const d = f.composition.dominant;
      out.push(`     rows           : ${f.composition.total} total — ${d.count} ${d.kind} (${Math.round(d.share * 100)}%)`);
      for (const c of f.composition.byClass.slice(1)) out.push(`                      ${c.count} ${c.kind}`);
    }
    const small = f.typeScale.filter((t) => t.small);
    out.push(`     type scale     : ${f.typeScale.map((t) => `${t.px}px x${t.count}`).join(", ")}`);
    if (small.length) out.push(`                      ${small.reduce((n, t) => n + t.count, 0)} element(s) below ${SMALL_TEXT_PX}px`);
    out.push(`     small targets  : ${f.smallTargets.length} below ${MIN_TARGET_PX}px`);
    if (v.screenshot) out.push(`     screenshot     : ${v.screenshot}`);
  }
  out.push("");
  out.push("Beautiful is the operator's judgement, not this script's. The screenshots are the point.");
  return out.join("\n");
}

/**
 * Review one running console. Every I/O seam is injected, so the decisions above are provable
 * without a browser, a server, or a console.
 */
export async function reviewConsole({
  baseUrl,
  viewports = VIEWPORTS,
  openViewport,
  browserAbsence = { kind: "present" },
  outDir = null,
  now = () => new Date().toISOString(),
}) {
  const report = { target: baseUrl, startedAt: now(), viewports: [] };

  // A MISSING BROWSER IS NOT A CONSOLE DEFECT. Reported before any launch, in the shape
  // test/browser-absence.ts already uses, so it can never read as "the console is broken".
  if (browserAbsence.kind !== "present") {
    for (const v of viewports) {
      foldViewport(report, v.name, { ...v, ...notLookedAt(`chromium ${browserAbsence.kind}`, browserAbsence.reason) });
    }
    return report;
  }

  for (const v of viewports) {
    try {
      const outcome = await openViewport({ baseUrl, viewport: v, outDir });
      foldViewport(report, v.name, { ...v, ...outcome });
    } catch (err) {
      // ONE VIEWPORT MUST NOT ABORT THE RUN. The others still report, and the failure is a finding.
      foldViewport(report, v.name, { ...v, ...notLookedAt("viewport failed", String(err?.message ?? err)) });
    }
  }
  return report;
}

/** Write the JSON beside the screenshots so an operator has both. */
export function writeArtefacts(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "console-live-review.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
}

// ── THE LIVE PATH ────────────────────────────────────────────────────────────────────────────────
//
// diff-cov: process-boundary — a real browser against a real console. Every DECISION above is pure
// and covered; what is below is the irreducible I/O those decisions are made about, and a unit test
// cannot launch Chromium at a running daemon.

/** Open one viewport against the live console and measure what it renders. */
export async function defaultOpenViewport({ baseUrl, viewport, outDir }) {
  const { chromium } = await import("playwright");
  const { AxeBuilder } = await import("@axe-core/playwright");

  const browser = await chromium.launch();
  try {
    // A CONTEXT, NOT A BARE PAGE. @axe-core/playwright refuses a page created by `browser.newPage()`
    // ("Please use browser.newContext()"). MEASURED: the first live smoke of this path failed on all
    // three viewports for exactly that reason — the unit tests could not have caught it, because
    // they inject the opener. The per-viewport guard reported it and the run correctly read as NOT
    // LOOKED AT rather than as a clean console.
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    const res = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
    if (!res || !res.ok()) {
      return notLookedAt("target unreachable", res ? `HTTP ${res.status()}` : "no response");
    }

    const axe = await new AxeBuilder({ page }).analyze();
    const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");

    // Composition is read from the board's own rows. `data-kind` is what the shell already stamps;
    // a row without one is counted as "unclassified" rather than dropped, so the total stays honest.
    const rows = await page.$$eval("[data-row], li[data-kind], tr[data-kind]", (els) =>
      els.map((el) => ({ kind: el.getAttribute("data-kind") ?? "unclassified" })),
    );
    const sizes = await page.$$eval("body *", (els) =>
      els
        .filter((el) => el.textContent && el.textContent.trim().length > 0 && el.children.length === 0)
        .map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize))),
    );
    const boxes = await page.$$eval("a, button, input, select, [role=button]", (els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), tag: el.tagName.toLowerCase() };
      }).filter((b) => b.width > 0 && b.height > 0),
    );

    let screenshot = null;
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      screenshot = join(outDir, `console-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
    }

    return {
      lookedAt: true,
      reason: null,
      detail: null,
      screenshot,
      findings: {
        axe: {
          violations: axe.violations.length,
          serious: serious.length,
          nodes: axe.violations.reduce((n, v) => n + v.nodes.length, 0),
          rules: serious.map((v) => v.id),
        },
        composition: composition(rows),
        typeScale: typeScale(sizes),
        smallTargets: smallTargets(boxes),
      },
    };
  } finally {
    await browser.close();
  }
}

/** The pinned browser's presence, in test/browser-absence.ts's own three-outcome shape. Imported
 *  lazily so this module stays loadable by plain `node` for the pure functions above. */
async function defaultBrowserAbsence() {
  try {
    const { classifyBrowserAbsence } = await import("../test/browser-absence.ts");
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    const { requiredChromiumDirs } = await import("../src/lib/review.ts");
    const { playwrightCacheRoot } = await import("../src/lib/worker-home.ts");
    void requiredChromiumDirs;
    const root = playwrightCacheRoot();
    let text = null;
    try {
      text = rf(new URL("../node_modules/playwright-core/browsers.json", import.meta.url), "utf8");
    } catch {
      text = null;
    }
    return classifyBrowserAbsence({
      browsersJsonText: text,
      isInstalled: (dir) => ex(join(root, dir, "INSTALLATION_COMPLETE")),
    });
  } catch (err) {
    // An unreadable classifier is `unknown`, never `present`: guessing "the browser is here" is how
    // a launch failure gets reported as a console defect.
    return { kind: "unknown", reason: `could not classify the browser install: ${String(err?.message ?? err)}` };
  }
}

export async function main({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const refusal = refuseTokenSurface({ argv, env });
  if (refusal) {
    log(refusal);
    return 2;
  }
  const baseUrl = env.CONSOLE_BASE_URL;
  if (!baseUrl) {
    log(
      "console-live-review: set CONSOLE_BASE_URL to a console that already carries auth " +
        "(a loopback proxy or an SSH-forwarded port). This script takes no token.",
    );
    return 2;
  }
  const outDir = env.CONSOLE_REVIEW_OUT ?? join(process.cwd(), "console-review");
  const report = await reviewConsole({
    baseUrl,
    openViewport: defaultOpenViewport,
    browserAbsence: await defaultBrowserAbsence(),
    outDir,
  });
  log(formatReport(report));
  log(`\nartefacts: ${writeArtefacts(report, outDir)}`);
  // EXIT 0 EVEN WITH FINDINGS. This REPORTS; it does not gate (design i). A non-zero exit here would
  // recruit it into CI, where a restarting daemon becomes a red build.
  return everLooked(report) ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("console-live-review.mjs")) {
  main().then((code) => process.exit(code));
}
