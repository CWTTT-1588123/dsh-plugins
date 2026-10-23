# dsh-handoff-kit P3 设计草案——平台化（1.0，A 档：开源公开产品）

<!-- docs-meta: status=current; phase=P3; verified=dd91f73@2026-10-23; tracks=plugins/dsh-handoff-kit/src; supersedes=-; superseded-by=- -->

> 版本：**v1.0（2026-10-23，P3 执行计划；用户批准开工）**。
> 产品档位：**A —— 开源公开产品**（用户 2026-10-22 两轮对齐确认，决议见 §0.1）。
> 对应 [ROADMAP](../../../ROADMAP.md) P3「平台化（1.0）」；前置：P0/P1/P2 done（0.3.1，HEAD `0a2cbc9`；代码/版本自 `589c3f6` 未变）。
> 本文件**从零编写**：未参考、未恢复仓库外已删除的旧草稿；依据 = ROADMAP P3 原文 + [ADR-0003](../../adr/0003-prompt-first-and-ui.md) + 当前仓库实测事实（§1）。
> 治理：[ADR-0002](../../adr/0002-document-governance.md)（四类文档/唯一索引/两层检查）；索引入口 [docs/README](../../README.md)；机器检查 [DOC_CHECKS](../../DOC_CHECKS.md)。
> 评审方式：A 档对齐结论已落档（§0.1、§9）；**2026-10-23 用户确认开工（「总之进行P3吧」）**，本文件转为 P3 执行计划并进入 M0（M0 决议见 §10）。

## 0. 一句话

把 0.3.1 的「本地可用的确定性交接包」推进成 **面向所有人可用的开源 1.0 平台**：**公开** `HANDOFF.md`/`manifest@2` 规范（英文交付物），提供 **schema 迁移器**与 **跨工具参考消费端（零依赖 CLI）**，以 **GitHub 公开仓库 + npm 公开包 + DSH bundle** 分发，并以**可选**的签名/审计/脱敏策略配置补上可信度外层；同时补齐公开产品必需的**英文门面、隐私与安全声明、CI 与平台声明**。P0–P2 的运行边界（零依赖、无网络、无子进程、无 LLM 自动写、手动触发、历史批次不原地重写）**全部保持不变**。

## 0.1 A 档产品定位与已确认决议（2026-10-22）

### A. 定位

| 维度 | 结论 |
|---|---|
| 产品形态 | 开源公开产品（MIT）；DSH 用户安装 bundle，非 DSH 的 agent/CLI 按公开规范消费同一交接包 |
| 受众 | ① DSH 用户：`plugin_manager install_bundle` 安装；② 其他 agent/工具作者：按 `spec/` + 参考 CLI 只读校验 |
| 分发 | GitHub 公开仓库（源码/文档/Issue）+ npm 公开包（安装源）+ DSH bundle 安装（主通道）；插件市场仅可选 |
| 版本承诺 | 1.0 起 manifest@2 / 工具 API / CLI 契约冻结；1.0 前用 `1.0.0-rc.N` 暴露问题 |
| 边界 | 不做 SaaS/云同步/账号体系/团队协作平台，无服务器、无变现；插件运行时仍无网络 |

### B. 对齐决议（用户已确认，全部为最终决议）

| # | 问题 | 决议 |
|---|---|---|
| A1 | GitHub 仓库形态 | **多插件仓整体公开**：`dsh-plugins` 仓库直接公开（源码 + 中文治理文档一起可见） |
| A2 | GitHub 归属 | **用户个人 GitHub 账号**（后续需要再迁组织） |
| A3 | npm 身份 | **无 scope 包名 `dsh-handoff-kit`**；M0 先查 npm 是否被占用 |
| A4 | 发布授权 | **AI 准备 → 用户逐次确认 → AI 执行** push/tag/publish；首次 `npm publish` 由**用户手动执行** |
| A5 | 语言 | **英文优先 + 中文保留**：英文顶层 README/安装文档/规范/schema/CLI 帮助/UI 文案；中文治理文档保留并随仓库公开 |
| A6 | 文案审校 | **用户不审校**，英文用户文案由 AI 编写；发布前用户可抽查 |
| A7 | 平台 | **Windows 优先 + macOS/Linux 实验性**；GitHub Actions 跑跨平台单测，但不承诺其他平台 |
| A8 | 签名 | **opt-in Ed25519，默认不签名**；无签名时 verify 报 `UNSIGNED`（非 error） |
| A9 | 脱敏策略 | **可选 `policy.json`，只能追加规则/denylist**；内置规则为安全地板不可关；非法配置 fail-closed |
| A10 | 第三方验收 | **代理验收**：干净环境 + 非 DSH 消费脚本 + 用户复核；验收记录如实写「代理验收」 |
| A11 | 发布节奏 | **每个里程碑发 `1.0.0-rc.N`**（npm `next`）；M6 后 `1.0.0`（`latest`） |
| A12 | P2 挂账 | **纳入 P2-G1（项目选择器）+ P2-G3（语言/i18n）**；不纳入 P2-G2（血缘单列） |
| A13 | 插件市场 | **仅可选渠道，不列 1.0 门槛**（官方市场为实验性、当前未启用） |
| A14 | 提交身份 | **接受公开**：仓库公开后历史提交的作者名/邮箱可见（用户已确认接受，不在文档内重复记录） |
| A15 | npm 安全 | 用户注册 npm 账号并**开启 2FA**；provenance/trusted publishing 配好 CI 后可再加，不阻塞 1.0 |

### C. M0 需要用户完成/确认的资源型待办（不是设计问题）

1. 注册 npm 账号并开启 2FA（发布凭证不经过对话）；
2. 用个人 GitHub 账号创建并公开 `dsh-plugins` 仓库（M0 只建仓/公开，M4 才发布）；
3. M0 由 AI 检查包名占用（`npm view dsh-handoff-kit`）；被占用则回到 TODO：改用用户自有 scope；
4. 英文文案 M4 发布前由用户抽查即可（不要求逐字审校）；
5. **2026-10-23 更新：已解决**——用户用手机移动网络完成 npm 账号注册（`shanaliaoliao`，邮箱已验证、2FA auth-and-writes 已开启），并在本机 PowerShell 完成 `npm login --auth-type=web`；GitHub 个人账号下已创建公开仓库 `CWTTT-1588123/dsh-plugins` 并完成 SSH 鉴权与首次 push。M4 剩余仅为 **rc.1 npm 发布 + 安装/回滚演练**（需用户逐次确认）。

