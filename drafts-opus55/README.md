# Draft plan shards from the Opus 5.5 prompting-guide audit (2026-10-03)

NOT part of the plan: this directory is outside `plan/tasks.d`, so nothing loads it.

Eighteen shard drafts, pre-linted with `rmd lint-plan --base origin/main --merge-base` (0 failing; advisory
warnings only: a duplicate-surface note on W1-T9901 against the parked W1-T7B, and call-site or span notes on
the scout tasks). Their ids `W1-T9900`..`W1-T9917` are PLACEHOLDERS, never claimed. To file them: reserve
eighteen real ids from the operator checkout
(`rmd next-task-id --branch <file/...>`, eighteen times), replace each placeholder id throughout (filenames,
`id:`, and every `test("W1-T99xx: ...` proof title, which must stay byte-identical to its test title),
move the shards to `plan/tasks.d/`, and lint again.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5

## The proactivity set (W1-T9912..W1-T9917), added after the audit

Operator ask 2026-10-03: a gardener that looks for ways to improve the plan, the task list and the repository
and flows through with no human review. Filed `risk: low` / `verify: auto` so the machine-filing judge and the
ordinary review and merge gates decide, not a person. Order and dependencies:

- W1-T9912 the scout's ledger class (finds a recurring failing step no task cites; queue-bounded; judged by
  whether the symptom stopped). W1-T9916 registers it. W1-T9913 adds the repo-reading class and depends on
  W1-T9912.
- W1-T9914 and W1-T9917 are the quarantine pair from the 2026-10-03 outage (a malformed shard stops the whole
  daemon today): the plan reader quarantines it, then the reporter names it. W1-T9915 is the cause-side half:
  a plan-writing gardener lints the merged result before it lands. These three do not depend on the scout.
  Take W1-T9914 first: the fleet-down class.
- W1-T9916 is `risk: high, band_meaning: span` only because Rule 19 counts the registry and the builder as two
  concerns. High risk does not gate dispatch; the other five are `risk: low`.
