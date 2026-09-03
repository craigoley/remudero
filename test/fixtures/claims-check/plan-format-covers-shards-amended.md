# Fixture (W1-T2640): a synthetic §2-shaped fragment carrying the AMENDED wording -- the sharded
# filing home, the monolith-append refusal, and the loadPlan merge/duplicate-id rule all present.
# Mirrors plan/claims.yaml's `plan-format-covers-shards` assertion, pointed at this fixture instead
# of the real MASTER-PLAN.md so the falsifier below never has to mutate a real plan file.

## 2. Plan format & contracts

A task record lives in plan/tasks.yaml or in its own plan/tasks.d/<id>-<kebab-slug>.yaml shard.
NEVER append a new task to plan/tasks.yaml: new tasks belong in their own shard.
loadPlan merges both surfaces into one view and throws duplicate task id across them.
