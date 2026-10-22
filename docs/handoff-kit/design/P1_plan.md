# dsh-handoff-kit P1 实施计划

<!-- docs-meta: status=frozen; phase=P1; verified=c275312@2026-10-22; tracks=plugins/dsh-handoff-kit/src; supersedes=-; superseded-by=- -->

> 版本：v1（2026-10-22，已评审）。对应 [ROADMAP](../../../ROADMAP.md) P1、[ADR-0001](../../adr/0001-handoff-kit-repo-and-decisions.md) 决策 17–19。
> 状态：**已完成（frozen）**——M1–M3 已实现并验收（见 [P1 验收记录](../acceptance/P1.md)）；后续变更按文档治理流程走新 ADR/新计划，不改本文件正文。
> 证据标记：`【已核实】`=本会话用 `cordis_inspect`/源码/实测确认；`【实证】`=仓库文件引用；`【待验】`=未验证并写明验证方式；`【推断】`=基于已核实事实的推理。

## 0. 实施状态快照（单一权威）

| 项 | 值 | 核对方式 |
|---|---|---|
| 当前 HEAD | `607e2cb`（P0 已 done；工作树 clean） | `git log --oneline -1` 【已核实】 |
| P0 基线版本 | `dsh-handoff-kit 0.1.0`，已在 desktop profile 安装（`link:` 本地目录） | `plugin_manager list_bundles` / profile package.json 【已核实】 |
| DSH / profile | `0.2.1-rc.2` / `desktop`（Desktop） | 安装 manifest + `$DSH_PROFILE=desktop` 【已核实】 |
| P0 验收 | [P0 验收记录](../acceptance/P0.md)：L1–L3 全过（严格口径） | 验收记录 §0/§5 【已核实】 |
| P1 目标版本 | `0.2.x` | ROADMAP 状态总览 【实证】 |
| P1 计划审批 | 2026-10-22：Q1 = M3 只留接口；Q2 = append/update 新建批次+血缘；Q3 = verify error 时 load 返回 `trust='invalid'`；Q4 = manifest 升 v2；Q5 = ROADMAP 改 task board 口径 | 用户决策记录（§10）【已核实】 |

**一句话结论**：P1 把 P0 的"手动生成 + 校验闭环"升级为"**真实改动证据 + 消费闭环 + 批次演进**"，并保留 P0 的全部硬约束（host-only、零运行时依赖、禁子进程/网络/默认 LLM、手动触发）。建议按 M1→M2→M3 三个里程碑推进，每个里程碑单独验收；M3（opt-in LLM/自动钩子）建议**默认关闭且可整体推迟**——这是本计划需要你拍板的第一项。

## 1. 目标与边界

**P1 要做的（对应 ROADMAP P1 六条）**

1. `handoff_load` 工具 + `/handoff resume`：verify → 读取 manifest/HANDOFF → 漂移报告 → 指针式消费（消费闭环）；
2. `ctx.workspaceChanges` 真实改动证据：把"本会话实际改了哪些文件/多少行"写进交接包（**保持禁子进程**，用宿主已有服务）；
3. 批次 `append` / `update` + `supersedes` 链：同一工作连续交接（append-only，不原地改历史批次）；
4. goal / jobs 只读燃料（确定性证据，不引入自动执行）；**task board 本阶段不接入**（理由见 §7 R5）；
5. opt-in LLM 叙述增强：**P1 仅预留接口/配置与文档，不启用**（Q1 决议）；
6. 自动草稿钩子：**P1 仅预留接口与文档，不实现自动写盘**（Q1 决议）。

**P1 不做（延续 P0 边界）**：UI/Client 半区、网络、子进程、DB、自动执行 next steps、自动 commit/push、默认 LLM、原地修改历史批次、任务板/团队集成。

**P1 门槛**（ROADMAP 原文，验收时逐条给证据）：真项目连续两次交接；漂移检测准确；自动草稿不误触发；成本与隐私可测。

## 2. 与 P0 的兼容策略

