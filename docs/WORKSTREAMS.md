# dsh-plugins 并行工作流对齐（三线任务）

<!-- docs-meta: status=current; phase=cross; verified=dda8796@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

> 状态：**current**（协调文档，2026-10-22 创建）
> 读者：用户（决策者）+ 后续 AI 会话（执行者）
> 用途：把当前并行的三条工作线固定成一张图，明确各自边界、权威文档、执行顺序，避免"路线/需求/文档治理"互相漂移。
> 维护规则：本文件只记录三线关系与顺序；具体内容以各线权威文档为准。每次推进后更新 §5 状态与 §8 变更记录。
> 未来归宿：`docs:check` + 文档索引建成后，本文件进入 `docs/README.md` 索引；三线全部落地后标记为 `frozen`。

## 0. 为什么需要这份文档

当前同时存在三件事，且互相影响：

1. **线 A：原定整体路线** P0 → P1 → P2 → P3（已推进到 P1 done、P2 未开始）；
2. **线 B：新需求**——使用不便，要 UI 界面；回溯后确认用户原意是 **prompt-first**（对接提示词是第一公民），与当前 **package-first** 的实现叙述有偏差，**会改动 P2 的排序与门槛**；
3. **线 C：文档治理**——AI 编程文档会随时间/位置/权威漂移，需要一套"四类文档 + 冻结归档 + 低承诺两层检查"的机制。

三线不是三个独立项目：**C 决定文档怎么写，B 决定路线怎么改，A 是底座**。若顺序错误，新需求会被写进旧计划、旧计划继续自称权威，正好制造我们要防的漂移。

## 1. 三线总览

| 线 | 是什么 | 当前状态 | 权威文档 |
|---|---|---|---|
| **A 原定路线** | P0–P3 阶段规划与验收 | P0 done（0.1.0）；P1 done（0.2.0 + 0.2.1 清理）；P2/P3 未开始 | [ROADMAP](../ROADMAP.md)、各阶段 plan/acceptance |
| **B 新需求（prompt-first + UI）** | 可用性：对话/工作台界面，把"对接提示词"变成第一公民 | **已对齐，未落文档、未开工** | 待建 `ADR-0003` + `P2_plan.md`；原意见 [v1 文档](handoff-kit/design/20261022_通用交接包生成器_v1.md) |
| **C 文档治理** | 四类文档 + 冻结归档 + `docs:check` 漂移检测 | **D1/D2 已建**（骨架 + 脚本 + 首份报告）；D3 待修 | [ADR-0002](adr/0002-document-governance.md) + [索引](README.md) + [scripts/docs-check.mjs](../scripts/docs-check.mjs) |

## 2. 线 A：原定整体路线（不变的部分）

**已完成**（勿重开，验收记录冻结）：

- P0（0.1.0）：host-only bundle，`handoff_pack` scan/create/verify/list + `/handoff` + 技能；证据 = git + sha256 + 会话 tool/call；[P0 计划](handoff-kit/design/P0_implementation_plan.md)、[P0 验收](handoff-kit/acceptance/P0.md)；
- P1（0.2.0/0.2.1）：`handoff_load`/`/handoff resume`、manifest@2、workspaceChanges、goal/jobs 燃料、append/update/血缘、挂账清理；[P1 计划](handoff-kit/design/P1_plan.md)、[P1 验收](handoff-kit/acceptance/P1.md)、[GAPS](handoff-kit/GAPS.md)。

**未开始**（按 ROADMAP 原文）：

- P2（0.3.x）"团队/界面"：client 伴侣包（批次列表/预览/一键复制开场提示词/漂移徽章）、Agent Teams 交接、漂移监视、自动快照；门槛 = 浏览器实测 + 团队场景 E2E；
- P3（1.0）"平台化"：规范公开 + schema 迁移器、跨工具适配器、npm/插件市场发布、签名/审计/脱敏配置。

**注意**：P2 的上述内容**会因线 B 而重排**（见 §4），但 P0/P1 的结论、边界、验收不重开。

## 3. 线 B：新需求（已对齐的结论）

### 3.1 用户原意（2026-10-22 回溯确认）

