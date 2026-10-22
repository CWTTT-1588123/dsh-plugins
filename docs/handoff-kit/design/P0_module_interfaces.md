# P0 模块接口规格（实现协作基线）

<!-- docs-meta: status=frozen; phase=P0; verified=c275312@2026-10-22; tracks=plugins/dsh-handoff-kit/src; supersedes=-; superseded-by=- -->

> 版本：v1（2026-10-22）。这是 `P0_implementation_plan.md` §3/§8 的**可执行细化**：
> 每个模块的导出签名、数据形状、确定性规则、错误码与测试门槛。并行实现时以本文件为准；
> 与实施计划冲突时以实施计划为准，并立即告知 Lead。

## 0. 全局约定

- ESM、`"type": "module"`、Node ≥ 20（本机 v24.21.0）；**零运行时依赖**。
- **禁止** `import` 任何 `@deepseek-ai/*` 包；只允许 Node 内建模块。
- **禁止** 网络、子进程、LLM 调用、读取环境变量中的密钥（`process.env.DSH_HOME` 这类非密钥路径变量除外；纯逻辑模块不得读环境变量，统一由调用方注入）。
- 纯逻辑模块**不得**使用 `Date.now()` / `new Date()`（无参）/ `Math.random()`；时间、随机后缀、文件内容全部由参数注入，保证两次渲染字节一致。
- 错误统一：`import { ERROR, handoffError } from './contracts.js'`，`throw handoffError(ERROR.X, 'english detail')`。
- 路径在 manifest/HANDOFF 中一律 **POSIX 分隔符 + token 化**（`$WORKSPACE`、`$DSH_HOME`）；文件系统调用用原生路径。
- 输出排序一律确定性（路径按字典序、按 lastSeq 降序等），不得依赖对象插入顺序或 locale。
- JSDoc 注释覆盖每个导出；`node --check` 必须通过。
- 测试：`node:test` + `node:assert/strict`；文件名 `test/<module>.test.js`；复用 `test/helpers/*`。

## 1. `src/redact.js`（负责人：trace-redact）

```js
export const REDACTION_RULES = [/* {kind, pattern: RegExp, replacement?: string} ... */]
export function redactText(text) -> {text: string, hits: [{kind, count}]}
export function scanSecrets(text) -> [{kind, count}]      // 只检测不替换；空数组=干净
export function finalCheck(text) -> [{kind, count}]       // 终检，语义同 scanSecrets
export function redactDeep(value) -> {value, hits}        // 递归字符串/数组/普通对象，其余原样
export function isDeniedFile(relativePath) -> boolean
export function deniedReason(relativePath) -> string|null
```

规则（`kind` 必须使用这些字面量）：
`env-assignment`、`generic-assignment`、`bearer`、`cloud-key`、`private-key-block`、`url-credentials`、`conn-string-password`。

- 命中替换为 `«REDACTED:<kind>»`；`hits` 按 `kind` 字典序排序，`count` 为该规则命中次数。
- 规则顺序固定（先 private-key-block，再 bearer/cloud-key/url-credentials/conn-string-password，最后 env/generic-assignment）；替换后的占位符不得被后续规则二次命中；`redactText(redactText(x).text).hits` 必须为空（幂等）。
- 文件级 denylist（相对 POSIX 路径，大小写不敏感）：`.env` 及其后缀变体（`.env.local` 等）、`*.pem`、`*.key`、`id_rsa*`、`*.p12`、`*.pfx`、文件名含 `credential`、`*.db`、`*.sqlite*`，以及路径段 `node_modules/`、`.venv/`、`.git/`。`deniedReason` 返回稳定英文原因（如 `dot-env`、`private-key`、`directory:node_modules`），无命中返回 `null`。
- 终检失败映射：调用方在写盘前若 `finalCheck(artifactText).length > 0` → `HANDOFF_SECRET_CHECK_FAILED`，整批不写。

测试必须覆盖：每条规则命中、二次脱敏幂等、占位符不复发、`isDeniedFile` 全表、`finalCheck` 对干净文本为空。

