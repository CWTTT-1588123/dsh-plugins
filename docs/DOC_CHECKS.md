# docs:check 检查清单（规格）

<!-- docs-meta: status=current; phase=cross; verified=dda8796@2026-10-22; tracks=scripts/docs-check.mjs; supersedes=-; superseded-by=- -->

> 状态：**current**（D1 规格；D2 实现脚本）
> 依据：[ADR-0002 文档治理](adr/0002-document-governance.md) §D5
> 读者：D2 实现者、阶段收尾执行者
> 非目标：**不检查语义正确性**（文档内容是否与代码逻辑一致、API 描述是否准确、文字质量），这些由语义层（阶段开始/收尾、只审 current 文档）负责。

## 1. 输入与运行

- 运行位置：仓库根 `D:\repos\dsh-plugins`；
- 命令（D2 实现）：`node scripts/docs-check.mjs [--json] [--root <dir>]`；
- 零运行时依赖；需要 `git` 可执行（DC1/DC6 用 `git ls-files`、`git diff`）；
- 扫描集合：`git ls-files '*.md'`，排除 `docs/archive/**`（归档文件只做 DC8 归档属性检查）与任何 `node_modules/` 路径；
- 索引来源：`docs/README.md` 的文档总表。

## 2. 检查项

| ID | 级别 | 检查 | 规则 | 修复提示 |
|---|---|---|---|---|
| **DC1** | error | 索引完整性 | 扫描集合中除 `docs/README.md` 外，每份 `.md` 必须作为相对链接出现在索引总表 | 在 `docs/README.md` §4 登记该文档 |
| **DC2** | error | 索引有效性 | 索引总表每个链接目标存在且属于扫描集合（`../` 路径归一化后） | 修正路径或移除死条目 |
| **DC3** | error | 元数据存在/格式 | 扫描集合中每份非归档 `.md` 标题后必须有 `<!-- docs-meta: ... -->`，字段齐全且枚举合法；`current`/`frozen` 必须有 `verified=<commit>@<date>`；`superseded`/`historical` 必须有 `superseded-by` 或位于 archive | 按索引 §3 模板补齐；冻结文档只补头不改正文 |
| **DC4** | error | 状态一致性 | 索引总表登记的 status 必须与文件 `docs-meta.status` 一致；索引不得把 `docs/archive/**` 文件登记为 current/frozen | 同步索引与文档头 |
| **DC5** | error | 链接有效性 | 文档内所有相对 Markdown 链接（`](path)`）必须解析到存在的文件；忽略 `#anchor`、`http(s)://`、`mailto:`、代码块/行内代码中的示例 | 修正或删除失效链接；归档引用改为 archive 路径 |
| **DC6a** | error | 新鲜度基线 | `status=current` 或 `frozen` 且 `tracks != -` 的文档，其 `verified` 中的 commit 必须存在于 git 历史 | 更新 `verified` 为真实核对过的 commit |
| **DC6b** | warn | 新鲜度漂移 | `git diff --name-only <verified-commit>..HEAD -- <tracks>` 非空 → 文档标 **stale**（不自动改 status） | 重核对内容后刷新 `verified`，或降级为 frozen/historical |
| **DC6c** | warn | 元数据滞后 | 文档文件本身在 `verified` 日期之后有提交，但 `verified` 未更新 | 确认内容仍有效后刷新 `verified` |
| **DC7a** | warn | 派生事实：版本 | 根/插件 `package.json` 的 version 未以 `## [x.y.z]` 形式出现在 `CHANGELOG.md` | 补 CHANGELOG 或修正文档 |
| **DC7b** | warn | 派生事实：测试数 | 文档中手写 `\d+/ ?\d+` 且邻近"测试/单测/tests"（视为权威数字） | 改为"以测试输出为准"或注明命令+日期 |
| **DC8** | error | 归档隔离 | `docs/archive/**` 下每个 `.md` 的 `docs-meta.status` 必须为 `historical`；索引不得将其登记为 current/frozen | 修正状态头或索引条目 |
| **DC9** | warn | current 过期 | `status=current` 且 `verified` 日期早于 90 天前 | 阶段收尾重核对或降级 |
| **DC10** | error | 索引结构 | `docs/README.md` 必须包含：权威顺序、状态图例、文档头模板、文档总表四个章节（标题匹配） | 恢复章节 |

## 3. 输出与退出码

- 人类摘要：按 ID 列出 error/warn 与文件:行；末尾打印 `N errors, M warnings, K stale`；
- `--json`：`{ok, errors:[{id,path,detail}], warnings:[...], stale:[{path,verifiedTracksChangedAt}]}`；
- 退出码：存在 error → `1`；仅 warning/stale → `0`（stale 用显式输出提醒，不阻断）；
- **不自动修改任何文件**（检查器只读；修复由人/AI 按提示完成）。

## 4. D2 实施步骤

1. 建 `scripts/docs-check.mjs`（Node ESM、零依赖）；
2. 先在当前文档集上运行，产出首次报告（预期会暴露 D3 待修项：缺元数据、索引未登记、链接/派生事实等）；
3. 把检查命令写入阶段收尾清单与新会话提示词（D4 的 `START_PROMPT_P2.md`）；
4. 不设 pre-commit hook、不自动改写文档。

## 5. 豁免与边界

- `docs/archive/**` 文件跳过 DC1–DC7（只查 DC8）；
- 插件内 `README.md`/`SKILL.md` 纳入 DC1/DC3/DC5（它们是 current 产品文档）；
- 外部链接（http/https）只检查语法不联网；
- 语义正确性、API 准确性、文字质量**不在本清单范围**。

## 6. 变更

- 2026-10-22 创建（D1）；新增/调整检查项必须更新本文件并记录。
