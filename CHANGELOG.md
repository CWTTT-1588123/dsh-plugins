# Changelog

<!-- docs-meta: status=current; phase=cross; verified=c5fe455@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本按 [ROADMAP](ROADMAP.md) 阶段映射（P0 = 0.1.x）。

## [Unreleased]

## [0.3.1] - 2026-10-22

提示词安全修复（0.3.0 交付后真实事故复现并修复；验收记录勘误见
[docs/handoff-kit/acceptance/P2.md](docs/handoff-kit/acceptance/P2.md) §9）。

### Fixed

- **开场提示词缺少强制只读门（严重）**：新会话把旧文案"请先读它，再继续工作"理解为"立即
  开工"，实际创建了 P3 计划文件并修改仓库文件（已被完整恢复，越界草稿移至仓库外 temp）。
  `renderOpeningPrompt` 现在第一段即声明强制边界：先只读验证、等待用户明确指令；在用户同意前
  禁止修改/创建/删除文件、禁止 commit、禁止自行开始上一阶段后续开发。第 0 步强制
  `handoff_load batchId=<id>` 复核，结果非 `verified` 时立即停止并报告 findings（不自行修复/
  重建）；"建议的下一步"降级为"仅供参考，仍需用户确认"；结尾附"只汇报、不落盘"提醒。
  新增回归测试 `opening prompt embeds a mandatory read-only gate before any work`。

### Changed

- 版本 0.3.0 → 0.3.1；单测 244 → 245。

## [0.3.0] - 2026-10-22

P2（0.3.x）完成首块：**prompt-first UI 工作台**。验收证据见
[docs/handoff-kit/acceptance/P2.md](docs/handoff-kit/acceptance/P2.md)。

### Added

- **Client half（同包 `client.js`，纯 JS 无构建）** 四处注册：输入框左侧「交接」按钮
  （`conversation.input.left`）、浮层小面板（`shell.overlay`）、侧栏面板图标
  （`sidebar.panellist`↔`main` key）、中央「交接工作台」页。
- **宿主 UI RPC**：`/api/handoff-kit/rpc`（`ctx.connection.fetch` 认证同源 JSON；持久 bundle
  无 `host.call`，该通道仅属于动态 Cordis 包——U0 实测结论）。方法 `state` / `detail` /
  `copy` / `create`；只做参数校验（复用 `validateToolArgs` / `validateLoadArgs`）与现有
  `service.run()` / `service.load()` 适配，manifest 解析/校验仍只有 `src/manifest.js` 一份。
- **「生成」Tab**：标题（当前会话标题预填）/ 备注（→ H1 summary）/ 目标 user|workspace
  （点击前显示目标根目录）/ 附带会话改动 diff；结果展示 batchId、真实目录、证据数、warnings、
  血缘；一键复制「新会话开场提示词」（trust 徽章 + 只读文本，复用 load 的 pointers/next 与
  有界 H0/H1/H8 摘要）。
- **「载入」Tab**：批次列表 → verify / drift / findings 详情 → 复制开场提示词 / 插入输入框。
- **「工作台」页**：左批次列表 + 右详情 + 刷新 / 校验 / 生成 / 继续交接（append 默认最新、
  update 二次确认；旧批次不被修改，写入新批次记录 lineage）。
- 新测试：UI RPC 18 条（含真实 service 的端到端 create 回归）+ client 注册 3 条；总计
  223 → 244。

### Changed

- `package.json` 新增 `dsh.client` 声明（`platform: web`、`immediately`、`inject:
  @deepseek-ai/dsh-client-ui-conversation`）、`./client` 导出与 `files` 条目。
- 版本 0.2.1 → 0.3.0；P0/P1 工具 API、`manifest@2`、证据模型与验收记录**未改动**。
- UI 只读动作零写入；写操作必须用户点击并显示目标目录；不联网（仅同源 `/api`）、无子进程、
  无 LLM 调用。

### Known limitations（P2）

- 工作台是 root 作用域：首次从侧栏直接打开、且本页从未点过「交接」时，Host 会话回退可能选中
  其它项目的 live 根会话；点一次输入框「交接」（localStorage hint）后固定到当前会话（GAPS P2-G1）。
