# dsh-handoff-kit P0 实施计划（P0 基线，已冻结）

<!-- docs-meta: status=frozen; phase=P0; verified=c275312@2026-10-22; tracks=plugins/dsh-handoff-kit/src; supersedes=-; superseded-by=- -->

> 版本：v2（2026-10-22）。替代历史文档中过时条款；裁决依据见
> [`docs/adr/0001-handoff-kit-repo-and-decisions.md`](../../adr/0001-handoff-kit-repo-and-decisions.md)。
> 实施会话：工作区 = `D:\repos\dsh-plugins`，权限 danger-full-access。

## 1. 目标与边界

**目标**：把“通用交接包生成器”做成 DSH host-only bundle，手动触发，生成
`HANDOFF.md` + `manifest.json` + 证据，且可被新会话校验与消费。

**P0 范围内**
- `handoff_pack` 工具：`scan` / `create` / `verify` / `list`；
- `/handoff` 人类命令；
- `handoff-pack` 技能；
- 默认用户级输出 `$DSH_HOME/handoff`，显式 `target=workspace` 降级；
- 证据：git HEAD/reflog + 文件 sha256 + 会话 `tool/call` 元数据；
- 零运行时依赖，本地安装，可回滚。

**P0 不做**：UI/Client 半区、LLM、DB、自动阈值或 compaction 钩子、
goal/task board/job 集成、网络、子进程、自动 commit/push。

## 2. 已核实的运行环境与硬约束（2026-10-22）

| 事实 | 值 | 影响 |
|---|---|---|
| DSH 版本 | `0.2.1-rc.2`（Desktop / profile `desktop`） | `engines.dsh: >=0.2.0 <0.3.0` |
| DSH_HOME | `C:\Users\32098\.dsh` | 用户级输出根 = `$DSH_HOME/handoff` |
| `ctx.fs` 后端 | `dsh-fs-sandbox`（dsh-base 装配） | `workspace-write` 只能写工作区根或系统临时目录 |
| `writeText` | 自动 `mkdir -p` 父目录 | 无需 mkdir 原语 |
| `ctx.fs` 能力缺口 | 无 mtime、无删除、无 mkdir 原语 | 不能做“最近改动”；失败不能清理 |
| 沙箱策略 | `ctx.sandboxPolicy.resolve({session})` → `{mode, workspaceRoot, sessionId}` | 每次写必传 policy |
| 子进程 | P0 禁用 | 不能 `git status`；git 信息靠解析 `.git` 文件 |
| 会话事件 | `ctx.sessions.get(agent.id).ownEvents()`（只读） | 可挖 `tool/call` 元数据 |
| 工具注册范式 | 原始 JSON Schema 注册（已装 `dsh-session-insights` 为证） | 零依赖、不 import `@deepseek-ai/*` |
| 技能注册范式 | `ctx.skills.registerProvider` + 打包 `SKILL.md`（已装 `dsh-grill-me` 为证） | rank 600、source bundled |
| Node | `v24.21.0` | `node --test` 可用 |

## 3. 仓库与插件结构

```
D:\repos\dsh-plugins\
├── ROADMAP.md / CHANGELOG.md / README.md
├── docs/
│   ├── adr/0001-handoff-kit-repo-and-decisions.md
│   └── handoff-kit/
│       ├── design/…（本文件 + 历史 3 份）
│       ├── acceptance/P0.md（验收时写）
│       └── START_PROMPT.md
└── plugins/
    └── dsh-handoff-kit/
        ├── package.json
        ├── cordis.patch.yml
        ├── index.js
        ├── icon.svg
        ├── locale/{en,zh}.json
        ├── skills/handoff-pack/SKILL.md
        ├── src/
        │   ├── contracts.js      # 参数/输出 JSON Schema、错误码、上限（测试共用）
        │   ├── paths.js          # DSH_HOME 解析、project-key、batch-id、containment
        │   ├── git.js            # 解析 .git/HEAD、refs、packed-refs、reflog、config
        │   ├── collect.js        # 有界工作区采集（deny/allowlist、symlink、截断）
        │   ├── session-trace.js  # 会话 tool/call 元数据挖掘
        │   ├── redact.js         # 脱敏规则 + 计数 + 终检
        │   ├── manifest.js       # manifest 构建/校验/哈希、SHA256SUMS
        │   ├── render.js         # HANDOFF.md（H0–H9）确定性渲染
        │   ├── write.js          # sandbox policy 解析 + 写入计划（manifest 最后）
        │   ├── service.js        # scan/create/verify/list 编排
        │   ├── tool.js           # handoff_pack 定义（raw JSON Schema + 自校验）
        │   ├── command.js        # /handoff
        │   └── skill.js          # 打包 SKILL.md 的 skills provider
        ├── test/（fixtures、fake-fs、fake-ctx、*.test.js）
        └── README.md
```

