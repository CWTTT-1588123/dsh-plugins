# dsh-handoff-kit 挂账与边界台账

> 版本：v1（2026-10-22）。本文件把 P0/P1 验收记录里的"已知缺口"统一分类，避免"挂账"语义漂移。
> 分类：**已关闭**（已实现/实测）；**设计边界**（P0/P1 约束或宿主契约，不在本插件内修，需改计划或等宿主）；
> **外部缺陷**（其他插件/环境，非本仓库）；**已归档**（数据类一次性清理）。
> 复验方法一栏必须可执行；无法执行的写"不可实测"并说明原因。

## 0. 台账总览

| 类别 | 数量 | 说明 |
|---|---|---|
| 已关闭 | 9 | G5/G6/G8/G10/G11、M1-G1/M1-G2/M1-G5、M3（决策关闭） |
| 设计边界 | 8 | G1/G2/G3/G4/G7/G9、M2-G2、M2-G1（Session 关闭部分） |
| 外部缺陷 | 1 | G12（第三方任务板执行器） |
| 已归档（数据清理） | 12 个批次 | 见 §2；非缺陷，仅测试产物 |

## 1. 逐条台账

### P0 缺口（来源：[P0 验收记录](../acceptance/P0.md) §6）

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

### P1 缺口（来源：[P1 验收记录](../acceptance/P1.md) §3/§6）

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
| M2-G5 | M3 是否实现 | **决策关闭（Q1）** | 2026-10-22 评审：M3 仅接口与文档，不实现 LLM/自动写盘；合同在 [P1_plan](../design/P1_plan.md) §3.5 | `grep -rn "llm\\|turn-stopping" src/` 无运行时调用 |

## 2. 数据归档记录（2026-10-22）

无删除 API，采用**移动归档**（不删除），归档根：`%TEMP%\dsh-handoff-kit-archive\`。

| 来源 | 归档批次 | 保留批次 |
|---|---|---|
| user 级 `$DSH_HOME/handoff/dsh-plugins-cb7aa4e5/` | `20261022T034441Z-7e8a`、`20261022T053805Z-89b2`、`20261022T060908Z-6518`、`20261022T074439Z-4090`、`20261022T074546Z-b3b7`、`20261022T074550Z-f9cb`、`20261022T074550Z-ca96` | `20261022T034757Z-69e7`（P0 最终）、`20261022T074809Z-da0b`（P1 最终）+ 本次清理后生成的最终包（id 见交付报告） |
| workspace 级 `D:\repos\dsh-plugins\.dsh\handoff\...` | `20261022T034630Z-275a`、`20261022T034656Z-c58a`、`20261022T034744Z-bd14`、`20261022T055248Z-de05`、`20261022T060915Z-014f` | （全部归档；`.dsh/` 为 gitignore 的本地验证输出） |

复验：`handoff_pack list` 应只返回保留的 3 个 user 级批次；归档目录可直接打开复查。
**注意**：P0/P1 验收记录中引用的历史批次路径已因归档失效——这是本次清理的预期结果，验收结论本身已有测试/日志/哈希证据支撑，归档只是数据搬迁。
