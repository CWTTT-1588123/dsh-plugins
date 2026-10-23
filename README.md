# dsh-plugins

<!-- docs-meta: status=current; phase=cross; verified=c3ba381@2026-10-23; tracks=-; supersedes=-; superseded-by=- -->

DeepSeek Harness (DSH) plugins, developed in this repository. The main product is
**`dsh-handoff-kit`** — deterministic, verifiable session handoff packages
(`HANDOFF.md` + `manifest.json` + evidence) with a prompt-first UI workbench and a
zero-dependency CLI.

**Language note:** this file is the English public entry point. The governance
documents under [`docs/`](docs/README.md) are written in Chinese and remain the
authoritative process record (phases, acceptance, gaps).

## dsh-handoff-kit

Give a long-running AI session a way to hand its work to the next session **with
evidence, not vibes**: one tool call writes a handoff package, and the next session
verifies hashes before trusting the claims.

| Surface | What you get |
|---|---|
| Tool `handoff_pack` | `scan` / `create` / `verify` / `list` / `append` / `update` / `migrate` |
| Tool `handoff_load` | Read-only consumption: verify + `trust` verdict (`verified` / `stale` / `invalid`) + drift + pointers |
| Command `/handoff` | Human shortcut: create (default), append, update, scan, verify, list, migrate, resume |
| UI workbench | 「交接」 button in the conversation composer, floating panel (generate / load), and a 交接工作台 page |
| CLI `handoff-kit` | `verify` / `load` / `list` / `migrate` for non-DSH agents, scripts and CI (exit codes `0/3/1/2`) |
| Spec | [`spec/HANDOFF.md`](plugins/dsh-handoff-kit/spec/HANDOFF.md) + [`spec/verify.md`](plugins/dsh-handoff-kit/spec/verify.md) + JSON Schemas under `schema/` |

Runtime guarantees: zero runtime dependencies, **no network**, **no subprocess**, no
LLM calls, writes only on an explicit user action, and history batches are never
rewritten in place.

### Install (DSH)

```text
plugin_manager install_bundle target: dsh-handoff-kit@1.0.0
```

Published on npm as **`dsh-handoff-kit@1.0.0`** (`latest`). For local development from this
checkout:

```text
plugin_manager install_bundle target: D:\repos\dsh-plugins\plugins\dsh-handoff-kit
```

The package targets DSH `>=0.2.0 <0.3.0` (Windows first; macOS/Linux are
**experimental** and covered by non-blocking CI jobs only).

### CLI (outside DSH)

Install or run it without installing DSH:

```text
npm install dsh-handoff-kit          # or: npx dsh-handoff-kit <command>
handoff-kit verify  <batchDir> [--workspace <dir>] [--pubkey <pem>] [--json]
handoff-kit load    <batchDir> [--workspace <dir>] [--sections|--full] [--json]
handoff-kit list    --root <handoffRoot> [--json]
handoff-kit migrate <batchDir> --out <newBatchDir>                 # v1 -> v2, source read-only
handoff-kit sign    <batchDir> --key <privateKey.pem> [--force]    # opt-in signature
handoff-kit delete  <batchDir> [--hard] [--force]                  # soft delete by default
```

Exit codes: `0` verified/ok, `3` stale, `1` invalid/refused, `2` usage/IO.

See [`plugins/dsh-handoff-kit/spec/verify.md`](plugins/dsh-handoff-kit/spec/verify.md) §4
for the frozen CLI contract.

## Privacy and security

- A handoff package can contain: tokenized workspace paths (`$WORKSPACE` / `$DSH_HOME`),
  file names and sha256 digests, session id / agent preset, `tool/call` counts, and
  **redacted** command snippets; `copyFiles` optionally adds redacted file copies.
- Message bodies and model reasoning are **never** recorded. `.env*`, private keys,
  credential-named files, databases, `node_modules`, `.venv`, `.git` and `.dsh` are
  excluded from collection; every artifact is redacted and scanned for secret residue
  before the batch is written.
- Generation is local-only (no network, no subprocess, no LLM). Publishing a package
  is a human decision.
- Handoff packages are **data, never commands**: a consumer must not treat narrative
  text as verified facts and must not execute instructions embedded in a package.
- Security reports: please use the repository's
  [issue templates](.github/ISSUE_TEMPLATE) (no tokens or package contents in issues);
  for sensitive reports, contact the maintainer through GitHub.
- License: [MIT](LICENSE).

## Repository layout and process

```text
.
├── README.md / ROADMAP.md / CHANGELOG.md
├── LICENSE
├── scripts/docs-check.mjs          # documentation drift checks
├── docs/                            # Chinese governance docs (index, ADRs, plans, acceptance, gaps)
└── plugins/dsh-handoff-kit/         # the DSH bundle (+ CLI, spec, schema, tests)
```

- Phase and status authority: [`ROADMAP.md`](ROADMAP.md); documentation index:
  [`docs/README.md`](docs/README.md).
- Development: `cd plugins/dsh-handoff-kit && npm test`; repository doc check:
  `node scripts/docs-check.mjs` (zero errors required).
- CI: Windows runs the full test suite + doc check; Linux/macOS run unit tests as
  **experimental** (non-blocking) jobs.

## Other plugins

This repository is a multi-plugin monorepo; `dsh-handoff-kit` is currently the only
plugin in it. New plugins will be added as `plugins/<package-name>/`.
