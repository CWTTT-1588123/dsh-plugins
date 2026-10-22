#!/usr/bin/env node
/**
 * docs:check — deterministic documentation drift checks for this repository.
 *
 * Spec: docs/DOC_CHECKS.md (DC1–DC10). Governance: docs/adr/0002-document-governance.md.
 * This script is READ-ONLY: it never edits documents. Exit code 1 when at least
 * one error exists; warnings/stale findings keep exit code 0.
 *
 * Usage:
 *   node scripts/docs-check.mjs [--json] [--root <dir>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const STATUSES = ['current', 'frozen', 'superseded', 'historical']
const PHASES = ['P0', 'P1', 'P2', 'P3', 'cross']
const REQUIRED_META_FIELDS = ['status', 'phase', 'verified', 'tracks', 'supersedes', 'superseded-by']
const CONFIRMED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VERIFIED_RE = /^([0-9a-f]{7,40})@(\d{4}-\d{2}-\d{2})$/
const INDEX_EXEMPT = new Set(['docs/README.md'])
const STALE_AFTER_DAYS = 90
const MAX_DETAILS_PER_ID = 12

function parseArgs(argv) {
  const options = { json: false, root: process.cwd() }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--root requires a directory')
      options.root = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/docs-check.mjs [--json] [--root <dir>]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function toPosix(path) {
  return path.split(sep).join('/')
}

function repoPath(root, absolutePath) {
  return toPosix(relative(root, absolutePath))
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

function parseMeta(text) {
  const match = text.match(/<!--\s*docs-meta:\s*([^>]*?)\s*-->/)
  if (match === null) return null
  const fields = {}
  for (const part of match[1].split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    fields[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  return fields
}

function parseIndex(root) {
  const indexPath = resolve(root, 'docs/README.md')
  if (!existsSync(indexPath)) return { indexPath, rows: [], text: '' }
  const text = readFileSync(indexPath, 'utf8')
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('| [')) continue
    const match = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|(.*)$/)
    if (match === null) continue
    const target = match[2].split('#')[0]
    const absolute = resolve(dirname(indexPath), target)
    const cells = match[3].split('|').map((cell) => cell.trim())
    rows.push({
      label: match[1],
      target,
      repoPath: repoPath(root, absolute),
      type: cells[0] ?? '',
      status: cells[1] ?? '',
      phase: cells[2] ?? ''
    })
  }
  return { indexPath, rows, text }
}

function check() {
  const options = parseArgs(process.argv.slice(2))
  const root = resolve(options.root)
  const errors = []
  const warnings = []
  const stale = []
  let scanned = []

  const addError = (id, path, detail) => errors.push({ id, path, detail })
  const addWarning = (id, path, detail) => warnings.push({ id, path, detail })

  let tracked
  try {
    tracked = runGit(root, ['ls-files', '--', '*.md']).split(/\r?\n/).filter(Boolean)
  } catch (error) {
    console.error(`docs:check requires git and a git repository at ${root}: ${error.message}`)
    process.exit(2)
  }
  const archiveDocs = tracked.filter((path) => path.startsWith('docs/archive/'))
  scanned = tracked.filter((path) => !path.startsWith('docs/archive/') && !path.includes('node_modules/'))
  const trackedSet = new Set(tracked)

  /* DC10 — index structure */
  const index = parseIndex(root)
  if (index.text === '') {
    addError('DC10', 'docs/README.md', 'index file is missing')
  } else {
    const requiredSections = [
      ['权威顺序', '权威顺序'],
      ['状态图例', '状态图例'],
      ['文档头模板', '文档头模板'],
      ['文档总表', '文档总表']
    ]
    for (const [label, needle] of requiredSections) {
      if (!index.text.includes(needle)) addError('DC10', 'docs/README.md', `missing section: ${label}`)
    }
  }

  /* DC1 — index completeness */
  const indexTargets = new Set(index.rows.map((row) => row.repoPath))
  for (const path of scanned) {
    if (INDEX_EXEMPT.has(path)) continue
    if (!indexTargets.has(path)) addError('DC1', path, 'not registered in docs/README.md §4 文档总表')
  }

  /* DC2 — index validity */
  for (const row of index.rows) {
    if (!existsSync(resolve(root, row.repoPath))) {
      addError('DC2', 'docs/README.md', `index link does not resolve: ${row.target}`)
    } else if (row.repoPath.endsWith('.md') && !trackedSet.has(row.repoPath)) {
      addError('DC2', 'docs/README.md', `index links an untracked file: ${row.repoPath}`)
    }
  }

  /* DC3/DC4/DC5/DC6/DC9 — per document */
  const metaByPath = new Map()
  const today = new Date()
  for (const path of scanned) {
    const absolute = resolve(root, path)
    const raw = readFileSync(absolute, 'utf8')
    const meta = parseMeta(raw)
    metaByPath.set(path, meta)
    const docErrorsBefore = errors.length

    /* DC3 metadata */
    if (meta === null) {
      addError('DC3', path, 'missing docs-meta comment')
    } else {
      for (const field of REQUIRED_META_FIELDS) {
        if (meta[field] === undefined) addError('DC3', path, `docs-meta missing field: ${field}`)
      }
      if (meta.status !== undefined && !STATUSES.includes(meta.status))
        addError('DC3', path, `invalid status: ${meta.status}`)
      if (meta.phase !== undefined && !PHASES.includes(meta.phase))
        addError('DC3', path, `invalid phase: ${meta.phase}`)
      if (meta.status === 'current' || meta.status === 'frozen') {
        if (meta.verified === undefined || !VERIFIED_RE.test(meta.verified)) {
          addError('DC3', path, 'status requires verified=<commit>@YYYY-MM-DD')
        }
      }
      if (meta.status === 'superseded' || meta.status === 'historical') {
        const hasSuperseder = meta['superseded-by'] !== undefined && meta['superseded-by'] !== '-'
        if (!hasSuperseder && !path.startsWith('docs/archive/'))
          addError('DC3', path, 'superseded/historical requires superseded-by or docs/archive/')
      }
      /* DC6a/DC6b — freshness against verified commit */
      if ((meta.status === 'current' || meta.status === 'frozen') && meta.verified !== undefined) {
        const verifiedMatch = meta.verified.match(VERIFIED_RE)
        if (verifiedMatch === null) {
          addError('DC6a', path, `invalid verified value: ${meta.verified}`)
        } else {
          const [, commit, verifiedDate] = verifiedMatch
          let commitExists = true
          try {
            runGit(root, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
          } catch {
            commitExists = false
            addError('DC6a', path, `verified commit not found: ${commit}`)
          }
          const tracks = meta.tracks === undefined ? '-' : meta.tracks
          if (commitExists && meta.status === 'current' && tracks !== '-') {
            const trackPaths = tracks.split(',').map((item) => item.trim()).filter(Boolean)
            try {
              const changed = runGit(root, ['diff', '--name-only', `${commit}..HEAD`, '--', ...trackPaths])
              if (changed !== '') {
                stale.push({ path, verified: meta.verified, changed: changed.split(/\r?\n/) })
                addWarning('DC6b', path, `tracked files changed since ${meta.verified}: ${changed.split(/\r?\n/).join(', ')}`)
              }
            } catch (error) {
              addWarning('DC6b', path, `could not diff tracked files: ${error.message}`)
            }
          }
          /* DC6c — document edited after verification date */
          try {
            const lastCommitDate = runGit(root, ['log', '-1', '--format=%cs', '--', path])
            if (lastCommitDate !== '' && CONFIRMED_DATE_RE.test(verifiedDate) && lastCommitDate > verifiedDate) {
              addWarning('DC6c', path, `document changed after verified date (${verifiedDate} < ${lastCommitDate})`)
            }
          } catch {
            /* not tracked yet: ignored */
          }
          /* DC9 — current doc too old */
          if (meta.status === 'current' && CONFIRMED_DATE_RE.test(verifiedDate)) {
            const ageDays = Math.floor((today.getTime() - Date.parse(`${verifiedDate}T00:00:00Z`)) / 86_400_000)
            if (ageDays > STALE_AFTER_DAYS) addWarning('DC9', path, `current doc verified ${ageDays} days ago`)
          }
        }
      }
    }

    /* DC5 — relative links (skip code spans) */
    const text = stripCode(raw)
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1]
      if (link.startsWith('http') || link.startsWith('mailto:') || link.startsWith('#')) continue
      const target = resolve(dirname(absolute), link.split('#')[0])
      if (!existsSync(target)) addError('DC5', path, `broken relative link: ${link}`)
    }

    void docErrorsBefore
  }

  /* DC4 — index status vs document meta (only when both exist) */
  for (const row of index.rows) {
    if (row.repoPath.startsWith('docs/archive/') && (row.status === 'current' || row.status === 'frozen'))
      addError('DC8', 'docs/README.md', `archive doc registered as ${row.status}: ${row.repoPath}`)
    const meta = metaByPath.get(row.repoPath)
    if (meta !== null && meta !== undefined && row.status !== '' && meta.status !== undefined && row.status !== meta.status)
      addError('DC4', row.repoPath, `index status ${row.status} != docs-meta status ${meta.status}`)
  }

  /* DC8 — archive isolation */
  for (const path of archiveDocs) {
    const meta = parseMeta(readFileSync(resolve(root, path), 'utf8'))
    if (meta === null || meta.status !== 'historical')
      addError('DC8', path, 'archived document must declare status=historical')
  }

  /* DC7a — package versions appear in CHANGELOG */
  let changelog = ''
  try {
    changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
  } catch {
    addError('DC7a', 'CHANGELOG.md', 'CHANGELOG.md is missing')
  }
  let packageJsons = []
  try {
    packageJsons = runGit(root, ['ls-files', '--', '**/package.json', 'package.json'])
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    packageJsons = []
  }
  for (const packageJsonPath of packageJsons) {
    try {
      const version = JSON.parse(readFileSync(resolve(root, packageJsonPath), 'utf8')).version
      if (typeof version === 'string' && !changelog.includes(`## [${version}]`))
        addWarning('DC7a', packageJsonPath, `version ${version} missing from CHANGELOG`)
    } catch {
      /* invalid package.json is out of scope */
    }
  }

  /* DC7b — hardcoded authoritative test counts (current docs only) */
  for (const path of scanned) {
    if (metaByPath.get(path)?.status !== 'current') continue
    const text = stripCode(readFileSync(resolve(root, path), 'utf8'))
    for (const line of text.split(/\r?\n/)) {
      if (!/测试|单测|tests?/i.test(line)) continue
      if (!/\b\d{1,4}\s*\/\s*\d{1,4}\b/.test(line)) continue
      addWarning('DC7b', path, `hardcoded test count near 测试/单测: ${line.trim().slice(0, 120)}`)
    }
  }

  /* Output */
  const result = {
    ok: errors.length === 0,
    scanned: scanned.length,
    indexRows: index.rows.length,
    errors,
    warnings,
    stale: stale.map((entry) => ({ path: entry.path, verified: entry.verified, changed: entry.changed }))
  }

  const printGrouped = (title, items, severity) => {
    if (items.length === 0) return
    console.log(`\n${title} (${items.length}):`)
    const grouped = new Map()
    for (const item of items) {
      const key = item.id
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(item)
    }
    for (const [id, group] of grouped) {
      console.log(`  [${id}] ${group.length} finding(s)`)
      for (const item of group.slice(0, MAX_DETAILS_PER_ID)) {
        console.log(`    - ${item.path}: ${item.detail}`)
      }
      if (group.length > MAX_DETAILS_PER_ID) console.log(`    … +${group.length - MAX_DETAILS_PER_ID} more`)
    }
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`docs:check — scanned ${scanned.length} docs, ${index.rows.length} index rows`)
    printGrouped('ERRORS', errors)
    printGrouped('WARNINGS', warnings)
    if (stale.length > 0) {
      console.log(`\nSTALE (${stale.length}):`)
      for (const entry of stale) console.log(`  - ${entry.path} (verified ${entry.verified})`)
    }
    console.log(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s), ${stale.length} stale doc(s)`)
    console.log(result.ok ? 'docs:check OK (no errors)' : 'docs:check FAILED')
  }

  process.exit(result.ok ? 0 : 1)
}

try {
  check()
} catch (error) {
  console.error(`docs:check crashed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