## 2. `src/session-trace.js`（负责人：trace-redact）

```js
export const FILE_TOOLS = ['write','edit','read','read_image','str_replace_editor','glob','grep']
export const SHELL_TOOLS = ['pwsh','bash']
export function extractTouchedPaths(toolName, args) -> string[]   // 从已解析 args 提取路径参数
export function buildSessionTrace({sessionId, events, totalEvents, contexts, limits}) -> trace
```

- 只读 `tool/call` 与 `tool/result` 两类事件；**绝不**读取 `user/message` / `assistant/message` 正文。
- `events` 为已按时间排序的事件数组（调用方保证是 `session.ownEvents()` 的后 ≤2000 条且序列化 ≤400KB 的窗口）。
- `contexts = {workspaceRoot, dshHome}`，用于 `paths.tokenizePath` / `relativeToWorkspace`。
- `trace` 形状：

```js
{
  sessionId: string|null,
  eventCounts: { total: number, toolCalls: number, toolErrors: number },
  toolCalls: { total: number, byName: { /* name: count, keys 字典序 */ } },
  touchedFiles: [ { path, tool, count, lastSeq } ],   // ≤ limit.sessionMaxFiles，按 lastSeq 降序
  commands: [ { tool, commandRedacted, lastSeq } ],    // ≤ limit.sessionMaxCommands，按 lastSeq 降序
  window: { events: number, truncated: boolean }
}
```

- 文件类工具路径参数：`path`/`file_path`/`filePath`/`target`（以及 `glob`/`grep` 的 `path`）字符串；绝对路径在工作区内转相对，工作区外 token 化；相对路径原样（去 `./`）。
- shell 命令：取 `command` 字符串，`redactText` 后截断 `limit.sessionMaxCommandChars`（300）字符。
- 同一路径多次触碰：`count` 累加、`lastSeq` 取最大、`tool` 取最后一次工具名。
- `tool/result` 错误判定：`data.error != null` 或 `data.message?.isError === true`。
- 会话不可得/空事件：返回空 trace（`sessionId` 仍写入传入值或 null），由调用方加 warning。
- 测试必须覆盖：fixture 事件流提取、路径相对化/token 化、命令脱敏与截断、上限（100 文件/40 命令）、lastSeq 排序、空 trace、不读取消息正文（events 中混入 user/message 也必须被忽略）。

## 3. `src/git.js`（负责人：git-collect）

```js
export function parseGitHead(text) -> {head: string|null, branch: string|null, detached: boolean}
export function parsePackedRefs(text) -> Record<string, string>          // ref -> sha
export function parseReflog(text) -> [{oldSha, newSha, actor, time, message, subject}]
export function parseGitConfig(text) -> {remoteOriginUrl: string|null}
export function parseIndexVersion(bytes) -> number|null                  // DIRC 头 version (2/3/4)
export function buildGitInfo({headText, refs, packedRefs, reflog, config, indexBytes}) -> gitInfo
export async function readGitInfo({io, workspaceRoot}) -> {git: gitInfo|null, warnings: [{code, detail}]}
```

`io` 形状（由调用方适配 `ctx.fs`，测试用 fake）：

```js
{
  async lstat(absPath) -> {type: 'file'|'directory'|'symlink'|'other', size?: number} | undefined,
  async readText(absPath) -> string,        // 不存在/读失败时抛错
  async readBytes(absPath, maxBytes) -> Uint8Array,
  async listDir(absPath) -> [{name, type, size?}]
}
```

`gitInfo`（写进 `manifest.git` 与 `evidence/git.json`，字段顺序固定）：

```js
{
  head: string|null, branch: string|null, detached: boolean,
  remote: string|null,
  lastCommit: {sha, time /* ISO */, subject} | null,
  indexVersion: number|null,
  packedRefsPresent: boolean,
  reflog: [{sha, time, subject}]          // 最多 10 条，新→旧
}
```

