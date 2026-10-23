# dsh-plugins ROADMAP

<!-- docs-meta: status=current; phase=cross; verified=c1e57a2@2026-10-23; tracks=-; supersedes=-; superseded-by=- -->

> 本文件是插件仓库**阶段与状态的唯一权威**。规划、进度、验收均以这里为准；
> 每阶段的设计与验收见 `docs/<插件>/{design,acceptance}/`。
> 最后更新：2026-10-23

## 状态总览

| 阶段 | 版本 | 目标 | 状态 | 设计 | 验收 |
|---|---|---|---|---|---|
| P0 | 0.1.x | 手动生成 + 校验闭环 | **done**（0.1.0，2026-10-22） | [P0 实施计划](docs/handoff-kit/design/P0_implementation_plan.md) | [P0 验收记录](docs/handoff-kit/acceptance/P0.md) |
| P1 | 0.2.x | 真实改动证据 + 消费闭环 + 轻自动 | **done**（0.2.0，2026-10-22；0.2.1 挂账清理） | [P1 实施计划](docs/handoff-kit/design/P1_plan.md) | [P1 验收记录](docs/handoff-kit/acceptance/P1.md) |
| P2 | 0.3.x | UI 工作台（对接提示词优先） | **done**（0.3.0，2026-10-22；0.3.1 提示词安全修复） | [P2 计划](docs/handoff-kit/design/P2_plan.md) | [P2 验收记录](docs/handoff-kit/acceptance/P2.md) |
| P3 | 1.0 | 规范与分发 | **done**（1.0.0，2026-10-23；npm `latest` + tag `v1.0.0`；M0–M6 完成） | [P3 实施计划](docs/handoff-kit/design/P3_plan.md)（frozen） | [P3 验收记录](docs/handoff-kit/acceptance/P3.md)（frozen） |

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

**设计文档**：[`docs/handoff-kit/design/P2_plan.md`](docs/handoff-kit/design/P2_plan.md)（v1，2026-10-22 已批准并完成，现已冻结）
**启动提示词（历史）**：[`docs/handoff-kit/START_PROMPT_P2.md`](docs/handoff-kit/START_PROMPT_P2.md)

**门槛**：浏览器实测 UI 闭环（生成 → 复制开场提示词 → 新会话 load 得 trust）+ `docs:check` 0 error
+ 既有单测回归（数量以测试输出为准）+ 用户确认。

**验收结论**（2026-10-22，0.3.0）：U0–U4 全部落地并经**用户在浏览器逐项点击确认**：
输入框「交接」按钮与浮层面板（生成/载入）、侧栏图标与「交接工作台」页均实测可用；
生成批次 `20261022T112055Z-e27c`（create）与 `20261022T113405Z-78e8`（append 第 2 代）经
UI 点击写入，复制开场提示词 trust=verified；旧批次漂移显示 stale、篡改批次显示 invalid；
只读动作零写入（目录哈希对照）；`docs:check` 0 error；单测 244 全绿；本地提交不 push。
已知缺口见验收记录与 GAPS（工作台 root 作用域会话回退、血缘不单列、无删除 UI、中文 v1）。
详见 [P2 验收记录](docs/handoff-kit/acceptance/P2.md)。

**交付物**：`plugins/dsh-handoff-kit/client.js` + `src/ui.js`（同包 Client half + UI RPC）、
`docs/handoff-kit/acceptance/P2.md`、CHANGELOG 0.3.0。

**0.3.1 补丁（2026-10-22）**：交付后真实使用中发现并修复**开场提示词越界风险**——旧文案
"请先读它，再继续工作"会让新会话直接开工写文件；现提示词内置强制只读门（第 0 步
`handoff_load` 复核 + 等用户明确指令 + 禁止改文件/commit），新增回归测试。详见
[P2 验收记录 §9 勘误](docs/handoff-kit/acceptance/P2.md)。P2 门槛与功能验收结论不变；
版本 0.3.1、单测 245。

