# dsh-handoff-kit

<!-- docs-meta: status=current; phase=P2; verified=dd91f73@2026-10-23; tracks=plugins/dsh-handoff-kit/src,plugins/dsh-handoff-kit/client.js,plugins/dsh-handoff-kit/index.js,plugins/dsh-handoff-kit/package.json; supersedes=-; superseded-by=- -->

Deterministic **session handoff packages** for DeepSeek Harness: one tool call writes
`HANDOFF.md` + `manifest.json` + evidence, and a later session can **verify the hashes**
before trusting the claims. Host half (tools/command/skill/service) plus a **prompt-first
Client half** (0.3.0/P2) that puts generation/loading on a clickable workbench. No LLM, no DB,
no external network, no subprocess.

**标准交接流程（中文使用说明）**：[USAGE.md](USAGE.md) — 旧会话生成 → 新会话只粘贴提示词 →
旁证只读复核 → 新会话收到明确指令后再开工。**粘贴即安全，无需额外保险操作。**
**Usage (English)**：[USAGE.en.md](USAGE.en.md) — the same standard four-step flow in English.

## What it provides

| Surface | Name | Purpose |
|---|---|---|
| Tool | `handoff_pack` | `scan` / `create` / `verify` / `list` / `append` / `update` / `migrate` handoff packages |
| Tool | `handoff_load` | Read-only consumption: verify + trust verdict + drift + pointers (P1/M1) |
| Command | `/handoff` | Human shortcut: create (default), append, update, scan, verify, list, migrate, resume |
| Skill | `handoff-pack` | When and how to generate / consume a handoff package |
| UI (P2) | 「交接」按钮 / 浮层面板 / 工作台 | 生成、载入、复制新会话开场提示词、继续交接（同包 Client half + 宿主 `/api` RPC） |

## UI workbench (P2, 0.3.0; prompt safety gate 0.3.1)

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

**1.0.0-rc UI additions (P3/M4).** Since `1.0.0-rc.1` the workbench is **English-first with a
manual switch**: UI copy lives in the embedded EN/ZH tables and `locale/en.json` + `locale/zh.json`
(kept in sync by tests). Language resolution is explicit preference
(`localStorage: dsh.handoff-kit.locale`) → `navigator.languages/language` (`zh*` → Chinese) →
page `document.lang` → English, and a **中文 / English toggle** in the workbench header and the
floating panel switches instantly without a reload. The workbench header also shows an explicit
**project / session** line — the Host-resolved project, workspace and session id, a live/fallback
badge, and a session selector that pins a session (known sessions recorded by the 「交接」 button);
fallbacks are surfaced instead of silently choosing a root session (P2-G1).

**Project identity changes.** The project key prefers the git remote URL, so adding or changing a
remote changes the key. When the current key has no batches, the workbench lists batches from
historical project keys **with the same workspace slug** in a read-only group with a banner, and an
explicit `batchId` load/verify falls back read-only to a unique same-slug key with a
`PROJECT_KEY_FALLBACK` warning. Unrelated projects on the same handoff root are never mixed in.
Writes always use the current key; history is never rewritten.

Data flow: the Client half calls this bundle's Host half through one authenticated same-origin
JSON route, `POST /api/handoff-kit/rpc` (registered on `ctx.connection.fetch`). The route only
validates arguments (`validateToolArgs`/`validateLoadArgs`) and adapts the **existing**
`service.run()`/`service.load()`; manifest parsing/verification stays in `src/manifest.js`.
A persistent (non-dynamic) bundle has **no `host.call`** — that builtin belongs to dynamic
Cordis packages only (verified during U0). UI rules: read-only actions never write; write
actions only run on an explicit click and show the target directory; no network beyond that
same-origin `/api` route; no subprocess; no LLM call.

**Opening-prompt safety gate (0.3.1).** A handoff prompt is context, not a work order. After a
real incident where a freshly started agent read the old wording as permission to continue the
previous work and started editing files, the rendered prompt now opens with a mandatory
boundary: verify read-only first (第 0 步: `handoff_load batchId=<id>`), report the verdict, and
**wait for the user's explicit instruction before modifying/creating/deleting any file or
starting the next phase**. Non-`verified` verdicts must be reported and stop the session rather
than be self-repaired. The UI generation/copy flow renders this prompt unchanged.

Known P2 limitations (full list in `docs/handoff-kit/GAPS.md`): the workbench is root-scoped, so
without a session hint the Host falls back to the newest live root session (click 「交接」 once to
pin the current session); lineage is shown inside H0/create results rather than a separate list
column; no delete/archive UI; Chinese-only copy.

## CLI (P3/M3)

The package also ships a **zero-dependency CLI** (`bin/handoff-kit.mjs`, binary `handoff-kit`)
that runs **outside** DeepSeek Harness — for other agents, scripts and CI, no DSH install needed:

```text
handoff-kit verify  <batchDir> [--workspace <dir>] [--json]
handoff-kit load    <batchDir> [--workspace <dir>] [--sections|--full] [--json]
handoff-kit list    --root <handoffRoot> [--json]
handoff-kit migrate <batchDir> --out <newBatchDir> [--workspace <dir>] [--json]
```

- no network, no subprocess, Node >= 20; reuses the same manifest/verification/redaction modules
  as the plugin (no second implementation of the format);
- exit codes: `0` verified/ok, `3` stale, `1` invalid, `2` usage/IO error (frozen in
  [`spec/verify.md`](spec/verify.md) §4);
- `--workspace <dir>` enables git/source drift checks; without it the verifier states that drift
  was not checked instead of assuming it clean;
- `migrate --out` must point at a new/empty directory whose basename is a batch id
  (`YYYYMMDDTHHmmssZ-xxxx`); the source batch is never modified.

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

## Schema migration (P3/M2)

`migrate` upgrades a legacy `schemaVersion 1` batch to `schemaVersion 2` by writing a **new**
batch; the source batch stays read-only and byte-identical:

```text
handoff_pack action=migrate batchId=<v1-batch>     # tool
/handoff migrate <v1-batch>                        # command shortcut
```

- the source must verify without errors (`HANDOFF_MIGRATION_SOURCE_INVALID` otherwise): a package
  that cannot be trusted is never laundered into a "new" one;
- only v1 -> v2 is supported (`HANDOFF_MIGRATION_UNSUPPORTED_VERSION` for already-v2 batches);
- `evidence/migration.json` records the source batch id, source `SHA256SUMS` digest, source
  generator, migration timestamp and tool identity; it is listed in `manifest.artifacts` /
  `SHA256SUMS` like every other artifact;
- v2-only evidence the original session never captured (`changes` / `fuel`) is recorded as
  `available:false` with a `MIGRATED_FROM_V1` warning — never invented;
- no `lineage` is created: migration is a format upgrade, not a continuation (use `append` for
  continuation).

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
