# dsh-handoff-kit

<!-- docs-meta: status=current; phase=P2; verified=42fdf57@2026-10-22; tracks=plugins/dsh-handoff-kit/src,plugins/dsh-handoff-kit/client.js,plugins/dsh-handoff-kit/index.js,plugins/dsh-handoff-kit/package.json; supersedes=-; superseded-by=- -->

Deterministic **session handoff packages** for DeepSeek Harness: one tool call writes
`HANDOFF.md` + `manifest.json` + evidence, and a later session can **verify the hashes**
before trusting the claims. Host half (tools/command/skill/service) plus a **prompt-first
Client half** (0.3.0/P2) that puts generation/loading on a clickable workbench. No LLM, no DB,
no external network, no subprocess.

## What it provides

| Surface | Name | Purpose |
|---|---|---|
| Tool | `handoff_pack` | `scan` / `create` / `verify` / `list` / `append` / `update` handoff packages |
| Tool | `handoff_load` | Read-only consumption: verify + trust verdict + drift + pointers (P1/M1) |
| Command | `/handoff` | Human shortcut: create (default), append, update, scan, verify, list, resume |
| Skill | `handoff-pack` | When and how to generate / consume a handoff package |
| UI (P2) | 「交接」按钮 / 浮层面板 / 工作台 | 生成、载入、复制新会话开场提示词、继续交接（同包 Client half + 宿主 `/api` RPC） |

## UI workbench (P2, 0.3.0)

The same bundle also ships a plain-JS Client half (`client.js`, no build step). It registers:

- a **「交接」 button** at the left of the conversation composer (`conversation.input.left`);
- a **floating panel** with two tabs (`shell.overlay`): **生成** — title (pre-filled from the
  current session title) / note (→ H1 `summary`) / target `user|workspace` with the target root
  shown **before** the click / optional session diff; the result shows `batchId`, the real
  directory, evidence count, warnings and lineage, plus **复制开场提示词** (opening prompt with a
  `trust=` badge and a manual-copy textarea);
  **载入** — batch list → verify/drift/findings detail → **复制开场提示词** / **插入输入框**;
- a **sidebar panel icon** and a central **交接工作台** page (`sidebar.panellist` ↔ `main` key):
  left batch list + right detail, with 刷新 / 校验 / 生成 / 继续交接 (append by default, update
  requires a second confirmation; history is never rewritten) and 返回对话.

Data flow: the Client half calls this bundle's Host half through one authenticated same-origin
JSON route, `POST /api/handoff-kit/rpc` (registered on `ctx.connection.fetch`). The route only
validates arguments (`validateToolArgs`/`validateLoadArgs`) and adapts the **existing**
`service.run()`/`service.load()`; manifest parsing/verification stays in `src/manifest.js`.
A persistent (non-dynamic) bundle has **no `host.call`** — that builtin belongs to dynamic
Cordis packages only (verified during U0). UI rules: read-only actions never write; write
actions only run on an explicit click and show the target directory; no network beyond that
same-origin `/api` route; no subprocess; no LLM call.

Known P2 limitations (full list in `docs/handoff-kit/GAPS.md`): the workbench is root-scoped, so
without a session hint the Host falls back to the newest live root session (click 「交接」 once to
pin the current session); lineage is shown inside H0/create results rather than a separate list
column; no delete/archive UI; Chinese-only copy.

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
- The UI workbench needs the Web composition (the Desktop profile provides it). In a
  host-only profile the bundle still registers its tools/command/skill; the Client half and
  the `/api/handoff-kit/rpc` route are simply absent.

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
  when the current turn is still open, `changes.currentTurn` adds its file-tool paths/counts from
  `tool/call` metadata (no line counts) and H1/H4 render that supplement;
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

## Development

```powershell
cd plugins/dsh-handoff-kit
npm test        # node --test "test/**/*.test.js" (Node 24 does not expand a directory argument)
```

Batch cleanup is manual because the harness filesystem has no delete primitive: move obsolete
`$DSH_HOME/handoff/<project>/<batch>` directories out of the handoff root (the plugin never deletes
history). `docs/handoff-kit/GAPS.md` is the single ledger for gaps and boundaries.