| 项 | P0 现状 | P1 策略 |
|---|---|---|
| manifest schema | `schemaVersion: 1`（17 键 + `target`） | **新增 `schemaVersion: 2`**：全部 v1 字段保留，新增 `changes`/`fuel`/`lineage` 可选块；verify 同时接受 1 与 2；不迁移旧批次（只读兼容） |
| HANDOFF 结构 | H0–H9 + 覆盖说明 | 不新增/不重排章节；H1 增加"本会话改动"子节（有 `changes` 时），H4 增加 `[改动]` 证据标签，H8 增加 resume 指引 |
| 工具面 | `handoff_pack` 四动作 + `/handoff` + 技能 | 新增 `handoff_load` 工具（独立 schema，约 +150 tokens）；`/handoff resume` 子命令；`handoff_pack` 增加 `append`/`update` 动作（动作枚举扩展，参数向后兼容） |
| 依赖 | 零运行时依赖 | 不变；新服务一律 `ctx.get(...)` 可选访问，缺失时降级 + warning（不硬注入，避免破坏激活） |
| 证据真实 | git HEAD/ref + sha256 + tool/call | 增加 `[改动]`（workspaceChanges）与 `[goal]`/`[job]` 可选标签，仍不编造 |

## 3. 能力与接口

### 3.1 `handoff_load` 工具 + `/handoff resume`（M1，最高优先级）

**工具参数**（根 object，`additionalProperties:false`）：

| 参数 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `batchId` | string | 最新批次 | `YYYYMMDDTHHmmssZ-xxxx` |
| `target` | enum `user|workspace` | `user` | 与 P0 语义一致 |
| `verifyFirst` | boolean | `true` | 先跑 verify；`ok:false` 时仍返回 findings 但不给"可采信"结论 |
| `include` | enum `summary|sections|full` | `summary` | summary=结论+指针；sections=附 H1/H4/H8 摘录（≤4000 字符）；full=附完整 HANDOFF（≤24 KiB，超限截断并标注） |

**返回（canonical）**：`{ok, batchId, dir, displayDir, verification:{ok,counts,findings,drift}, trust:'verified|stale|invalid', handoff:{path,sections?:{...},excerpt?,truncated?}, manifest:{path,createdAt,gitHead,inputsSummary}, pointers:[{label,path}], next:[string], warnings}`。

**行为**：

- 只读（不写盘）；`verifyFirst=false` 时 `trust` 最多为 `stale`（未校验不得宣称可信）；
- `trust` 判定：verify ok → `verified`；只有 warn/漂移 → `stale`；有 error → `invalid`；
- 指针式消费：默认只回摘要与路径，正文由模型用文件工具按需读取（避免把 10–20 KiB HANDOFF 塞进上下文）。

**命令** `/handoff resume [<batchId>] [--target ...] [--include ...]`：中文摘要（trust、错误码、漂移项、下一步指引），不产生模型消息；`handoff_load` 与 `resume` 共用同一 service 方法。

**错误码**：复用 P0；新增 `HANDOFF_RESUME_NOT_FOUND`（不存在批次，附 list 指引）与 `HANDOFF_VERIFY_INVALID`（verify 有 error 时 resume 拒绝宣称可信——具体行为见 §10 Q3）。

### 3.2 workspaceChanges 真实改动证据（M2）

**已核实的宿主契约**【已核实】（`cordis_inspect Service.workspaceChanges` + `dsh-workspace-changes` 源码）：

- `ctx.workspaceChanges.summary(sessionId, seq): WorkspaceChangesSummary | undefined`——`seq` 为 Session 事件 `workspace/changes` 的 seq（事件 data 仅 `{turn}`）；
- `summary = {turn, cwd, files:[{path, display, added, deleted, binary?, oversized?}], total, added, deleted, snapshot?:{before,after}}`；
- `ctx.workspaceChanges.diff(sessionId, seq, index, signal)` 可给出单文件 `WorkspaceFileDiff`（text hunks / binary / oversized）；
- **仅在 Session 存活期内可读**（`summary` 返回 undefined 当 Session disposed）；按**顶层 turn** 在 turn 开始/结束快照；非 git 仓库退化为"只列 file-tool 改动"；宿主任一实现会内部用 `subprocess+git`（这是**宿主服务**，不是本插件起子进程，符合 ADR 17）。

