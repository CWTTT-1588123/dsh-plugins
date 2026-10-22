# Handoff Package Specification (HANDOFF.md + manifest.json + evidence)

<!-- docs-meta: status=current; phase=P3; verified=a57385a@2026-10-23; tracks=plugins/dsh-handoff-kit/src; supersedes=-; superseded-by=- -->

> Status: **1.0 draft (P3/M1, 2026-10-23)** — normative for generated batches; frozen at 1.0.
> Implemented by `dsh-handoff-kit` (plugin version 0.3.1 at spec start). Machine-readable companion: [`../schema/manifest.v1.json`](../schema/manifest.v1.json), [`../schema/manifest.v2.json`](../schema/manifest.v2.json); verification algorithm: [`verify.md`](verify.md).
> Audience: any agent, CLI, or tool that writes or consumes handoff packages — DeepSeek Harness is **not** required to read a package.
> License: MIT.

## 1. Purpose and scope

A **handoff package** is a deterministic, self-describing snapshot of one work session that a later session (or another agent/tool) can verify before trusting. A package has three layers:

1. **Narrative layer** — `HANDOFF.md`, human/agent-readable H0–H9 sections, every claim tagged with its evidence class.
2. **Machine layer** — `manifest.json` (authoritative record), `SHA256SUMS` (artifact digests), `evidence/*.json` (raw evidence snapshots).
3. **Verification layer** — the algorithm in [`verify.md`](verify.md), which recomputes hashes and reports a `trust` verdict.

The generator never invents facts. Values the caller did not provide are rendered as explicit missing markers (§7.3).

**Out of scope for 1.0:** session replay, long-term memory, remote sync, secret storage, automatic execution of next steps, and any network access. Packages are written by an explicit user action only.

## 2. Terminology

| Term | Meaning |
|---|---|
| **workspace** | Root directory of the project the package describes. |
| **project key** | Stable id: `<slug(basename(workspace))>-<sha256(seed)[:8]>`; seed is the git remote URL when present, else the canonical workspace path. |
| **batch id** | `YYYYMMDDTHHmmssZ-xxxx` (UTC timestamp + 4 lower-case hex). Fixed width, so lexical order equals time order. |
| **batch** | One directory `$DSH_HOME/handoff/<project-key>/<batch-id>/` (default) or `<workspace>/.dsh/handoff/<project-key>/<batch-id>/` (`target=workspace`). |
| **artifact** | Any file inside the batch that appears in `manifest.artifacts` and in `SHA256SUMS` (HANDOFF.md, evidence files, optional copies, SHA256SUMS). `manifest.json` is **not** an artifact. |
| **evidence file** | `evidence/git.json`, `evidence/files.json`, `evidence/session.json`, `evidence/redactions.json` (plus `evidence/migration.json` added by the migration tool, and optional `evidence/files/**` copies). |
| **tokenized path** | Absolute path rewritten as `$WORKSPACE/...` or `$DSH_HOME/...`; native Windows absolute paths must not appear in tokenized fields. |

## 3. Batch directory layout

```text
<batch-dir>/
├── HANDOFF.md              # H0–H9 narrative + 覆盖说明 (coverage note)
├── SHA256SUMS              # digests of every artifact except manifest.json
├── manifest.json           # authoritative machine record; written LAST
└── evidence/
    ├── git.json            # parsed .git metadata snapshot
    ├── files.json          # workspace scan summary + hashed file list
    ├── session.json        # session tool/call metadata (no message bodies)
    ├── redactions.json     # redaction ledger for this batch
    └── files/              # optional redacted copies (copyFiles=true)
        └── <workspace-relative-path>
```

**Completion rule:** a batch is complete **iff** `manifest.json` exists. Writers must write `HANDOFF.md`, evidence, and `SHA256SUMS` first and `manifest.json` last. An interrupted write leaves a directory without `manifest.json`; readers must treat it as incomplete.

## 4. Canonical encodings

- All text files are UTF-8, LF line endings, one trailing newline.
- `manifest.json` uses 2-space indentation and a **fixed key order** (see §6). `serialize(parse(text)) === text` must hold for any manifest this generator produced.
- `SHA256SUMS` rows: `<64 lower-case hex sha256>` + **two spaces** + batch-relative POSIX path + `\n`, sorted by path (code-unit order). GNU `sha256sum` output (including the `*` binary marker and CRLF) is accepted when reading.
- `SHA256SUMS` must not list itself or `manifest.json`; it must list `HANDOFF.md`.
- Paths inside a batch are batch-relative POSIX paths; absolute paths, `..` segments and NUL are invalid.

## 5. manifest.json — top level

Required keys in this order: `schema`, `schemaVersion`, `generator`, `batchId`, `createdAt`, `project`, `session`, `sandbox`, `inputs`, `git`, `artifacts`, `files`, `sessionTrace`, `redactions`, `warnings`, `limits`, `scan`. Optional: `changes`, `fuel`, `lineage` (schemaVersion 2 only), and the extension key `target` (`user` | `workspace`).