## P3 — 平台化（1.0）

**设计文档**：[`docs/handoff-kit/design/P3_plan.md`](docs/handoff-kit/design/P3_plan.md)（v1.0，2026-10-23 **已批准，执行计划**；A 档 = 开源公开产品）

> **开工记录（2026-10-23，用户确认）**：P3 进入 M0 并完成；发布资源（npm 账号+2FA、GitHub 公开仓库）因注册受阻**延后到 M4 前**，不阻塞规范/迁移器/跨工具 CLI（M0–M3）；包名 `dsh-handoff-kit` 已确认未被占用。设计范围见计划 §2.1（T1–T6），里程碑 M0–M6，门槛如下。
>
> **M1 完成（2026-10-23，提交 `f656c09`）**：英文规范 [交接包格式](plugins/dsh-handoff-kit/spec/HANDOFF.md) + [验证算法](plugins/dsh-handoff-kit/spec/verify.md)、`schema/manifest.v1/v2.json`、`test/spec.test.js` 规范向量；`npm test` 全绿、`docs:check` 0 error。
>
> **M2 完成（2026-10-23，提交 `e3e6cba`）**：`handoff_pack action=migrate` / `/handoff migrate`——v1→v2，源批次只读且字节不变，`evidence/migration.json` 记录 provenance，`changes`/`fuel` 标 unavailable、不建 lineage；`test/migration.test.js` 覆盖负例；`npm test` 全绿。
>
> **M3 完成（2026-10-23，提交 `ce3cb8d`）**：零依赖 CLI `bin/handoff-kit.mjs`（`verify`/`load`/`list`/`migrate`，退出码 0/3/1/2，无网络/无子进程/无 harness 导入）；`test/cli.test.js` 真实文件系统 E2E；**非 DSH 消费演练**用 CLI 直接验证用户级真实批次（trust=verified）。M4（发布/公开门面）待 npm/GitHub 账号资源。
>
> **M4 门面/UI 完成（2026-10-23，提交 `62adf57`/`9781ce5`）**：GitHub 公开仓库 + 英文根 README/`LICENSE`/YAML Issue 模板/CI（Windows 必跑，Linux/macOS 实验性非阻塞）；英文 `USAGE.en.md`；英文优先 i18n（client 内嵌 142 keys + `locale/*.json`，跟随页面/浏览器语言，中文保留）与 P2-G1 工作台项目/会话选择器；版本 `1.0.0-rc.1`；283 测试全绿、`docs:check` 0 error、CI 绿；**rc.1 已发布**（npm tag `next`/`latest`）+ tag `v1.0.0-rc.1`。
> **安装演练发现（2026-10-23）**：npm 包体安装成功，但实时激活需重启 DSH；且 `plugin_manager remove_bundle` 会清空 `link:` 目标目录（本地插件 64 文件被删，已 git 恢复并验证）。详见 [GAPS](docs/handoff-kit/GAPS.md) §3；后续安装演练必须备份 + 重启。
> **验收补充（2026-10-23）**：添加 GitHub remote 使 `projectKey` 由 workspace seed 变为 remote seed，旧批次默认入口不可见（CLI 显式路径可用）；1.0 前补「显式 batchId 跨 project key 只读回退 + 迁移说明」，见 GAPS §3.4。
> **rc.1 后修复（2026-10-23，提交 `91a4fae`/`2430f1b`；待 rc.2 发布）**：①中文界面回归——探测顺序改为「显式偏好 > 浏览器 zh* > 页面 lang > 英文」+ 工作台/浮层中文/English 切换（持久化）；②projectKey 变化——显式 batchId 跨兄弟 key 只读回退（`PROJECT_KEY_FALLBACK` 结果级警告、不降级 trust；**仅同 workspace slug**），工作台历史项目分组/只读横幅/禁用继续交接，写操作仍只落当前 key；303 测试全绿、`docs:check` 0 error、spec/README/USAGE 同步。
> **M4 验收通过（2026-10-23 09:10，用户浏览器确认）**：中文界面/语言切换生效；「历史项目（只读）」显示 `cb7aa4e5` 的 8 个旧批次（无关项目已过滤）；旧批次显示 `trust=stale` + 9 条正确漂移警告；Host 侧显式 batchId 回退返回 `PROJECT_KEY_FALLBACK`。**M4 收口**；rc.2 已发布（`next=1.0.0-rc.2`，tag `v1.0.0-rc.2`）→ **M5 签名/审计/脱敏策略进行中。**
> **M5 + A 增强 + M5b 完成（2026-10-23，待 rc.3 发布）**：opt-in Ed25519 签名（`signature.json` + CLI `sign`/`--pubkey`/trusted-keys）、脱敏策略（只能追加/内置地板不可关/fail-closed）、审计回执；转接增强（提示词 re-grounding 实际读关键文件 + `HANDOFF_PATH_MISSING` 路径存在性）；批次删除（软删 `.trash` + CLI `--hard` + 血缘保护 + UI 删除按钮）。测试 303→362 全绿、`docs:check` 0 error、真实 CLI E2E 通过。**下一步统一提交 → rc.3 → M6。**
> **M6 1.0 门槛（2026-10-23，进行中）**：版本升 `1.0.0`（rc.3 候选晋升，未单独发布 rc.3）；P3 验收记录已建（`docs/handoff-kit/acceptance/P3.md`，frozen）；代理验收（干净目录 npm install + 非 DSH CLI）、迁移演练（真实 v1→v2、源字节不变）、回滚演练（软删→restore→verify）通过；362 测试/docs:check 0 error/npm pack 37。待用户重启抽查 UI + 发布 `1.0.0` + tag `v1.0.0`。

