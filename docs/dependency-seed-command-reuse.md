# Reuse a dependency generation after command edits

An edited build command changes the complete dependency generation identity even
when the dependency inputs stay fixed. The explicit reuse path publishes a new
generation for the new identity without running an installation:

```sh
node scripts/dependency-seeds.mjs prime "$PWD" --proof \
  --root "/absolute/account/dependencies" \
  --reuse-seed "/absolute/account/dependencies/<existing-generation-key>"
```

If the target generation already exists, normal exact-identity reuse applies.
Otherwise the source must be a real account-owned generation in a managed
store. Its bounded, descriptor-read readiness metadata must agree with the
physical input files and the current Node, ABI, npm, platform, architecture,
proof policy and dependency-related npm environment. Lock and workspace inputs
must remain byte-identical. All root package fields except command scripts must
remain equal. Root installation lifecycle scripts make this path ineligible.

The source generation gets a second nonblocking GC/installer lock. A foreign
lock is preserved and the request refuses. Invalid source input never triggers
an installation fallback. The target retains its complete new identity and
records `reusedFrom` provenance. Workspace links resolve to the consuming
checkout. Source payloads and readiness metadata are preserved.

Darwin uses the existing force-only APFS clone primitive, with independent
inodes; an unsupported clone refuses. Linux retains the existing proof/private
copy or development/read-only-link policy. This feature does not change normal
installation permissions, GC's six-hour rule, active consumer protection,
resource admission or required assurance. Metadata compatibility is not a full
package byte attestation or permission to replay tests from another head.

## Existing-input proof mode

For isolated proof validation, explicitly set `RMD_DEPENDENCY_SEED_ROOT` and
`RMD_PROOF_DEPENDENCY_SEED` to an owned store and an already verified generation.
Fresh proof checkouts reuse that generation with `--read-only-links`; this
consumer uses package links on Darwin too, while its local workspace links point
to the code in the proof checkout. The generation keeps its actual development
identity and the consumer records its actual materialization method.

An explicit source refuses invalid identities, incompatible inputs and missing
generations. It never falls back to installation or toolchain refresh. A failed
provisioning attempt remains failed on later calls in the same process. This
mode does not change the default installation path, admission or assurance gates.

The standalone `prime --reuse-seed GENERATION --read-only-links` command also
requires an explicit managed generation. It makes no new package installation
permission implicit. Read-only links protect against writes by sandboxed proofs;
they are not a replacement for the proof sandbox or generation byte attestation.

## Basis

- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) replaces an existing
  `node_modules` tree and requires matching package and lock declarations.
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/)
  describe installation hooks; those roots remain ineligible here.
- [Apple File System](https://developer.apple.com/documentation/foundation/about-apple-file-system)
  supports clones sharing unchanged blocks on the same volume. Physical unique
  allocation and eventual reclaim require separate measurements.
