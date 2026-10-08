# install-container-runtime-mount-order.sh forensics

The measured forensics, incident narrative and design arguments removed from
`deploy/install-container-runtime-mount-order.sh` when its comments were compacted to the
plain-language standard. Every block below is the removed text verbatim, marker characters
(the leading `# ` and the trailing box-drawing dashes) stripped and nothing else changed. Headings
name the step the text explained; the script keeps a one-line `Why:` pointer where the history
mattered. Base revision: origin/main at 9391ac5647ed0c337eeedffd5ff7525a5d5022f9; the line
numbers below are that revision's.

## The incident this closes

### Base lines 6-16 — THE INCIDENT THIS CLOSES. On the…

THE INCIDENT THIS CLOSES. On the 2026-09-05 Azure reboot, `docker.service` started before
`/mnt/rmd` and its bind mounts were available; Docker loaded an empty root and no Remudero
container was there to restart. A same-day emergency host edit installed matching
`containerd.service.d`/`docker.service.d` drop-ins with `RequiresMountsFor=/mnt/rmd
/var/lib/containerd`, and a later reboot proved that runtime-root ordering worked: both mounts
and containerd started before Docker. The LIVE STATE bind mount (named by RMD_STATE_DIR) was
never added to either service's dependency set. Per systemd.mount(5) (v255), a `nofail` mount is
only WANTED, never ordered before the local-filesystem target — so an auto-restarted container
can still resolve `-v "$RMD_STATE_DIR":...` against the un-mounted OS-disk directory before the
real bind mount lands. Those emergency files are also untracked machine state: a rebuilt VM or
another fleet host starts without them.

## The fix mechanism: one RequiresMountsFor row per service

### Base lines 18-23 — THE FIX IS ONE MORE `RequiresMountsFor=`…

THE FIX IS ONE MORE `RequiresMountsFor=` ROW PER SERVICE, IN THIS REPOSITORY'S OWN DROP-INS.
systemd.unit(5) (v255) says `RequiresMountsFor=` adds both `Requires=` and `After=` for every
listed path, and a unit's dependencies are the UNION of every drop-in that sets it — so this
script never touches, reads for merging, or removes either emergency (or any other
administrator) drop-in file. It writes its own two files, under its own name, and lets systemd
union them with whatever else is already there.

## Why the two services need different rows

### Base lines 25-35 — THE TWO SERVICES NEED DIFFERENT ROWS.…