- 批次列表/详情未单列「血缘序号」：`handoff_load` 摘要不含 lineage，不为 UI 改 P1 契约；
  lineage 批次在 H0 摘要与 create/append 结果中可见（P2-G2）。
- 无删除/归档 UI（宿主无删除原语）；UI 文案仅中文（P2-G3）。

## [0.2.1] - 2026-10-22

挂账清理补丁（不改变 P1 功能面；台账见 [docs/handoff-kit/GAPS.md](docs/handoff-kit/GAPS.md)）。

### Added

- `manifest.changes.currentTurn`：当前**未完成 turn** 的 file-tool 路径/计次补充
  （来自会话 `tool/call` 元数据，无 added/deleted 行数）；H1 新增「当前未完成 turn 的触碰」、
  H4 增加对应 `[改动]` 断言，缓解"当前 turn 改动不可见"（Session 关闭后不可回读仍为宿主契约限制）。
- `package.json` 增加 `scripts.test`：插件目录 `npm test` 直接运行全部测试（关闭 Node 24
  `node --test` 目录位置参数不展开的 G10 缺口）。
- `docs/handoff-kit/GAPS.md`：P0/P1 缺口台账（已关闭/设计边界/外部缺陷/归档四类，每项可复验）。

### Changed

- 测试/对照批次移动归档到 `%TEMP%\dsh-handoff-kit-archive\`（不删除，保留复查）；
  user 级 handoff 根仅保留正式包 + 本次最终包；workspace `.dsh` 验证批次全部归档。

## [0.2.0] - 2026-10-22

P1（0.2.x）完成：消费闭环 + 真实改动证据 + 批次血缘。验收证据见
[docs/handoff-kit/acceptance/P1.md](docs/handoff-kit/acceptance/P1.md)。

### Added

- **M1 消费闭环**：`handoff_load` 工具（只读：内部 verify → `trust=verified|stale|invalid`
  + findings/drift + 指针；`include=summary|sections|full` 有界摘录）；
  `/handoff resume [<batchId>]`（同一 trust 判定的中文摘要）。
- **M2 真实改动证据**：`manifest@2` 可选 `changes` 块——宿主 `workspaceChanges` 的
  **已完成 turn** 改动（`{available,source,turn,totals,files[],diffs?}`），
  `includeDiffs=true` 附有界 diff（≤20 文件/单文件 64 KiB/总 512 KiB）；H1「本会话改动」、
  H4 `[改动]` 标签；不可用时 `available:false` + `CHANGES_UNAVAILABLE` warning。
- **M2 只读燃料**：`manifest@2` 可选 `fuel` 块——当前 goal 与 session-owned jobs
  （只读快照、不自动执行；缺失降级 `available:false` + warning）；H4 `[goal]`/`[job]` 标签。
- **M2 批次血缘**：`handoff_pack action=append previousBatchId=<id>`（连续交接，默认最新批次）
  与 `action=update supersedes=<id>`（替代声明，默认最新批次）；新建批次 +
  `lineage{sequence,previous,root,supersedes?}`，**不原地修改历史批次**；H0 批次血缘、
  verify 新增 `LINEAGE_BROKEN`（error）/`SUPERSEDED_BATCH`（warn）。
- M3 接口与文档：LLM 叙述增强与自动草稿钩子的未来合同保留在 P1_plan §3.5（按 Q1 不实现运行时）。

### Changed

- `manifest.schemaVersion` 升为 `2`（v1 字段保留 + 可选 `changes`/`fuel`/`lineage`；
  v1 批次只读兼容、不迁移）。
- H8 首步改为 `handoff_load`（纯哈希校验仍可用 `handoff_pack verify`）；
  技能/README 的消费流程同步更新。
- `/handoff` 新增 `append`/`update`/`resume` 动作与 `--previous/--supersedes/--include-diffs/
  --include/--no-verify` 选项。

### Known limitations（P1）

- workspaceChanges 只覆盖**已完成 turn**；create 发生在 turn 中时看不到当前 turn 改动；
  Session 结束后宿主不再提供 summary（新会话只能读包内证据）。
- 无删除 API：E2E/验收产生的批次保留在 `$DSH_HOME/handoff` 与工作区 `.dsh/handoff`（可手动删）。
- M3 的 LLM/自动钩子仅文档合同，未实现运行时（默认关的能力也未实现）。

## [0.1.0] - 2026-10-22

P0「手动生成 + 校验闭环」完成。验收证据见
[docs/handoff-kit/acceptance/P0.md](docs/handoff-kit/acceptance/P0.md)。

### Added

- `dsh-handoff-kit` host-only bundle（`plugins/dsh-handoff-kit/`，零运行时依赖、无 UI/Client 半区）：
  - `handoff_pack` 工具：`scan` / `create` / `verify` / `list`（raw JSON Schema + 参数自校验）；
  - `/handoff` 人类命令（默认 create，支持 `--target/--title/--batch/--force/--all/--copy-files`）；
  - `handoff-pack` bundled 技能（rank 600、source bundled、目录 resourceBase）；
  - 默认用户级输出 `$DSH_HOME/handoff/<project-key>/<batch-id>/`，显式 `target=workspace` 降级；
    无 auto 静默回退，权限拒绝返回结构化错误与两条修法。
- 确定性数据契约：`HANDOFF.md`（H0–H9 + 覆盖说明）、`manifest.json`（schemaVersion 1，最后写入）、
  `SHA256SUMS`（覆盖 HANDOFF.md + evidence/*）、`evidence/{git,files,session,redactions}.json`、
  可选 `evidence/files/`（copyFiles，≤20 文件 / 256 KiB / 2 MiB，复制前脱敏）。
- 证据来源：`.git` 解析（HEAD/loose refs/packed-refs/reflog/config/index，无 git status、无子进程）+
  文件 sha256 + 当前会话 `tool/call` 元数据（路径/命令计数，脱敏+截断，不含消息正文）。
- 脱敏：7 类规则（env/generic assignment、bearer、cloud-key、private-key-block、url-credentials、
  conn-string-password）+ 文件级 denylist + 写盘前终检（命中即整批不写）。
- 测试与文档：14 个测试文件 179 个 `node:test` 用例；`docs/handoff-kit/design/P0_module_interfaces.md`
  模块接口规格；`docs/handoff-kit/acceptance/P0.md` 验收记录。

### Changed

- `generic-assignment` 脱敏规则收紧：裸 `key`/`keys`、点分命名空间 `project.key`、普通 prose
  （如 `target=user …`、`project-key = basename(...)`）不再误报；`env-assignment` 仅匹配大写环境变量名。
  复合密钥名（`api_key`/`privateKey`/…）与真实密钥仍命中。
- `handoff-pack` 技能补充消费提示：Windows/PowerShell 读取 `manifest.json` / `HANDOFF.md` 时需显式 UTF-8
  （`[System.IO.File]::ReadAllText(..., UTF8)` 或 `Get-Content -Encoding utf8`），避免默认 ANSI 解码导致
  中文乱码与 JSON 解析失败（新会话消费实测踩坑，技能 provider 逐次读文件，修改即时生效）。

### Fixed

- 修复验收中发现的调用方文本误脱敏（HANDOFF concepts 被占位符替换）；
- 修复 verify 把 `SHA256SUMS` 自身误判为「应从 SHA256SUMS 覆盖」的问题；
- 修复 verify `SOURCE_FILE_*` 对未哈希/已跳过证据文件的误报；
- 修复 `manifest.json` 未记录 `target` 导致 H0 无法如实声明输出目标的问题。

### Known limitations（P0 如实声明）

- 无 `git status`（P0 禁子进程）、无 mtime（fs 无此 API）、无删除原语（失败留下不完整批次）；
- linked bundle 改 JavaScript 需重启 Desktop 或 `remove_bundle` + `install_bundle` 重装；
- `read-only` / `workspace-write` 真实权限链路未实测（fake 策略单测覆盖，见验收缺口 G5）；
- `/handoff` 命令的 Web UI 键入未驱动验证（注册有单测，见验收缺口 G8）；
- 错误码以 message 前缀 + `error.code` 暴露（注册表只对内置 `HarnessError` 保留结构化 info）。