**P1 数据采集**（`src/changes.js`，纯逻辑 + 注入式 reader，可单测）：

1. 从当前 Session `ownEvents()` 过滤 `type==='workspace/changes'`，取**最后一条已完成 turn** 的 event seq（当前未结束 turn 不出现——见 §7 R1）；
2. `summary(sessionId, seq)` → 归一化为 `manifest.changes`；
3. 可选取 `includeDiffs`：对 ≤`maxDiffFiles`(20) 个文件调 `diff()`，单文件 ≤64 KiB、总计 ≤512 KiB，截断标 `truncated`；
4. 路径 token 化（`$WORKSPACE`）与脱敏复用 P0 `paths.redact`；`[改动]` 断言写入 H1/H4。

**manifest.changes 形状（v2 新增，字段全可选）**：

```js
changes: {
  available: boolean, source: 'workspace-changes', turn: number|null,
  totals: {files, added, deleted, binary, oversized},
  files: [{path, added, deleted, binary?, oversized?}],   // ≤500（宿主上限），按 path 排序
  diffs?: [{path, kind:'text'|'binary'|'oversized', hunks?, truncated?}],
  collectedAt: ISO, note?: string
}
```

**降级**：服务缺失/agentless/Session 已 disposal/当前 turn 无完成记录 → `available:false` + warning `CHANGES_UNAVAILABLE`（带原因），**不阻塞** create；H4 写 `[待验]` 而不是编造。

### 3.3 批次 `append` / `update` + `supersedes` 链（M2）

**决策（请审 §10 Q2）**：不原地修改历史批次（fs 无"原子替换整批"且 verify 以不可变为前提），两种动作都**新建批次**并写血缘：

- `handoff_pack action=append`：`previousBatchId`（必填，默认最新批次）+ 新内容 = 本次会话自上一批以来的 delta 叙述 + 全量证据；manifest 写 `lineage:{sequence, previous, root}`；H0 标注"承接 <previous>"；
- `handoff_pack action=update`：`supersedes`（必填，目标批次）——语义"用新包替代旧包的结论"，H0/H6 写明 supersede 关系与替代原因；被替代批次保持只读不动；
- `verify` 增强：校验 `lineage.previous`/`supersedes` 存在且完整，链上批次的 `git.head` 单调（不强制，但漂移报告给出链式对比）；新增 finding `LINEAGE_BROKEN`（error）/`SUPERSEDED_BATCH`（warn）。

**append/update 的额外参数**：`summary/goal/decisions/...` 同 create；`append` 可用 `sinceBatchId` 定位 delta 起点（默认 previous）。

### 3.4 goal / jobs 只读燃料（M2，可选块）

**已核实的宿主契约**【已核实】：

- `ctx.goals.get(agent): GoalView | undefined`，`GoalView={id, revision, objective, phase, maxGoalRounds, roundsStarted, createdAt, updatedAt, activation, blockedReason?}`；
- `ctx.jobs.list(callerSessionId?): JobView[]`，`JobView={id, kind, label, owner?, status, progress?, detail?, startedAt, finishedAt?, output:{total, earliest, spillPaths?}}`；
- **task board：Host 没有可编目服务**（`cordis_inspect Service` 无 `taskBoard`；且第三方任务板当前有 G12 执行器缺陷）→ P1 不接入，ROADMAP 的"task board 只读燃料"标记为**待稳定后 opt-in**。

**采集规则**：`fuel:{goals:{available,goal?}, jobs:{available,count,statusCounts,items:[...]}}`；只读、只取当前 agent/session 可见项、条数上限 50、文本截断 500 字符并脱敏；H4 标签 `[goal]`/`[job]`；缺失 → warning + `available:false`。

