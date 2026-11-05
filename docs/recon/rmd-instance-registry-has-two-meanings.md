# `RMD_INSTANCE_REGISTRY` has two meanings

**Snapshot:** `origin/main` at `1b559f062255646abe5d8d28e16033eb3903b3b4` (2026-11-05). This is a source inventory, not proof of the environment loaded by any running container. The deployment task must read each target container and generated unit before claiming adoption.

## Finding

The same variable is both a path to the host-wide instance catalog and an explicit active-instance selection. The first contract enumerates instances or state roots; the second binds one trusted invocation to a selected registry file, instance name, digest, and file identity. Treating the path as the target identity is unsafe: a reader can silently observe the wrong catalog, while a selected consumer must refuse when its named instance is absent or the bytes changed.

The source already has a useful absence distinction: an *unset* selected path is `legacy`; a *present but invalid/unreadable/missing* selected path is unknown/refused and does not fall back. Preserve that distinction during migration.

## Reader inventory

| File and lines | Meaning at this read | Behavior when the requested instance is absent |
|---|---|---|
| `deploy/field-trials-refresh.sh:41,47,52-67` | Legacy catalog path; enumerates `core`, `site`, and `console` state roots. | It does not select one instance. Missing/unreadable catalog exits 2; a catalog missing any required root produces “missing absolute state directory” and exits 2. |
| `deploy/host-update.sh:605,624-627,677-705` | Legacy catalog path; lists every state root for disk checks and relocation. | Missing/unreadable catalog exits 2; zero catalog entries exits 1; a named relocation target absent from the catalog refuses with exit 2. |
| `deploy/install-host-units.sh:209,214-227,802,1194,1365` | Reads the catalog to install one named instance; generated watchdog/relaunch units pass the same value onward. | Missing/unreadable catalog or missing named row is fatal (exit 2). A generated relaunch can then pass the value to `recycle-container.sh`, where the same variable is treated as selected input. |
| `scripts/fleet-heartbeat.sh:1006-1008,1019-1044` | Legacy catalog path; maps running container names to state roots for memory/tuner observations. | A missing row yields no mapped root; the code falls back to `RMD_ROOT` for the tuner file/ledger lookup. The heartbeat continues, so the observation can be unavailable or attributed to the default root rather than failing closed. |
| `deploy/recycle-container.sh:11-18,34-67,641-652,731-739` | Selected binding when the variable is present; otherwise the legacy local default and unscoped behavior apply. | Present-but-empty selection, missing instance name, bad digest, unreadable/invalid registry, missing/non-live/mismatched target all refuse (exit 2); they do not fall back. With the variable absent, an unscoped legacy recycle is preserved only when the default catalog is absent/empty or an explicit state root names the target. |
| `deploy/serve-container.sh:156,262-270,272-304` | Selected binding when present; otherwise reads the legacy default catalog. | A present selected path with no instance name refuses. Missing/unreadable file, missing row, or missing required `repo`, `state_dir`, `container_name`, or `image` refuses. Without the variable, a named instance is still required to be present in the default catalog. |
| `src/lib/instance-registry-selection.ts:17,303-320,329-333,348-355` | Active selected path, with optional digest and physical file binding. | Unset input returns `legacy`. Explicit missing/unreadable/malformed/changed bytes remain `unknown` or `refused`; runtime launch packets require one live matching row and reject a missing or mismatched target. No legacy fallback after an explicit selection fails. |
| `src/cli/commands/daemon.ts:651-652,2103-2107` | Runtime-presence guard and selected path (or checkout-local default). | An explicit selection without an established runtime is rejected; target resolution uses the active binding and can return missing/unqualified rather than selecting a different instance. |
| `src/cli/commands/run-task-verb.ts:4441,5095,5398` | Guards runtime context, captures selected intent, and passes the environment path plus `RMD_INSTANCE_NAME` into target resolution. | An explicit but unavailable selection refuses/records unknown; it does not silently choose a different registry. |
| `src/run-task.ts:1890,28542,28570,29551,33541,33633,38672,38680,43041` | CLI dispatch, pause/resume, sweep/reload and explicit-selection checks. Some reads distinguish “variable was set” from the local default. | Selected target resolution must be present in the bound registry; an explicit unresolved selection is refused. The unset case continues through the existing local/default path. |
| `src/lib/sweep.ts:2655` | Captures the selected-registry intent and instance name for sweep/admission. | Missing/unreadable/stale selection is unknown or refused, not permission to infer another instance. |
| `src/lib/sre-lane.ts:453` | Resolves registry path for SRE target/state-root attribution, defaulting to the checkout-local registry when unset. | If no matching row can be established, target identity is not proven; callers must keep the outcome unknown rather than attribute to another instance. |
| `deploy/registry-shadow.sh:83-100` | Forwards the caller's variable to the shadow observer; it does not select a runtime target itself. | The observer records its own absent/unknown state; this forwarding path cannot grant selection. |
| `src/selected-registry-shadow-main.ts:103-119` | Shadow-session capture reads the selected input and records ready, absent/legacy, or unknown. | Observation only: absent/unreadable input does not activate a target. |
| `src/lib/config-schema.ts:507-509` | Documentation/metadata for the path, digest, and file-binding variables; not a runtime file read. | No selection occurs here. The description currently says the same path is used by pause/resume and deploy shell readers, which hides the split in meaning. |