THE TWO SERVICES NEED DIFFERENT ROWS.
  containerd.service requires the DATA MOUNT BACKING `/var/lib/containerd` plus
    `/var/lib/containerd` itself. The data mount is RESOLVED, not hardcoded: this script reads
    the live mount table (default /proc/mounts, override RMD_PROC_MOUNTS_FILE) for the bind
    source behind `/var/lib/containerd` (matching the documented fstab layout, "Attaching a data
    disk to the container host" in docs/operator-guide.md), then finds the real filesystem mount
    enclosing that source. containerd carries no Remudero state requirement — it never opens the
    state bind mount.
  docker.service requires the resolved Docker data root (`docker info --format
    '{{.DockerRootDir}}'`, same call as deploy/host-update.sh), `/var/lib/containerd`, AND the
    explicit Remudero state directory.

## The two operating modes

### Base lines 37-48 — TWO EXPLICIT MODES, NEITHER OF WHICH…

TWO EXPLICIT MODES, NEITHER OF WHICH TOUCHES DOCKER, CONTAINERD, OR A CONTAINER.
  (check, default) Compare EACH service's EFFECTIVE `RequiresMountsFor` (via `systemctl show`)
    against its own required paths. Writes nothing, reloads nothing, requires no privilege.
    Names the service AND every missing path for that service.
  (--install) Requires root. Validates RMD_STATE_DIR, renders BOTH drop-ins, writes each
    atomically (mktemp + same-directory rename), runs `systemctl daemon-reload` exactly ONCE,
    then re-runs the SAME two checks to prove both writes took effect. It never runs `systemctl
    start/stop/restart/reload docker.service` or `containerd.service`, and never runs a `docker`
    subcommand beyond the read-only `docker info` used to resolve the Docker root, or any
    containerd client command (`ctr`/`nerdctl`) at all. Lifecycle timing (when either runtime
    restarts, when a reboot is taken) remains the operator's decision — see
    docs/operator-guide.md.

## Why RMD_STATE_DIR has no default

### Base lines 50-56 — RMD_STATE_DIR HAS NO DEFAULT, DELIBERATELY.…

RMD_STATE_DIR HAS NO DEFAULT, DELIBERATELY. deploy/host-update.sh and deploy/recycle-container.sh
fall back to `${HOME:-/root}/rmd-state` because a missing container mount there merely warns.
Here a wrong path is silently WRONG for the rest of this host's life — reviving that default
would let an unset variable render a drop-in that "protects" a path nothing ever writes to. So
RMD_STATE_DIR must be set, absolute, must already exist, and must already be its own mount point
before ANYTHING is written — an unset, relative, absent or unmounted value is refused first, in
both modes, before the host is touched.

## resolve_data_mount's fstab example

### Base lines 126-130 — the data-disk mount BACKING /var/lib/containerd…

the data-disk mount BACKING /var/lib/containerd — the fstab shape docs/operator-guide.md
documents is `/mnt/rmd/containerd /var/lib/containerd none bind,nofail 0 0`, so the mount that
must be up before Docker or containerd can trust that path is the one enclosing the BIND
SOURCE, not the bind target itself. Falls back to the mount enclosing CONTAINERD_ROOT directly
when it is not itself a bind mount (e.g. a single-disk host).

## Comments compacted for the scratch-runtime mode (2026-10-08)

Base revision: origin/main at 2d7fa62b29367db30c314904f2193577a831e198. These blocks were
shortened to keep the script under its comment-load ceiling when `RMD_RUNTIME_ON_SCRATCH` was
added; the text below is the removed original, verbatim.

### Base lines 13-17 — TRAP and Why

TRAP: per systemd.mount(5), a `nofail` mount is only WANTED, never ordered before the
local-filesystem target — a bind mount existing does not make a service wait for it.
Why: closes the third path of the 2026-09-05 Azure reboot defect (W1-T2856, PR #4021); full
incident in docs/forensics/install-container-runtime-mount-order.md.

### Base lines 22-26 — TEST SEAMS

TEST SEAMS (production defaults shown; a real host never sets these)
  RMD_DOCKER_DROPIN_DIR     default /etc/systemd/system/docker.service.d
  RMD_CONTAINERD_DROPIN_DIR default /etc/systemd/system/containerd.service.d
  RMD_CONTAINERD_ROOT       default /var/lib/containerd
  RMD_PROC_MOUNTS_FILE      default /proc/mounts

### Base lines 88-90 — resolve_data_mount

the mount BACKING /var/lib/containerd (the fstab shape docs/operator-guide.md documents),
not the bind target itself — the bind source's own enclosing mount is what must be up first.
Falls back to the mount enclosing CONTAINERD_ROOT directly when it is not itself a bind mount.

## Moving both runtime roots to /mnt/scratch (RMD_RUNTIME_ON_SCRATCH=1, 2026-10-08)

The operator approved moving Docker's data-root and containerd's root from the IOPS-capped data
disk (`/mnt/rmd`) to the ephemeral local NVMe (`/mnt/scratch`) on 2026-10-08. The operator
procedure is in docs/operator-guide.md, "Container runtimes on the scratch NVMe".

### The trap

`/mnt/scratch` is not in fstab. `rmd-scratch.service` (`After=local-fs.target`) formats the disk if
it is blank, then mounts it, and exits 0 with the disk UNMOUNTED when that fails. An fstab line
`/mnt/scratch/containerd /var/lib/containerd none bind,nofail 0 0` runs during local-fs, BEFORE
`rmd-scratch.service`, so it would bind an empty directory on the 29 GB OS disk, and containerd
would then pull every image onto `/`. The script therefore refuses to install while any active
fstab line still mounts `/var/lib/containerd`, prints that line, and never edits fstab itself.

### Why a mount unit, and why fstab must lose its line

systemd.mount(5): when a mount point is configured in both fstab and a unit file, the unit file
wins. The fstab generator writes into the generator directory, which sorts after
`/etc/systemd/system`. That precedence is not enough on its own. The generator still adds its
`local-fs.target` dependency, and `mount -a` or `mount /var/lib/containerd` would still read the
fstab line and bind the OLD root over the new one. One source of truth means the fstab line goes.

### The unit's choices

- `Requires=` and `After=rmd-scratch.service` order the bind after the script that mounts the disk.
- `AssertPathIsMountPoint=/mnt/scratch`, not `ConditionPathIsMountPoint=`. A failed Condition only
  SKIPS the unit; containerd, which requires it through `RequiresMountsFor=/var/lib/containerd`,
  would start anyway on the bare directory. A failed Assert fails the start job, and containerd
  fails with it.
- `DefaultDependencies=no`, plus an explicit `Conflicts=` and `Before=umount.target`. A local mount
  unit's default dependencies add `Before=local-fs.target`. With `After=rmd-scratch.service`, which
  is itself `After=local-fs.target`, that is an ordering cycle, and systemd would break it by
  deleting a job.
- The bind source must exist, and a deallocate wipes the disk. A drop-in on `rmd-scratch.service`
  (`ExecStartPost`) re-creates `/mnt/scratch/containerd` (mode 0711) when the disk is mounted. This
  needs `Type=oneshot`, so that `After=` waits for `ExecStartPost` to finish. Install refuses any
  other Type. Docker creates its own data-root.

### The guards

`15-remudero-scratch-runtime.conf` in both `docker.service.d` and `containerd.service.d` holds one
`ExecStartPre=` that exits 1 unless `/mnt/scratch` is a mount point. containerd's guard also
requires `/var/lib/containerd` to be one. Drop-ins apply in filename order, so the guard runs
before `20-`'s `rmd-scratch-mounts --restore`, which would otherwise `mkdir` on `/`. The guards
sit in their own files so that the rollback deletes them without re-rendering the `20-` files.

### Why daemon.json is not rewritten

`/etc/docker/daemon.json` belongs to Docker, and an operator may add keys to it. If the script
rewrote it, the change would be hidden, and the rollback would have to remember to undo it. So
install READS `data-root`, refuses unless it equals `/mnt/scratch/docker`, and prints the exact
value to set. The operator makes that edit (with a backup) and restores it on rollback, as with
fstab. Scratch install also never calls `docker info`: Docker is stopped during the window, and
the root it would report is the old one.

### What check mode proves

Static (install and check): no active fstab bind; daemon.json `data-root`; the mount unit's
`What=` and `FragmentPath` (the unit file, not fstab); both services' effective `ExecStartPre`
contain the guard; `rmd-scratch.service` is `Type=oneshot` and its `ExecStartPost` re-creates the
source. Live (check only): `ActiveState=active`, and `/proc/self/mountinfo` shows
`/var/lib/containerd` on the SAME device as `/mnt/scratch` with fs-root `/containerd`. `/proc/mounts`
cannot answer that, because it shows a bind mount's DEVICE rather than its source directory. Last,
`docker info` must report `DockerRootDir=/mnt/scratch/docker`.
