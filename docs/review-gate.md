# Review-enforced merge gate (W1-T1D)

`remudero-review` is a **REQUIRED status check** on `main`, alongside `ci`.

`ci` (W1-T1B) proves the code typechecks and its tests pass — Standing rule 4:
green checks are not evidence that the task's ACCEPTANCE CRITERIA were met. The
fresh-context REVIEW worker (W1-T1C) verdicts each criterion against its stated
proof and posts the `remudero-review` commit status. W1-T1D makes that verdict
**binding**: GitHub merges a PR only when BOTH checks are green, so the runner's
exit verdict becomes advisory telemetry that cannot diverge from reality and
auto-merge is safe to leave armed permanently.

## Required contexts

```
required_status_checks.contexts = [ci, remudero-review]
```

## Bootstrap ordering (same pattern as T1B)

Branch protection is armed from OBSERVED check-run names, never guessed. This
change is a config action, not a repo file — the protection API is updated
**after** this PR merges, so this PR itself merges under the CURRENT gate
(`ci` only). Sequence:

1. Merge this PR under the ci-only gate.
2. Add `remudero-review` to the required contexts:

   ```sh
   gh api --method PUT \
     repos/craigoley/remudero/branches/main/protection/required_status_checks \
     -f strict=true \
     -f 'contexts[]=ci' \
     -f 'contexts[]=remudero-review'
   ```

3. Confirm:

   ```sh
   gh api repos/craigoley/remudero/branches/main/protection \
     --jq .required_status_checks.contexts
   # -> ["ci","remudero-review"]
   ```

## Live falsification (acceptance)

- A PR that is CI-GREEN but posts `remudero-review=failure` stays OPEN and does
  not merge (planted probe: passes tests, ignores a stated acceptance criterion).
- A PR green on BOTH checks auto-merges with no runner-side merge call
  (ledger: `automerge.armed` then `pr.merged`, no explicit merge command).
