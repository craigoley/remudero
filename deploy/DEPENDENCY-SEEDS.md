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

Enabled asynchronous worker creation, hand-worktree and proof priming use the provisioner.
Existing checkouts are retained. Worker and asynchronous reviewer provisioning invoke the
standalone tool in a bounded child process, leaving the daemon's event loop available.
Legacy synchronous worktree and semantic-snapshot creation retain their dependency linking;
they do not perform a new seed install on the daemon loop.
Root dependency stores carry `.rmd-dependency-seed-root.json`; generic Mac/Azure janitors retain
them and their ancestors. Install `dependency-seed-guard.sh` beside deployed janitor scripts.
The installers copy the guard before the janitor. No emergency mode reduces the six-hour floor.

`remudero-dependencies sweep` is a dry run. Generation collection also requires six idle hours,
no recorded checkout reference, no installer/collector lock, and a successful open-file scan by
an administrator, or on macOS by the owner when the store is inside a home no other account can
enter (mode and ACL). Missing or unreadable evidence keeps the generation. `--apply` is explicit;
the Mac janitor passes it on every apply pass. A root that is URL-encoded (`%20` for a space) is
refused: on 2026-10-22 one wrote a 506 MiB store to `Library/Application%20Support` that no sweep
saw. The Mac janitor also sweeps that exact stray root when it holds a seed store marker.

An account whose home others can enter (on this host `craigoleyagent`, whose home is
group-readable so another account's clones can borrow its objects) cannot prove with its own lsof
that no other account holds a seed file open, and running its sweeper as root would run
account-owned code as root. Instead, `sudo bash deploy/mac/install-seed-open-files.sh STORE...`
installs a root-owned launchd job (`com.remudero.seed-open-files`, every 5 minutes) that runs only
the root-owned `seed-open-files.py`: one `lsof +D` per named store, written as JSON under
`/Library/Application Support/Remudero/open-files`. The account's sweeper accepts that scan in place
of an administrator scan only when the file and every folder above it are root-owned and writable
by root alone, the scan names the generation's store, and it is under 15 minutes old. Otherwise
the generation is kept as before. Names compare case-insensitively, as APFS does here.
Consumer records bind the mount namespace too: a host collector must not mistake
a container's invisible checkout paths for deleted checkouts. Foreign namespaces are retained
for operator review, and so are older records without namespace evidence, except on macOS for
a checkout under `/Users`, `/private`, `/var/folders` or `/tmp`: the host owns those paths and
a bind mount keeps them, so the host reads the checkout's marker directly.
Busy locks are never stolen by age. Interrupted locks require operator investigation.

Roll out new worktrees on craigoley, then craigoleyagent, then Azure. Validate independent file
mutation, local workspace resolution, warm reuse, occupied-directory preservation, and janitor
retention before expanding. Disable future seed provisioning by setting `enabled` to false in
`~/.config/remudero/dependency-seeds.json`; existing cloned/copy checkouts remain usable.
Do not remove referenced Linux generations: their read-only package links still need them.