- 支持两类 `.git`：目录；或工作区根下 `.git` 文件内容 `gitdir: <path>`（相对路径相对工作区根）。
- HEAD：`ref: refs/heads/<branch>` → 从 loose ref 或 packed-refs 解析；40-hex → detached。解析不到时 `head:null` + warning `GIT_HEAD_UNRESOLVED`。
- reflog：`.git/logs/HEAD`；每行 `<old> <new> <actor> <epoch> <tz>\t<message>`；`time` = epoch 转 ISO（保留时区偏移换算为 UTC ISO）；`subject` = 去掉 `commit: ` 前缀后的文本；reflog 最后一行=最新。
- config：`[remote "origin"]` 段中的 `url`；无 → `remote:null`。
- index：`.git/index` 前 8 字节 `DIRC` + uint32BE version；文件缺失 → `indexVersion:null`。
- `.git` 不存在 → `{git:null, warnings:[{code:'GIT_UNAVAILABLE', detail:'...'}]}`；单个子文件读失败降级为 null + warning（`GIT_HEAD_UNRESOLVED` / `GIT_REFLOG_UNREADABLE` / `GIT_CONFIG_UNREADABLE` / `GIT_INDEX_UNREADABLE`）。
- **不得**调用 `git` 命令、不得读 `git status`、不得读工作区文件内容（只读 `.git` 内文件）。
- 测试必须覆盖：`ref:` 头、detached、packed-refs、reflog 解析与排序、remote URL、`.git` 缺失降级、`.git` 文件（gitdir）、index 版本、损坏行容错。

## 4. `src/collect.js`（负责人：git-collect）

```js
export async function collectWorkspace({workspaceRoot, workspaceCanonical, dshHome, explicitFiles, io, limits, trace}) -> collect
export async function readCopyCandidate({io, workspaceRoot, relPath, limits, denied = isDeniedFile}) -> {path, content, bytes, truncated} | {path, skippedReason}
export function classifyRole(relativePath) -> 'entry'|'config'|'test'|'doc'|'source'|'other'
```

`collect` 形状：

```js
{
  entries: number,            // 访问到的条目数（文件+目录）
  dirs: number,
  denied: number,             // 因 denylist 跳过的条目数
  symlinksSkipped: number,
  tree: [{name, type: 'file'|'directory'|'other', bytes?}],   // 工作区顶层直接子项，≤100，按 name 字典序
  files: [{path, role, bytes, sha256, truncated?, skippedReason?}], // 证据文件，≤200，按 path 字典序
  readBytes: number,          // 哈希/读取累计字节
  explicitFiles: string[],    // 校验通过的显式路径（POSIX 相对）
  warnings: [{code, detail}]
}
```

