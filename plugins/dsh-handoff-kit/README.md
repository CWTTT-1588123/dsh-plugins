# dsh-handoff-kit

Deterministic **session handoff packages** for DeepSeek Harness: one tool call writes
`HANDOFF.md` + `manifest.json` + evidence, and a later session can **verify the hashes**
before trusting the claims. Host-only bundle — no UI, no Client half, no LLM, no DB,
no network, no subprocess.

## What it provides

| Surface | Name | Purpose |
|---|---|---|
| Tool | `handoff_pack` | `scan` / `create` / `verify` / `list` handoff packages |
| Command | `/handoff` | Human shortcut: create (default), scan, verify, list |
| Skill | `handoff-pack` | When and how to generate / consume a handoff package |

## Output

Default target is user level, so a package survives workspace resets:

```
$DSH_HOME/handoff/<project-key>/<batch-id>/
├── HANDOFF.md          # H0–H9 narrative, every claim tagged with its evidence class
├── SHA256SUMS          # hashes of HANDOFF.md + evidence/*
├── manifest.json       # written last; its presence = batch complete
└── evidence/
    ├── git.json        # parsed .git HEAD / refs / reflog / remote (no git status, no subprocess)
    ├── files.json      # scanned files with role, size and sha256
    ├── session.json    # this session's tool/call metadata only (never message bodies)
    └── redactions.json # secret redaction counts
```

`target=workspace` explicitly downgrades to `<workspace>/.dsh/handoff/…` (git-ignored in
the developing repository). There is **no silent fallback**: permission refusals return a
structured error with two remedies.

`copyFiles: true` additionally copies up to 20 redacted files (≤256 KiB each, ≤2 MiB total)
into `evidence/files/`.

## Requirements

- DSH `>=0.2.0 <0.3.0` (desktop profile tested on `0.2.1-rc.2`).
- `target=user` requires the session sandbox mode `danger-full-access`; in
  `workspace-write` use `target=workspace`, in `read-only` generation is refused.
- Zero runtime dependencies; the package is installed from a local directory with
  `plugin_manager install_bundle`.

## Evidence model (P0)

Because the plugin must not spawn processes, it cannot read `git status`; and the
filesystem service exposes no mtime. Evidence is therefore: parsed `.git` state
(HEAD, loose refs, `packed-refs`, reflog, remote URL), per-file sha256, and the current
session's `tool/call` metadata (paths / commands / counts, redacted and truncated;
message bodies are never mined). `HANDOFF.md` marks every assertion with
`[文件哈希]` / `[git]` / `[会话]` / `[输入]` / `[待验]`.

## Verify

```text
handoff_pack verify                       # latest batch of this project
handoff_pack verify batchId=20261022T023512Z-a1b2
```

`verify` recomputes artifact hashes, checks `SHA256SUMS`, re-hashes the source files the
manifest recorded, compares the current git HEAD, and scans the package for secret residue.
It is read-only and stable: two runs on an unchanged package differ only in `checkedAt`.

## Uninstall

```text
plugin_manager remove_bundle target: dsh-handoff-kit
```

The package directory in this repository stays untouched; packages already written under
`$DSH_HOME/handoff` remain readable.
