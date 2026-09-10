import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// W1-T3185 — NOTHING REVIEWED THE RUNNING CONSOLE.
//
// THE CENSUS, 2026-09-08: 31 files under test/ import Playwright; 22 stand up their own fixture
// server, and the other 9 are about the browser toolchain rather than the console. No suite could
// be pointed at a running console at all.
//
// WHAT THAT COST, measured the same day: test/serve.shell-ux.test.ts runs @axe-core/playwright and
// passes 18/18 against its fixture, while the LIVE console at the same commit reported 2 SERIOUS
// axe violations across 10 nodes, 5 unlabelled controls, 17 sub-24x24 targets and 67 elements at
// 11px. Both are true at once, because the defects are properties of REAL VOLUME: five escalations
// make five reply boxes, and a fixture with one makes one and trips nothing.
//
// `scripts/**` sits OUTSIDE tsconfig's `include`, so this reaches the script through a runtime
// import rather than a typed one — the convention test/clock-sweep.test.ts already documents.

const SCRIPT_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "console-live-review.mjs"),
).href;

const mod = (await import(SCRIPT_URL)) as {
  VIEWPORTS: Array<{ name: string; width: number; height: number }>;
  MIN_TARGET_PX: number;
  SMALL_TEXT_PX: number;
  refuseTokenSurface: (o: { argv?: string[]; env?: Record<string, string> }) => string | undefined;
  notLookedAt: (reason: string, detail?: string) => { lookedAt: false; reason: string; findings: null };
  typeScale: (px: number[]) => Array<{ px: number; count: number; small: boolean }>;
  smallTargets: (b: Array<{ width: number; height: number }>, min?: number) => unknown[];
  composition: (rows: Array<{ kind: string }>) => {
    total: number;
    byClass: Array<{ kind: string; count: number }>;
    dominant: { kind: string; count: number; share: number } | null;
  };
  defaultOpenViewport: (o: Record<string, unknown>) => Promise<{
    lookedAt: boolean;
    reason: string | null;
    detail: string | null;
    screenshot: string | null;
    findings: {
      axe: { violations: number; serious: number; nodes: number; rules: string[] };
      composition: { total: number; dominant: { kind: string; count: number; share: number } };
      typeScale: Array<{ px: number; count: number; small: boolean }>;
      smallTargets: unknown[];
    };
  }>;
  defaultBrowserAbsence: (o?: Record<string, unknown>) => Promise<{ kind: string; reason?: string; missing?: string[] }>;
  writeArtefacts: (report: unknown, outDir: string) => string;
  everLooked: (r: { viewports: Array<{ lookedAt: boolean }> }) => boolean;
  formatReport: (r: unknown) => string;
  reviewConsole: (o: Record<string, unknown>) => Promise<{
    target: string;
    viewports: Array<{ name: string; lookedAt: boolean; reason: string | null; findings: unknown }>;
  }>;
  main: (o: {
    argv?: string[];
    env?: Record<string, string>;
    log?: (m: string) => void;
    openViewport?: (o: { viewport: { name: string } }) => Promise<unknown>;
    browserAbsence?: () => Promise<{ kind: string; reason?: string }>;
    write?: (report: unknown, outDir: string) => string;
  }) => Promise<number>;
};

/** A viewport opener that reports one plausible live reading. */
const openOk = async ({ viewport }: { viewport: { name: string } }) => ({
  lookedAt: true,
  reason: null,
  detail: null,
  screenshot: `/tmp/${viewport.name}.png`,
  findings: {
    axe: { violations: 2, serious: 2, nodes: 10, rules: ["aria-prohibited-attr", "label"] },
    composition: mod.composition([
      ...Array.from({ length: 53 }, () => ({ kind: "verify-human" })),
      ...Array.from({ length: 13 }, () => ({ kind: "escalation" })),
    ]),
    typeScale: mod.typeScale([...Array.from({ length: 67 }, () => 11), 14, 14, 16]),
    smallTargets: mod.smallTargets([{ width: 18, height: 18 }, { width: 40, height: 40 }]),
  },
});