## 1. 起点基线（P3 的事实依据）

### 1.1 本次复核的仓库事实（2026-10-22，只读实测）

| 项 | 事实 | 证据类别 |
|---|---|---|
| 版本/代码基线 | HEAD `0a2cbc9514d2ae1674cf7105506ccb933178daad`（`main`）；代码/版本自 `589c3f6` 起未变（`0a2cbc9` 仅文档提交：新增 `USAGE.md` + 索引/CHANGELOG/插件 README），`package.json` 与 `src/contracts.js` 均为 `0.3.1`；工作树仅本草案未跟踪 | [git]/[文件哈希] |
| 测试基线 | `npm test` 全绿：245 tests、0 fail（2026-10-22 实测；数量以 `npm test` 输出为准） | [实测] |
| 文档检查 | `node scripts/docs-check.mjs`：0 error / 1 warning（21 docs / 26 index rows；DC5：ADR-0001 冻结正文指向已归档 `START_PROMPT.md`，按治理规则允许） | [实测] |
| manifest 契约 | `schemaVersion=2`（`changes`/`fuel`/`lineage` 可选块），v1 保持只读兼容；manifest 键序与序列化规则已固定、可幂等解析 | [文件哈希] |
| 批次布局 | `HANDOFF.md` + `SHA256SUMS` + `manifest.json`（最后写，存在即完整）+ `evidence/{git,files,session,redactions}.json`；`copyFiles` 副本在 `evidence/files/` | [文件哈希] |
| trust 模型 | `verified` / `stale` / `invalid` 三态；verify 复算产物哈希、`SHA256SUMS`、源文件哈希、git HEAD、血缘与密钥残留 | [文件哈希] |
| 运行边界 | 零运行时依赖、不 import `@deepseek-ai/*`、无网络/子进程/LLM、写操作手动触发 | [文件哈希] |
| 运行形态 | 同包 Host half（工具/命令/技能/UI RPC）+ Client half（0.3.0 UI 工作台）；当前安装为 `plugin_manager install_bundle` 本地 `link:` | [实测] |
| 版本约束 | `engines.dsh: >=0.2.0 <0.3.0`；当前 profile 实测 DSH `0.2.1-rc.2` | [文件哈希]/[实测] |
| 仓库/发布现状 | **无 git remote**、26 个本地提交、`main` 无 upstream；`package.json` 版本 `0.3.1`、`private: true`、`license: MIT`；仓库根无 `LICENSE` 文件 | [实测] |

**与发布设计直接相关的新事实（本次只读 `plugin_manager list_bundles`）**：

- npm 包 → bundle 的安装通道**已在本 profile 被第三方包验证**：`dsh-session-insights@^0.5.2`、`dsh-grill-me@^0.1.0`、`@linxin666/dsh-web-all@0.4.6` 均以 npm spec 安装且 `installed: true`；官方 `installTarget.spec` 机制存在。→ 「npm 发布 + `install_bundle` 安装」是本 profile 可复现的主渠道。
- 官方**实验性插件市场** bundle（`@deepseek-ai/dsh-experimental-plugin-market-bundle`）存在但本 profile **未启用**。→ 「插件市场」只能作为可选渠道，不阻塞 1.0（A13、R6）。

### 1.2 0.3.1 安全门实测证据

> **0.3.1 开场提示词粘贴即验证（只读、零写入）已实测通过。**

证据链（本次接手会话即该提示词的首次真实粘贴样本）：

1. 本次接手会话由 0.3.1 `renderOpeningPrompt` 生成的提示词启动（批次 `20261022T140057Z-b49e`，`trust=verified`）；
2. 会话行为严格按提示词第 0–3 步执行：先 `handoff_load` 复核 trust → 按 H2→H3→H4→H8 读 HANDOFF → 独立复算 3 个文件 sha256、git HEAD、包内 `SHA256SUMS`、H4 改动统计 → 汇报并**等待用户明确指令**；
3. 全程未调用任何写工具、未改/删/建文件、未 commit；`git status --porcelain` 输出 0 行；
4. 在用户明确批准后才开始本设计草案的单文件写入。

**边界说明**：这是 1 次真实样本，不是统计性证明；0.3.1 回归测试 `opening prompt embeds a mandatory read-only gate before any work` 负责防止文案回退。该证据可作为 1.0 发布说明中「提示词安全门已实战有效」的依据。

### 1.3 与 P3 相关的既有挂账（沿用 [GAPS](../GAPS.md)，不新增承诺）

- **契约边界（不在 P3 修复，公开规范时如实写入）**：G1 无 `git status`、G2 无 mtime、G9 会话 trace 有界、M2-G1 当前 turn 改动不可见/Session 关闭后 summary 不可读。
- **P2 已知限制（A 档处置）**：P2-G1 工作台 root 作用域回退 → **纳入 P3**（显式项目选择器）；P2-G3 UI 仅中文/未接 locale → **纳入 P3**（英文优先 + i18n）；P2-G2 血缘不单列 → **不纳入**。
- **外部缺陷**：G12 任务板执行器（第三方插件，与本插件无关）。
- **ADR-0003 后移项**：Agent Teams 交接、漂移监视、定时/自动快照——**另行评审/新 ADR**，不纳入 1.0。

## 2. 目标、范围与不变量

### 2.1 A 档范围（ROADMAP P3 四项 + 公开产品化一项 → T1–T6）