- 遍历：BFS，深度 ≤ `limits.maxDepth`(4)，条目 ≤ `limits.maxEntries`(4000)；目录列表按 name 排序稳定。
- 跳过（不报错）：denylist（`redact.isDeniedFile`，含 `node_modules`、`.venv`、`.dsh`、`.git`）、symlink（`io.lstat` type==='symlink'，计 `symlinksSkipped`）、非普通文件。超上限时停止并加 warning（`COLLECT_ENTRY_LIMIT` / `COLLECT_DEPTH_LIMIT` / `COLLECT_FILE_LIMIT`）。
- `explicitFiles`：先 `paths.validateRelativePath`，再逐段 `io.lstat` 检查**不得有 symlink 祖先**（任一段 symlink → `HANDOFF_PATH_ESCAPE`），文件必须存在且为文件；denylist 命中 → `HANDOFF_PATH_ESCAPE`（detail 说明 denied）；≤200。
- 自动证据文件选取（去重、按 path 排序，取前 `maxEvidenceFiles`=200）：显式文件；工作区顶层与 ≤3 层的入口/配置/测试/文档候选名（`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`Makefile`、`README*`、`AGENTS.md`、`tsconfig.json`、`*.config.*`、`docker-compose*`、`requirements*.txt`、`test/**`、`tests/**`、`__tests__/**` 中文件名匹配测试模式的文件）；`trace.touchedFiles` 中工作区存在的路径。不得把 `.git`、`.dsh`、denylist 路径纳入。
- 每个证据文件：`io.lstat` 取 size；size > `limits.maxHashBytes`(4MiB) → `skippedReason:'FILE_TOO_LARGE'`、不哈希；否则 `io.readBytes` 哈希，累计 `readBytes` 超 `maxHashTotalBytes`(16MiB) 后停止哈希并 warning。
- `classifyRole` 规则：入口/清单（`package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`/`Makefile`/`README*`/`AGENTS.md`）→ `entry`；`*.config.*`/`tsconfig.json`/`docker-compose*`/`requirements*.txt`/`config/**` → `config`；`test/**`/`tests/**`/`__tests__/**`/`*.test.*`/`*_test.*` → `test`；`docs/**`/`*.md` → `doc`；代码后缀（`.js/.mjs/.cjs/.ts/.tsx/.jsx/.py/.go/.rs/.java/.cs/.c/.h/.cpp/.rb/.php/.sh/.ps1`）→ `source`；其余 `other`。
- `readCopyCandidate`：仅用于 `copyFiles=true`；denylist/symlink/超 `limits.copyMaxFileBytes` → `{skippedReason}`；否则读文本（UTF-8，超限截断并 `truncated:true`）。
- 测试必须覆盖：denylist、深度/条目/文件上限、截断标记、显式 files 越界/不存在/denied、symlink 祖先拒绝与 symlink 跳过、顶层 tree、role 分类、readCopyCandidate 上限。

## 5. `src/manifest.js`（负责人：render-manifest）

```js
export function createManifest(input) -> manifest          // artifacts 为空数组
export function setArtifacts(manifest, artifacts) -> manifest  // 返回新对象，artifacts 按 path 排序
export function serializeManifest(manifest) -> string      // 固定键序 + 2 空格缩进 + 结尾 \n
export function parseManifest(text) -> manifest            // 失败抛 HANDOFF_MANIFEST_INVALID
export function validateManifest(value) -> {ok: boolean, findings: [{severity, code, path?, detail?}]}
export function artifactEntry(path, content) -> {path, bytes, sha256}
export function buildSha256Sums(entries) -> string         // "<sha256>  <path>\n"，path 字典序
export function parseSha256Sums(text) -> [{path, sha256}]
export function isCompleteManifest(value) -> boolean       // schemaVersion/artifacts 等关键字段齐全
```

`input` 字段（全部由 service 组装，均已就绪）：`batchId, createdAt(ISO), generator, project, session, sandbox, inputs, git, files, sessionTrace, redactions, warnings, limits, scan`。

`manifest` 固定键序（与 §8.2 对齐）：

```
schema, schemaVersion, generator, batchId, createdAt, project, session, sandbox,
inputs, git, artifacts, files, sessionTrace, redactions, warnings, limits, scan
```

- `project = {key, name, workspace}`；`workspace` 为 token 化路径。
- `session = {id|null, cwd|null, agentPreset|null}`（cwd token 化）。
- `sandbox = {mode, workspaceRoot}`（workspaceRoot token 化）。
- `inputs` 保存调用方输入：`{title, goal, summary, decisions, nextSteps, concepts, flow, risks, files, copyFiles}`（无值用 null / []，顺序固定）。
- `artifacts`：`[{path, bytes, sha256}]`，只含实际写出的文件（**不含 manifest.json**），按 path 字典序。
- `warnings`：按 `code` 再按 `detail` 字典序。
- `limits` 用 `contracts.publicLimits()` 的结果。
- `validateManifest` 检查：对象、`schema==='dsh-handoff-kit/handoff'`、`schemaVersion===1`、`batchId` 匹配 `BATCH_ID_RE`、`createdAt` 可解析、`project.key/name/workspace` 字符串、`files` 数组、`artifacts` 数组、`limits` 对象；findings severity `error`（结构性）或 `warn`（可疑但可读）。
- `serializeManifest(parseManifest(text))` 必须等于 `text`（往返稳定）。
- 测试必须覆盖：构建↔解析往返、稳定键序、篡改 artifact 触发校验差异（由 service 层用 artifactEntry 重算）、缺字段、非法 JSON、SHA256SUMS 往返。

## 6. `src/render.js`（负责人：render-manifest）

```js
export const HANDOFF_HEADINGS = ['H0','H1','H2','H3','H4','H5','H6','H7','H8','H9','覆盖说明']
export function renderHandoff(manifest) -> string   // UTF-8、LF、结尾 \n、两次渲染字节一致
```

- 只读 `manifest`；不得使用时钟/随机/文件系统。所有路径用 manifest 中的 token 化形式。
- 章节（顺序固定，标题含编号与中文名）：

| 段 | 内容要求 | 缺失输入时 |
|---|---|---|
| H0 身份与边界 | 项目名/`project.key`/`$WORKSPACE`/batchId/生成时间/目标（user/workspace）/适用边界 | 必有 |
| H1 上次做了什么 | `summary`、`goal`、`decisions` 列表、`sessionTrace` 触碰文件（≤15 条，附 lastSeq）、`git.lastCommit` | 写「调用方未提供，待补（生成器不编造）」，不得编造 |
| H2 概念词典 | `concepts` 列表 | 「未提供（P1 会话提取）」 |
| H3 代码地图 | `files` 按 role 分组（entry/config/test/doc/source/other），每条 `路径` + `sha256:<前12位>` + bytes；`scan.tree` 顶层目录表；`sessionTrace.touchedFiles` 中存在的路径 | 只列实际存在的路径；空时写「本次未采集到代码地图」 |
| H4 已验证事实 | **至少**以下断言并带标签：工作区扫描条目数 `[文件哈希]`、git HEAD/branch `[git]`、会话工具调用计数 `[会话]`、调用方 decisions/summary `[输入]`；`[待验]` 用于未覆盖项 | 若无断言，明确写「本次未产生可验证断言」 |
| H5 端到端流程 | `flow` 列表 | 「未提供」 |
| H6 未决/风险/坑 | `risks` 列表 + `warnings` 列表（code + detail） | 至少列已知限制（无 mtime、无 git status、无删除原语） |
| H7 协作方式 | 指向 `$WORKSPACE/AGENTS.md`（`scan.tree` 或 files 中存在时），否则说明未发现；协作纪律 2–3 条 | 指针 |
| H8 新会话首轮动作 | 1) `handoff_pack verify batchId=<id>`；2) 按 H2→H3→H4→H8 阅读；3) 抽查 ≥3 条 H4 断言的哈希（给 PowerShell `Get-FileHash` 与 sha256sum 两种写法）；4) 漂移报告格式（列出断言/期望/实际/结论） | 必有 |
| H9 禁区 | 不得宣称验证未跑、不得用文档覆盖代码、不得省略待验、不得擅自改代码/重启/改库/commit/push | 必有 |
| 覆盖说明 | 扫了什么（条目/文件数）、没扫什么（denylist/上限/无 mtime/无 git status）、哪些待验 | 必有 |

- 强制：每节出现真实项目名/路径/哈希（来自 manifest）；禁止通用套话；`[待验]` 不得伪装成事实。
- 测试必须覆盖：固定输入两次渲染字节一致、H0–H9+覆盖说明齐全、无输入时写「未提供」、token 化路径（不得出现绝对 `C:\`）、H8 含 batchId、确定性。

## 7. Lead 负责的模块（不委派）

`src/write.js`、`src/service.js`、`src/tool.js`、`src/command.js`、`src/skill.js`、`index.js`、`skills/handoff-pack/SKILL.md`、`test/{service,tool,command,skill,index,redact 集成}.test.js`。

## 8. 协作纪律

- 只改自己写域内的文件；`test/helpers/*`、`src/contracts.js`、`src/paths.js` 为**只读共享基线**，需要改动先给 Lead 发消息。
- 每完成一个模块立即运行：`node --check <file>` 与 `node --test "test/<your-tests>.test.js"`（Node 24 目录位置参数不展开，必须用 glob）。
- 测试必须绿；报告：交付文件、测试命令与通过数、与规格的偏差、未决问题。
- 不得 `git add/commit/push`，不得安装 bundle，不得改 DSH 源码，不得写仓库外文件（`%TEMP%` 除外）。