- `manifest@2` / `HANDOFF.md` 规范公开 + schema 迁移器；
- 跨工具适配器（其他 agent / CLI 消费同一交接包）；
- npm / 插件市场发布（插件市场仅可选渠道，不列 1.0 门槛）；
- 签名 / 审计 / 脱敏策略配置；
- 批次删除（软删除/回收站 + CLI 硬删除 + 血缘保护，M5b）。

**门槛**：第三方可独立安装使用 + 迁移演练通过。

## 非目标

会话全文回放、通用记忆系统、项目管理工具、密钥保管、远程同步、自动执行 next steps、自动 push。

## 落地机制

1. 每阶段开工前写 `docs/<插件>/design/<phase>.md`；收尾写 `docs/.../acceptance/<phase>.md`
   （命令、输出、证据、已知缺口）。
2. **阶段门槛**：上阶段验收记录完整 + 回归绿 + 回滚演练通过 + 用户确认，才进入下一阶段。
3. 版本映射：P0=0.1.x、P1=0.2.x、P2=0.3.x、P3=1.0；
   `manifest.schemaVersion` 独立演进并提供迁移器。
4. 关键取舍记 `docs/adr/`；变更记 `CHANGELOG.md`；P3 起源码同步到 GitHub 公开仓库
   （`CWTTT-1588123/dsh-plugins`），push/tag/publish 需用户逐次确认，凭证不入仓库。
5. 文档治理：四类文档 + 冻结归档 + `node scripts/docs-check.mjs`；入口 [docs/README](docs/README.md)，
   规则 [ADR-0002](docs/adr/0002-document-governance.md)。

## 决策索引

- [ADR-0001：handoff-kit 仓库拆分与 P0 关键决策](docs/adr/0001-handoff-kit-repo-and-decisions.md)
- [ADR-0002：文档治理](docs/adr/0002-document-governance.md)
- [文档索引](docs/README.md) / [检查清单](docs/DOC_CHECKS.md) / [三线协调](docs/WORKSTREAMS.md)