test("W1-T3185: the review reports axe, row composition, type scale and target sizes TOGETHER", async () => {
  const report = await mod.reviewConsole({ baseUrl: "http://127.0.0.1:4317/", openViewport: openOk });
  assert.equal(report.viewports.length, mod.VIEWPORTS.length, "every viewport is reported");
  assert.ok(mod.everLooked(report as never));

  const out = mod.formatReport(report);
  // THE DESIGN DEFECTS LIVE IN THE NUMBERS A RULE LIST DOES NOT HAVE. The 53-of-66 finding is not
  // an axe rule; it came from counting what the board actually rendered, and no hand-written
  // fixture would have been given 53 rows of one class.
  assert.match(out, /2 violation\(s\), 2 serious/, "axe output is present");
  assert.match(out, /66 total — 53 verify-human \(80%\)/, "and so is the composition it cannot see");
  assert.match(out, /11px x67/, "the type scale in use");
  assert.match(out, /element\(s\) below 12px/, "called out as fine print");
  assert.match(out, /small targets  : 1 below 24px/, "and the sub-minimum tap target");
  assert.match(out, /screenshot/, "with an artefact the operator can actually look at");
});

test("W1-T3185: the live viewport opener collects the same four findings from the page", async () => {
  const screenshotCalls: unknown[] = [];
  const closed: string[] = [];
  const page = {
    goto: async () => ({ ok: () => true, status: () => 200 }),
    $$eval: async (selector: string, fn: (els: unknown[]) => unknown) => {
      if (selector.includes("data-row")) {
        return fn([
          { getAttribute: () => "verify-human" },
          { getAttribute: () => "verify-human" },
          { getAttribute: () => "escalation" },
        ]);
      }
      if (selector === "body *") {
        return fn([
          { textContent: "tiny", children: [], fontSize: "11px" },
          { textContent: "normal", children: [], fontSize: "14px" },
          { textContent: "wrapper", children: [{}], fontSize: "20px" },
        ]);
      }
      if (selector.includes("button")) {
        return fn([
          { tagName: "BUTTON", getBoundingClientRect: () => ({ width: 18, height: 20 }) },
          { tagName: "A", getBoundingClientRect: () => ({ width: 44, height: 44 }) },
        ]);
      }
      throw new Error(`unexpected selector ${selector}`);
    },
    screenshot: async (opts: unknown) => {
      screenshotCalls.push(opts);
    },
  };
  const context = { newPage: async () => page };
  const browser = {
    newContext: async (opts: unknown) => {
      assert.deepEqual(opts, { viewport: { width: 390, height: 844 } });
      return context;
    },
    close: async () => {
      closed.push("closed");
    },
  };
  const viewport = { name: "phone", width: 390, height: 844 };
  const styleGlobal = globalThis as unknown as {
    getComputedStyle?: (el: { fontSize: string }) => { fontSize: string };
  };
  const previousGetComputedStyle = styleGlobal.getComputedStyle;
  const result = await (async () => {
    styleGlobal.getComputedStyle = (el) => ({
      fontSize: el.fontSize,
    });
    try {
      return await mod.defaultOpenViewport({
        baseUrl: "http://127.0.0.1:4317/",
        viewport,
        outDir: "/tmp/console-live-review-test",
        playwright: Promise.resolve({ chromium: { launch: async () => browser } }),
        axePlaywright: Promise.resolve({
          AxeBuilder: class {
            analyze() {
              return {
                violations: [
                  { id: "label", impact: "serious", nodes: [{}, {}] },
                  { id: "color-contrast", impact: "moderate", nodes: [{}] },
                ],
              };
            }
          },
        }),
      });
    } finally {
      styleGlobal.getComputedStyle = previousGetComputedStyle;
    }
  })();

  assert.equal(result.lookedAt, true);
  assert.equal(result.findings.axe.violations, 2);
  assert.equal(result.findings.axe.serious, 1);
  assert.equal(result.findings.axe.nodes, 3);
  assert.deepEqual(result.findings.axe.rules, ["label"]);
  assert.equal(result.findings.composition.total, 3);
  assert.equal(result.findings.composition.dominant.kind, "verify-human");
  assert.deepEqual(result.findings.typeScale, [
    { px: 11, count: 1, small: true },
    { px: 14, count: 1, small: false },
  ]);
  assert.equal(result.findings.smallTargets.length, 1);
  assert.equal(result.screenshot, "/tmp/console-live-review-test/console-phone.png");
  assert.deepEqual(screenshotCalls, [{ path: "/tmp/console-live-review-test/console-phone.png", fullPage: true }]);
  assert.deepEqual(closed, ["closed"], "the live browser is closed after collection");
});