## 4. 包与装配

### 4.1 package.json

```json
{
  "name": "dsh-handoff-kit",
  "version": "0.1.0",
  "private": true,
  "description": "Deterministic session handoff packages (HANDOFF.md + manifest.json) for DeepSeek Harness",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "src", "skills", "locale/*.json", "icon.svg", "cordis.patch.yml", "README.md"],
  "engines": { "dsh": ">=0.2.0 <0.3.0" },
  "license": "MIT"
}
```

无 `dependencies` / `peerDependencies`。`icon.svg` 为原创图标（≤256 KiB）。

### 4.2 cordis.patch.yml

```yaml
# dsh-handoff-kit：host-only bundle，无 Client 半区。
# 提供 handoff_pack 工具、/handoff 命令、handoff-pack 技能。
- insert:
    - id: dsh-handoff-kit
      name: dsh-handoff-kit
```

### 4.3 index.js

```js
export const name = 'dsh-handoff-kit'
export const inject = ['tools', 'commands', 'skills', 'fs', 'sessions', 'sandboxPolicy']

export function apply(ctx) {
  const service = createService(ctx)
  ctx.effect(() => ctx.tools.register(createTool(service)))
  ctx.effect(() => ctx.commands.register(createCommand(service)))
  ctx.effect(() => ctx.skills.registerProvider(createSkillProvider()))
}
```

会话与策略解析（只用公开 API）：
`exec.agent.id` → `ctx.sessions.get(id)` → `session.header.cwd`；
`ctx.sandboxPolicy.resolve({ session })` → 写入策略；命令侧 `invocation.agent.id` 同理。
会话缺失（agentless）时降级：workspace 取 `ctx.workingDirectory.defaultDirectory`，
策略取 `ctx.sandboxPolicy.resolve()`，并在结果中给 warning。

## 5. 工具契约：`handoff_pack`

**描述（英文）**：`Create, scan, verify, or list deterministic session handoff packages
(HANDOFF.md + manifest.json) for the current workspace. Use before ending a long session
or handing work to a new session; a new session should verify and read HANDOFF.md before
trusting its claims.`

**参数**（根 `type:object, additionalProperties:false`）

| 参数 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `action` | enum | ✅ | — | `scan`（只采集+预览，不写盘）/`create`/`verify`（只读）/`list` |
| `target` | enum | | `user` | `user`=`$DSH_HOME/handoff`；`workspace`=`<workspace>/.dsh/handoff` |
| `title` | string | | — | ≤200 |
| `goal` | string | | — | ≤4000 |
| `summary` | string | | — | ≤8000，H1 叙述（调用方提供，生成器不编造） |
| `decisions` | string[] | | — | ≤50 条 × 2000 |
| `nextSteps` | string[] | | — | ≤50 条 × 1000 |
| `concepts` | string[] | | — | ≤50 条 × 1000，H2 |
| `flow` | string[] | | — | ≤50 条 × 1000，H5 |
| `risks` | string[] | | — | ≤50 条 × 1000，H6 |
| `files` | string[] | | — | ≤200，工作区相对路径；绝对路径/`..` 直接拒绝 |
| `copyFiles` | boolean | | `false` | 脱敏复制进 `evidence/files/`，≤20 个/≤256 KiB/≤2 MiB |
| `batchId` | string | | — | verify/list 定位；缺省=当前项目最新批次 |
| `all` | boolean | | `false` | list 列所有项目（默认只列当前项目） |
| `force` | boolean | | `false` | 允许覆盖同名批次；默认 `createIfAbsent` |

**返回（canonical JSON）**

