# dsh-plugins 文档索引（唯一入口）

<!-- docs-meta: status=current; phase=cross; verified=ce3cb8d@2026-10-23; tracks=-; supersedes=-; superseded-by=- -->

> 状态：**current**（2026-10-22 建立，D1）
> 读者：用户 + 所有 AI 会话
> 规则来源：[ADR-0002 文档治理](adr/0002-document-governance.md)；检查规格：[DOC_CHECKS](DOC_CHECKS.md)。
> 本文件是**唯一文档索引**：仓库内所有 Markdown 必须在此登记；新会话入口固定为 `ROADMAP → 本索引 → 当前阶段 plan`。
> 维护：新增/归档文档必须同步本表；D3 起由 `docs:check` 强制校验。

## 1. 权威顺序（冲突时从高到低）

1. **运行事实**：代码、测试、实测输出；
2. **ADR**（决策，只增不改）；
3. **ROADMAP**（阶段与状态唯一权威）；
4. **本索引 + current 类文档**（当前描述）；
5. **冻结文档**（历史记录，只读；不得作为现状依据）；
6. **historical 文档**（仅背景，已移出读路径）。

## 2. 状态图例

| 状态 | 含义 | 可改正文？ |
|---|---|---|
| `current` | 当前有效的描述/规格/索引 | ✅ 允许（更新后刷新 verified） |
| `frozen` | 已完成阶段的计划/验收/ADR，或已接受决策 | ❌ 只允许追加勘误章节 |
| `superseded` | 已被新文档取代 | ❌ |
| `historical` | 历史背景材料，已归档 | ❌ |

## 3. 文档头模板（复制到每份 Markdown 标题后）

```html
<!-- docs-meta: status=current; phase=P2; verified=c5fe455@2026-10-22; tracks=plugins/dsh-handoff-kit/src,docs; supersedes=-; superseded-by=- -->
```

- `current`/`frozen` 必须带 `verified`；`superseded`/`historical` 必须有 `superseded-by` 或位于 `docs/archive/`；
- 纯协调文档 `tracks=-`；`verified` 是最后一次对照代码/测试核对的提交与日期。

## 4. 文档总表

| 文档 | 类型 | 状态 | 阶段 | 负责范围 / 备注 |
|---|---|---|---|---|
| [ROADMAP](../ROADMAP.md) | 当前真相 | current | P0–P3 | 阶段与状态唯一权威（P2 已按 ADR-0003 修订） |
| [CHANGELOG](../CHANGELOG.md) | 记录 | current | 全 | 版本变更（D3 加 meta） |
| [README](../README.md) | 当前真相 | current | 全 | 仓库说明/安装/治理（D3 已修 C1） |
| [WORKSTREAMS](WORKSTREAMS.md) | 当前真相 | current | cross | 三线任务协调与执行顺序 |
| [本索引](README.md) | 当前真相 | current | cross | 唯一文档入口 |
| [DOC_CHECKS](DOC_CHECKS.md) | 规格 | current | cross | `docs:check` 检查清单（D2 实现脚本） |
| [ADR-0001 仓库拆分与 P0 决策](adr/0001-handoff-kit-repo-and-decisions.md) | 决策 | frozen | P0 | 仓库拆分与 P0 关键决策 20 条（D3 已加 meta；正文指向已归档 P0 START_PROMPT，按 DC5 为允许的 warning） |
| [ADR-0002 文档治理](adr/0002-document-governance.md) | 决策 | frozen | cross | 四类文档/冻结归档/两层检查 |
| [ADR-0003 prompt-first + UI](adr/0003-prompt-first-and-ui.md) | 决策 | frozen | cross | P2 产品叙事（prompt-first/package-backed）与 UI 工作台决策 |
| [P0 实施计划](handoff-kit/design/P0_implementation_plan.md) | 计划 | frozen | P0 | P0 实施基线（D3 已改标题为"P0 基线，已冻结"） |
| [P0 模块接口](handoff-kit/design/P0_module_interfaces.md) | 规格 | frozen | P0 | P0 模块级接口规格 |
| [P1 实施计划](handoff-kit/design/P1_plan.md) | 计划 | frozen | P1 | P1 实施基线（D3 已改为"已完成/frozen"） |
| [P2 实施计划（UI 工作台）](handoff-kit/design/P2_plan.md) | 计划 | frozen | P2 | UI 工作台 v1：入口/面板/工作台页/U0–U4（已完成，D5 收尾冻结） |
| [P3 实施计划（平台化 1.0）](handoff-kit/design/P3_plan.md) | 计划 | current | P3 | 规范公开/迁移器/跨工具 CLI/发布/签名策略/公开门面（A 档开源公开产品；2026-10-23 开工，M0–M6） |
| [P2 启动提示词](handoff-kit/START_PROMPT_P2.md) | 入口（历史） | frozen | P2 | D5 启动场景历史记录；P2 完成后不再作为新会话入口 |
| [旧设计索引（历史）](archive/handoff-kit/design-README.md) | 索引（旧） | historical | — | 被本索引取代；D3 已归档 |
| [通用交接包生成器 v1（历史）](archive/handoff-kit/20261022_通用交接包生成器_v1.md) | 方法论 | historical | — | 用户原意 + H0–H9 方法论；D3 已归档，内容仍有效 |
| [P0 实施说明（历史草案）](archive/handoff-kit/20261022_dsh-handoff-kit_P0实施说明.md) | 历史 | historical | P0 | 初版形态草案；D3 已归档 |
| [创造模式会话启动提示词（历史）](archive/handoff-kit/20261022_创造模式会话启动提示词.md) | 历史 | historical | P0 | 首次会话入口；D3 已归档 |
| [START_PROMPT（P0，历史）](archive/handoff-kit/START_PROMPT.md) | 历史 | historical | P0 | P0 启动词；D3 已归档，新入口见 D4 的 `START_PROMPT_P2.md` |
| [GAPS 挂账台账](handoff-kit/GAPS.md) | 记录 | current | P0–P1 | 缺口分类与归档记录（追加式更新） |
| [P0 验收记录](handoff-kit/acceptance/P0.md) | 验收 | frozen | P0 | P0 L1–L3 证据（批次引用已归档见 GAPS §2） |
| [P1 验收记录](handoff-kit/acceptance/P1.md) | 验收 | frozen | P1 | P1 M1–M3 + 0.2.1 清理证据 |
| [P2 验收记录](handoff-kit/acceptance/P2.md) | 验收 | frozen | P2 | P2 U0–U4/L1–L3 浏览器实测证据、已知缺口（0.3.0；§9 为 0.3.1 提示词安全勘误） |
| [插件 README](../plugins/dsh-handoff-kit/README.md) | 产品文档 | current | 0.3.1 | 插件使用/安装/开发说明（含 P2 UI 工作台与提示词安全门） |
| [插件使用说明（标准交接流程）](../plugins/dsh-handoff-kit/USAGE.md) | 使用说明 | current | 0.3.1 | 旧会话生成 → 新会话只粘贴 → 旁证只读复核 → 明确指令后开工（四步） |
| [插件使用说明（英文）](../plugins/dsh-handoff-kit/USAGE.en.md) | 使用说明 | current | P3 | USAGE.md 英文对照（四步标准交接流程；1.0 公开门面） |
| [交接包格式规范（英文）](../plugins/dsh-handoff-kit/spec/HANDOFF.md) | 规格 | current | P3 | 1.0 交接包格式规范：批次布局/manifest@1/2/HANDOFF 结构/证据标签/trust 语义（M1） |
| [交接包验证规范（英文）](../plugins/dsh-handoff-kit/spec/verify.md) | 规格 | current | P3 | 1.0 验证算法：步骤/finding 码/trust 判定/CLI 退出码（M1） |
| [handoff-pack 技能](../plugins/dsh-handoff-kit/skills/handoff-pack/SKILL.md) | 技能 | current | 0.3.1 | 模型使用交接包的流程说明（P2 UI 不改变模型消费路径） |