### 3.5 opt-in LLM 叙述增强 + 自动草稿钩子（M3，**仅接口与文档**）

> **Q1 决议（2026-10-22）**：M3 只留接口与文档，**本阶段不实现自动写盘/运行时默认关能力**；因此 P1 的实际运行时行为 = 确定性骨架，不产生任何 LLM 调用或自动写入。下列描述保留为未来实现契约。

- **LLM 叙述**（未来合同，不在 P1 实现）：`handoff_pack action=create narrative='deterministic'|'llm'`（默认 deterministic）。`llm` 模式 = 确定性骨架为权威 + 一次受控模型调用补 H1/H6 叙述；约束：显式 opt-in、provider/model 由调用方或配置指定、输入仅交接包内已脱敏内容、输出设上限（≤8000 字符）、失败回退 deterministic 并 warning、成本/耗时计入结果。**隐私要求**：不得发送工作区文件原文（只发 HANDOFF 骨架/摘要）。
- **自动草稿钩子**（未来合同，不在 P1 实现）：opt-in 默认关。宿主事件目录里**没有** "session end"/"compaction before" 这类可直接挂的事件【已核实】（仅 `agent/turn-stopping`/`agent/disposed`/`session/flush` 等）→ 若做，只能用 `agent/turn-stopping` + `minTurns`/`minInterval` 阈值（每 N 轮最多一次），且默认关、失败静默、不写用户目录除非 `autoTarget` 显式配置。

## 4. 数据契约（manifest@2 / HANDOFF / 错误码）

- **manifest@2**：v1 全字段 + 可选 `changes`/`fuel`/`lineage`/`narrative`；固定键序、UTF-8/LF、结尾换行不变；`schemaVersion=2`；verify 兼容 v1（v1 无新块时照常通过）。
- **HANDOFF**：H0 增加血缘行（append/update 时）；H1 增加"本会话改动（workspaceChanges，已完成 turn）"子节（`available:false` 时写 `[待验]`）；H4 新标签 `[改动]`/`[goal]`/`[job]`；H6 增加"改动证据只覆盖已完成 turn、Session 结束后不可再取"的已知限制；H8 增加 `handoff_load`/`/handoff resume` 首步。
- **错误码新增**：`HANDOFF_RESUME_NOT_FOUND`、`HANDOFF_VERIFY_INVALID`、`HANDOFF_APPEND_TARGET_MISSING`、`HANDOFF_LINEAGE_CYCLE`（append/update 自指或成环）。
- **输出 schema**：`handoff_pack` 输出向后兼容（新增可选块）；`handoff_load` 新 output schema（DSH 子集：object/array/scalar/enum/oneOf）。

## 5. 测试与验收

### 5.1 单测（`node --test`，不依赖 DSH）

- `changes.js`：`workspace/changes` 事件筛选、last-completed-turn 选择、summary 归一化、bounds/截断、二进制/oversized、`available:false` 降级、diff 提取与脱敏；
- `fuel.js`：goal/jobs 可选服务、缺失降级、上限、状态聚合、脱敏；
- `lineage.js`/manifest：v1↔v2 兼容、append/update 血缘、环检测、verify 兼容旧批次；
- `load service`：trust 判定矩阵（verified/stale/invalid）、include=summary/sections/full 截断、只读（零写入断言）；
- 回归：P0 的 179 用例必须全绿（manifest@2 不破坏 v1 路径）。

### 5.2 L1–L3（实机，沿用 P0 方法）

- **L1**：重装 → 新工具/命令可见；`create` 产物含 `changes`（与外部 `git status`/`git diff --stat` 抽样核对，仅作**验证对照**不入包）；`handoff_load`/`resume` 可用；旧 v1 批次 verify 仍 ok；外部 `Get-FileHash` 复算；
- **L2**：连续两次交接（append/update）+ `supersedes` 链 verify；跨会话 resume 漂移报告（删改文件/HEAD 变化）；服务缺失降级（fake ctx 无 workspaceChanges/goals/jobs）；越界/脱敏回归；
- **L3**：只读 vs 可写权限矩阵回归；回滚演练；DSH 源码零改动；**不改历史批次**（append/update 前后旧批次哈希不变）；无子进程/无网络源码审计。
- **门槛证据**：真项目连续两次交接（本仓库自用即可）；漂移检测用"故意改文件/提交"制造；自动草稿若实现须给出"未误触发"证据；LLM 模式给出 token/耗时/隐私输入清单。

