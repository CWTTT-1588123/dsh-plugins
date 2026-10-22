# dsh-handoff-kit P2 实施计划——UI 工作台（0.3.x）

<!-- docs-meta: status=frozen; phase=P2; verified=ca27745@2026-10-22; tracks=plugins/dsh-handoff-kit; supersedes=-; superseded-by=- -->

> 版本：v1（2026-10-22，按 [ADR-0003](../../adr/0003-prompt-first-and-ui.md) 编写）。
> 对应 [ROADMAP](../../../ROADMAP.md) P2；前置：P0/P1 done（0.2.1）、文档治理 D1–D3 done。
> 状态：**已完成（0.3.0，2026-10-22），本文件冻结**；验收见
> [P2 验收记录](../acceptance/P2.md)；启动提示词随阶段结束冻结
> （[START_PROMPT_P2](../START_PROMPT_P2.md)，仅作历史记录）。

## 0. 一句话

把交接包从"模型/命令才能操作的工具"变成**点得到的 UI 工作台**：输入框「交接」按钮 + 小面板（生成/载入）+ 工作台页（批次列表/详情/操作），默认交付"新会话开场提示词"；所有数据经宿主 RPC 调现有 service，不复制业务逻辑。

## 1. 目标与边界

### 1.1 P2 v1 要做的

1. **对话入口**：输入框左侧「交接」按钮（已核实宿主槽位 `conversation.input.left`）；
2. **小面板**：点击按钮弹出——标题预填、备注可选；两个 Tab：
   - **生成**：调用现有 create（可选 includeDiffs）；展示 batchId、目录、warnings；提供「复制新会话开场提示词」；
   - **载入**：列出最近批次（项目默认当前项目）→ 选中 → 展示 trust 判定、findings/drift、changes 摘要 → 提供「复制开场提示词 / 插入输入框 / 打开工作台」；
3. **工作台页**：侧栏入口打开的完整页面——左列表（批次、状态徽章、血缘）、右详情（H0 摘要、证据统计、verify findings、changes/fuel 摘要）、顶部动作（刷新/校验/生成/继续交接）；
4. **开场提示词**：由现有 load/verify 结果与 manifest 生成（复用 service 的 pointers/next，不另造一套）；支持复制到剪贴板。

### 1.2 不做（v1）

Agent Teams 交接、漂移监视、定时/任务结束自动快照、LLM 叙述、自动写盘/自动发送、批次删除、独立安装包（仍是同一 bundle 的版本演进）。

## 2. 已核实与待核实

| 项 | 状态 | 说明 |
|---|---|---|
| `conversation.input.left` 槽位 | 【已核实】 | 输入框工具条左侧 list 槽位，`listSubTree` 返回 registration/standardProps（含 `useSession`、`useChat`、`inputActions` 等） |
| `sidebar.panellist` / `main` 槽位 | 【已核实存在】 | `main` 以 sidebar entry id 为 key 分发页面（已占用 `conversation`）；工作台页注册方式 D5 首日确认 |
| Client → Host `host.call(method,args)` | 【已核实存在】 | 本包 Client half 可 JSON RPC 调本包 Host half（Builtin 清单） |
| Host 侧 RPC 注册 API | 【待核实】 | `host.call` 的服务端注册方式/命名规范需 D5 用 `cordis_inspect` + 官方参考确认 |
| Client half 打包/构建/加载 | 【待核实】 | 需按官方 ui-plugin 模板与构建链确认；可能需构建产物 + 页面刷新 |
| 新会话预填提示词 | 【待核实】 | `uiWorkspace.startSession/openSession` 存在，但"自动填入提示词/自动发送"能力 D5 验证；v1 保守为"复制 + 用户粘贴" |

## 3. UI 设计（v1）

### 3.1 入口

- **A 对话入口**：输入框左侧按钮「交接」（图标 + 文案/tooltip）；点击打开小面板（浮层）。
- **B 工作台页**：侧栏 panel 图标打开完整页面；面板内「打开工作台」跳转过去。

### 3.2 小面板

```text
┌ 交接 ─────────────────────────┐
│ [生成]  [载入]                 │
│ 标题: [当前会话标题预填    ]    │
│ 备注: [可选                ]    │
│ 目标: (user) ▾   [ ] 附改动diff │
│ [生成交接包]  [生成并复制提示词] │
│ ── 结果 ──                     │
│ batchId / 目录 / warnings       │
│ [复制开场提示词] [打开目录]      │
└────────────────────────────────┘
```

载入 Tab：批次列表（batchId · 时间 · 状态徽章）→ 详情（trust、drift 摘要、changes totals）→ 动作「复制开场提示词 / 插入输入框 / 打开工作台」。

### 3.3 工作台页

- 左列表：项目（默认当前工作区项目）+ 批次；徽章：`verified` / `stale` / `invalid` / `superseded` / 血缘序号；
- 右详情：H0 摘要（项目/批次/时间/目标/血缘）、证据统计（artifacts/files/warnings）、verify findings 与 drift、changes/fuel 摘要、`next` 指针；
- 顶部动作：刷新 / 校验 / 生成 / 继续交接（append 默认最新；update 需二次确认）。

