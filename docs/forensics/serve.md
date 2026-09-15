# serve.ts comment forensics

The measured forensics and design arguments behind `src/lib/serve.ts`, kept out of the source so
the code carries the invariant and the trap while the numbers live somewhere dated. Each section
is named for the symbol whose one-line `// Why:` pointer resolves to it.

## Change pressure, as a shrinking budget

`consoleRecyclePatienceMs` / `gateStaleCodeExit`.

W1-T2229 built the stale-code gate to end the console's own process at a moment that costs
nothing — zero SSE subscribers and zero in-flight writes — and deliberately never on a schedule,
because a re-check costs a `git rev-parse`. That reasoning holds whenever such a moment arrives.

Measured 2026-09-15 on the live daemon:

```
commits behind boot: 8
serve uptime:        12332s     (3h25m)
```

Three and a half hours serving code eight commits behind main, with the gate wired and working.
The container logs carry three `checkout:` / `listening on` pairs, so the gate had fired before —
this was never a broken gate, but one whose only trigger is a coincidence. A console tab left
open never produces the zero-client edge, and between edges nothing re-asks the question at all.

### The curve

| watchers | backlog | patience |
| --- | --- | --- |
| none | any | 0 — a free moment is free, exactly as before |
| some | 1 commit | 60 min |
| some | 10 commits | 6 min |
| some | 50 commits | 72 s |
| some | unknown | infinite — no evidence is not pressure |

One constant divided by the backlog. No cliff anywhere, and no reading of "too stale" to tune —
only a budget that shrinks as the reason to recycle grows. A test walks 1 to 200 commits behind
and asserts the curve is strictly decreasing at every step, so a threshold cannot be
reintroduced by accident. It self-heals: recycling resets the backlog to zero and patience to
its maximum.

### Why the re-check is armed at construction

Arming it lazily from inside `maybeExit` would reproduce the very defect being fixed: a tab left
open fires no edge, so the re-check meant to notice that would itself never be scheduled.

### The W1-T2562 assertion this supersedes

`test/serve-freshness-restart.test.ts` pinned the literal
`if (clients !== 0 || inFlightWrites !== 0) return;` as proof the idle exit had not been
weakened. The client half of that line is deliberately replaced here, so the assertion now pins
the invariant it was protecting — the in-flight-write refusal, which is absolute, and the
free-moment exit, which is unchanged — rather than the implementation text.