## 6. 阶段实施顺序（每步验收后才下一步）

| 里程碑 | 内容 | 验收门槛 |
|---|---|---|
| **M1 消费闭环** | `handoff_load` + `/handoff resume` + service/load 层 + 单测 + L1/L2 消费侧 E2E | 新会话只调一次 `handoff_load` 即得 trust 结论 + 指针；`/handoff resume` UI 实测 |
| **M2 真实证据与血缘** | `changes.js` + `fuel.js` + manifest@2 + append/update/verify 链 + 测试 | 两次连续交接 + 链式 verify；changes 与外部 git 对照；旧批次不变且 v1 verify 兼容 |
| **M3 opt-in 增强（仅接口与文档）** | LLM 叙述 + 自动草稿钩子的**接口/配置/文档**（不实现自动写盘与默认运行时行为，Q1 决议） | 显式开启路径在未来可用；P1 运行时与 M2 无差异（无 LLM 调用、无自动写盘） |

## 7. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | `workspaceChanges` 按**已完成 turn**记录，create 发生在 turn 中 → **当前 turn 的改动看不到**；Session disposed 后 summary 不可读 | 交接包可能漏掉"最后一段改动" | 明示限制（H6 + `changes.note`）；用 P0 会话 `tool/call` 轨迹补"本 turn 触碰文件"；`append` 在下一会话/下一轮追加 delta；`available:false` 不编造 |
| R2 | 宿主 git 快照受仓库规模/`maxFiles=500`/超时限制 | 大仓库改动列表截断 | 上限与截断字段显式化；超大改动给 warning；不把截断当全量 |
| R3 | manifest@2 兼容性 | 旧 verify/旧批次 | v1 只读兼容专项测试；不迁移旧批次；schemaVersion 独立演进（P3 再出迁移器） |
| R4 | append/update 链无限增长（无删除 API） | 批次堆积 | 明确 append-only 语义；`list` 显示血缘；用户可手动删目录；P2 考虑 cleanup 工具 |
| R5 | task board 无 Host 服务 + 第三方执行器 G12 缺陷 | ROADMAP 的"task board 燃料"不可实现 | P1 明确排除；ROADMAP 标注"待服务稳定后 opt-in"；修好后另行评审 |
| R6 | 自动钩子误触发/隐私 | 意外写盘/泄露 | 默认关；仅 `agent/turn-stopping` + 阈值 + 显式 `autoTarget`；失败静默 + warning；M3 可整体延后 |
| R7 | LLM 叙述破坏确定性与隐私 | 权威性/成本/泄露 | 默认关；确定性骨架仍为权威；只送脱敏骨架；输出上限；失败回退 deterministic |
| R8 | 新工具 schema 全局成本 | 每请求 +tokens | 接受（P0 已 +400~600 tokens）；`handoff_load` 保持小 schema（≤6 参数），必要时 P2 评估 preset 收窄 |

## 8. 边界清单（行为约定）