test("W1-T3185: the live viewport opener reports an unreachable target without findings", async () => {
  const closed: string[] = [];
  const browser = {
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => ({ ok: () => false, status: () => 502 }),
      }),
    }),
    close: async () => {
      closed.push("closed");
    },
  };

  const result = await mod.defaultOpenViewport({
    baseUrl: "http://down/",
    viewport: { name: "phone", width: 390, height: 844 },
    playwright: Promise.resolve({ chromium: { launch: async () => browser } }),
    axePlaywright: Promise.resolve({
      AxeBuilder: class {
        analyze() {
          throw new Error("axe must not run when the target is unreachable");
        }
      },
    }),
  });

  assert.deepEqual(result, mod.notLookedAt("target unreachable", "HTTP 502"));
  assert.deepEqual(closed, ["closed"], "even unreachable targets close the browser");
});

test("W1-T3185: browser absence classification uses the pinned Playwright manifest shape", async () => {
  const installChecks: string[] = [];
  const absence = await mod.defaultBrowserAbsence({
    browserAbsence: Promise.resolve({
      classifyBrowserAbsence: ({ browsersJsonText, isInstalled }: { browsersJsonText: string; isInstalled: (dir: string) => boolean }) => {
        assert.equal(browsersJsonText, '{"browsers":[]}');
        assert.equal(isInstalled("chromium-1234"), true);
        assert.deepEqual(installChecks, ["/cache/chromium-1234/INSTALLATION_COMPLETE"]);
        return { kind: "present" };
      },
    }),
    fs: Promise.resolve({
      readFileSync: () => '{"browsers":[]}',
      existsSync: (path: string) => {
        installChecks.push(path);
        return true;
      },
    }),
    review: Promise.resolve({ requiredChromiumDirs: () => [] }),
    workerHome: Promise.resolve({ playwrightCacheRoot: () => "/cache" }),
  });

  assert.deepEqual(absence, { kind: "present" });

  const missingManifest = await mod.defaultBrowserAbsence({
    browserAbsence: Promise.resolve({
      classifyBrowserAbsence: ({ browsersJsonText }: { browsersJsonText: string | null }) => {
        assert.equal(browsersJsonText, null);
        return { kind: "unknown", reason: "manifest missing" };
      },
    }),
    fs: Promise.resolve({
      readFileSync: () => {
        throw new Error("missing");
      },
      existsSync: () => false,
    }),
    review: Promise.resolve({ requiredChromiumDirs: () => [] }),
    workerHome: Promise.resolve({ playwrightCacheRoot: () => "/cache" }),
  });

  assert.deepEqual(missingManifest, { kind: "unknown", reason: "manifest missing" });
});

test("W1-T3185: browser absence classification fails closed when its imports cannot load", async () => {
  const absence = await mod.defaultBrowserAbsence({
    browserAbsence: Promise.reject(new Error("classifier unavailable")),
    fs: Promise.resolve({}),
    review: Promise.resolve({}),
    workerHome: Promise.resolve({}),
  });

  assert.equal(absence.kind, "unknown");
  assert.match(absence.reason!, /classifier unavailable/);
});

