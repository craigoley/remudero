# Account dependency seeds

Install with Node 24.21 or newer: `bash deploy/install-dependency-seeds.sh`.
Each account owns its configuration and generations. Mac defaults to
`~/Library/Application Support/Remudero/dependencies`. On Azure choose a directory
on the worktree filesystem with `RMD_DEPENDENCY_SEED_ROOT=/mnt/scratch/remudero-dependencies/<account>`.
Keep production `/app/node_modules` in Docker image layers.

`remudero-dependencies prime /absolute/new/checkout --source /absolute/validated/donor`
creates a real node_modules directory without modifying the donor or occupied destinations.
Mac materialization uses Apple's clonefile-backed cp; Linux development materialization
links read-only external packages with private root caches and checkout-local workspace links.
`--proof` disables lifecycle scripts and gives Linux proofs independent copies.
Darwin and Linux, toolchain versions, workspace manifests, project npm options, and proof/development
policy never share a generation. Inputs are required; unreadable or escaping inputs fail closed.
Seed installs default their npm cache to `.npm-cache` inside the seed root, so
Azure's root disk and a broken account cache symlink cannot receive the downloads.
An explicit npm cache environment override is preserved. An empty
`RMD_DEPENDENCY_SEED_ROOT` disables account preferences; test setup uses this
unless a fixture supplies its own root, avoiding writes to the operator store.

Enabled worker, hand-worktree and proof paths use the provisioner. Existing checkouts are retained.
The asynchronous reviewer invokes the standalone tool in a bounded child process.
Root dependency stores carry `.rmd-dependency-seed-root.json`; generic Mac/Azure janitors retain
them and their ancestors. Install `dependency-seed-guard.sh` beside deployed janitor scripts.
The installers copy the guard before the janitor. No emergency mode reduces the six-hour floor.

`remudero-dependencies sweep` is a dry run. Generation collection also requires six idle hours,
no recorded checkout reference, no installer/collector lock, and an administrator's successful
open-file scan. Missing or unreadable evidence keeps the generation. `--apply` is explicit.
Busy locks are never stolen by age. Interrupted locks require operator investigation.

Roll out new worktrees on craigoley, then craigoleyagent, then Azure. Validate independent file
mutation, local workspace resolution, warm reuse, occupied-directory preservation, and janitor
retention before expanding. Disable future seed provisioning by setting `enabled` to false in
`~/.config/remudero/dependency-seeds.json`; existing cloned/copy checkouts remain usable.
Do not remove referenced Linux generations: their read-only package links still need them.
