#!/bin/bash
# Seed stores have their own reference-aware six-hour collector. Generic sweeps retain them.
rmd_dependency_seed_risk() {
  local path="$1" parent found status
  case "$path" in /*) ;; *) path="$(pwd -P)/${path#./}" ;; esac
  parent="$path"
  [ -d "$parent" ] || parent="${parent%/*}"
  while [ -n "$parent" ] && [ "$parent" != / ]; do
    if [ -f "$parent/.rmd-dependency-seed-root.json" ]; then
      echo 'dependency seed store; reference-aware GC required'; return 0
    fi
    parent="${parent%/*}"
  done
  [ -d "$path" ] || return 1
  found=$(find "$path" -xdev \( -name node_modules -o -name .git \) -prune -o -name .rmd-dependency-seed-root.json -print -quit 2>&1); status=$?
  if [ "$status" -ne 0 ]; then echo 'dependency seed scan unavailable'; return 0; fi
  if [ -n "$found" ]; then echo 'contains dependency seed store; reference-aware GC required'; return 0; fi
  return 1
}