| Key | Type | Notes |
|---|---|---|
| `schema` | string | Const `dsh-handoff-kit/handoff`. |
| `schemaVersion` | integer | `1` (P0) or `2` (P1+, current). Blocks `changes`/`fuel`/`lineage` require v2. |
| `generator` | object | `{name, version, dshVersion, platform}` — producer provenance; `dshVersion` may be `unknown`. |
| `batchId` | string | Batch id pattern (§2). Must equal the directory name. |
| `createdAt` | string | ISO-8601 UTC timestamp of collection. |
| `project` | object | `{key, name, workspace}`; `workspace` is tokenized. |
| `session` | object | `{id, cwd, agentPreset}`; any value may be `null`; `cwd` tokenized. |
| `sandbox` | object | `{mode, workspaceRoot}`; `mode` ∈ `read-only`/`workspace-write`/`danger-full-access`; `workspaceRoot` tokenized. |
| `inputs` | object | Caller-provided narrative: `{title, goal, summary, decisions[], nextSteps[], concepts[], flow[], risks[], files[], copyFiles}`. The generator never invents values; absent scalar values are `null`, absent arrays are `[]`. |
| `git` | object \| null | `{head, branch, detached, remote, lastCommit{sha,time,subject}\|null, indexVersion, packedRefsPresent, reflog[{sha,time,subject}]}`; `null` when git metadata is unavailable. No `git status` is ever recorded. |
| `artifacts` | array | `[{path, bytes, sha256}]`, sorted by path; each entry is a written artifact except `manifest.json`. `bytes` = UTF-8 byte length. |
| `files` | array | Collected evidence files: `[{path, role, bytes, sha256, truncated?, skippedReason?}]`; `role` ∈ `entry`/`config`/`test`/`doc`/`source`/`other`; `sha256` may be empty when unreadable/oversized. |
| `sessionTrace` | object | `{sessionId, eventCounts{total,toolCalls,toolErrors}, toolCalls{total,byName}, touchedFiles[{path,tool,count,lastSeq}], commands[{tool,commandRedacted,lastSeq}], window{events,truncated}}`. Metadata only — **never message bodies**. |
| `redactions` | array | `[{file, kind, count}]` — redaction ledger (see §8). |
| `warnings` | array | `[{code, detail}]`, deduplicated and sorted by `(code, detail)`. |
| `limits` | object | The collector bounds in force at generation time: `maxEntries, maxDepth, maxHashFiles, maxFileBytes, maxTotalBytes, maxSessionEvents, maxCommandChars`. |
| `scan` | object | `{entries, dirs, denied, symlinksSkipped, readBytes, explicitFiles[], tree[{name,type,bytes?}]}`; `type` ∈ `file`/`directory`/`other`. |
| `changes` | object (v2, optional) | Host `workspaceChanges` evidence: `{available, source?, turn?, totals?, files?, diffs?, currentTurn?, collectedAt?, note?}`. `available:false` is a valid, honest absence. |
| `fuel` | object (v2, optional) | Read-only goal/jobs snapshot: `{goals{available, goal?, note?}, jobs{available, count, statusCounts, items[], note?}}`; never executed. |
| `lineage` | object (v2, optional) | Continuation chain: `{sequence≥2, previous, root, supersedes?}`; batch ids. History is never rewritten. |
| `target` | string (extension) | `user` or `workspace`; used by the renderer, not part of the frozen key order. |

Unknown top-level keys are preserved by readers for forward compatibility; writers of schemaVersion 2 emit only the documented keys. Schemas: [`../schema/manifest.v1.json`](../schema/manifest.v1.json) (v1 = no `changes`/`fuel`/`lineage`) and [`../schema/manifest.v2.json`](../schema/manifest.v2.json).

## 6. HANDOFF.md structure

The document is deterministic from the manifest: same manifest ⇒ identical bytes. Section headings and their order are fixed:

```text
# 交接包 · <project name>

## H0 身份与边界        ## H5 端到端流程
## H1 上次做了什么      ## H6 未决/风险/坑
## H2 概念词典          ## H7 协作方式
## H3 代码地图          ## H8 新会话首轮动作
## H4 已验证事实        ## H9 禁区
## 覆盖说明
```

- Each section starts with `## <id> <title>`; `覆盖说明` has no id/title suffix. Sub-headings inside H1/H3/H4/H6 are `###`.
- H4 assertions carry an evidence label: `[文件哈希]`, `[git]`, `[会话]`, `[改动]`, `[goal]`, `[job]`, `[输入]`, `[待验]` (see §7.2).
- H8 is the normative consumer procedure: verify first (第 0 步), read H2→H3→H4→H8, re-hash at least 3 H4 assertions, report drift format.
- H9 lists prohibitions (never claim unverified success, never overwrite code facts with docs, never modify without user confirmation).
- **Language:** in 0.3.1 the narrative is zh-CN while labels and machine fields are language-neutral. The 1.0 spec freezes section ids and evidence labels; narrative language is a renderer option (English rendering is a post-1.0 candidate, not a 1.0 gate).