test("W1-T3185: artefacts are written beside screenshots for operator review", () => {
  const outDir = join("/tmp", "console-live-review-artefacts");
  const report = { target: "http://127.0.0.1:4317/", startedAt: "2026-09-08T00:00:00.000Z", viewports: [] };
  const path = mod.writeArtefacts(report, outDir);

  assert.equal(path, join(outDir, "console-live-review.json"));
});

test("W1-T3185: main reports usage, success artefacts and non-gating findings through injected live seams", async () => {
  const missingUrl: string[] = [];
  assert.equal(await mod.main({ argv: [], env: {}, log: (m) => missingUrl.push(m) }), 2);
  assert.match(missingUrl.join("\n"), /set CONSOLE_BASE_URL/);

  const lines: string[] = [];
  const code = await mod.main({
    argv: [],
    env: { CONSOLE_BASE_URL: "http://127.0.0.1:4317/", CONSOLE_REVIEW_OUT: "/tmp/console-live-main" },
    browserAbsence: async () => ({ kind: "present" }),
    openViewport: async ({ viewport }: { viewport: { name: string } }) => ({
      ...(await openOk({ viewport })),
      screenshot: null,
    }),
    write: (_report: unknown, outDir: string) => join(outDir, "console-live-review.json"),
    log: (m) => lines.push(m),
  });

  assert.equal(code, 0, "findings are reported without gating the operator run");
  assert.match(lines.join("\n"), /axe\s+: 2 violation\(s\), 2 serious/);
  assert.match(lines.join("\n"), /artefacts: \/tmp\/console-live-main\/console-live-review.json/);
});

test("W1-T3185: main returns a not-looked-at exit when the browser classifier quarantines the run", async () => {
  const lines: string[] = [];
  const code = await mod.main({
    argv: [],
    env: { CONSOLE_BASE_URL: "http://127.0.0.1:4317/" },
    browserAbsence: async () => ({ kind: "unknown", reason: "manifest unreadable" }),
    openViewport: async () => {
      throw new Error("openViewport must not run when the browser is not known present");
    },
    write: (_report: unknown, outDir: string) => join(outDir, "console-live-review.json"),
    log: (m) => lines.push(m),
  });

  assert.equal(code, 1);
  assert.match(lines.join("\n"), /NOT LOOKED AT/);
});

test("W1-T3185: the live viewport opener can run without writing screenshots", async () => {
  const browser = {
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => ({ ok: () => true, status: () => 200 }),
        $$eval: async () => [],
      }),
    }),
    close: async () => {},
  };

  const result = await mod.defaultOpenViewport({
    baseUrl: "http://127.0.0.1:4317/",
    viewport: { name: "phone", width: 390, height: 844 },
    playwright: Promise.resolve({ chromium: { launch: async () => browser } }),
    axePlaywright: Promise.resolve({
      AxeBuilder: class {
        analyze() {
          return { violations: [] };
        }
      },
    }),
  });

  assert.equal(result.lookedAt, true);
  assert.equal(result.screenshot, null);
});

test("W1-T3185: an unreachable or timing-out target is reported as NOT LOOKED AT, never as zero findings", async () => {
  const unreachable = async () => mod.notLookedAt("target unreachable", "HTTP 502");
  const report = await mod.reviewConsole({ baseUrl: "http://down/", openViewport: unreachable });

  assert.equal(mod.everLooked(report as never), false);
  for (const v of report.viewports) {
    assert.equal(v.lookedAt, false);
    assert.equal(v.findings, null, "a run that could not look reports NO findings, not zero findings");
  }
  const out = mod.formatReport(report);
  assert.match(out, /NOT LOOKED AT/);
  assert.match(out, /NOT a clean bill of health/, "the headline must refuse to read as a pass");
  assert.doesNotMatch(out, /0 violation/, "and must never print a violation count it did not measure");
});