```json
{
  "ok": true,
  "action": "create",
  "dir": "$DSH_HOME/handoff/stand-1a2b3c4d/20261022T023512Z-a1b2",
  "displayDir": "C:\\Users\\32098\\.dsh\\handoff\\...",
  "project": { "key": "stand-1a2b3c4d", "name": "stand", "workspace": "$WORKSPACE" },
  "batchId": "20261022T023512Z-a1b2",
  "artifacts": [ { "path": "HANDOFF.md", "bytes": 12345, "sha256": "…" } ],
  "totals": { "files": 42, "readBytes": 512000, "artifacts": 5, "artifactBytes": 45678, "redactions": 3, "warnings": 1 },
  "redactions": [ { "file": "docs/x.md", "kind": "bearer-token", "count": 1 } ],
  "warnings": [ { "code": "NO_MTIME_API", "detail": "recency unavailable" } ],
  "git": { "head": "6180456", "branch": "fde-mm-integration", "detached": false, "lastCommit": { "sha": "…", "time": "…", "subject": "…" } },
  "verification": null,
  "preview": { "text": "…", "truncated": false },
  "next": ["read $DIR/HANDOFF.md", "handoff_pack verify --batch …"]
}
```

- `scan`：返回清单 + `preview.text`（≤12000 字符），**零写入**。
- `create`：scan + 写入；manifest 最后写。
- `verify`：只读，返回 `verification` 报告（不写盘）。
- `list`：只读 handoff 根，按 batch-id 降序。
- `output.render` → 1–3 行文本摘要；`isConcurrencySafe: args.action !== 'create'`；
  `timeoutMs: 120000`（由 `dsh-tool-call-timeout-policy` 包装）。
- 参数自校验（raw JSON Schema 工具不由注册表校验），失败抛 `HANDOFF_INVALID_ARGS`。

**错误码**（抛错对象带 `code`，注册表保留 `{name, code}`）：
`HANDOFF_INVALID_ARGS`、`HANDOFF_READ_ONLY`、`HANDOFF_SANDBOX_DENIED`、
`HANDOFF_PATH_ESCAPE`、`HANDOFF_BATCH_EXISTS`、`HANDOFF_BATCH_NOT_FOUND`、
`HANDOFF_MANIFEST_MISSING`、`HANDOFF_MANIFEST_INVALID`、`HANDOFF_WRITE_FAILED`、
`HANDOFF_SECRET_CHECK_FAILED`。

## 6. 命令契约：`/handoff`

```
name: handoff
description: 生成/校验会话交接包（HANDOFF.md + manifest.json）
input.hint: [create|scan|verify|list] [--target user|workspace] [--title TEXT] [--batch ID] [--force]
```

- 默认 `create`；`/handoff verify <batchId>`；`/handoff list`。
- 返回 `{kind:'success', text}`（中文摘要：目录、字节、sha256 前缀、warnings、
  新会话开场指引）或 `{kind:'error', text}`（错误码 + 原因 + 修法）。
- 不产生模型消息（commands 契约）。

## 7. 技能契约：`handoff-pack`

- 打包 `skills/handoff-pack/SKILL.md`；`ctx.skills.registerProvider`，
  `rank: 600`、`source: 'bundled'`、`resourceBase: {kind:'directory'}`。
- frontmatter：`name: handoff-pack`；description（中文）：
  `生成、校验或消费当前工作区的确定性会话交接包（HANDOFF.md + manifest.json）。`
- 正文：何时用 / 怎么生成（scan→create）/ 权威顺序（manifest 哈希 > HANDOFF 断言 > 会话记忆）/
  新会话怎么读（verify → H0/H2/H3/H4/H8 → 抽查哈希）/ 边界（不编造、不含密钥、不 commit/push、不联网）。

## 8. 数据契约

### 8.1 目录与命名

```
$DSH_HOME/handoff/                     # 默认根（target=user）
<workspace>/.dsh/handoff/              # 降级根（target=workspace，已被双方 .gitignore 忽略）
└── <project-key>/
    └── <batch-id>/
        ├── HANDOFF.md
        ├── SHA256SUMS
        ├── manifest.json            # 最后写；存在 = 批次完成
        └── evidence/
            ├── git.json
            ├── files.json
            ├── session.json         # 会话 tool/call 元数据（无消息正文）
            ├── redactions.json
            └── files/…              # 仅 copyFiles=true
```