| 工作包 | 内容 | 对应来源 |
|---|---|---|
| **T1 规范公开** | 版本化发布**英文** `spec/HANDOFF.md`（H0–H9、证据标签、`SHA256SUMS` 格式、批次布局、trust/verify 语义、错误码与 finding 码）+ `spec/verify.md`（验证算法/退出码）+ `schema/manifest.v1/v2.json`；规范与实现双向一致 | ROADMAP「manifest@2 / HANDOFF.md 规范公开」 |
| **T2 schema 迁移器** | 历史 v1 批次 → v2 的**只读源 + 新批次**迁移；迁移 provenance 可审计；未来 schema 演进框架；迁移演练通过 | ROADMAP「schema 迁移器」 |
| **T3 跨工具适配器** | 零依赖 CLI（`verify`/`load`/`list`/`migrate`/`sign`），固定退出码与 JSON 输出，英文 `--help`；非 DSH agent/CLI 可按规范消费同一交接包 | ROADMAP「跨工具适配器」 |
| **T4 发布与分发** | `private` 移除、发布元数据定稿；**npm 无 scope 公开包** + DSH bundle 安装；`1.0.0-rc.N` 节奏；GitHub 公开仓库 + Release/tag；插件市场仅可选 | ROADMAP「npm / 插件市场发布」 |
| **T5 可信度外层** | opt-in Ed25519 签名、审计回执、脱敏策略配置（内置规则为安全地板）；不破坏零依赖/无网络/无子进程 | ROADMAP「签名 / 审计 / 脱敏策略配置」 |
| **T6 公开门面与合规** | 英文顶层 README + 快速开始 + 截图；`LICENSE` 文件（MIT）；Issue 模板；**隐私与安全声明**；CI（Windows 必跑 + Linux/macOS 单测 + `docs:check`）；英文 UI 文案/locale 接入 + P2-G1 项目选择器 | A 档对齐新增（A5/A7/A12） |

**1.0 门槛（ROADMAP 原文）**：第三方可独立安装使用 + 迁移演练通过；本草案再叠加 §6.3 的 DoD（含 A 档门面/合规）。

### 2.2 不变量（P0–P2 已验收，P3 不得破坏）

1. 运行时**零依赖**、不 import 官方包；**无网络**、**无子进程**、**无默认 LLM 调用**。
2. 写操作必须**手动触发**并显示目标目录；只读动作**零写入**。
3. **历史批次永不原地重写**（append/update/迁移都写新批次并记录血缘/来源）。
4. 既有工具/命令/技能 API **向后兼容**：新增字段不删旧字段，错误码只增不改；manifest v1/v2 保持只读兼容。
5. 文档治理与证据模型（H0–H9 标签、trust 三态、`verify` 可复现）延续。

### 2.3 明确不做（1.0 范围内）

- Agent Teams 交接、漂移监视、定时/自动快照（ADR-0003 后移项，另行评审）；
- 自动执行 next steps、自动 push（发布 push 仅指人工确认的 M4 发布动作）、自动修复漂移、自动写盘/自动发送；
- 会话全文回放、长期记忆、项目管理、密钥保管、远程同步、任何运行期网络上传；
- 在插件运行时内引入第三方依赖或动态代码加载。

### 2.4 后移/不纳入（A 档决议）

- **P2-G2 血缘单列**：不纳入（对第三方价值低，徒增 P1 契约改动）；
- **插件市场上架**：仅可选，不列入 1.0 门槛（A13/R6）；
- **删除/归档 UI**：宿主无删除原语，沿用 G3 手动归档 runbook；
- **provenance / trusted publishing**：配好 CI 后可加，不阻塞 1.0（A15）。

## 3. 已确认设计决策（D1–D10，A 档定稿）

> 以下均为 v0.2 决议（对应 §0.1 与 §9），实施时不再重新选择；如需变更走 ADR/计划修订。

**D1 发布单元：单包多入口** — 现有 `dsh-handoff-kit` 包内新增 `bin/`（CLI 入口）、`spec/`、`schema/`，不拆新包。理由：规范/实现/版本单一事实源；bundle 安装与 CLI 安装共用同一版本线；拆包会让「规范版本 ≠ 插件版本」漂移。CLI 命令名 `handoff-kit`。

**D2 规范版本化** — `spec/HANDOFF.md`（英文规范性文本）+ `spec/verify.md`（验证算法、finding 码、退出码）+ `schema/manifest.v1.json`、`schema/manifest.v2.json`（JSON Schema）。规范版本与 `manifest.schemaVersion` 对齐；**1.0 冻结 v2**，新增可选块必须升 v3 并同时交付迁移器。理由：已发布的证据模型不能靠改 v2 悄悄扩展。

**D3 迁移器形态** — `handoff_pack action=migrate`（插件内，与工具同一套校验）+ CLI `handoff-kit migrate`；语义为**只读源批次 → 写新批次**，迁移 provenance 记入新批次的 `evidence/migration.json`（含源批次 id、源 `SHA256SUMS` 哈希、迁移时间、迁移者），不覆盖原批次、不改历史。**1.0 只做 v1→v2**；v2→v3 框架预留。理由：与「append-only、不原地改历史」一致；用证据文件而非新增 manifest 块，避免 1.0 中途改 manifest 契约。

**D4 跨工具消费契约（三层）** — L1 文本层（`HANDOFF.md` 人/AI 可读）；L2 机器层（`manifest.json` + schema + `SHA256SUMS` + **参考 verify CLI**，固定退出码/JSON）；L3（可选）JS API（纯函数 `verifyBatch()` 导出）。**1.0 先交付 L1+L2**，L3 视需求。CLI 约束：零依赖、Node ≥20、只读文件/哈希/JSON，**不 import DSH 包、不联网、不起子进程**；退出码冻结为 `0=verified`、`3=stale`、`1=invalid`、`2=用法/IO 错误`。理由：让「其他 agent / CLI 消费同一交接包」有可执行标准，而不是只有叙述。

**D5 发布渠道与授权** — 主渠道：**npm 公开包**（无 scope `dsh-handoff-kit`；2FA；移除 `private`；MIT；英文 README 安装段）+ **DSH bundle 安装**（`plugin_manager install_bundle target: dsh-handoff-kit@<version>`，本 profile 已用同类第三方 npm bundle 验证该通道）+ **GitHub 个人账号公开 `dsh-plugins` 仓库**（源码/文档/Issue/Release）。可选渠道：官方实验性插件市场。**发布动作（push/tag/publish）一律由 AI 准备、用户逐次确认后执行；首次 `npm publish` 由用户手动执行；凭证不入仓库、不进会话文本。**（A1/A2/A3/A4/A15）

**D6 版本与兼容** — 1.0 前每个里程碑发 **`1.0.0-rc.N`**（npm dist-tag `next`），M6 达标后发 `1.0.0`（`latest`）；`engines.dsh` 从 `>=0.2.0 <0.3.0` 调整为「M0 实测确认的支持矩阵」（草案：`>=0.2.0 <0.4.0`，README 标注实测版本）；manifest v1 只读兼容至少保留到 1.x。理由：1.0 是兼容承诺，必须先在 rc 阶段暴露规范/CLI 问题。（A11）