## 5. 已建与计划新增

| 文档 | 状态 | 产出步骤 |
|---|---|---|
| `scripts/docs-check.mjs`（规格 `docs/DOC_CHECKS.md`） | 已建 | D2 |
| `docs/adr/0003-prompt-first-and-ui.md` | 已建 | D4 |
| `docs/handoff-kit/design/P2_plan.md` | 已建 | D4 |
| `docs/handoff-kit/START_PROMPT_P2.md` | 已建 | D4 |
| `docs/handoff-kit/acceptance/P2.md` | 已建 | D5 / U4 |
| `docs/handoff-kit/design/P3_plan.md` | 已建 | M0（2026-10-23 批准） |
| `plugins/dsh-handoff-kit/spec/HANDOFF.md` + `spec/verify.md` | 已建 | P3/M1（规范公开，2026-10-23） |
| `plugins/dsh-handoff-kit/schema/manifest.v1.json` + `manifest.v2.json` | 已建 | P3/M1（JSON Schema，2026-10-23） |
| `plugins/dsh-handoff-kit/test/spec.test.js`（规范向量） | 已建 | P3/M1（2026-10-23） |
| `plugins/dsh-handoff-kit/test/migration.test.js`（迁移测试） | 已建 | P3/M2（2026-10-23） |
| `plugins/dsh-handoff-kit/bin/handoff-kit.mjs` + `src/cli.js`（零依赖 CLI） | 已建 | P3/M3（2026-10-23） |
| `plugins/dsh-handoff-kit/test/cli.test.js`（CLI E2E） | 已建 | P3/M3（2026-10-23） |
| `plugins/dsh-handoff-kit/USAGE.en.md`（英文使用说明） | 已建 | P3/M4（2026-10-23） |

D5（P2 实现）已完成；P3 设计文档已建（`P3_plan.md`，2026-10-23 开工），无需其他待建文档。

## 6. 归档规则

- 目录：`docs/archive/<插件>/`；文件首行 `docs-meta` 标 `status=historical`，并写 `superseded-by`；
- 归档不是删除：git 历史与目录都保留；索引中只以 historical 形式登记；
- 归档后不得再从 `design/` 等主路径引用为"现行"。

## 7. 新会话读取协议

1. 读 [ROADMAP](../ROADMAP.md)（阶段/状态）；
2. 读本索引（当前文档与状态）；
3. 读当前阶段 plan（current）；
4. 其余文档只在明确需要时读：`frozen` 只作历史，`historical` 仅背景；
5. 引用任何文档结论前，看其 `verified` 是否还能对上当前代码；对不上→按 `stale` 处理并报告。