| # | 场景 | 行为/口径 |
|---|---|---|
| E1 | 本次 create 前无已完成 turn | `changes.available=false` + `CHANGES_UNAVAILABLE`，H4 该条 `[待验]` |
| E2 | Session 已结束/新会话 load 旧批次 | 只读包内证据；不回读旧 Session 的 workspaceChanges（服务已 disposal） |
| E3 | latest 批次被 `supersedes` | `verify` 对旧批次给 `SUPERSEDED_BATCH`（warn，不判失败）；`handoff_load` 默认解析到链尾最新 |
| E4 | append 指向不存在/已归档批次 | `HANDOFF_APPEND_TARGET_MISSING`，不写任何文件（预检查） |
| E5 | append 指向自身/成环 | `HANDOFF_LINEAGE_CYCLE`，预检查拒绝 |
| E6 | workspaceChanges 服务缺失（headless/fake） | `changes.available=false` + warning；create 照常成功 |
| E7 | goals/jobs 缺失或无数据 | `fuel.*.available=false`；不阻塞 create |
| E8 | `handoff_load include=full` 超 24 KiB | 截断 + `truncated:true` + 指引读原文件 |
| E9 | `verifyFirst=true` 且 verify 有 error | 返回 `trust='invalid'` + findings；不宣称可采信 |
| E10 | LLM 模式失败/超时 | 回退 deterministic + warning `NARRATIVE_FALLBACK`；不重试 |

## 9. 否决归档

| 方案 | 结论 | 理由 |
|---|---|---|
| 原地修改/覆盖历史批次（update=重写） | **否决** | fs 无原子整批替换；破坏 verify 不可变前提；无法回滚 |
| 新建独立仓库/拆包做 P1 | **否决** | 与 ADR-0001 A 冲突；P1 是同一 bundle 的版本演进 |
| 在插件内起子进程跑 `git status` 补改动证据 | **否决** | 违反 P0 硬约束与 ADR 17；宿主 `workspaceChanges` 已提供等价能力 |
| 默认开启 LLM 叙述/自动草稿 | **否决** | 成本、隐私、确定性、误触发；按 ADR 18/19 必须 opt-in 默认关 |
| 接入第三方 task board 作为 P1 燃料 | **否决（暂缓）** | Host 无可编目服务（已核实）+ G12 执行器缺陷；等稳定后再评审 |
| `handoff_load` 直接内联完整 HANDOFF（默认） | **否决** | 上下文成本；默认指针式，`include=full` 才内联 |

## 10. 评审决议（2026-10-22 已确认）

| # | 问题 | 决议 |
|---|---|---|
| Q1 | M3（LLM 叙述 + 自动草稿钩子）范围 | **已确认**：M3 只留接口/配置/文档，**不实现自动写盘与默认运行时行为**；P1 运行时 = 确定性骨架（无 LLM 调用、无自动写入） |
| Q2 | append/update 语义 | **已确认**：两者都新建批次 + 写血缘（`lineage.previous/root/sequence`；`update` 用 `supersedes`），**不原地修改历史批次** |
| Q3 | `handoff_load` 在 verify 有 error 时 | **已确认**：仍返回 `trust='invalid'` + findings（便于模型/用户看到问题），但不得宣称可采信 |
| Q4 | manifest 版本 | **已确认**：升 `schemaVersion: 2`（v1 字段保留，新增可选块；v1 只读兼容，不迁移旧批次） |
| Q5 | ROADMAP 的 task board 口径 | **已确认**：改为「goal/jobs 只读燃料；task board 待其 Host 服务稳定/修复 G12 后再 opt-in」 |

## 11. 本版新增问题/欠账（评审时注意）

- 【已核实】`session.ownEvents()` 稳定包含 `workspace/changes` 事件（M2 spike，2026-10-22：当前会话 3 条事件 seq=1227/1349/1580 对应 turn 1/4/6；当前未结束 turn 无事件，证实"只覆盖已完成 turn"）；mid-turn create 取最后一条已完成 turn 的 seq，M2 已按此实现。
- 【待验】`ctx.jobs.list(callerSessionId)` 在无 job 控制器时的行为（可能抛错而不是返回空）：M2 用 try/catch + warning 包裹，并以 fake 单测覆盖。
- 【推断】`handoff_load` 的 contexts 成本增加可接受（小 schema），但需要在 L1 记录实际 tools token 增量（`cordis_inspect Tool.listTools` 大小对比）。
- 本文档不改变 P0 验收结论；M2 已按本计划实现并通过单测（详见 [P1 验收记录](../acceptance/P1.md)）。