**D7 签名（opt-in，默认不签）** — **Ed25519 detached 签名 `signature.json`**（`alg`/`keyId`/`publicKey`/`signature`/`signedFile: "SHA256SUMS"`/`signedSha256`/`createdAt`），用 `node:crypto` 零依赖；`signature.json` 不进入 `SHA256SUMS`（它签的是 `SHA256SUMS` 的字节），不改变批次既有哈希语义。**默认不签名**；私钥只在 CLI/显式签名操作中使用，**不写入 profile、不进入会话上下文**；verify 输出 `SIGNATURE_VALID` / `UNSIGNED`（非 error）/ `SIGNATURE_INVALID`（error finding）。否决 HMAC（共享秘密语义弱、分发困难）。（A8）

**D8 审计与脱敏策略配置** — 审计 = 批次内 provenance（`generator.name/version/dshVersion/platform`）+ 可选签名 envelope + **verify 只读回执**（checker 身份/版本、`checkedAt`、输入哈希），不做持久化审计日志（保持只读语义）。脱敏策略 = 可选 `$DSH_HOME/handoff/policy.json`：严格 schema；**内置规则为安全地板，禁止关闭**，只允许追加 denylist/自定义规则/收紧阈值；策略内容 sha256 记入 `evidence/redactions.json` 的 `policy` 字段（不新增 manifest 块）；非法配置 **fail-closed**（拒绝生成，返回 `HANDOFF_POLICY_INVALID`）。理由：第三方场景需要可配置脱敏，但不能给「关掉安全规则」的开关。（A9）

**D9 语言与公开门面（英文优先）** — 对外交付物用英文：**顶层 README（重写为英文公开入口：安装/快速开始/隐私声明/链接到中文治理文档）、`spec/`、`schema/`、CLI `--help`、UI 文案、USAGE 英文版**；中文治理文档（ROADMAP/docs/设计/验收）保留并随仓库公开。UI 接入 locale（默认英文，可切中文，覆盖 P2-G3）；工作台补项目选择器（P2-G1）。英文文案由 AI 编写，用户不逐字审校、发布前抽查。（A5/A6/A12）

**D10 平台与 CI** — **Windows 优先 + macOS/Linux 实验性**：GitHub Actions 必跑 Windows 全量测试 + `docs:check`；Linux/macOS 跑单测（不承诺系统级行为）。README 如实写「实测平台」与「实验性平台」。理由：当前只有 win32 实测，公开产品不可虚假承诺。（A7）

## 4. 架构与接口草案（M0 通过前不实现）

### 4.1 包结构（建议）

```text
plugins/dsh-handoff-kit/
├── index.js / client.js / src/        # 现有 Host/Client 半区，不变
├── bin/handoff-kit.mjs                # 新增：零依赖 CLI（verify/load/list/migrate/sign）
├── spec/HANDOFF.md                    # 新增：交接包规范（英文，版本化）
├── spec/verify.md                     # 新增：验证算法/finding 码/退出码规范（英文）
├── schema/manifest.v1.json            # 新增：JSON Schema（历史兼容）
├── schema/manifest.v2.json            # 新增：JSON Schema（1.0 生成默认）
└── USAGE.en.md                        # 新增：英文使用说明（中文 USAGE.md 保留）
```

- `package.json` 增 `bin`、`engines.node`、发布元数据（`repository` 等；**author 不写个人邮箱**）；`files` 纳入 `bin`/`spec`/`schema`/英文 USAGE；**测试与临时证据不入包**。
- `locale/en.json` 扩展为 UI 文案英文源；`zh.json` 为中文；client 接 locale 服务。
- 仓库根新增 `LICENSE`（MIT）、`.github/ISSUE_TEMPLATE/`、`.github/workflows/ci.yml`（M4 交付，见 §4.8）。

### 4.2 发布物清单（M4 前用 `npm pack --dry-run` 核对）

`index.js`、`client.js`、`src/**`、`skills/**`、`locale/*.json`、`icon.svg`、`cordis.patch.yml`、`README.md`、`USAGE.en.md`、`bin/**`、`spec/**`、`schema/**`、`package.json`；不包含 `test/**`、`evidence/**`、仓库级文档。1.0 时 `private` 已移除、`engines.dsh`/`engines.node` 已定稿。

### 4.3 CLI 契约（草案）

```text
handoff-kit verify  <batchDir> [--json]            # 复算哈希/漂移，输出 trust 与 findings
handoff-kit load    --dir <root> [--batch <id>] [--json]   # 只读摘要（不含 narrative）
handoff-kit list    [--root <handoffRoot>] [--all] [--json]
handoff-kit migrate <batchDir> --out <newBatchDir> [--to 2]
handoff-kit sign    <batchDir> --key <path>        # opt-in；默认不要求
handoff-kit verify-signature <batchDir> [--pubkey <path|keyId>]
```

- 位置解析优先显式 `--dir/--out`，不依赖 `$DSH_HOME`（跨工具场景）；
- 输出 JSON 字段为 `handoff_load`/`verify` 的**稳定子集**；退出码表在 `spec/verify.md` 冻结（D4）；
- 只读命令零写入；`migrate`/`sign` 只在显式调用时写**新产物**；`--help` 英文。

### 4.4 verify/trust 规范要点（冻结进 spec，实现不变）

1. 产物完整性：`SHA256SUMS` ↔ 文件字节；manifest `artifacts[]` ↔ 实际文件；
2. 结构完整性：manifest schema 校验（v1/v2 各自 schema）、必需文件存在、批次 id 形状；
3. 漂移：manifest 记录的源文件哈希 ↔ 当前工作区；git HEAD ↔ 记录值（git 不可用时降级为 warning）；
4. 血缘：`LINEAGE_BROKEN`（error）/ `SUPERSEDED_BATCH`（warn）；
5. 安全：批次内密钥残留扫描（`finalCheck`）；
6. trust 判定：`errors>0 → invalid`；否则 `warnings>0 或漂移 → stale`；否则 `verified`。

### 4.5 迁移语义（v1 → v2）

