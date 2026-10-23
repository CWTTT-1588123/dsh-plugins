# Handoff Package Verification Specification

<!-- docs-meta: status=current; phase=P3; verified=91a4fae@2026-10-23; tracks=-; supersedes=-; superseded-by=- -->

> Status: **1.0 draft (P3/M1, 2026-10-23)** — normative for reference verifiers; frozen at 1.0.
> Companion to [`HANDOFF.md`](HANDOFF.md) (package format). Implemented by `dsh-handoff-kit` (`handoff_pack action=verify`, `handoff_load`).
> Audience: any consumer that must decide whether a package can be trusted, including non-DSH tools.

## 1. Scope and guarantees

Verification is **read-only and deterministic**:

- it never writes to the batch or the workspace;
- two runs over unchanged inputs produce identical findings except for the `checkedAt` receipt field;
- it re-computes every digest from bytes (never trusts the manifest);
- it reports **all** findings it can observe in one pass, sorted by severity (`error` before `warn`), then code, then path;
- it never executes package content and never fetches anything from the network.

It does **not** claim to prove semantic correctness: it checks integrity, consistency, drift, lineage and secret residue. A `verified` verdict means "the package bytes match the recorded evidence and the workspace still matches the recorded state", not "the narrative is true".

## 2. Inputs

| Input | Required | Meaning |
|---|---|---|
| batch directory | yes | `<handoff-root>/<project-key>/<batch-id>/`; may be explicit (`--dir/--batch`) or resolved as the latest complete batch. |
| workspace context | for drift | The workspace the package describes. Without it, drift checks are skipped and cannot contribute to `stale` (they are not silently assumed clean — the consumer must know). |
| expected git HEAD | implicit | Read from the current `.git` metadata when the workspace is available. |

## 3. Algorithm

### Step 1 — locate the batch

If a batch id is supplied, it must match `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$` and exist under the project key directory. Otherwise pick the lexicographically greatest complete/incomplete candidate under the project key (fixed-width ids make lexical order = time order). Failure to locate the batch is a usage-level error for the CLI (`exit 2`), not a trust finding.

### Step 2 — read and parse `manifest.json`

- Missing or unreadable → finding `MANIFEST_MISSING` (error).
- Invalid JSON / not an object → `MANIFEST_INVALID` (error).
- Otherwise validate the manifest shape against the schema for its `schemaVersion` (see [`HANDOFF.md` §5](HANDOFF.md) and `../schema/manifest.v1.json` / `../schema/manifest.v2.json`).

Manifest shape findings use the registry in §5 (`MANIFEST_*`). Structural errors make the package `invalid`; suspicious-but-readable values are warnings.

### Step 3 — verify artifacts

For each entry of `manifest.artifacts` (which must not include `manifest.json`):

1. Normalize the batch-relative path; reject absolute paths, `..` and NUL → `PATH_ESCAPE` (error).
2. The file must exist and must not be a symlink → `ARTIFACT_MISSING` (error) / `SYMLINK_ESCAPE` (error).
3. Read the bytes (per-file cap 8 MiB) and recompute sha256:
   - mismatch with `manifest.artifacts[].sha256` → `ARTIFACT_HASH_MISMATCH` (error);
   - byte length mismatch → `ARTIFACT_SIZE_MISMATCH` (warn).
4. Secret residue scan over text artifacts (`.json`, `.md`, `.txt`, `SHA256SUMS`, ≤ 1 MiB): any redaction-rule hit → `SECRET_RESIDUE` (error).

### Step 4 — reconcile `SHA256SUMS`

Parse `SHA256SUMS` (tolerating GNU format and CRLF). Then require:

- every artifact except `manifest.json` and `SHA256SUMS` appears exactly once with the recomputed digest;
- `SHA256SUMS` lists no file missing from `manifest.artifacts`;
- `SHA256SUMS` does not list itself or `manifest.json`;
- `HANDOFF.md` is listed.