> 有一个通用的交接包提示词；把它输入工作区 A，A 生成一段**给下一个工作区的对接提示词**；工作区 B 按这段提示词开始工作。

本质：**prompt-first + 人工复制**。原意原文保存在 [v1 文档](handoff-kit/design/20261022_通用交接包生成器_v1.md)（"把本文件整段发给当前有上下文的对话……再把生成结果发到新对话"）。

### 3.2 现状与偏差

当前插件是 **package-first**：产物是可校验交接包（HANDOFF.md + manifest + evidence），你的"对接提示词"对应 H4/H7/H8 + `next`，但被埋在工具/命令后面。于是使用抽象，也解释了你为何想"对话区一个按钮"。

### 3.3 已对齐的产品原则

1. **prompt-first**：默认交付物是"新会话可直接照做的对接提示词"；
2. **package-backed**：交接包、证据、trust 判定是支撑与可展开项，不是第一入口；
3. **UI 工作台**：比单个按钮更合适——能看批次、状态、证据、血缘，并能生成/校验/载入；
4. **入口**：对话输入框左侧「交接」按钮 + 工作台（按钮是快捷入口）。

### 3.4 已确认的交互（用户选择）

- 位置：输入框左侧「交接」按钮（已核实宿主槽位 `conversation.input.left` 可注册）；
- 点击：弹小面板——标题预填当前会话标题、备注可选；
- 面板动作：**生成**（显示 batchId/目录/warnings + 复制新会话开场提示词）；**载入**（列最近批次 → 选 → trust/drift → 把指针/开场提示词填回输入框）；
- 第一版就包含"生成 + 载入"，不是只做生成；
- 技术通道：同包新增 Client half + 宿主 RPC（已核实 client builtin `host.call` + 同 package host half 通道存在）。

### 3.5 与线 A 的关系（改什么、不改什么）

**改**：P2 排序与门槛——UI 工作台升为 P2 首块；Agent Teams/自动快照等团队向内容**后移**（P2 后段或 P3），P2 门槛改为"UI 实测闭环 + 浏览器验证"。
**不改**：P0/P1 范围与验收、host-only 引擎、零依赖、禁子进程/网络/默认 LLM、手动触发语义。

## 4. 线 C：文档治理（已认可的核心）

### 4.1 问题

AI 编程文档三种偏移：**时间**（描述旧状态）、**位置**（旧文档留在主路径）、**权威**（多份自称现行）。AI 按 grep 读，旧文档必被读到并可能被当事实。

### 4.2 已认可的机制（低承诺、两层）

1. **文档四类 + 生命周期**：决策（ADR，只增不改）/ 计划（阶段完成即冻结）/ 验收记录（冻结，只追加勘误）/ 当前真相（ROADMAP、索引、README，唯一允许原地更新）；
2. **单一索引 + 权威顺序**：`ROADMAP`（阶段状态）→ `docs/README`（索引/当前计划）→ ADR（决策）→ 冻结文档（只读历史）；代码/测试/实测高于所有文档；
3. **两层检查**：
   - 机器层 `docs:check`：索引完整性、头部元数据、状态冲突、链接/路径、**tracks 文件在 `verified` commit 后是否变化（判 stale）**、派生事实（版本号）、归档隔离——确定性、覆盖全部文档；
   - 语义层：只审 `status: current` 的少量文档，只在阶段开始/收尾，用代码/测试取证后更新 `verified: commit`；冻结文档永不重审；
4. **冻结/归档**：旧文档移出读路径（`docs/archive/`），文件名与首行带 `HISTORICAL` 标记；
5. **减少需维护文档**：版本/测试数/接口等派生事实不手写；默认不新增文档，能合并就合并。

### 4.3 当前仓库已发现的偏移点（待治理时修）

