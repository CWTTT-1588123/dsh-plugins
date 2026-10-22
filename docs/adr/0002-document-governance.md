# ADR-0002：文档治理——四类文档、冻结归档与 docs:check

<!-- docs-meta: status=frozen; phase=cross; verified=dda8796@2026-10-22; tracks=-; supersedes=-; superseded-by=- -->

- 日期：2026-10-22
- 状态：**已接受**
- 相关：[WORKSTREAMS](../WORKSTREAMS.md)、[ROADMAP](../../ROADMAP.md)、[ADR-0001](0001-handoff-kit-repo-and-decisions.md)、[文档索引](../README.md)、[检查清单](../DOC_CHECKS.md)
- 背景问题：AI 编程产生大量文档；文档随项目推进出现**时间/位置/权威**三种偏移，旧文档留在主路径被下一个 AI 当成事实。

## 背景

1. 本仓库已出现偏移点（[WORKSTREAMS](../WORKSTREAMS.md) §4.3）：根 README 停在 P0、旧索引称 P1 计划"待审"、P0 计划自称"现行权威"、历史文档与现行文档并排。
2. 已认可"低承诺、两层"机制：**机器只检查结构与新鲜度，语义只核对少数 current 文档**；不承诺"文档内容全对"。
3. 该机制适用于本仓库所有插件文档，因此作为仓库级治理决策记录（而非某个插件阶段计划）。

## 决策

### D1. 文档四类与生命周期（强制）

| 类型 | 例子 | 变更规则 | 冻结时机 | 默认位置 |
|---|---|---|---|---|
| **决策 ADR** | `adr/0001`、本文件 | **只增不改**；被新 ADR 取代，旧 ADR 保留 | 接受即冻结 | `docs/adr/` |
| **计划 plan** | P0/P1/P2 实施计划 | 阶段内可更新；**阶段验收通过即冻结**，后续变更写新计划/ADR | 阶段验收 | `docs/<插件>/design/` |
| **验收 record** | P0/P1 验收、GAPS 台账 | **冻结**；只允许追加"勘误/补充"章节并注明日期 | 写就冻结 | `docs/<插件>/acceptance/`、`GAPS.md` |
| **当前真相 current** | ROADMAP、`docs/README.md`、根 README、当前阶段计划 | **唯一允许原地更新**的文档；每次更新必须刷新 `verified` | 阶段结束由新阶段文档接替 | 根目录 / `docs/` |

**只有 current 类可以原地改正文。** 冻结类的新结论必须写成新 ADR/新 plan/追加章节，并让索引指向新文档。

### D2. 文档头元数据（强制，机器可读）

仓库内所有 Markdown（`docs/archive/**` 除外）在标题后带一行 HTML 注释，渲染不可见、grep/脚本可读：

```html
<!-- docs-meta: status=current; phase=P2; verified=dda8796@2026-10-22; tracks=plugins/dsh-handoff-kit/src,docs; supersedes=-; superseded-by=- -->
```

字段规则：

- `status`：`current | frozen | superseded | historical`；
- `phase`：`P0|P1|P2|P3|cross`；
- `verified`：`<commit>@<YYYY-MM-DD>`，即最后一次**对照代码/测试核对**的提交与日期；
- `tracks`：该文档描述的代码/配置路径（逗号分隔）；纯协调文档可为 `-`；
- `supersedes` / `superseded-by`：文档路径，没有则 `-`；
- `current` 必须带 `verified`；`frozen` 必须带 `verified`；`superseded`/`historical` 必须有 `superseded-by` 或位于 `docs/archive/`。

**不使用 YAML frontmatter**（避免污染用户可读文档）；不使用中心 JSON 替代（AI 直接读单文件时也需要看到状态）。

### D3. 单一索引与权威顺序