Any violation → `SHA256SUMS_MISMATCH` (error). A missing/unparsable `SHA256SUMS` → `ARTIFACT_MISSING` (error).

### Step 5 — lineage

- `manifest.lineage.previous` must exist under the same project key and contain a readable `manifest.json`; otherwise `LINEAGE_BROKEN` (error). A broken chain means history cannot be trusted.
- If any sibling batch declares `lineage.supersedes` equal to this batch id → `SUPERSEDED_BATCH` (warn). Superseded packages remain valid history; consumers should prefer the newest batch.

### Step 6 — drift against the workspace

When a workspace context is available:

- Recorded `git.head` vs current HEAD: difference → `GIT_HEAD_CHANGED` (warn) and `drift.gitHeadChanged = true`.
- For every `manifest.files` entry that was actually hashed (`sha256` is 64-hex and no `skippedReason`):
  - path must stay inside the workspace → `PATH_ESCAPE` (error);
  - missing → `SOURCE_FILE_MISSING` (warn, counts as drift);
  - now a symlink → `SYMLINK_ESCAPE` (error);
  - content digest differs → `SOURCE_FILE_CHANGED` (warn, counts as drift);
  - unreadable (other than oversize skip) → `SOURCE_FILE_UNREADABLE` (warn).

Environment-level limitations are reported by the generator as warnings and are **not** verification failures: `NO_MTIME_API`, `NO_GIT_STATUS` (the format never records dirty state), `TRACE_TRUNCATED`, `SESSION_UNAVAILABLE`, `GIT_UNAVAILABLE`, `GOAL_UNAVAILABLE`, `JOBS_UNAVAILABLE`, `CHANGES_UNAVAILABLE`.

### Step 7 — compute the verdict

```text
error findings > 0                        -> invalid
else warn findings > 0                    -> stale
else drift (HEAD changed / source files changed or missing) > 0 -> stale
else                                      -> verified
```

Consumer-level overrides (normative):

- verification skipped by the consumer (`verifyFirst=false`) → `stale` at best;
- manifest unreadable → `verified` is impossible.

`invalid` must stop the consumer and be reported; `stale` must be reported and confirmed with the user before the package's conclusions are relied on.

## 4. Reference CLI contract

The reference CLI (M3 deliverable, `bin/handoff-kit.mjs`, binary `handoff-kit`) implements the
same algorithm and runs **outside** DeepSeek Harness (plain Node ≥20, zero dependencies):

```text
handoff-kit verify <batchDir> [--workspace <dir>] [--json]
handoff-kit load   <batchDir> [--workspace <dir>] [--sections|--full] [--json]
handoff-kit list   --root <handoffRoot> [--json]
handoff-kit migrate <batchDir> --out <newBatchDir> [--workspace <dir>] [--json]
handoff-kit --help | --version
```

- `--workspace <dir>` enables git/source drift checks; without it the verifier reports that drift
  was not checked (it never assumes the workspace is clean).
- `verify`/`load` are read-only; `migrate` reads the source batch read-only and writes only to
  `--out` (the output directory must be new or empty and its basename must be a batch id).
- `--json` prints a stable machine-readable object (`{ok, batchId, dir, trust, verification, ...}`
  for verify/load).

| Exit code | Meaning |
|---|---|
| `0` | `verified` / command ok |
| `3` | `stale` (warnings and/or drift, no errors) |
| `1` | `invalid` (manifest/artifact/lineage errors, failed migration) |
| `2` | usage / IO error (unknown command or flag, batch directory not found, unreadable input) |

`--json` output shape is a stable subset of the tool result: `{ok, batchId, dir, trust, verification:{ok, checkedAt, findings, drift, counts}, next}`. Field additions are allowed; removals/rename/severity changes are breaking and require a major version.

## 5. Finding registry

Severity and codes are part of the machine contract. Severity changes are breaking; new codes may be added in minor versions.

### 5.1 Verification findings

