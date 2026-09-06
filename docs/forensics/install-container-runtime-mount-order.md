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
