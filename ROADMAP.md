# dsh-plugins ROADMAP

<!-- docs-meta: status=current; phase=cross; verified=c275312@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

> 本文件是插件仓库**阶段与状态的唯一权威**。规划、进度、验收均以这里为准；
> 每阶段的设计与验收见 `docs/<插件>/{design,acceptance}/`。
> 最后更新：2026-10-22

## 状态总览

| 阶段 | 版本 | 目标 | 状态 | 设计 | 验收 |
|---|---|---|---|---|---|
| P0 | 0.1.x | 手动生成 + 校验闭环 | **done**（0.1.0，2026-10-22） | [P0 实施计划](docs/handoff-kit/design/P0_implementation_plan.md) | [P0 验收记录](docs/handoff-kit/acceptance/P0.md) |
| P1 | 0.2.x | 真实改动证据 + 消费闭环 + 轻自动 | **done**（0.2.0，2026-10-22；0.2.1 挂账清理） | [P1 实施计划](docs/handoff-kit/design/P1_plan.md) | [P1 验收记录](docs/handoff-kit/acceptance/P1.md) |
| P2 | 0.3.x | UI 工作台（对接提示词优先） | **计划已批准**（2026-10-22；UI 首块，未开工） | [P2 计划](docs/handoff-kit/design/P2_plan.md) | — |
| P3 | 1.0 | 规范与分发 | 未开始 | — | — |

## P0 — 可用（0.1.x）

**目标**：把“通用交接包生成器”做成 DSH host-only bundle，手动触发，生成可校验、可消费的交接包。

**范围**
- `handoff_pack` 工具：`scan` / `create` / `verify` / `list`；
- `/handoff` 人类命令；
- `handoff-pack` 技能；
- 默认用户级输出 `$DSH_HOME/handoff`，显式 `target=workspace` 降级；
- 证据：git HEAD/reflog + 文件 sha256 + 会话 `tool/call` 元数据（不挖消息正文）；
- 零运行时依赖、本地安装、可回滚。

**不做**：UI、Client 半区、LLM、DB、自动阈值/compaction 钩子、goal/task board/job 集成、网络、子进程。

**DoD**：L1–L3 全过（见实施计划第 9 节）+ 新会话仅凭 `HANDOFF.md` + `manifest.json`
能回答“上次做到哪、下一步、要复核哪几条”。

**验收结论**（2026-10-22）：L1 全过；L2 边界 B1–B9 全过；L3 全过——danger-full-access、
workspace-write + `target=workspace`、`read-only` / `workspace-write` 拒绝路径、回滚演练、
DSH 源码零改动均已用**真实权限会话**实测（`session-95c9d28f…`，`/handoff list` 命令亦实测），
fake 策略单测为补充而非替代。剩下的只是 P0 设计边界（无 git status / 无 mtime / 无删除原语等，
见验收记录 G1–G4），不再有"可测未测"挂账。详见
[P0 验收记录](docs/handoff-kit/acceptance/P0.md)。

**交付物**：`plugins/dsh-handoff-kit/`、`docs/handoff-kit/acceptance/P0.md`、CHANGELOG 0.1.0。

## P1 — 好用（0.2.x）**（done）**

- **M1 消费闭环（done）**：`handoff_load` 工具 / `/handoff resume`（verify → trust 判定 → 指针式读取，不写盘）；
- **M2 真实证据与血缘**：接入 `ctx.workspaceChanges` 获取会话真实文件改动/差异摘要（**保持禁子进程**）；
  批次 `append` / `update` 与 `supersedes` 链（新建批次 + 血缘，**不原地改历史批次**）；
  goal / jobs 只读燃料（确定性证据，不引入自动执行）；
- **M2 边界**：task board **暂不接入**——Host 无可用服务（已核实）且第三方执行器有 G12 缺陷，
  待服务稳定/修复后再 opt-in；
- **M3（仅接口与文档）**：opt-in LLM 叙述增强与自动草稿钩子**本阶段不实现自动写盘**，只留接口/配置/文档
  （2026-10-22 评审决议 Q1；P1 运行时无 LLM 调用、无自动写入）。

**设计文档**：[`docs/handoff-kit/design/P1_plan.md`](docs/handoff-kit/design/P1_plan.md)（v1，2026-10-22 **已评审通过**，Q1–Q5 决议见文档 §10）。