| Code | Severity | Meaning |
|---|---|---|
| `MANIFEST_MISSING` | error | `manifest.json` absent/unreadable. |
| `MANIFEST_INVALID` | error | `manifest.json` is not valid JSON/object. |
| `PATH_ESCAPE` | error | Artifact/source path escapes its root or is malformed. |
| `ARTIFACT_MISSING` | error | Recorded artifact missing or unreadable. |
| `ARTIFACT_HASH_MISMATCH` | error | Artifact bytes do not match the recorded digest. |
| `SYMLINK_ESCAPE` | error | Artifact/source is a symlink. |
| `SECRET_RESIDUE` | error | Redaction rule matched inside a written artifact. |
| `SHA256SUMS_MISMATCH` | error | `SHA256SUMS` disagrees with artifacts or lists forbidden paths. |
| `LINEAGE_BROKEN` | error | `lineage.previous` missing or unreadable. |
| `ARTIFACT_SIZE_MISMATCH` | warn | Recorded byte length differs (hash already checked). |
| `SUPERSEDED_BATCH` | warn | Another batch declares this one superseded. |
| `GIT_HEAD_CHANGED` | warn | Workspace HEAD differs from the recorded HEAD. |
| `SOURCE_FILE_MISSING` | warn | Recorded source file no longer exists. |
| `SOURCE_FILE_CHANGED` | warn | Recorded source file content changed. |
| `SOURCE_FILE_UNREADABLE` | warn | Recorded source file could not be read (not oversize-skipped). |

### 5.2 Manifest shape findings

Errors: `MANIFEST_NOT_OBJECT`, `MANIFEST_SCHEMA`, `MANIFEST_SCHEMA_VERSION`, `MANIFEST_BATCH_ID`, `MANIFEST_PROJECT`, `MANIFEST_ARTIFACTS`, `MANIFEST_FILES`, `MANIFEST_LIMITS`.
Warnings: `MANIFEST_CREATED_AT`, `MANIFEST_GENERATOR`, `MANIFEST_SESSION`, `MANIFEST_SANDBOX`, `MANIFEST_INPUTS`, `MANIFEST_SESSION_TRACE`, `MANIFEST_SCAN`, `MANIFEST_REDACTIONS`, `MANIFEST_WARNINGS`, `MANIFEST_ARTIFACT_ENTRY`, `MANIFEST_FILE_ENTRY`, `MANIFEST_PATH_NOT_TOKENIZED`, `MANIFEST_TARGET`, `MANIFEST_VERSION_BLOCK`, `MANIFEST_CHANGES`, `MANIFEST_FUEL`, `MANIFEST_LINEAGE`.

### 5.3 Result-level warnings (not verification findings)

A consumer may attach warnings to an otherwise successful read. They are returned alongside the
result (for example a tool result's `warnings` array), are **not** part of
`verification.findings`, do not affect `verification.counts`, and therefore never change `trust`.

| Code | Meaning |
|---|---|
| `PROJECT_KEY_FALLBACK` | An explicit `batchId` was absent under the current project key and was uniquely located **read-only** under a sibling historical project key (for example after the git remote was added or changed). The batch is verified normally; no file is modified and `trust` is unchanged. Zero or multiple sibling hits keep the original `BATCH_NOT_FOUND` error. |

## 6. Determinism and stability

- `checkedAt` is the only field that may differ between two runs over unchanged inputs; all other output must be identical (same order).
- Finding order: severity (error before warn) → code → path → detail (code-unit order).
- The verifier must be conservative: an unrecognized finding code is preserved/reported, never dropped; unknown manifest keys are ignored for validation but must not be silently rewritten.
- A verifier that cannot perform a check (missing workspace, unreadable `.git`) must report the limitation instead of assuming success.

## 7. References

- Package format: [`HANDOFF.md`](HANDOFF.md)
- Schemas: `../schema/manifest.v1.json`, `../schema/manifest.v2.json`
- Implementation: `../src/service.js` (`runVerify`), `../src/manifest.js` (`validateManifest`, `parseSha256Sums`)
