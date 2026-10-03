# Draft plan shards from the Opus 5.5 prompting-guide audit (2026-10-03)

NOT part of the plan: this directory is outside `plan/tasks.d`, so nothing loads it.

Twelve shard drafts, pre-linted with `rmd lint-plan --base origin/main --merge-base` (0 failing; one advisory
duplicate-surface warning on W1-T9901 against the parked W1-T7B). Their ids `W1-T9900`..`W1-T9911` are
PLACEHOLDERS, never claimed. To file them: reserve twelve real ids from the operator checkout
(`rmd next-task-id --branch <file/...>`, twelve times), replace each placeholder id throughout (filenames,
`id:`, and every `test("W1-T99xx: ...` proof title, which must stay byte-identical to its test title),
move the shards to `plan/tasks.d/`, and lint again.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