- 前置：源批次 verify 必须无 error（否则 `MIGRATION_SOURCE_INVALID`）；
- 行为：读源 → 构造 v2 manifest（`changes`/`fuel` 置 `available:false` + note，因为历史宿主证据不可回读；保留 `sessionTrace`/`git`/`files`/`redactions` 原值）→ 复制证据 → 写 `evidence/migration.json` → 正常写 `SHA256SUMS`/`manifest`（manifest 最后）；
- 审计：`migration.json` 记录源批次 id、源 `SHA256SUMS` 哈希、迁移时间、迁移实现版本；原批次**不写一个字节**（迁移前后哈希对照证明）；
- 不自动建立 `lineage`（迁移不是"继承工作"，是"格式升级"）；若用户要续接，另用 `append`。

### 4.6 签名/审计/策略接口（对应 D7/D8）

- `signature.json`：签名 envelope；公钥信任来源优先级 `--pubkey` → `$DSH_HOME/handoff/trusted-keys.json`（只读列表）→ `UNSIGNED`；
- `policy.json`：`{ version, denylist: {paths[], extensions[]}, redaction: {rules:[{kind,pattern,flags,replacement?}]} }`；内置 `REDACTION_RULES` **不可禁用**；
- `evidence/redactions.json` 增 `policy: {sha256, source: tokenizedPath|null}`；策略读取失败或校验失败 → fail-closed；
- verify 回执：`checker {name, version}`、`checkedAt`、输入哈希；除 `checkedAt` 外两次运行结果稳定（沿用 P0 的可复现原则）。

### 4.7 兼容承诺（1.0）

1. manifest v1 只读兼容保留到 1.x；v2 为生成默认；v3 必须带迁移器与新规范版本；
2. 工具/命令/技能：新增可选参数与输出字段不破坏旧字段；错误码只增不改；
3. CLI：JSON 字段与退出码在 1.0 冻结；破坏性变更按 semver major；
4. 文档：规范/README/技能随发布更新，`docs:check` 0 error 才允许收尾。

### 4.8 公开门面与合规清单（M4 交付，T6）

| 交付物 | 内容 | 判定 |
|---|---|---|
| 英文顶层 README | 一句话定位、安装、快速开始、UI 截图、隐私/安全摘要、平台声明、链接中文治理文档 | 用户可读性人工检查 |
| `LICENSE` | MIT 全文（与 `package.json` 一致） | 文件存在 + 一致 |
| Issue 模板 | bug / feature 模板（含"交接包隐私"提示） | GitHub 上可见 |
| 隐私与安全声明 | 交接包会写什么（工作区路径/哈希/会话工具元数据/脱敏命令片段）、默认脱敏、敏感场景建议、无网络声明、漏洞报告渠道 | 人工评审 |
| CI（`.github/workflows/ci.yml`） | Windows：全量测试 + `docs:check`；Linux/macOS：单测；`npm pack --dry-run` | Actions 全绿 |
| 英文 UI + locale | 工作台文案英文默认、中文可切；不改变只读/写操作语义 | 浏览器实测 |
| P2-G1 项目选择器 | 工作台显式选择项目，消除 root 作用域回退歧义 | 浏览器实测 |

## 5. 里程碑（M0–M6，每步用户确认后进下一步）

| 里程碑 | 内容 | 交付物 | 门槛 |
|---|---|---|---|
| **M0 评审收口与基线**（✅ 已完成 2026-10-23） | 本文件批准为执行计划；A 档决议落档；P3 验收计划；包名占用检查（已完成）；DSH 版本支持矩阵实测；`LICENSE`/Issue 模板/CI 落点确认。**发布资源（npm 账号+2FA、GitHub 公开仓库）延后到 M4 前**（用户 2026-10-23 指示）。**不改产品代码** | 本文件 + 索引/ROADMAP 同步 + M0 决议 | 用户确认开工（2026-10-23） |
| **M1 规范公开**（✅ 已完成 2026-10-23） | 英文 `spec/HANDOFF.md`、`spec/verify.md`、`schema/manifest.v1/v2.json`；规范测试向量（合规/反例 fixture） | 规范 + schema + `test/spec.test.js` 向量 | 规范落地；`npm test` 全绿；`docs:check` 0 error（M1 提交 `f656c09`） |
| **M2 schema 迁移器**（✅ 已完成 2026-10-23） | `migrate`（插件工具 + `/handoff migrate`）；v1→v2；`evidence/migration.json` provenance；迁移测试与只读源断言 | 迁移器 + `test/migration.test.js` | 源批次零写入/字节不变；新批次 verify 通过；`npm test` 全绿（M2 提交 `e3e6cba`） |
| **M3 跨工具适配**（✅ 已完成 2026-10-23） | 零依赖 CLI `verify/load/list/migrate` + 英文帮助；非 DSH 环境真实文件系统 E2E；真实批次只读复验演练（CLI 直接读用户级交接包，trust=verified） | `src/cli.js` + `bin/handoff-kit.mjs` + `test/cli.test.js` | 退出码 0、3、1、2 与 spec 一致；`npm test` 全绿（M3 提交 `ce3cb8d`） |
| **M4 发布与公开门面**（**已完成 2026-10-23**：门面/CI/UI/rc.1 发布/安装演练 + 浏览器验收通过；rc.1 后语言/回退修复待 rc.2 发布；安装工具链缺陷见 GAPS §3） | `package.json` 发布元数据定稿；`npm pack --dry-run` 核对；**T6 门面**（英文 README/`LICENSE`/Issue 模板/隐私安全声明/CI/英文 UI+locale/P2-G1 选择器）；`1.0.0-rc.N` 发布到 `next`（**首次用户手动**）；bundle 通过 npm spec 安装/卸载/回滚演练；插件市场可选 | npm rc 包 + 公开仓库 + 安装/回滚记录 | 用户逐次授权；安装回执；CI 全绿 |
| **M5 可信度外层** | 签名 opt-in + 策略配置 + 审计回执；负例测试（坏签名/篡改/坏策略 fail-closed） | 签名/策略实现 + 测试 | 负例全绿；默认路径零依赖不变 |
| **M6 1.0 门槛验收** | 第三方代理独立安装使用 + 迁移演练 + 回滚 + 全量回归 + `docs:check` 0 error；P3 验收记录、CHANGELOG `1.0.0`、P3 文档冻结、ROADMAP 状态更新；隐私/平台声明复核 | `1.0.0`（latest）+ `docs/handoff-kit/acceptance/P3.md`（M6 产出，届时再建链） | ROADMAP P3 门槛 + §6.3 DoD + 用户确认 |

