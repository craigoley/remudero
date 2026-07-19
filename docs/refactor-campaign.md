# Refactor campaign — the measurable gate-delta formula (W2-T3)

MASTER-PLAN §3A flagged "tech-debt sweep" as under-built as a vibe. This
document describes the refactor campaign as it is **wired and running** — a
first-class campaign whose acceptance is a measurable delta on the Tier-2/3
gates already live on this repo (§5), not prose asserting improvement.

`plan/campaigns/refactor.yaml` is the campaign template: a repo selector plus
five gate definitions. `scripts/refactor-campaign.mjs` is the CLI that reads
it, computes each gate's current value, and compares it against the recorded
baseline.

## The five gates

| gate | direction | current-value source | baseline |
| --- | --- | --- | --- |
| `mutation` | up (higher is better) | Stryker JSON report (`reports/mutation/mutation.json`) | `scripts/mutation-baseline.json` |
| `complexity` | down | this script's own cyclomatic-approximation scan over `src/**/*.ts` | `scripts/complexity-baseline.json` |
| `duplication` | down | jscpd JSON report's `statistics.total.percentage` | `scripts/dup-baseline.json` |
| `cve` | down | `npm audit --json`'s `metadata.vulnerabilities.total` | `scripts/cve-baseline.json` |
| `fitness` | down | dependency-cruiser JSON report's `summary.violations.length` | `scripts/fitness-baseline.json` |

`complexity` is a heuristic (1 + one per `if`/`for`/`while`/`case`/`catch`/
`&&`/`||`/`??`/ternary, after stripping comments and string/template literal
bodies) computed in-process — no new dependency, and good enough to **rank**
files by how much branching logic they carry, which is exactly what a
campaign needs to name targets.

## The formula (`evaluateCampaign`)

**GREEN iff (a) no gate regressed versus its baseline AND (b) at least one
gate strictly improved.**

- A refactor that leaves every number unchanged is a **no-op, not a
  refactor** — RED.
- A refactor that regresses one gate to buy improvement on another is RED too
  — no trading one debt for another.
- A missing current-value report fails **closed** (non-zero exit) — "can't
  prove it improved" is treated the same as "didn't improve."

Each gate may declare an `epsilon` tolerance (the `duplication` gate uses
`0.01` percentage points) so tool-level measurement noise — jscpd's percentage
shifts slightly on any `src/**` line change, even one unrelated to the
refactor — doesn't register as a false regression or a false improvement.

## Usage

```
node scripts/refactor-campaign.mjs dry-run [--config plan/campaigns/refactor.yaml]
node scripts/refactor-campaign.mjs check   [--config plan/campaigns/refactor.yaml]
```

`dry-run` is read-only and always exits 0: it prints the project-wide gate
deltas plus the top-N tech-debt targets (ranked by complexity, cross-
referenced against which of those files also show up in the duplication/
fitness reports). `check` is the CI gate: exit 0 is GREEN, non-zero is RED
with the failing reason(s) printed.

## CI wiring

The `refactor-campaign` job (`.github/workflows/ci.yml`) runs **unconditionally**
on every PR (no path filter — a conditionally-skipped required check is the
synthwatch #102 deadlock class `ci-gate.yml` exists to avoid), but its real
work — regenerating the four tool reports and running `check` — is scoped
internally to PRs carrying the `refactor-campaign` label (mirrors
`containment-probe`'s diff-based scoping). A PR without the label completes
the job successfully and is never blocked by it.

`ci-gate.yml`'s `REQUIRED` list includes `refactor-campaign`, so a labeled
refactor PR that doesn't move the gate numbers in the right direction cannot
merge — proven by `test/refactor-campaign.test.ts`'s falsifier fixtures (an
all-improved fixture is accepted; a no-improvement fixture and a
one-gate-regressed fixture are both rejected), not merely asserted.