### 3.4 交互与文案

- 中文 UI；错误展示 `HANDOFF_*` 错误码 + 修法（复用 command 文案）；
- 写操作必须显式点击，并在按钮/结果中显示目标目录；不自动生成；
- 只读动作（列表/详情/校验/载入）不得写盘；
- 样式使用主题 token，图标用包内 `icon.svg`，不引入新依赖/图标库。

## 4. 数据与接口

### 4.1 宿主 RPC（建议方法名，D5 按注册规范调整）

| 方法 | 作用 | 底层 |
|---|---|---|
| `ui/state` | 当前项目/批次列表/计数（含 lineage 摘要） | list + 读 manifest 摘要 |
| `ui/detail` | 单批次详情：verify、drift、manifest 摘要 | verify/load 结果裁剪 |
| `ui/create` | 生成（create/append/update），参数同工具 | 现有 run() |
| `ui/copy` | 生成开场提示词文本（不写盘） | load/verify + pointers，纯文本 |

- 返回统一为 JSON（client 可直接渲染），错误带 `{code,message,remedy}`；
- Host half 只调用现有 service，不新增业务规则；manifest@2 解析/校验仍只有 `src/manifest.js` 一份。

### 4.2 Client 状态

- 用宿主标准 props（`useSession`/`useChat`/`useSessions`）取当前 session/项目；
- 状态只存在组件内（列表缓存可短期保存，不做持久化）；
- 不引入网络请求，除 `host.call`。

## 5. 里程碑（D5 执行）

| 里程碑 | 内容 | 门槛 |
|---|---|---|
| U0 spike | 确认 client half 构建/加载、宿主 RPC 注册、`conversation.input.left`/`sidebar.panellist`/`main` 注册方式；最小按钮 + `ui/state` 打通 | 页面出现按钮，点击能取到批次列表 |
| U1 生成 | 小面板生成 Tab（标题/备注/diff 选项）+ 结果展示 + 复制提示词 | 浏览器：点按钮生成成功，batchId/目录/warnings 正确 |
| U2 载入 | 载入 Tab：列表/详情/trust/drift + 复制/插入 | 旧批次 verified、篡改批次 invalid、漂移批次 stale 均正确显示 |
| U3 工作台页 | 列表 + 详情 + 校验/继续交接 + 刷新 | 页面操作与面板一致，无写盘副作用（只读动作） |
| U4 验收 | 浏览器 E2E + `docs:check` 0 error + 单测回归 + 验收记录/ROADMAP/CHANGELOG/本地 commit | 见 §6 |

## 6. 测试与验收

### 6.1 单测（不依赖浏览器）

- Host RPC handler：fake ctx 下 `ui/state`/`ui/detail`/`ui/create`/`ui/copy` 的参数校验、只读性、错误码；
- Client 纯函数（若有）：徽章映射、提示词拼装、格式化（与 React 解耦）；
- 回归：现有测试全绿（数量以 `npm test` 输出为准）。

### 6.2 浏览器实测（沿用 P0/P1 方法）

- L1：点「交接」→ 生成 → 出现 batchId/目录/warnings → 复制开场提示词 → 新会话 `handoff_load` 得 `trust=verified`；
- L2：篡改/漂移批次 → 面板与工作台徽章/详情正确；权限不足 → 错误提示与修法；workspace target 显示正确；
- L3：只读动作零写入（对比目录）；无网络请求；不改 P0/P1 工具 schema；P1 单测回归。

### 6.3 文档与交付

- 验收写入 `docs/handoff-kit/acceptance/P2.md`；更新 `docs/README.md` 索引、ROADMAP P2 状态、CHANGELOG `0.3.0`；
- 收尾 `node scripts/docs-check.mjs` 0 error；本地 commit，不 push；已知缺口如实记录。

## 7. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 宿主 RPC 注册方式与 client 打包未核实 | U0 首日 spike 验证；不通则缩小到"按钮跳转命令"的降级方案并先报告，不硬写 |
| R2 | Client half 需构建/刷新，迭代慢 | 先做最小可用；每次改动静默用 install + 页面刷新验证；必要时缩短反馈环 |
| R3 | 浏览器验收需人工点击 | 明确验收脚本与步骤，由用户点一次确认；不伪造浏览器结论 |
| R4 | UI 状态与底层 service 不一致 | 每次刷新/操作后重取 `ui/state`；不长期缓存写状态 |
| R5 | 无删除 API，列表可能很长 | 列表默认只显示最近 N 批 + 状态筛选；归档由用户手动 |
| R6 | 主题/i18n/图标 | 使用主题 token + 包内图标；中文文案；不新增依赖 |

## 8. 依赖与顺序

D5 按 U0 → U1 → U2 → U3 → U4 推进；每步验收后才进入下一步。
前置：`docs:check` 0 error（当前 0 error / 1 warning）、P1 冻结文档不再改动。