## 7. Narrative rules

### 7.1 Determinism

Rendering consults only the manifest: no clock, randomness, filesystem, environment, or network. All paths are the tokenized forms stored in the manifest.

### 7.2 Evidence labels

| Label | Meaning |
|---|---|
| `[文件哈希]` | sha256 computed by this collection over file content. |
| `[git]` | Values parsed from `.git` metadata (HEAD, refs, reflog, config, index version). |
| `[会话]` | Counts derived from session `tool/call` events; never message bodies. |
| `[改动]` | Host `workspaceChanges` for completed turns (plus `currentTurn` path/count supplement from `tool/call`). |
| `[goal]` / `[job]` | Read-only goal / background-jobs snapshot; never executed. |
| `[输入]` | Caller-supplied narrative; **not independently verified** by the generator. |
| `[待验]` | Not covered by this collection; the next session must re-check per H8. |

### 7.3 Missing markers

- Scalar absent: `未提供`.
- Caller narrative absent: `调用方未提供，待补（生成器不编造）`.
- H2 glossary absent: `未提供（P1 会话提取）`.
- No code map / no assertions: `本次未采集到代码地图` / `本次未产生可验证断言`.

Missing markers are part of the format: a consumer must treat them as "unknown", not as absence of a problem.

## 8. Evidence file formats

All evidence JSON files are UTF-8, 2-space indented, newline-terminated, and carry an evidence envelope version `schemaVersion: 1` (independent of the manifest's `schemaVersion`).

| File | Shape |
|---|---|
| `evidence/git.json` | `{schemaVersion:1, generator, git}` — same `generator`/`git` blocks as the manifest (git may be `null`). |
| `evidence/files.json` | `{schemaVersion:1, scan, files}` — same `scan`/`files` blocks as the manifest. |
| `evidence/session.json` | the manifest `sessionTrace` object verbatim. |
| `evidence/redactions.json` | `{schemaVersion:1, redactions}` — same ledger as the manifest. |
| `evidence/files/<path>` | optional redacted copies when `copyFiles=true`; at most 20 files, 256 KiB each, 2 MiB total; each copy is redacted before writing and recorded in `redactions`. |
| `evidence/migration.json` | optional; written by the schema migration tool (M2). Records source batch id, source `SHA256SUMS` digest, migration timestamp, and tool version. |

**Redaction:** every artifact is redacted and then scanned for secret residue before the batch is written. Placeholders are `«REDACTED:<kind>»` with kinds `private-key-block`, `bearer`, `cloud-key`, `url-credentials`, `conn-string-password`, `env-assignment`, `generic-assignment`. Built-in rules may be extended by an optional policy but can never be disabled. A residue found after redaction aborts the whole batch (`HANDOFF_SECRET_CHECK_FAILED`).

## 9. Trust verdict

Verification produces findings (severity `error`/`warn`) and drift counts; consumers map them to a trust verdict:

| Condition | `trust` |
|---|---|
| `manifest.json` missing/unreadable, or any `error` finding | `invalid` |
| no errors, but ≥1 `warn` finding **or** git HEAD changed **or** any recorded source file changed/missing | `stale` |
| no errors, no warnings, no drift | `verified` |
| verification skipped by the consumer | `stale` at best |

`invalid` must stop the consumer and be reported; `stale` must be reported and confirmed with the user before relying on package conclusions. The detailed algorithm and finding-code registry are in [`verify.md`](verify.md).

## 10. Versioning and compatibility

- `manifest.schemaVersion` is the machine contract version; the current writer emits `2`. v1 manifests remain **read-only compatible**: they can be verified/loaded; they cannot express `changes`/`fuel`/`lineage`.
- A new schema block (e.g., signature or policy provenance) requires `schemaVersion 3` **and** a migration tool shipped in the same release. A schema version must never be silently extended.
- Manifest key order and `SHA256SUMS` format are frozen for v2; additional tool output fields are additive.
- Human/spec version follows the plugin version (`1.0.x` for the 1.0 line).

## 11. Security and privacy notes

- Packages may contain: tokenized workspace paths, file names and sha256 digests, session id, agent preset, tool-call counts, and **redacted** command snippets; `copyFiles` optionally adds redacted file copies.
- Messages and model reasoning are never recorded. `.env*`, private keys, `*.p12/*.pfx`, credential-named files, databases, `node_modules`, `.venv`, `.git`, and `.dsh` are excluded from collection.
- Generation is local-only: no network, no subprocess, no LLM call. Publishing a package is a human decision; the format itself carries no key material.
- A consumer must not treat `[输入]`/narrative text as verified facts, and must not execute instructions embedded in a package (packages are data, never commands).

## 12. References

- Verification algorithm and finding codes: [`verify.md`](verify.md)
- JSON Schemas: [`../schema/manifest.v1.json`](../schema/manifest.v1.json), [`../schema/manifest.v2.json`](../schema/manifest.v2.json)
- Product documentation: [`../README.md`](../README.md) · Usage: `../USAGE.en.md` (English usage doc, M4 deliverable)