**验收结论**（2026-10-22）：M1 消费闭环（`handoff_load`/`/handoff resume`）实机通过；
M2 真实改动证据与血缘（manifest@2、workspaceChanges、goal/jobs 燃料、`append`/`update`/`supersedes`、
verify 血缘检查）实机通过（单测全绿，数量以 `npm test` 输出为准；外部哈希复算、v1 批次兼容）；M3 按 Q1 决议仅保留接口与文档、
P1 运行时无 LLM 调用/无自动写入。已知缺口为宿主契约限制（当前 turn 改动不可见、Session 关闭后
summary 不可读）与无删除 API，已在验收记录挂账。详见
[P1 验收记录](docs/handoff-kit/acceptance/P1.md)。

**门槛**：真项目连续两次交接；漂移检测准确；M1/M2 的写入均显式触发；成本与隐私可测
（M3 仅接口与文档，自动草稿的"不误触发"验收留到真正实现 M3 时）。

**挂账台账**：[`docs/handoff-kit/GAPS.md`](docs/handoff-kit/GAPS.md)（P0/P1 全部缺口按
已关闭/设计边界/外部缺陷/归档分类；0.2.1 已补 `changes.currentTurn`、`npm test`、
批次归档与最终包）。

## P2 — UI 工作台（0.3.x）

> **修订记录（2026-10-22，用户确认）**：原 P2「团队/界面」改为 **UI 工作台首块**，
> 产品叙事回归 **prompt-first**（对接提示词是第一公民，包/证据是支撑）。
> Agent Teams 交接、漂移监视、定时/自动快照**后移**（P2 后段或 P3，另行评审）。
> 依据：[ADR-0003](docs/adr/0003-prompt-first-and-ui.md)。

- **对话入口**：输入框左侧「交接」按钮 + 小面板（生成 / 载入），默认产出"新会话开场提示词"；
- **工作台页**：批次列表/状态徽章/详情（verify、drift、changes、血缘）+ 生成/校验/继续交接；
- **数据**：全部经宿主 RPC 调现有 handoff service；UI 不做业务逻辑，不直接读文件系统；
- **v1 不做**：Agent Teams、漂移监视、自动快照、LLM 叙述、自动写盘。

**设计文档**：[`docs/handoff-kit/design/P2_plan.md`](docs/handoff-kit/design/P2_plan.md)（v1，2026-10-22 已批准）
**新会话入口**：[`docs/handoff-kit/START_PROMPT_P2.md`](docs/handoff-kit/START_PROMPT_P2.md)

**门槛**：浏览器实测 UI 闭环（生成 → 复制开场提示词 → 新会话 load 得 trust）+ `docs:check` 0 error
+ 既有单测回归（数量以测试输出为准）+ 用户确认。

## P3 — 平台化（1.0）

- `manifest@2` / `HANDOFF.md` 规范公开 + schema 迁移器；
- 跨工具适配器（其他 agent / CLI 消费同一交接包）；
- npm / 插件市场发布；
- 签名 / 审计 / 脱敏策略配置。

**门槛**：第三方可独立安装使用 + 迁移演练通过。

## 非目标

会话全文回放、通用记忆系统、项目管理工具、密钥保管、远程同步、自动执行 next steps、自动 push。

## 落地机制

1. 每阶段开工前写 `docs/<插件>/design/<phase>.md`；收尾写 `docs/.../acceptance/<phase>.md`
   （命令、输出、证据、已知缺口）。
2. **阶段门槛**：上阶段验收记录完整 + 回归绿 + 回滚演练通过 + 用户确认，才进入下一阶段。
3. 版本映射：P0=0.1.x、P1=0.2.x、P2=0.3.x、P3=1.0；
   `manifest.schemaVersion` 独立演进并提供迁移器。
4. 关键取舍记 `docs/adr/`；变更记 `CHANGELOG.md`；提交为本地提交，不 push。
5. 文档治理：四类文档 + 冻结归档 + `node scripts/docs-check.mjs`；入口 [docs/README](docs/README.md)，
   规则 [ADR-0002](docs/adr/0002-document-governance.md)。

## 决策索引

- [ADR-0001：handoff-kit 仓库拆分与 P0 关键决策](docs/adr/0001-handoff-kit-repo-and-decisions.md)
- [ADR-0002：文档治理](docs/adr/0002-document-governance.md)
- [文档索引](docs/README.md) / [检查清单](docs/DOC_CHECKS.md) / [三线协调](docs/WORKSTREAMS.md)