- `docs/README.md` 是**唯一文档索引**；所有 Markdown 必须登记，未登记视为无效文档；
- 新会话入口固定为：`ROADMAP` → `docs/README.md` → 当前阶段 plan；不按目录浏览；
- **权威顺序**：运行事实（代码/测试/实测） > ADR（决策） > ROADMAP（阶段状态） > `docs/README.md` + current 计划（当前描述） > 冻结文档（历史，只读）；
- 任何文档结论与更高层权威冲突时，以更高层为准，并应更新/归档该文档（不得两处并存）。

### D4. 冻结与归档

1. 阶段验收通过：该阶段 plan/record 改 `status=frozen`，正文不动；
2. 历史材料（已被取代的草案/入口提示词/旧索引）**移出读路径**到 `docs/archive/<插件>/`，首行 `docs-meta` 标 `status=historical`；文件名保留原日期前缀；
3. 归档不删除（git 历史之外仍可复查）；索引中只以 historical 形式列出；
4. 冻结文档正文不可编辑；确需勘误时追加 `## 勘误（YYYY-MM-DD）` 章节，并由索引记录。

### D5. 两层检查（低承诺）

- **机器层** `docs:check`：清单见 [DOC_CHECKS.md](../DOC_CHECKS.md)。确定性检查索引/元数据/状态/链接/`tracks` 新鲜度/派生事实/归档隔离；覆盖全部文档，文档再多也不增加成本；输出 `verified/stale/invalid` 三态（与交接包 trust 模型同构）；
- **语义层**：只审 `status=current` 的少数量文档，只在阶段开始/收尾，用代码/测试取证后刷新 `verified`；冻结文档**永不重审**；
- **不做承诺**：不保证文档内容全对；保证"旧文档不会被当现行、结构性漂移可检测、语义核对只发生在少数时点"。

### D6. 减少可漂移事实

1. 版本号以 `package.json` 为准；测试数量以测试输出为准（文档引用时带命令与日期，不作为权威数字）；
2. 接口/数据结构以代码/契约为准，文档链接而非复制；
3. 默认不新增文档；能合并进现有 current 文档就不新建；每份文档在索引中登记"负责范围与读者"；
4. 阶段收尾时优先更新 current 文档与索引，其次才写新说明。

### D7. 变更流程与强制点

```text
新需求 → 新 ADR（决策） → 新/更新 plan → ROADMAP 修订记录 → 实施 → 验收 → 冻结
```

- 顺序不可倒；ROADMAP 修订必须写"修订记录（日期/原因/用户确认）"；
- 强制点：新会话提示词要求先读 `ROADMAP` + 索引；阶段收尾必须跑 `docs:check`；提交前 `docs:check` 无 error（warning 允许）；
- 不设自动 hook（避免不可控的静默修改）；由协议 + 阶段清单保证。

## 后果

**正面**：旧文档物理隔离；current 文档面小；stale 可机器判定；新 AI 会话有唯一入口；新需求不再"悄悄改旧计划"。

**代价**：D3 需一次性补元数据/归档（约 17 份文档）；`docs:check` 需 D2 实现与维护；current 文档必须在阶段边界更新 `verified`。

## 未采纳

| 方案 | 否决理由 |
|---|---|
| 让 AI 审查所有文档内容 | 数量/语义成本不可控，必然抽样漏检（已讨论） |
| 只维护 README 一张表、不写单文件元数据 | AI 直接 grep 单文件时看不到状态，旧文档仍会被误读 |
| 只建中心 JSON manifest、不给文档加头 | 与上同；且人读单文件时无上下文 |
| 删除过期文档 | 丢失历史与审计线索；应为归档而非删除 |
| YAML frontmatter | 污染用户可读文档；HTML 注释渲染不可见 |
| 每次提交强制 pre-commit hook | 静默/不可控，与"低承诺"不符；留给协议与阶段清单 |

## 生效

本 ADR 自 2026-10-22 起生效。D1 建立骨架；D2 实现 `docs:check`；D3 对既有文档落地；D4 起新需求按本流程进入路线。
