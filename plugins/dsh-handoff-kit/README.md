# dsh-handoff-kit

Deterministic **session handoff packages** for DeepSeek Harness: one tool call writes
`HANDOFF.md` + `manifest.json` + evidence, and a later session can **verify the hashes**
before trusting the claims. Host-only bundle — no UI, no Client half, no LLM, no DB,
no network, no subprocess.

## What it provides

| Surface | Name | Purpose |
|---|---|---|
| Tool | `handoff_pack` | `scan` / `create` / `verify` / `list` / `append` / `update` handoff packages |
| Tool | `handoff_load` | Read-only consumption: verify + trust verdict + drift + pointers (P1/M1) |
| Command | `/handoff` | Human shortcut: create (default), append, update, scan, verify, list, resume |
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

## Continuous handoffs (P1/M2)

`append` and `update` both write a **new** batch and record lineage; history is never rewritten:

```text
handoff_pack action=append previousBatchId=<id>   # continuation (default: latest batch)
handoff_pack action=update supersedes=<id>        # replacement statement (default: latest batch)
```

`manifest.lineage = {sequence, previous, root, supersedes?}`; `verify` reports `LINEAGE_BROKEN`
(previous batch missing/unreadable) and `SUPERSEDED_BATCH` (warn only — the old batch stays valid
history). `create/append/update` also capture read-only P1 evidence when available:

- `manifest.changes` — host `workspaceChanges` for the latest **completed** turn
  (`{available, source, turn, totals, files[], diffs?}`; `includeDiffs=true` adds bounded hunks);
- `manifest.fuel` — current goal and session-owned background jobs (read-only, never auto-executes);

Both degrade to `available:false` + warning when the service/data is missing. `manifest.schemaVersion`
becomes `2`; v1 manifests remain readable/verifiable.

## Consume (P1/M1)

A new session should check a package before trusting it:

```text
handoff_load                                # latest batch of this project (verifies first)
handoff_load batchId=20261022T053805Z-89b2 include=sections
handoff_load verifyFirst=false              # skip checks; trust can only be stale
```

`handoff_load` is read-only. It returns:

- `trust`: `verified` (hashes + source files + git HEAD all consistent) / `stale` (warnings or
  drift found) / `invalid` (verification errors — do not trust);
- `verification.findings` + `drift` (same checks as `handoff_pack verify`);
- pointers to `HANDOFF.md`, `manifest.json`, `SHA256SUMS`, `evidence/session.json`, and
  optionally bounded excerpts (`include=sections|full` — summary is the default to save context).

Human shortcut: `/handoff resume [<batchId>]` prints the same verdict in Chinese.

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