顺序理由：规范（M1）先于适配器（M3）与发布（M4）；迁移器（M2）依赖规范；门面与 CI 在 M4 与首发合并；签名/策略（M5）依赖规范；1.0 最后统一验收。

## 6. 测试与验收策略

### 6.1 机器层（每次里程碑收尾必跑）

- **单测扩展**：schema 正/反例、迁移 fixture（v1 批次构造）、CLI E2E（临时目录）、签名/策略负例、退出码断言、`npm pack` 清单断言；回归全绿（**数量以 `npm test` 输出为准**，current 文档不写死）。
- **规范↔实现一致性**：实现生成 → schema 校验通过；schema 反例 → 实现拒绝；`serialize(parse(x)) === x` 幂等保持。
- **边界静态检查**：断言 `bin/`/`spec/`/`schema/` 不 import `@deepseek-ai/*`、无网络 API、无 `child_process`；插件运行时零依赖不退化。
- **CI**：Windows 全量测试 + `docs:check`；Linux/macOS 单测；`npm pack --dry-run` 无意外文件。
- **文档**：`node scripts/docs-check.mjs` 0 error（warning 按 ADR-0002 允许）。

### 6.2 人工/外部层（诚实代理验收）

- **第三方独立安装（代理）**：干净临时目录 + 独立 profile，从 npm 安装并用 `plugin_manager` 安装 bundle；记录完整命令与输出。**若无法取得真实第三方，就写"代理验收：本人 + 干净环境"，不宣称真实第三方。**（A10）
- **跨工具消费**：不依赖 DSH 的消费者（纯 Node 脚本或另一个 agent 会话）按 `spec/HANDOFF.md` 的 H8 步骤只读复验，报告 trust；作为「其他 agent 可消费」证据。
- **迁移演练**：v1 fixture + 真实历史批次**副本**（复制到 temp，不碰原批次）→ migrate → verify；迁移前后原批次哈希对照，证明零写入。
- **回滚演练**：`remove_bundle` → 重装上一版本（npm dist-tag 或本地 link）→ 复验工具可用；记录命令与结果。
- **公开门面人工检查**：英文 README 安装步骤从零照做一遍；隐私声明逐条对照实际写入内容；Issue 模板可用。
- **发布执行**：rc 发布由 AI 准备、用户确认；**首次 `npm publish` 由用户手动执行**；AI 记录发布命令与结果（不含令牌）。
- **0.3.1 安全门**：保留 §1.2 的真实样本；M6 前再跑一次"新会话粘贴提示词 → 只读验证 → 等待指令"演练。

### 6.3 1.0 DoD 清单

ROADMAP P3 门槛（第三方可独立安装使用 + 迁移演练通过）+ 全部机器层检查绿 + CI 三平台矩阵通过 + `docs:check` 0 error + 英文公开门面/隐私声明/`LICENSE`/Issue 模板就绪 + CHANGELOG `1.0.0` + P3 验收记录冻结 + 回滚演练通过 + 用户确认。

## 7. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 发布不可逆/凭证与账号风险 | M4 前只做 dry-run；发布需用户逐次确认；首次 `npm publish` 由用户手动；记录 dist-tag 回滚路径；凭证不入仓库/会话文本 |
| R2 | 规范冻结过早，1.0 后发现缺陷 | 1.0 前以 `1.0.0-rc.N` 发布；规范在 rc 阶段允许修订，1.0 才承诺兼容 |
| R3 | 第三方环境差异（Windows/POSIX、token 路径、Node 版本） | spec 明确 `$WORKSPACE`/`$DSH_HOME` 路径与跨平台规则；CI 跑三平台单测；README 如实写实验性平台 |
| R4 | 签名密钥管理不当 | 私钥不入 profile/会话；opt-in；无 key 时 `UNSIGNED` 非 error；信任来源显式配置 |
| R5 | 脱敏策略配置被滥用（关规则/逃逸） | 内置规则安全地板不可关闭；非法配置 fail-closed；策略哈希记录；负例测试 |
| R6 | 插件市场为实验性/未启用 | 主渠道 npm + GitHub；市场仅可选；不阻塞 1.0 门槛 |
| R7 | `engines.dsh` 声明过宽造成静默不兼容 | M0 确认支持矩阵；README 标注实测版本；1.0 只声明已验证范围 |
| R8 | 没有真实第三方可验收 | 代理验收 + 如实标注；把它写进 P3 验收记录，不夸大 |
| R9 | 迁移写坏历史批次 | 只读源 + 写新批次 + 前后哈希对照 + fixture 测试 |
| R10 | 0.3.1 存量用户升级路径不清 | CHANGELOG/README 写迁移说明；v1 批次只读兼容保持；安全门证据写入发布说明 |
| R11 | CLI 引入子进程/网络违反边界 | 静态检查 + 评审；CLI 只做文件/哈希/JSON；M4 发布前复查 |
| R12 | 公开产品的维护成本（Issue/PR/英文支持） | 1.0 只承诺明确支持面；Issue 模板声明响应预期；已知缺口写进 GAPS/README |
| R13 | 提交身份/邮箱随公开仓库暴露 | **用户已接受**（A14）；README 不额外暴露联系方式，Issue 为主渠道 |
| R14 | npm 账号被盗导致恶意发布 | 用户开启 2FA；首次发布手动；后续可加 provenance/trusted publishing（A15） |
| R15 | 中文治理文档随仓库公开（信息面变大） | **用户已接受**（A1）；文档中已无密钥，发布前再跑一次仓库级密钥扫描 |
| R16 | 英文文案质量/与中文文档漂移 | AI 负责文案；发布前用户抽查关键页；中文文档仍是治理权威，英文以用户文档为主 |

## 8. 依赖与顺序

```text
M0 评审/基线 → M1 规范 → M2 迁移器 → M3 跨工具适配 → M4 发布/公开门面 → M5 签名/策略 → M6 1.0 门槛
```

