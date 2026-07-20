// scripts/shell-screenshot.mjs
//
// W1-T153's "a11y/screenshot mechanism" (task design note, per W3-T7 / the arcade-fleet
// Lighthouse pattern): boots a REAL `rmd serve` shell (buildServeServer) over representative
// fixture data — a mix of in-flight, needs-human, queued, merged, and blocked tasks so every
// one of the five operator-priority sections (NOW/NEEDS ME/UP NEXT/RECENT/rest) renders real
// content, not just empty states — and captures 390px (iPhone, the operator's primary glance
// device) + 1440px (desktop) screenshots with a headless Chromium (Playwright).
//
// "Structure the CSS/layout for CHEAP revision — the operator is the design judge and a taste
// iteration loop is expected" (task design note): this script IS that cheap iteration loop —
// re-run it any time the shell's CSS/markup changes to regenerate the design-review artifacts
// under docs/design-review/w1-t153/ for the operator's next look.
//
// Usage: tsx scripts/shell-screenshot.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { buildServeServer } from "../src/lib/serve.ts";

const READ_TOKEN = "screenshot-token";

function task(over) {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks) {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const root = mkdtempSync(join(tmpdir(), "rmd-shell-screenshot-"));
mkdirSync(join(root, "state"), { recursive: true });
const ledgerPath = join(root, "state", "ledger.ndjson");

const plan = planOf([
  task({ id: "W1-T156", status: "running" }), // NOW (in-flight, via ledger run.start below)
  task({ id: "W1-T88", status: "queued" }), // NEEDS ME (needs-human, via ledger escalation below)
  task({ id: "W1-T157", status: "queued" }),
  task({ id: "W1-T158", status: "queued" }), // UP NEXT
  task({ id: "W1-T146", status: "merged" }), // RECENT
  task({ id: "W1-T145", status: "blocked" }), // RECENT
  ...Array.from({ length: 12 }, (_, i) => task({ id: `W1-T${200 + i}`, status: i % 3 === 0 ? "merged" : "queued" })), // rest
]);

mkdirSync(join(root, "plan"), { recursive: true });
writeFileSync(
  join(root, "plan", "tasks.yaml"),
  plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join(""),
);

const ledgerLines = [
  { ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T156", step: "run.start" },
  { ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T156", step: "recon.done" },
  { ts: new Date().toISOString(), run_id: "r2", task_id: "W1-T88", step: "escalation.issue_opened", issue_url: "https://github.com/craigoley/remudero/issues/1" },
  { ts: new Date().toISOString(), run_id: "r3", task_id: "W1-T146", step: "pr.opened", pr_url: "https://github.com/craigoley/remudero/pull/146" },
  { ts: new Date().toISOString(), run_id: "r4", task_id: "W1-T145", step: "pr.opened", pr_url: "https://github.com/craigoley/remudero/pull/145" },
];
writeFileSync(ledgerPath, ledgerLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const prByRef = {
  "https://github.com/craigoley/remudero/pull/146": { number: 146, url: "https://github.com/craigoley/remudero/pull/146", state: "MERGED" },
  "https://github.com/craigoley/remudero/pull/145": { number: 145, url: "https://github.com/craigoley/remudero/pull/145", state: "OPEN" },
};
const github = {
  prByRef: (ref) => prByRef[String(ref)] ?? null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const deps = {
  board: { plan, ledgerPath, github },
  panelGraph: {
    root,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: github,
  },
  ledgerPath,
  issues: { close() {} },
  fleetControlRoot: root,
  questionsRoot: root,
  tokens: { read: READ_TOKEN, write: "screenshot-write-token" },
  pollMs: 250,
};

const server = buildServeServer(deps);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const outDir = join(process.cwd(), "docs", "design-review", "w1-t153");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const [label, width, height] of [
    ["390", 390, 844],
    ["1440", 1440, 900],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${base}/?token=${READ_TOKEN}`);
    await page.waitForFunction(() => !document.getElementById("top-status")?.textContent?.includes("loading"));
    // expand "everything else" so the collapsed-group affordance is visible in the desktop shot.
    if (label === "1440") await page.click("#rest-toggle");
    const outPath = join(outDir, `shell-${label}.png`);
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`wrote ${outPath}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
