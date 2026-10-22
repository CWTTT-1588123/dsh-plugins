#!/usr/bin/env node
/**
 * `handoff-kit` CLI entry point (P3/M3).
 *
 * Thin wrapper over `src/cli.js`: the core stays importable/testable without
 * spawning a process. Zero dependencies; no network; no subprocess.
 */

import { runCli } from '../src/cli.js'

process.exitCode = await runCli(process.argv.slice(2))