### Trusted forwarding and privacy guards (not additional registry readers)

- `src/lib/deployer.ts:2718-2719,2915` and `src/lib/serve-policy-convergence.ts:429` forward the selected path, instance, digest, and launch binding into trusted shell/container launches. `src/lib/selected-registry-consumers.ts:51-53` defines the trusted child wrapper that exports the selected path, digest, and launch binding before executing the shell child.
- `deploy/install-host-units.sh:802,1155,1365` renders that value into generated relaunch code; these are part of the boundary even though the generated code reads it later.
- `src/lib/worker.ts:3230` removes `RMD_INSTANCE_REGISTRY` from the model-worker environment. `src/lib/worker-provider.ts:2807` has an environment filter that mentions the key. Any new selected-variable prefix must receive the same privacy treatment and tests.
- `deploy/recycle-container.sh:1253` recognizes registry binding keys in its secret/private-output filter; update that classification for any new variable.

## Recommendation

Split the names while preserving the old input as a compatibility alias:

- Keep `RMD_INSTANCE_REGISTRY` as the legacy catalog-path input for heartbeat, host-update, and installer enumeration.
- Add `RMD_SELECTED_INSTANCE_REGISTRY` as the explicit active selection path for daemon/CLI, serve, recycle, deploy-run, and trusted child launches.
- During transition, selected readers prefer `RMD_SELECTED_INSTANCE_REGISTRY` when present; if it is absent, they accept the old `RMD_INSTANCE_REGISTRY` alias for existing launchers. If the new variable is present but invalid, refuse; never fall back to the old path. When a launcher supplies both, legacy readers consume the old catalog variable and selected readers consume the new one. They may initially point at the same bytes, but their meanings stay distinct.
- Continue binding the selected path to the instance name, digest, and physical file identity. Never expose either private path or raw registry bytes in public telemetry, logs, worker prompts, or untrusted process environments.

This keeps old-only launchers working while allowing the new contract to be explicit. A new launcher must not stop emitting the old variable until every legacy reader is migrated or has an explicit independent catalog path.

## Safe rollout order

1. Add the new name and compatibility resolver to source readers and schema. Test unset/old-only/new-only/both-set cases, explicit invalid and missing targets, changed bytes/file identity, worker redaction, and exact no-option legacy shell output. No service configuration changes in this phase.
2. Update trusted launchers and generated units to carry both names separately. Preserve the old catalog path for heartbeat/host-update/installer; carry the selected path plus instance/digest/file binding only to selected runtime children. Keep all effects in shadow mode.
3. Merge source through normal hosted checks and automated review. Read back each generated unit and each target container's environment/mount/digest; verify the process actually loaded the reviewed source. A merged PR or image build alone is not adoption evidence.
4. Observe a bounded canary with selected binding absent and present, including old/new version combinations. Any missing, unreadable, stale, or identity-mismatched input stays unknown/refused. Do not infer health from missing rows.
5. Keep private configuration uninstalled and unselected until the separate live-cutover approval. Before cutover, identify exact targets, rollback bytes/path, current owners, and the normal graceful rollout mechanism. Request approval for that exact rollout; no worker stop or restart is implied by this report.

## Operator decision

The operator approved this exact backwards-compatible split on 2026-11-04:

- Reserve `RMD_INSTANCE_REGISTRY` for the legacy catalog path.
- Add `RMD_SELECTED_INSTANCE_REGISTRY` for explicit active selection.
- Selected readers accept the old variable only when the new variable is absent. If the new variable is present but invalid, fail closed; do not fall back.

The source inventory and this decision authorize follow-on source work through normal task scope, validation, review and merge. They do not select the private registry, alter defaults, install configuration, restart any service, release an image/recycle hold, or authorize live cutover.
