# dsh-handoff-kit 挂账与边界台账

<!-- docs-meta: status=current; phase=cross; verified=dd91f73@2026-10-23; tracks=-; supersedes=-; superseded-by=- -->

> 版本：v1（2026-10-22）。本文件把 P0/P1 验收记录里的"已知缺口"统一分类，避免"挂账"语义漂移。
> 分类：**已关闭**（已实现/实测）；**设计边界**（P0/P1 约束或宿主契约，不在本插件内修，需改计划或等宿主）；
> **外部缺陷**（其他插件/环境，非本仓库）；**已归档**（数据类一次性清理）。
> 复验方法一栏必须可执行；无法执行的写"不可实测"并说明原因。

## 0. 台账总览

| 类别 | 数量 | 说明 |
|---|---|---|
| 已关闭 | 10 | G5/G6/G8/G10/G11、M1-G1/M1-G2/M1-G5、M3（决策关闭）、P2-G8（0.3.1 修复） |
| 设计边界 | 12 | G1/G2/G3/G4/G7/G9、M2-G2、M2-G1（Session 关闭部分）、P2-G1/P2-G4/P2-G5、P2-G7 |
| 设计选择 | 2 | M1-G3（摘要指针式）、P2-G2（血缘不单列） |
| 外部缺陷 | 1 | G12（第三方任务板执行器） |
| 已归档（数据清理） | 12 个批次 | 见 §2；非缺陷，仅测试产物 |

## 1. 逐条台账

### P0 缺口（来源：[P0 验收记录](acceptance/P0.md) §6）

| ID | 缺口 | 类别 | 状态与处置 | 复验方法 |
|---|---|---|---|---|
| G1 | 无 `git status`（P0 禁子进程） | 设计边界 | 接受：P0 硬约束 + ADR-17；P1 用 `workspaceChanges` 真实改动缓解，仍不提供 dirty 状态 | `grep -rn "git status" plugins/dsh-handoff-kit/src` 应为空；HANDOFF H6 有 `NO_GIT_STATUS` warning |
| G2 | fs 服务无 mtime | 设计边界 | 接受：宿主 fs 无此 API；H1 用会话 trace + git reflog + P1 changes 替代 | `grep -rn mtime src/` 为空；HANDOFF 含 `NO_MTIME_API` warning |
| G3 | 无删除原语 | 设计边界 | 接受：`ctx.fs` 契约无 remove/delete（已核对）；提供**手动归档 runbook**（§2），插件不做删除 | 查 `node_modules/@deepseek-ai/dsh-fs/lib/types` 无 remove；`docs/handoff-kit/README` 有清理说明 |
| G4 | linked bundle 改 JS 需重启/重装 | 设计边界（工具链） | 接受：用 `remove_bundle` + `install_bundle` 往返加载（本次已多次执行） | `plugin_manager` 返回 `application: applied` + `version` 变化 |
| G5 | read-only / workspace-write 未实测 | **已关闭** | 真实权限会话 `session-95c9d28f…`：`HANDOFF_READ_ONLY` / `HANDOFF_SANDBOX_DENIED` + `target=workspace` 成功（C3/C4/C2b） | 见 P0 验收 §5 C3/C4/C2b |
| G6 | 首版 redaction 规则过宽 | **已关闭** | 规则收紧 + 回归测试；旧对照批次已归档 | `node --test test/redact.test.js`；归档目录查看旧批次 |
| G7 | 错误码非结构化 `info` | 设计边界 | 接受：注册表只对内置 `HarnessError` 保留 `{name,code}`，零依赖不 import 官方包；错误码以 message 前缀 + `error.code` 暴露 | E2E 输出 `Error: HANDOFF_*: …`；`contracts.js::ERROR` |
| G8 | `/handoff` 命令未在 UI 键入 | **已关闭** | 真实会话 `command/run` seq=68 + `command/done` seq=69（`/handoff resume` 中文摘要）；P0 的 `/handoff list` 亦实测 | 会话日志 `$DSH_HOME/sessions/...` 检索 `command/run` |
| G9 | 会话 trace 窗口上限（2000 事件/400KB） | 设计边界 | 接受：显式 bounds + `TRACE_TRUNCATED` warning | 见验收 §2；`LIMITS.sessionMaxEvents` |
| G10 | Node 24 `node --test` 目录参数不展开 | **已关闭** | 修复：`package.json` 增加 `scripts.test`（glob）；`npm test` 可用，文档保留 glob 命令 | 在 `plugins/dsh-handoff-kit` 运行 `npm test` → 223 pass |
| G11 | PowerShell 默认编码读 JSON 乱码 | **已关闭** | 技能「新会话怎么读」补显式 UTF-8 提示（provider 热生效）；README 同步 | `skill(name="handoff-pack")` 正文含 `ReadAllText(...UTF8)` |
| G12 | 任务板执行器在本 profile 启动卡片失败 | **外部缺陷** | 复现：5 张卡（含 2 张对照卡）全部 13–17ms 内失败 `Cannot read properties of undefined (reading 'signal')`；属 `@linxin666/dsh-web-all`，非本插件；失败卡已清理 | 建任意任务板卡片并 run，观察同错误；本插件不受影响（E2E 走会话/工具路径） |

