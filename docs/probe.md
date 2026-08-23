# Mount Routing Probe — Deterministic Task-Class Routing (W1-T167)

The **mount routing probe** is the decision structure that routes a task to a dynamically-selected model and effort based on what the task actually touches: deterministic policy-as-data (MASTER-PLAN §2, Standing rule 2), never an LLM judgment.

## Overview: The Class Axis

Before W1-T167, every task rode the same mount regardless of shape: sonnet/high (MASTER-PLAN §9), pricing a docs-only edit the same as a risk:high source change. The class axis adds a THIRD dimension to task routing:

- **task_type** (`implement`, `review`, `diagnose`, etc.) — what kind of work
- **risk** (`low`, `medium`, `high`) — how much is at stake
- **class** (`src`, `docs`, `plan-lint`) — what is actually being changed

This table-driven design moves cost decisions INTO `.remudero/mounts.yaml` (a DATA edit), away from code branches, so the routing policy evolves independently of the harness logic.

## Deriving Task Class

The task-class derivation (src/lib/task-class.ts) inspects `task.files` globs and assigns a class using conservative rules:

| Condition | Result |
|-----------|--------|
| Every glob matches `plan/...` | `plan-lint` |
| Every glob matches `docs/...`, `learnings/...`, `*.md`, or root docs | `docs` |
| Any ambiguity (mixed paths, missing files, empty globs) | `src` (default) |

**Principle:** False "cheap" routes a real src change onto underpowered hardware (unsafe); false "src" forgoes a discount (acceptable). Ambiguity always defaults to `src`.

Root docs include: `README.md`, `CHANGELOG.md`, `MASTER-PLAN.md`, `DECISIONS.md`, `LEARNINGS.md`, `FINDINGS.md`, `DIAGNOSIS.md`, `SECURITY.md`, `CONTRIBUTING.md`.

## The Docs Class: Cost-Optimized Prose and Configuration

When every file a task touches lives in `docs/`, the task classifies as `docs` and routes to a **cheaper mount**. Example from `.remudero/mounts.yaml`:

```yaml
implement:
  medium:
    src:       { model: sonnet, effort: high,   max_turns: 400, context_budget: 160000 }
    docs:      { model: haiku,  effort: medium, max_turns: 400, context_budget: 90000 }
```

A docs-class `implement × medium` task:
- Rides **haiku** (the cheaper model tier) instead of sonnet
- Effort floors at **medium** (not high), matching work complexity
- Context budget is **90k tokens** (vs. 160k for src)
- **Result:** ~80% cost reduction on labor while maintaining sufficient reasoning for prose tasks

> **The payoff figures on this page are FROZEN, not current.** `MASTER-PLAN.md` holds the mount
> table frozen at its present values until TASK G ships — "NO mount may be re-based on it — the
> table is FROZEN until TASK G ships" — and the whole `implement` row publishes **`UNMEASURED`**
> across every column (runs, ships, cost/run, turns, total). So the routing MECHANICS below are
> live and accurate, and the `.remudero/mounts.yaml` excerpt above matches the committed table;
> what cannot be re-derived from the ledger today is the ~80%. Treat it as the figure that
> justified the row when it was written, not as a measurement you can quote. Re-check with
> `grep -n 'UNMEASURED' MASTER-PLAN.md`.

### When docs-class routing applies

- Documentation edits: ORIENTATION.md, architecture.md, troubleshooting.md
- Configuration guide updates
- Markdown-only changes (README, CHANGELOG, etc.)
- Learnings and decision records
- **NOT:** code samples in docs (mixed task → defaults to src)

### When docs-class routing is NOT used (fallback to src)

- Changes touching BOTH `docs/` and `src/`
- Code-shaped files (`.ts`, `.js`, `.json`) even if in docs/
- Ambiguous or repo-wide tasks with missing `files`
- `risk: high` tasks (docs-class rows do not exist by design; a high-risk docs task is unusual enough to merit the full mount)

The fallback is LOUD: if a task requests docs-class routing but the table has no matching row, run-task.ts ledgers a `mount.class_fallback` line, never a silent swap.

## Routing Flow (run-task.ts)

1. **Derive task class** via `deriveTaskClass(task)` → one of `"src"`, `"docs"`, `"plan-lint"`
2. **Resolve mount** via `resolveMountForClass(mountsTable, task.type, task.risk, taskClass)`
   - Checks for an exact (type, risk, class) row in `.remudero/mounts.yaml`
   - If not found, falls back to the (type, risk, `"src"`) row (the universal default)
   - **Ledgers a `mount.class_fallback` line** if the fallback triggers (for auditing)
3. **Ledger run.start** with `task_class` and `mount_class` (W1-T167 telemetry)
4. **Spawn worker** with the resolved mount's model, effort, and turn budget

## The Tier Invariant (G-17)

Every worker mount is capped at the **sonnet ceiling**; the Architect alone rides opus. The docs-class haiku mount respects this: haiku < sonnet, so routing a docs task to haiku never violates the invariant that the Architect (opus/high) remains strictly above all workers.

## When to add a docs-class row

Edit `.remudero/mounts.yaml` to introduce or upgrade a docs-class mount when:

1. A specific (type, risk) combination has logged repeated `mount.class_fallback` lines (falling back to src)
2. The work is GENUINELY docs-only (per the derivation rules above)
3. The new mount respects the Tier Invariant

Example: if `review × medium × docs` is falling back to src repeatedly, add:

```yaml
review:
  medium:
    src:  { model: sonnet, effort: medium, max_turns: 400, context_budget: 90000 }
    docs: { model: haiku,  effort: low,    max_turns: 400, context_budget: 50000 }  # new
```

## Testing the routing probe

The test suite (`test/mounts-wiring.test.ts`) verifies:

- Task class derivation matches files globs correctly
- Mount resolution finds the exact (type, risk, class) row
- Fallback to (type, risk, src) triggers and is ledgered
- Every task in the plan carries a valid risk (so routing can key on it)
- The committed `.remudero/mounts.yaml` table has no gaps in required rows

Run `npm test mounts-wiring` to validate the routing probe.

## References

- **MASTER-PLAN.md** — §9 "The class axis" (policy overview)
- **src/lib/task-class.ts** — class derivation logic
- **src/lib/mounts.ts** — mount resolution and validation
- **.remudero/mounts.yaml** — the policy table itself
- **W1-T167** (PR #411) — the landing PR for this feature
