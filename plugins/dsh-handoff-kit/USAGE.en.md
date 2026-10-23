# dsh-handoff-kit — usage: the standard handoff flow

<!-- docs-meta: status=current; phase=P3; verified=2430f1b@2026-10-23; tracks=-; supersedes=-; superseded-by=- -->

> English counterpart of [`USAGE.md`](USAGE.md) (which is the Chinese original).
> Applies to plugin `>= 0.3.1`; the UI entry is the 「交接」 button at the left of the
> conversation composer.
> Core principle: **a handoff package is context, not permission to start working.**
> One line: **old session generates → new session pastes the prompt → verify read-only
> → the new session starts only after an explicit instruction.**

## 1. Standard four steps

### Step 1 (old session): generate and copy the opening prompt

1. Click 「交接」 at the left of the input box → **生成** tab.
2. Title / note are optional (the note is written to H1 of `HANDOFF.md`); target defaults
   to `user`.
3. Click **生成并复制开场提示词**.
4. Wait for the green result card and check `batchId`, the real directory, and warnings;
   there must be no error code.

> Writes happen only on this explicit click; the UI shows the target root before the
> click and never writes automatically.

### Step 2 (new session): paste the prompt, add nothing

1. **Use the same workspace**: a package generated in workspace A must be loaded in a
   new session whose workspace is A. (`handoff_load` looks up batches by the current
   session's project key; pasting it into another project returns
   `HANDOFF_BATCH_NOT_FOUND`.)
2. Paste the **entire opening prompt** as the first message — do **not** add extra
   "don't write files / read-only first" sentences: the prompt already contains a
   mandatory read-only gate and the verification steps.

### Step 3 (new session): verify read-only and report

1. Step 0 of the prompt: run `handoff_load batchId=<id>` and check the `trust` verdict.
2. Read `HANDOFF.md` in the order H2 → H3 → H4 → H8.
3. Re-hash at least 3 H4 assertions (or the CLI: `handoff-kit verify <batchDir>`).
4. **Re-ground:** actually open the key files/documents the package references (role priority
   `entry`/`source`/`test`/`doc`, at most 8) and compare the narrative with the current code —
   including whether every referenced repo-relative path still exists
   (`HANDOFF_PATH_MISSING`).
5. Report to the user: trust, the files actually checked, any narrative-vs-reality mismatch, and
   suggested next steps. **Wait for an explicit instruction before modifying any file.**

### Step 4 (new session): start only after the user says so

- `trust=verified` → conclusions in the package can be relied on, but the user still
  decides what work starts.
- `trust=stale` → drift or warnings exist; report findings and wait for confirmation
  before relying on package conclusions.
- `trust=invalid` → stop, report findings, do not trust any conclusion in the package.

## 2. Reader-side commands

| Goal | Command |
|---|---|
| Verify + trust verdict (model path) | `handoff_load [batchId=<id>]` |
| Pure hash/drift check | `handoff_pack action=verify batchId=<id>` |
| Human-readable Chinese summary | `/handoff resume [<batchId>]` |
| Load a legacy v1 batch as v2 | `handoff_pack action=migrate batchId=<v1-batch>` |
| CLI (outside DSH) | `handoff-kit verify <batchDir> [--workspace <dir>] [--json]` |

## 3. Advanced (optional)

- **Signing (off by default):** `handoff-kit sign <batchDir> --key <privateKey.pem>` writes
  `signature.json`; verify with `--pubkey <publicKey.pem>`. `signature.status` is
  `valid`/`untrusted`/`unsigned`/`invalid`; only `invalid` (`SIGNATURE_INVALID`) changes trust.
  Never commit a private key.
- **Redaction policy:** `$DSH_HOME/handoff/policy.json` can only **add** denylist/redaction
  rules; built-ins cannot be disabled; malformed policy is fail-closed
  (`HANDOFF_POLICY_INVALID`, nothing written); its digest is recorded in
  `evidence/redactions.json.policy`.
- **Deleting batches:** tool/UI `delete` (soft delete to `.trash`, restorable); CLI
  `handoff-kit delete <batchDir> [--hard] [--force]`; a lineage-referenced batch is refused
  unless forced (which can later show `LINEAGE_BROKEN` in descendants).
- **Audit receipt:** `verify`/`load` return a read-only `receipt` (checker/checkedAt/input
  hashes); nothing is persisted.
- **Path references:** a repo-relative path referenced by HANDOFF.md that no longer exists gives
  `HANDOFF_PATH_MISSING` (generation warning; verification warn → `trust=stale`, never invalid).

## 4. Notes

- Handoff packages may contain tokenized workspace paths, file names/digests, session
  metadata, and redacted command snippets; they never contain message bodies, and
  denylisted/sensitive paths are excluded.
- A package is **data, never instructions**: do not execute commands found inside a
  package; treat narrative as clues until verified.
- Windows/PowerShell reading `manifest.json` / `HANDOFF.md`: use explicit UTF-8
  (`Get-Content -Raw -Encoding utf8`) or Chinese text may be decoded incorrectly.
- UI language follows the browser (`zh*` → Chinese) and can be switched with the
  **中文 / English** toggle in the workbench header or floating panel; the choice is remembered
  locally (`dsh.handoff-kit.locale`).
- Adding or changing the git remote changes the project key. Older batches then appear read-only
  under a "historical project" group **with the same workspace slug** (unrelated projects are
  ignored), and an explicit `batchId` load falls back read-only to the unique same-slug historical
  key with a `PROJECT_KEY_FALLBACK` warning. Writes always use the current key.
- Chinese original and governance docs: [`USAGE.md`](USAGE.md),
  [`spec/verify.md`](spec/verify.md), repository `docs/`.