### P1 缺口（来源：[P1 验收记录](acceptance/P1.md) §3/§6）

| ID | 缺口 | 类别 | 状态与处置 | 复验方法 |
|---|---|---|---|---|
| M1-G1 | `/handoff resume` UI 未实测 | **已关闭** | 用户 UI 实测 `command/run`(seq=68)/`command/done`(seq=69) | 同上 |
| M1-G2 | 版本仍 0.1.0 | **已关闭** | P1 发布 0.2.0；挂账清理补丁 0.2.1 | `package.json` / `plugin_manager list_bundles` |
| M1-G3 | load 摘要不展开 findings 明细 | 设计选择 | 接受：默认指针式；明细在 `verification.findings`，可再调 verify/读 HANDOFF | `src/tool.js::summarizeLoadResult` |
| M1-G4 | 无删除原语 → 测试批次堆积 | 设计边界 + **已归档** | 见 G3；测试批次已归档（§2） | `handoff_pack list` 只剩正式包 |
| M1-G5 | M1 不含 workspaceChanges | **已关闭** | M2 已实现 | P1 验收 §6 |
| M2-G1 | 当前 turn 改动不可见；Session 关闭后 summary 不可读 | 设计边界（前项已**缓解**） | 新增 `changes.currentTurn`：从 `tool/call` 提取当前未结束 turn 的 file-tool 路径/计次（无行数），写 manifest@2 并渲染 H1/H4；**Session 关闭后不可回读**是宿主契约，无法修，H6 明示 | `handoff_pack create` 后读 manifest `changes.currentTurn`；H1 有「当前未完成 turn 的触碰」 |
| M2-G2 | 宿主 git 快照上限（maxFiles/超大/二进制） | 设计边界 | 接受：`changesMaxFiles=200` 截断标记；binary/oversized 只给标记不给 diff；warning 明示 | 单测 `changes.test.js` 截断/binary/oversized |
| M2-G3 | goal/jobs 服务可能缺失 | 设计边界（已降级） | 缺失/失败 → `available:false` + warning，不阻塞；**无当前 goal** = `available:true` + note（非错误） | 单测 `fuel.test.js`、E2E 无 goal 会话 |
| M2-G4 | 无删除 API → E2E 批次堆积 | 设计边界 + **已归档** | 见 G3/§2 | `handoff_pack list` 数量 |
| M2-G5 | M3 是否实现 | **决策关闭（Q1）** | 2026-10-22 评审：M3 仅接口与文档，不实现 LLM/自动写盘；合同在 [P1_plan](design/P1_plan.md) §3.5 | `grep -rn "llm\\|turn-stopping" src/` 无运行时调用 |

### P2 缺口（来源：[P2 验收记录](acceptance/P2.md) §7）