| # | 位置 | 现状 |
|---|---|---|
| C1 | 根 [README](../README.md) | 插件表停在 P0 / 0.1.0；仍把 P0 START_PROMPT 当入口；目录树缺 GAPS |
| C2 | [design/README](handoff-kit/design/README.md) | 说"现行权威 = P0 计划 + ADR"；说 P1 计划"draft 待审"；未收录 GAPS |
| C3 | [P0 计划](handoff-kit/design/P0_implementation_plan.md) | 标题仍写"（现行权威）"，实际已是历史基线 |
| C4 | [P1 计划](handoff-kit/design/P1_plan.md) | 头部仍写"下一步 = M1 开工"；HEAD 快照停在 607e2cb |
| C5 | [ROADMAP](../ROADMAP.md) | 测试数写 221（实际 223）；P2 未反映新需求 |
| C6 | [START_PROMPT](handoff-kit/START_PROMPT.md) | P0 专用，仍被根 README 当新会话入口 |
| C7 | 历史 3 份文档 | 与现行文档并排放在 `design/`，未物理隔离 |

## 5. 执行顺序（已定：先治理文档，再改路线）

| 步骤 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **D1 治理骨架** | 治理约定 + 唯一索引 + 检查清单（只写文档，不动旧正文、不写代码） | [ADR-0002](adr/0002-document-governance.md)、[docs/README](README.md)、[docs/DOC_CHECKS](DOC_CHECKS.md) | **done**（2026-10-22） |
| **D2 检查脚本** | 按清单实现零依赖 `scripts/docs-check.mjs` 并跑通 | [scripts/docs-check.mjs](../scripts/docs-check.mjs) + 首份检查报告（23 error / 0 warn / 0 stale） | **done**（2026-10-22） |
| **D3 落地冻结归档** | 给现有 17 份文档加状态头；历史文档移入 `docs/archive/`；修 C1–C7 | 索引全绿、`docs:check` 无 error | 待开工 |
| **D4 路线整合** | 新需求落文档：`ADR-0003`（prompt-first + UI）+ ROADMAP 修订记录 + `P2_plan.md` + `START_PROMPT_P2.md` | 新路线正式生效 | 待开工 |
| **D5 UI 实现** | Client half + 宿主 RPC + 工作台/输入框入口（另行详细计划） | UI v1 + 浏览器实测 | 待开工 |

依赖关系：**C（D1–D3）→ B（D4）→ A 的 P2 实施（D5）**。P0/P1 文档保持冻结，不因 D4 改动。

## 6. 待确认 / 风险

- ADR 编号：治理用 `ADR-0002`、产品方向用 `ADR-0003`（建议，可换）；
- 归档位置：`docs/archive/<插件>/` vs `docs/handoff-kit/design/history/`（建议前者）；
- `docs:check` 运行方式：仓库根无 `package.json`，建议 `node scripts/docs-check.mjs`，不为此新建包管理；
- D4 是否裁剪 P2 团队向内容（Agent Teams/自动快照）到 P2 后段或 P3，需要你拍板；
- UI 的构建/刷新成本（Client half 可能需要构建产物与页面刷新）在 D5 前确认；
- 文档检查不做"语义全对"保证，只做结构性可检测（已认可低承诺）。

## 7. 立即下一步

**D3**：按 D2 首份报告修复——(1) 给 17 份旧文档补 `docs-meta` 状态头（current/frozen/historical 按分类）；(2) 修 GAPS.md 3 处、START_PROMPT.md 3 处失效链接（START_PROMPT 将归档，归档后不再检查其正文）；(3) 归档 3 份历史文档 + 旧索引 + START_PROMPT 到 `docs/archive/handoff-kit/`；(4) 修 C1–C7（根 README 插件表/入口/目录树、design/README 指向新索引、P0/P1 计划状态横幅、ROADMAP 派生事实）。目标：`docs:check` 0 error（warning 允许，D3 后另行清理）。

## 8. 变更记录

- 2026-10-22 创建：三线对齐成文（A 原路线 / B 新需求 / C 文档治理），确定执行顺序 D1→D5。
- 2026-10-22 D1 完成：[ADR-0002](adr/0002-document-governance.md) 治理决策、[docs/README](README.md) 唯一索引、[docs/DOC_CHECKS](DOC_CHECKS.md) 检查清单；下一为 D2 脚本。
- 2026-10-22 D2 完成：[scripts/docs-check.mjs](../scripts/docs-check.mjs)（零依赖，DC1–DC10）；首份报告 21 份文档 / 23 error（17 缺元数据 + 6 失效链接）/ 0 warning / 0 stale——全部为 D3 预期待修项；`frozen` 验收记录的历史测试数字改为豁免（DC7b 仅 current）。