- M2/M3/M5 依赖 M1 的规范；M4 依赖 M1+M3（发布物与 CLI）+ T6 门面；M6 依赖全部。
- 每个里程碑收尾：更新 current 文档（README/技能/索引/ROADMAP）+ `docs:check` 0 error + 用户确认，再进入下一步（沿用 ROADMAP 落地机制）。
- P0–P2 冻结文档不改；需要改动索引/ROADMAP/CHANGELOG 时按治理流程单独批准。

## 9. 决议记录（v0.2：设计层已无开放问题）

| # | 问题 | 决议（2026-10-22 用户确认） |
|---|---|---|
| Q1 | P3 范围 | **全做 T1–T6**（含 A 档公开门面）；ADR-0003 后移项不纳入 |
| Q2 | 发布目标与授权 | GitHub 个人账号公开 `dsh-plugins`；npm 无 scope `dsh-handoff-kit`；AI 准备、用户逐次确认后执行 push/tag/publish；首次 publish 用户手动 |
| Q3 | 单包 vs 拆包 | **单包多入口**；CLI 名 `handoff-kit` |
| Q4 | 签名 | **opt-in Ed25519，默认不签名**；受信公钥 `--pubkey` + trusted-keys 文件 |
| Q5 | 策略配置 | `$DSH_HOME/handoff/policy.json`；只能追加规则，内置规则不可关，fail-closed |
| Q6 | 迁移器 | **1.0 只做 v1→v2**；不建 `lineage`，用 `evidence/migration.json` |
| Q7 | ADR-0003 后移项 | **不纳入 1.0**，另立 ADR 评审 |
| Q8 | 版本策略 | 每里程碑 `1.0.0-rc.N`；`engines.dsh` M0 实测后定（草案 `>=0.2.0 <0.4.0`） |
| Q9 | P2 挂账 | **纳入 G1、G3**；不纳入 G2 |
| Q10 | 第三方验收 | **代理验收** + 如实标注 |
| Q11 | 许可/可见性 | MIT；仓库整体公开（A1/A14） |
| A5/A6 | 语言与文案 | 英文优先 + 中文保留；**用户不审校**英文文案，发布前抽查 |
| A7 | 平台 | Windows 优先 + macOS/Linux 实验性；CI 三平台单测 |
| A13 | 插件市场 | 仅可选渠道，不列 1.0 门槛 |
| A15 | npm 安全 | 用户注册 + 2FA；provenance/trusted publishing 后续可加 |

## 10. 修订与批准记录