- `project-key` = `sanitize(basename(repoRoot)) + '-' + sha256(git remote origin URL ‖ realpath(workspace))[:8]`；
  字符集 `[a-z0-9._-]`；远程 URL 优先（跨克隆稳定）。
- `batch-id` = `YYYYMMDDTHHmmssZ` + `-` + 4 hex（定宽，字典序=时间序）。
- 机器路径 token 化：`$WORKSPACE`、`$DSH_HOME`；`displayDir` 仅供人类。

### 8.2 manifest.json（`schemaVersion: 1`）

字段：`schema`、`schemaVersion`、`generator{name,version,dshVersion,platform}`、`batchId`、
`createdAt`、`project{key,name,workspace}`、`session{id,cwd,agentPreset}`、
`sandbox{mode,workspaceRoot}`、`inputs{…}`、`git{head,branch,detached,remote,lastCommit,indexVersion,packedRefsPresent}`、
`artifacts[{path,bytes,sha256}]`、`files[{path,role,bytes,sha256,truncated?,skippedReason?}]`、
`sessionTrace{…}`、`redactions[{file,kind,count}]`、`warnings[{code,detail}]`、`limits{…}`。

规则：键序固定、UTF-8/LF、结尾换行；manifest 不自哈希，其余文件哈希进 `artifacts[]` 与
`SHA256SUMS`（`SHA256SUMS` 覆盖 HANDOFF.md + evidence/*，manifest 覆盖 SHA256SUMS）。

### 8.3 HANDOFF.md（H0–H9）

| 段 | 内容 | 缺失时 |
|---|---|---|
| H0 身份与边界 | 项目、`$WORKSPACE`、batch、生成时间、适用边界 | 必有 |
| H1 上次做了什么 | `summary`/`goal`/`decisions` + `sessionTrace` 触碰文件 + 最近 git 提交 | 写“调用方未提供，待补”，不编造 |
| H2 概念词典 | `concepts` | “未提供（P1 会话提取）” |
| H3 代码地图 | 入口/配置/测试 + 顶层目录 + 会话触碰文件，每条带路径与存在证据/sha256 | 只列实际存在路径 |
| H4 已验证事实 | 断言/证据/标签（`[文件哈希]`/`[git]`/`[会话]`/`[输入]`/`[待验]`）/核对日期 | 无则声明“本次未产生可验证断言” |
| H5 端到端流程 | `flow` + 证据 | “未提供” |
| H6 未决/风险/坑 | `risks` + warnings（无 mtime、无 git status、脱敏计数等） | 至少列已知限制 |
| H7 协作方式 | 指向 `$WORKSPACE/AGENTS.md`（存在时） | 指针 |
| H8 新会话首轮动作 | verify → 读 H2/H3/H4 → 抽查哈希 → 漂移报告格式 | 必有 |
| H9 禁区 | 不得宣称已验证未跑、不得文档覆盖代码、不得省略待验、不得擅自改代码/重启/改库 | 必有 |
| 覆盖说明 | 扫了什么/没扫什么/哪些待验 | 必有 |

强制：每节出现真实项目名/路径/哈希；禁止通用套话；`[待验]` 不得伪装事实。

### 8.4 会话 trace（`evidence/session.json`）

```json
{
  "sessionId": "session-…",
  "eventCounts": { "total": 1200, "toolCalls": 88, "toolErrors": 3 },
  "toolCalls": { "total": 88, "byName": { "write": 12, "edit": 30, "read": 40 } },
  "touchedFiles": [ { "path": "docs/a.md", "tool": "edit", "count": 3, "lastSeq": 812 } ],
  "commands": [ { "tool": "pwsh", "commandRedacted": "pytest …", "lastSeq": 790 } ]
}
```

规则：只读 `ctx.sessions.get(agentId).ownEvents()`，取最后 ≤2000 事件 / ≤400 KB；
只从 `tool/call` 提取：文件类工具（`write`/`edit`/`read`/`read_image`/`str_replace_editor`/
`glob`/`grep`）的路径、shell 类（`pwsh`/`bash`）命令（脱敏+截断 300）；`tool/result` 统计错误。
**不含 user/assistant 消息正文**；≤100 文件、≤40 命令；按 lastSeq 排序；
会话不可得时写空 trace + warning。

### 8.5 verify 报告（只读返回）

`{ok, batchId, dir, checkedAt, findings[], drift{}, counts{}}`；findings 排序稳定
（severity→code→path）。检查项：`MANIFEST_MISSING`、`MANIFEST_INVALID`、`ARTIFACT_MISSING`、
`ARTIFACT_HASH_MISMATCH`、`SHA256SUMS_MISMATCH`、`PATH_ESCAPE`、`SYMLINK_ESCAPE`、
`SECRET_RESIDUE`（error）；`GIT_HEAD_CHANGED`、`SOURCE_FILE_CHANGED`、
`SOURCE_FILE_MISSING`、`DIR_INCOMPLETE`（warn/error 见实现）。
`ok = error 数为 0`；同状态重复 verify 除 `checkedAt` 外完全一致。

### 8.6 脱敏

规则：`env-assignment`、`generic-assignment`（key/token/secret/password/authorization/bearer）、
`bearer`、`cloud-key`（`sk-…`/`AKIA…`/`ghp_…`）、`private-key-block`、`url-credentials`、
`conn-string-password`。命中替换为 `«REDACTED:<kind>»`，`redactions[]` 只记
`{file,kind,count}`。文件级 denylist：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`*.p12/*.pfx`、
`*credential*`、`*.db/*.sqlite*`、`node_modules/`、`.venv/`、`.git/`（只按需读 HEAD/refs/reflog/config）。
终检：待写字符串再过一遍规则，仍命中 → `HANDOFF_SECRET_CHECK_FAILED`，整批不写。

### 8.7 路径与沙箱

1. 解析 session/policy（见 §4.3）。
2. `target=user` 且 `mode !== 'danger-full-access'` → `HANDOFF_SANDBOX_DENIED`（提示两条修法：
   切 danger-full-access 或 `target=workspace`）；`read-only` → `HANDOFF_READ_ONLY`。
3. 每次写 `ctx.fs.writeText(target, text, intent, signal, policy)` **必传 policy**。
4. 目标路径 `fs.resolve(abs)` + `fs.contains(根target, child)` 双校验；
   采集时 `fs.lstat` 发现 `symlink` 直接跳过并记 warning。
5. 无删除 API：失败返回已写清单 + `partial:true`，不尝试清理；verify/list 对无 manifest 目录报告不完整。

### 8.8 采集上限

总访问条目 ≤4000、深度 ≤4、读取文件 ≤60、单文件读 ≤128 KiB（截断标记）、总读 ≤1.5 MiB、
哈希单文件 ≤4 MiB；denylist 优先；目录清单只取名字/类型/大小。**无 mtime ⇒ 不产出“最近改动”**，
以会话 trace + git reflog 替代并在产物中标注。

## 9. 测试与验收

### 9.1 单元测试（`node --test plugins/dsh-handoff-kit/test/`，不依赖 DSH）

| 模块 | 用例 |
|---|---|
| paths | project-key（remote vs path）、batch-id 定宽排序、`..`/绝对/盘符/UNC/大小写 containment、symlink 拒绝 |
| git | `ref: refs/heads/x`、detached、packed-refs、reflog、remote URL、`.git` 缺失降级 |
| collect | denylist、深度/条目/字节上限、截断标记、显式 files 越界拒绝、symlink 跳过 |
| session-trace | fixture 事件流提取、脱敏、上限、lastSeq 排序、空 trace、仅 ownEvents |
| redact | 每规则命中、二次脱敏幂等、`.env` 不落盘、终检失败中止 |
| render | 固定时钟两次渲染字节一致、H0–H9 齐全、无输入写“未提供”、路径 token 化 |
| manifest | 构建↔解析往返、篡改任意 artifact 触发 HASH_MISMATCH、缺文件、路径逃逸、稳定键序 |
| service | scan 零写入；create 写入顺序（manifest 最后）；verify 幂等；list 降序；沙箱矩阵 |
| tool | 参数自校验、输出符合 output.schema、错误码 |
| command | 默认 create、各选项解析、错误文本 |
| skill | SKILL.md frontmatter、candidate/definition、get() 正文 |
| index | fake-ctx：注册 tool/command/skill + dispose |

门槛：0 fail；`node --check` 全绿；真实工作区 `scan` ≤2s。

### 9.2 L1–L3（实机，profile 备份后）

**L1**：`install_bundle` → `application: applied`；工具可见；`/handoff` 可用；
scan 零写入；create 目录含 HANDOFF/manifest/SHA256SUMS/evidence；外部 `Get-FileHash` 复算一致；
list 有批次；verify `ok:true` 且连跑两次稳定。

**L2**：`files:['../AGENTS.md']` / 绝对路径 → `HANDOFF_PATH_ESCAPE`；junction/symlink 夹具被拒/跳过；
`.env` 拒绝且产物无密钥（正则扫描）；新会话仅凭 HANDOFF+manifest 回答“做到哪/下一步/要复核什么”。

**L3**：read-only 会话 create → `HANDOFF_READ_ONLY`；workspace-write + `target=user` →
`HANDOFF_SANDBOX_DENIED`（预检查，不触 fs）；danger-full-access + user 成功；
`remove_bundle` 回滚后 profile 与备份一致（仅差 bundle 记录）；DSH 官方源码零改动。

> read-only / workspace-write 的真实链路需切换会话权限（用户操作）；否则用 fake 策略单测覆盖，
> 并在验收记录中如实标注“未实测”。

### 9.3 已知缺口（验收如实记录）

无 git status、无 mtime、无删除原语、linked bundle 改码需重启 Desktop。

## 10. 实施阶段

| 阶段 | 产出 | 门槛 |
|---|---|---|
| A 骨架 | 目录、package.json、patch、locale、icon、README、contracts.js | JSON/YAML 可解析；`node --check` 全绿 |
| B 纯逻辑 | paths/git/collect/session-trace/redact/render/manifest + 单测 | `node --test` 0 fail；确定性/逃逸/脱敏先绿 |
| C 装配 | service/tool/command/skill/index + fake-ctx 单测 | 注册与错误码单测绿；scan 零写入 |
| D 安装 spike | 备份 profile → `install_bundle` → 工具可见 → 只跑 scan | `application: applied`；scan 无副作用 |
| E 实机闭环 | create/verify/list + 外部 Get-FileHash | L1 全过 |
| F 边界 | 逃逸/脱敏/force/partial；read-only/workspace-write（按许可） | L2/L3 全过或如实标注 |
| G 收尾 | `docs/handoff-kit/acceptance/P0.md`、ROADMAP 状态、CHANGELOG、本地 commit | 回滚演练通过；记录完整 |

安装目标：`D:\repos\dsh-plugins\plugins\dsh-handoff-kit`（绝对目录，`plugin_manager install_bundle`）。
备份：`C:\Users\32098\.dsh\profiles\desktop\{package.json,cordis.patch.yml,pnpm-lock.yaml}`。
回滚：`plugin_manager remove_bundle dsh-handoff-kit`，必要时还原上述备份。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| linked bundle 改码需重启 | 单测全绿再安装；验收缺陷集中修改后一次重启 |
| 无删除 API，半批次残留 | 写入顺序 manifest 最后；失败报告 partial；verify 报 DIR_INCOMPLETE |
| 全局工具 schema 成本 | 接受（+400~600 tokens）；P1 可评估按 preset 收窄 |
| 脱敏漏检 | denylist + 终检双保险；绝不读环境变量密钥 |
| Windows junction/symlink 逃逸 | lstat 拒绝 + containment 双校验 + 单测/夹具 |
| 大仓库采集开销 | 采集上限 + denylist；scan 实测 ≤2s，超标则降上限 |
| 用户级输出需 full-access | 预检查 + 明确修法；`target=workspace` 降级可用 |

## 12. 完成定义

1. `node --test` 0 fail；`node --check` 全绿；
2. L1–L3 验收记录写入 `docs/handoff-kit/acceptance/P0.md`（命令、输出、外部哈希、已知缺口）；
3. `ROADMAP.md` P0 状态改 done；`CHANGELOG.md` 记 0.1.0；
4. 本仓库内本地 git commit，不 push。