test("W1-T3185: a missing Chromium is reported the way browser-absence.ts reports it, never as a console defect", async () => {
  // W1-T3018: with the pinned build missing, eleven suites launched anyway and emitted one raw
  // Playwright error each — read as 189 real failures, and the false claim reached two merged PR
  // bodies. The absence is classified BEFORE any launch, in that file's own three-outcome shape.
  let opened = 0;
  const report = await mod.reviewConsole({
    baseUrl: "http://127.0.0.1:4317/",
    openViewport: async () => {
      opened += 1;
      return openOk({ viewport: { name: "x" } });
    },
    browserAbsence: { kind: "absent", missing: ["chromium-1234"], reason: "chromium-1234 is not installed" },
  });

  assert.equal(opened, 0, "no launch may be attempted when the browser is known absent");
  assert.equal(mod.everLooked(report as never), false, "and it is NOT a clean run");
  assert.match(report.viewports[0].reason!, /chromium absent/, "the reason names the browser, not the console");
  assert.match(mod.formatReport(report), /chromium-1234 is not installed/, "carrying the classifier's own sentence");

  // `unknown` must behave like absent, never like present — a skip on a guess is a quarantine.
  const unsure = await mod.reviewConsole({
    baseUrl: "http://127.0.0.1:4317/",
    openViewport: openOk,
    browserAbsence: { kind: "unknown", reason: "manifest unreadable" },
  });
  assert.equal(mod.everLooked(unsure as never), false, "'could not tell' must not collapse into 'it is here'");
});

test("W1-T3185: the script accepts NO token argument and NO token environment variable", async () => {
  // A token on a command line lands in shell history, in `ps`, and in any transcript. The script
  // refuses one rather than accepting and redacting it, so there is no shape in which it can leak.
  for (const argv of [["--token", "abc"], ["--bearer=xyz"], ["--api-key", "k"], ["--console-secret"]]) {
    const refusal = mod.refuseTokenSurface({ argv, env: {} });
    assert.ok(refusal, `a credential-shaped argument must be refused: ${argv.join(" ")}`);
    assert.match(refusal!, /takes no token/, "and the refusal must say why");
  }
  assert.ok(mod.refuseTokenSurface({ argv: [], env: { CONSOLE_TOKEN: "x" } }), "a CONSOLE_* token var is refused");

  // AND IT MUST STAY USABLE. The ambient environment of any real machine is full of unrelated
  // secrets; refusing on those would make the script unrunnable, which is how a guard gets deleted.
  assert.equal(mod.refuseTokenSurface({ argv: ["--out", "x"], env: { GH_TOKEN: "real" } }), undefined);

  // main() refuses BEFORE it does anything else, and exits non-zero without looking.
  const lines: string[] = [];
  const code = await mod.main({ argv: ["--token", "abc"], env: { CONSOLE_BASE_URL: "http://x/" }, log: (m) => lines.push(m) });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /REFUSED/);
});

test("W1-T3185: one viewport failing does not abort the run, and the failure is itself a finding", async () => {
  // The phone layout crashing is the most interesting line in the report, and the other two
  // viewports still have something to say. An abort would lose both.
  const flaky = async ({ viewport }: { viewport: { name: string } }) => {
    if (viewport.name === "phone") throw new Error("Target closed");
    return openOk({ viewport });
  };
  const report = await mod.reviewConsole({ baseUrl: "http://127.0.0.1:4317/", openViewport: flaky });

  assert.equal(report.viewports.length, 3, "every viewport still appears");
  const phone = report.viewports.find((v) => v.name === "phone")!;
  assert.equal(phone.lookedAt, false);
  assert.match(phone.reason!, /viewport failed/);
  assert.equal(report.viewports.filter((v) => v.lookedAt).length, 2, "the survivors still report");
  assert.ok(mod.everLooked(report as never), "and the run as a whole DID look");
  assert.match(mod.formatReport(report), /NOT LOOKED AT: viewport failed — Target closed/);
});