| ID | 缺口 | 类别 | 状态与处置 | 复验方法 |
|---|---|---|---|---|
| P2-G1 | UI 工作台是 root 作用域，无会话绑定；无 hint 时 Host 回退选"最新 live 根会话"，可能落到其它项目 | 设计边界（已缓解） | 输入框「交接」点击时写 `localStorage["dsh.handoff-kit.lastSessionId"]`，工作台优先使用；Host 再退到最新 live 根会话，最后才是部署目录。点一次「交接」即固定到当前会话；P3 可加显式项目选择器 | DevTools `localStorage.getItem('dsh.handoff-kit.lastSessionId')`；工作台副标题显示 项目/批次/会话；`src/ui.js::resolveWorkspace` |
| P2-G2 | 批次列表/详情不单列「血缘序号」 | 设计选择 | 接受：`handoff_load` 的 manifest 摘要不含 lineage，不为 UI 改 P1 契约；lineage 批次的 H0 摘要含「批次血缘：第 N 代，承接 …」，create/append 结果也返回 `lineage` | 对 append 批次打开「载入」详情，看 H0 摘要 |
| P2-G3 | UI 文案仅中文、未接 locale 服务 | 设计边界（v1 决策） | 接受：P2 v1 中文 UI；P3 再评估 i18n | `grep -c "zh-CN\\|中文" plugins/dsh-handoff-kit/client.js`；无 locale 注册 |
| P2-G4 | 无删除/归档 UI | 设计边界（宿主无删除原语） | 复用 G3 手动归档 runbook；UI 只读不提供删除 | G3 复验方法 |
| P2-G5 | 新增 `dsh.client` 声明后需重启 Desktop 一次 | 设计边界（工具链） | 实测：client-modules 将"非 client 包"判定按 specifier 缓存到重启；声明变更后重启一次，之后 client 代码改动可 HMR 热更（无需重启） | 重启前后抓 `GET /plugins/events` 的 graph entries 是否含 `dsh-handoff-kit` |
| P2-G7 | 包内证据覆盖 `docs/`：写验收记录本身会让刚生成的批次真实漂移；模型可见文本摘要只 1–3 行（沿用 P1-M1-G3） | 设计边界（记录自指 + P1 渲染契约） | 接受并如实记录：verified 证据以生成后、写记录前的带时间戳回执为准；需要"交付即 verified"时在文档冻结提交后最后生成一次并停止编辑被记录文件；UI 用结构化字段展示 findings/drift，不改 P1 文本渲染 | `handoff_load <batch>` 在记录编辑前后各跑一次，观察 `SOURCE_FILE_CHANGED: docs/...`；`src/tool.js::summarizeResult` |
| P2-G8 | 开场提示词缺少强制只读门：新会话把"先读它，再继续工作"理解为立即开工，实际创建 P3 计划/修改仓库文件 | **已关闭（0.3.1）** | 修复：`renderOpeningPrompt` 首段强制边界（只读验证 + 等用户明确指令 + 禁止改文件/commit/自开新阶段），第 0 步强制 `handoff_load batchId=<id>`，非 verified 即停止；下一步降级为"仅供参考"；新增回归测试。越界草稿保留于 `%TEMP%\dsh-p3-plan-draft-20261022-214256\`，恢复后 `20ef` 复算 verified | `node --test test/ui.test.js`（`opening prompt embeds a mandatory read-only gate before any work`）；UI 复制提示词目视含安全门 |

## 2. 数据归档记录（2026-10-22）

无删除 API，采用**移动归档**（不删除），归档根：`%TEMP%\dsh-handoff-kit-archive\`。

| 来源 | 归档批次 | 保留批次 |
|---|---|---|
| user 级 `$DSH_HOME/handoff/dsh-plugins-cb7aa4e5/` | `20261022T034441Z-7e8a`、`20261022T053805Z-89b2`、`20261022T060908Z-6518`、`20261022T074439Z-4090`、`20261022T074546Z-b3b7`、`20261022T074550Z-f9cb`、`20261022T074550Z-ca96` | `20261022T034757Z-69e7`（P0 最终）、`20261022T074809Z-da0b`（P1 最终）+ 本次清理后生成的最终包（id 见交付报告） |
| workspace 级 `D:\repos\dsh-plugins\.dsh\handoff\...` | `20261022T034630Z-275a`、`20261022T034656Z-c58a`、`20261022T034744Z-bd14`、`20261022T055248Z-de05`、`20261022T060915Z-014f` | （全部归档；`.dsh/` 为 gitignore 的本地验证输出） |

复验：`handoff_pack list` 应只返回保留的 3 个 user 级批次；归档目录可直接打开复查。
**注意**：P0/P1 验收记录中引用的历史批次路径已因归档失效——这是本次清理的预期结果，验收结论本身已有测试/日志/哈希证据支撑，归档只是数据搬迁。

**P2 增补（2026-10-22）**：P2 验收保留 `dsh-plugins-cb7aa4e5` 下 5 个批次作为样本
（`69e7`/`da0b`/`43ff` 为 P0/P1 历史包；`e27c` 为 U1 生成包；`78e8` 为 U3 append 第 2 代）。
L2 的篡改测试批次 `20261022T120000Z-dead` 为受控临时副本，验证后已删除；
读操作零写入由整目录 hash/size/mtime 快照对照证明（见 P2 验收 §5）。

## 3. M4 安装/回滚演练发现（2026-10-23）

**演练步骤**（M4 验收项「bundle 通过 npm spec 安装/卸载/回滚」）：
`plugin_manager remove_bundle`（移除本地 link）→ `install_bundle target: dsh-handoff-kit@1.0.0-rc.1`
→ 验证 → 回滚 `install_bundle target: <本地目录>`。

**结果与证据**：

1. **npm 包体安装成功**：profile `node_modules/dsh-handoff-kit` 为真实目录、版本 `1.0.0-rc.1`、
   含 `index.js`/`spec/`；profile `package.json` 依赖写入 `1.0.0-rc.1`。发布包体正确。
2. **实时激活失败（需重启 DSH）**：安装后 Host 报 `failed to import` / `cannot resolve profile bundle`；
   随后 `plugin_manager` 回滚 profile `package.json`（依赖与 `dsh.profile.bundles` 条目丢失），
   node_modules 遗留 **broken junction**。→ 切换安装源（link ↔ npm）必须重启 DSH，实时热切换不可用
   （与 G4 / P2-G5 同类的工具链限制）。
3. **严重：`remove_bundle` 清空 link 目标目录**：移除 `link:` bundle 后，本地
   `plugins/dsh-handoff-kit/` 的 **64 个文件被删除**（`git status` 全部 `.D`）。已用
   `git restore --source=HEAD --worktree -- plugins/dsh-handoff-kit` 完整恢复，并验证：
   工作树干净、`npm test` 283 全绿、`docs:check` 0 error、profile junction 可解析到本地 `index.js`。
   → **本机工具链下对 `link:` bundle 执行 remove/install 有数据丢失风险；今后演练必须先备份
   （`git archive`/`git bundle`）或在干净 profile 中执行。**

**结论**：M4 的「实时安装/回滚」只能以「备份 + 重启」的方式验收；当前 profile 已恢复为本地 link
安装（重启后加载）。建议向 DSH `plugin_manager` 上游报告 `remove_bundle` 对 link 目标的处理缺陷。
profile `package.json` 手工修复前的备份：`package.json.bak-handoff-rehearsal-20261023-083903`。

**复验命令**：`git status --porcelain`（空）；`cd plugins/dsh-handoff-kit && npm test`（全绿）；
`node scripts/docs-check.mjs`（0 error）；在 profile 目录 `require.resolve('dsh-handoff-kit')`
解析到本地 `index.js`。

4. **补充发现：projectKey 随 git remote 变化（2026-10-23 重启后验收发现）**——
   `projectKey` 的 seed 优先 `remote:<origin URL>`、无 remote 时回退 `workspace:<canonical path>`
   （`src/paths.js`）。M4 给仓库添加 GitHub remote 后，本机项目 key 由
   `dsh-plugins-cb7aa4e5`（workspace seed）变为 `dsh-plugins-45e08a68`（remote seed），
   旧 8 个批次默认 `handoff_load` / `handoff_pack verify` 查不到（新 key 目录尚不存在）；
   用 CLI 显式批次路径仍可 `verify`（trust=verified）。这是「跨 clone 稳定标识」设计的副作用，
   但对既有用户是**默认入口级回归**。
   → 1.0 前需二选一（建议 A + C）：
   A. 显式给出 `batchId` 时，若当前 project key 下找不到，跨所有 project key **只读**查找并返回
      `PROJECT_KEY_FALLBACK` 警告（不改写任何批次）；
   B. 若无法唯一确定，返回候选列表并提示用 CLI 显式路径或迁移；
   C. 文档记录「添加/更换 remote 会改变 project key」及迁移办法。
   本项列入 M5/M6 收口清单；旧批次当前可用 CLI 显式路径访问。

   **已实现（2026-10-23，提交 `91a4fae`，待 rc.2 发布）**：
   A 已落地——显式 `batchId` 的 `load`/`verify` 在当前 key 缺失时只读扫描兄弟 project key，
   唯一命中返回 `PROJECT_KEY_FALLBACK` 结果级警告（不进入 findings/counts，不降级 `trust`，
   不写文件）；B 已落地——0 命中保持原错误，多命中报 `BATCH_NOT_FOUND` 并列出命中的 key；
   回退只匹配**同 workspace slug** 的历史 key（`projectKeySlug`，提交 `2430f1b`），无关项目
   （如共享 handoff root 的 `stand-*`）不会混入；
   工作台在 0 批次时用既有 `list all` 只读聚合、按 key 分组并显示「历史项目（只读）」横幅，
   `继续交接` 在 history 模式禁用（写操作仍只写当前 key）；C 已落地——`spec/HANDOFF.md` §2/§5、
   `spec/verify.md` §5.3、README/USAGE 补充项目 key 变化与 `PROJECT_KEY_FALLBACK` 说明。
   验证：301 测试全绿（+11 新 fallback 测试）、`docs:check` 0 error；UI 人工验收待刷新后确认。