- 2026-10-22：v0.1 草案创建（从零编写；依据 ROADMAP P3 + ADR-0003 + §1 实测基线；未参考仓库外旧草稿）。
- 2026-10-22 22:25：v0.1.1 基线刷新——仓库 HEAD 由 `589c3f6` 前进到 `0a2cbc9`（文档提交；代码/版本未变），§1 与 docs-meta `verified` 同步。
- 2026-10-22 23:05：**v0.2 A 档对齐落档**——用户确认产品档位 A（开源公开产品）并完成两轮选项对齐；新增 §0.1 定位与 15 条决议（A1–A15）、T6 公开门面与合规、D9 语言门面、D10 平台 CI；D5/D6/D7/D8 定稿；§9 由开放问题改为决议记录；新增 R12–R16。本文件仍为未跟踪草案，未 commit。
- 2026-10-23 00:20：**v1.0 批准开工（M0 完成）**——用户 2026-10-23 确认「总之进行P3吧」，P3 进入执行；M0 决议：①发布资源（npm 账号+2FA、GitHub 公开仓库）因注册受阻**延后到 M4 前**，不阻塞 M0–M3；②DSH 版本矩阵：当前实测 `0.2.1-rc.2`，1.0 暂维持 `engines.dsh >=0.2.0 <0.3.0`（不声明未验证范围），M4 前再评估；③包名 `dsh-handoff-kit` 未被占用（M0 检查完成）；④文档治理落地：本文件登记入 [docs/README](../../README.md) §4、ROADMAP P3 改为进行中，`docs:check` 0 error。本文件转为 P3 执行计划（current），本地提交、不 push。
- 2026-10-23 00:21：**M1 规范公开完成（提交 `f656c09` + 向量 `85c6162`）**——英文规范 `spec/HANDOFF.md`（批次布局/manifest@1/2/HANDOFF H0–H9/证据标签/trust）与 `spec/verify.md`（验证步骤/finding 码/CLI 退出码）；`schema/manifest.v1.json`（v2 派生，历史兼容）与 `schema/manifest.v2.json`；`test/spec.test.js` + `test/helpers/json-schema-lite.js` 规范向量（正例、版本边界、反例拒绝）；`package.json files` 纳入 `spec/schema`；索引/ROADMAP 同步；`npm test` 全绿、`docs:check` 0 error。
- 2026-10-23 00:24：**M2 schema 迁移器完成（提交 `e3e6cba`）**——新增 `handoff_pack action=migrate` 与 `/handoff migrate <batchId>`：源批次先 verify（error 即拒 `HANDOFF_MIGRATION_SOURCE_INVALID`），仅支持 v1→v2（`HANDOFF_MIGRATION_UNSUPPORTED_VERSION`）；只读源、写新批次；`evidence/migration.json` 记录 source batch id / `SHA256SUMS` 摘要 / 源 generator / 迁移时间 / 工具身份；`changes`/`fuel` 标 `available:false` + `MIGRATED_FROM_V1`；不建 lineage；`test/migration.test.js` 覆盖源字节不变/负例/命令解析；`npm test` 全绿、`docs:check` 0 error。下一步 M3 跨工具 CLI。
- 2026-10-23 00:28：**M3 跨工具 CLI 完成（提交 `ce3cb8d`）**——新增 `src/cli.js`（可测试核心）+ `bin/handoff-kit.mjs`：`verify`/`load`/`list`/`migrate`，退出码 0、3、1、2 冻结进 spec；`--json` 稳定输出、`--workspace` 才做漂移检查；复用同一套 manifest/verify/render/redact 模块；无网络/无子进程/无 `@deepseek-ai` 导入；`package.json` 增加 `bin`/`files`/`engines.node`；`test/cli.test.js` 真实文件系统 E2E（正例/篡改/漂移/迁移/退出码/边界静态检查）。**非 DSH 消费演练**：CLI 直接读取用户级真实批次 `20261022T140057Z-b49e` → `verify` exit 0 / trust=verified，`list` 9 批次，`load` 正常。`npm test` 全绿、`docs:check` 0 error。M1–M3 目标完成，M4 待发布账号资源。
- 2026-10-23 01:30：**M4 公开门面开始**——新建并推送 GitHub 公开仓库 `CWTTT-1588123/dsh-plugins`（SSH 推送）；提交 `a5dd175`（英文根 README、根/包内 `LICENSE`（MIT）、YAML Issue 模板、GitHub Actions CI：Windows 必跑 + Linux/macOS 实验性非阻塞、发布元数据移除 `private`）、`d476d2c`（英文 `USAGE.en.md` + 索引/发布清单同步）。npm 账号 `shanaliaoliao` 注册完成并开启 2FA，本机 `npm login --auth-type=web` 成功。
- 2026-10-23 01:41：**CI 修复（提交 `62adf57`）**——GitHub Actions 默认 `core.quotepath=true` 使中文归档路径被 C-quote，`docs:check` 误报 DC1/DC2/DC3 共 9 errors（本机 global 配置为 false 未复现）；`scripts/docs-check.mjs` 的 git 调用统一强制 `-c core.quotepath=false`，模拟 CI 环境验证通过，CI 转绿（Windows required success）。
- 2026-10-23 01:53：**M4 门面/UI 完成（提交 `9781ce5`；rc.1 待发布）**——版本 `1.0.0-rc.1`；英文优先 UI i18n（client 内嵌 EN/ZH 142 keys + `locale/*.json`，测试强制同步；跟随页面/浏览器语言，中文全文保留）；P2-G1 工作台项目/会话选择器（显式展示 Host 解析的 project/workspace/session 与 live/fallback 徽章，支持 pin/knownSessions，复用现有只读 `state` RPC，无新 RPC）。client 测试 3→19、总计 283 全绿、client.js 无网络/子进程/eval 新增；`docs:check` 0 error。**`npm publish --tag next`（1.0.0-rc.1）待用户确认后执行。**
- 2026-10-23 08:3x：**1.0.0-rc.1 发布完成 + 安装演练（含严重工具链发现）**——npm 发布成功（registry `latest`/`next` 均指向 `1.0.0-rc.1`；tarball 33 文件核对通过、无 test/docs/.github；`npx dsh-handoff-kit@1.0.0-rc.1 verify <真实批次>` → exit 0 / trust=verified）；git tag `v1.0.0-rc.1` 已推送。**安装演练**：npm 包体安装成功，但实时激活失败、需重启 DSH；`plugin_manager remove_bundle` 对 `link:` bundle **清空了本地插件目录 64 个文件**，已 `git restore` 完整恢复并验证（283 测试/docs:check 0 error/工作树干净/junction 可解析）。详见 [GAPS](../GAPS.md) §3。当前 profile 已恢复为 link 安装（待重启加载）。
- 2026-10-23 08:4x：**重启后插件恢复**（`handoff_pack`/`handoff_load` 工具与 `handoff-pack` 技能重新加载；profile 为 link 安装、版本 `1.0.0-rc.1`；工作树干净、283 测试全绿）。**新发现（GAPS §3.4）**：M4 添加 GitHub remote 使 `projectKey` 由 `dsh-plugins-cb7aa4e5`（workspace seed）变为 `dsh-plugins-45e08a68`（remote seed），旧 8 批次默认入口不可见；CLI 显式批次路径仍可 verify（trust=verified）。列入 1.0 前收口：显式 `batchId` 跨 project key 只读回退（`PROJECT_KEY_FALLBACK` 警告）+ 文档迁移说明。
- 2026-10-23 09:0x：**rc.1 后修复完成（提交 `91a4fae`，待 rc.2 发布）**——①中文界面回归：语言探测改为「显式偏好 > 浏览器 zh* > 页面 lang > 英文」，新增工作台/浮层面板 **中文/English** 切换（即时生效、`localStorage: dsh.handoff-kit.locale`）；②projectKey 变化：显式 `batchId` 的 `load`/`verify` 跨兄弟 project key **只读**回退（`PROJECT_KEY_FALLBACK` 结果级警告，不降级 trust；回退只匹配同 workspace slug 的历史 key，避免混入无关项目，提交 `2430f1b`），工作台 0 批次时按 key 分组显示历史批次（只读横幅、禁用继续交接），写操作仍只写当前 key；spec/HANDOFF §2/§5、spec/verify §5.3、README/USAGE 已同步。测试 283→301 全绿、`docs:check` 0 error；后续小修为 303 测试。
- 2026-10-23 09:10：**M4 浏览器验收通过（用户确认，截图证据）**——重启后插件从本地 link 加载（工具/技能正常、版本 `1.0.0-rc.1`）：①界面中文（探测顺序修复生效，中文/English 切换可见）；②「载入」显示「历史项目（只读）」横幅 + `dsh-plugins-cb7aa4e5` 的 8 个旧批次（分组/只读徽章，`stand-*` 无关项目已被 slug 过滤排除）；③打开旧批次 `20261022T140057Z-b49e` 显示 `trust=stale` 与 9 条漂移警告（`GIT_HEAD_CHANGED` 589c3f6→ccaf0e2、`SOURCE_FILE_CHANGED` 等，属正确漂移）；④Host 侧 `handoff_pack verify` 对该显式 batchId 走跨 key 只读回退并返回 `PROJECT_KEY_FALLBACK` 结果级警告。测试 303 全绿、`docs:check` 0 error/0 stale。**M4 收口；rc.2 版本已提交（`dd91f73`），待用户 `npm publish --tag next`；随后 M5 签名/审计/脱敏策略。**

**文档治理落点（评审通过后，需另行批准的改动）**：

1. 在 [docs/README](../../README.md) §4 文档总表登记本文件（`status=current`、phase=P3）；
2. 更新 ROADMAP P3 状态与修订记录（本轮不改）；CHANGELOG 在首个 rc 发布时记录；
3. 本文件当前为**未跟踪新文件**，`docs:check` 的扫描集合来自 `git ls-files`，因此暂不参与 DC1/DC3 检查；`git add` 前需同步索引，否则出现 DC1 error（这是预期治理顺序，不是缺陷）。
