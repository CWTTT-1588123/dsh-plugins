# dsh-handoff-kit P0 实施说明

> 版本：v1（2026-10-22）
> 状态：待创造模式会话评审；未开工
> 目标：把“通用交接包生成器”做成 DSH 插件；P0 只做 host-only、无 UI、手动触发、用户级输出。

## 1. 已确认的 P0 形态

- 单包 host-only bundle；
- handoff_pack 工具：scan / generate / verify 三个动作；
- /handoff 命令：人类快捷入口；
- handoff-pack 技能：流程说明、何时用、如何读；
- 不做 UI、不做 Client 半区、不做 LLM 摘要、不做 DB、不做自动阈值/compact 钩子；
- 输出到用户级目录：~/.dsh/handoff/<project-key>/；
- 手动触发；不绑定 DSH goal（P1 再议）。

## 2. 调研依据（三路结论）

1. DSH 插件单位是 bundle；Host 半是 Cordis 插件，Client 半可选；Host 代码在宿主进程、工作区沙箱之外。
2. 最小工具范式：name/inject/apply + ctx.tools.register(defineTool({...}))；参数校验由 defineTool 做，output.schema/render 决定模型可见内容。
3. Command 直接对 agent 执行、不创建模型消息；Skill 可用 SKILL.md 或 ctx.skills.register。
4. 现有 handoff 工具的可借鉴机制：目标定向抽取、确定性骨架+模型补叙述、指针式消费、可编辑草稿、漂移检测。
5. DSH 差异化：goal/task board/job/session 拓扑可作为确定性燃料；P0 先不接，避免依赖未稳定 API。

## 3. 目录建议

    D:/repos/stand/plugins/dsh-handoff-kit/
      package.json
      cordis.patch.yml
      index.js
      src/
        collect.js
        redact.js
        render.js
        write.js
        service.js
        tools.js
        command.js
        skill.js
      locale/
        zh.json
        en.json
      icon.svg
      test/

P0 不建 client 目录；P1 若做 UI，另建 client-only 伴侣包。

## 4. P0 工具契约（草案）

### handoff_pack

参数：
- action: create | verify | list（必填）
- outputDir: 可选，工作区相对路径；默认用户级 handoff 目录
- title: 可选
- goal: 可选，自由文本；不绑定 goal id
- decisions: 可选，换行分隔
- nextSteps: 可选，换行分隔
- copyFiles: 可选，是否复制关键文件（默认 false）
- force: 可选

返回（摘要，不返回全文）：
- ok、dir、files、bytes、warnings、redactions、verification

### create 行为

1. 解析 workspace/session cwd；
2. 采集：git HEAD/status、文件清单、入口/配置/测试、最近改动；
3. 脱敏：密钥/token/密码/连接串；记录 redactions；
4. 归一化路径：绝对路径换 $WORKSPACE；
5. 渲染：HANDOFF.md + manifest.json + evidence/（可选）；
6. 写入：ctx.fs + sandboxPolicy；manifest 最后写；
7. 返回摘要。

### verify 行为

1. 读 manifest；
2. 重算文件哈希；
3. 检查引用完整性、路径逃逸、密钥残留；
4. 标记 stale：HEAD/文件是否变化；
5. 返回 ok/findings。

### list 行为

列出用户级 handoff 目录下的项目/批次，返回摘要。

## 5. 安全要求（P0 硬约束）

- 不直接 node:fs 写用户路径；写走 ctx.fs.writeText，传 sandboxPolicy；
- 读也必须做工作区 allowlist：拒绝 ..、绝对路径逃逸、symlink 逃逸；
- 不联网、不起子进程、不调 LLM；
- 不读环境变量中的密钥；输出前脱敏；
- manifest 记录 git HEAD/时间/证据；不追加自定义 session event；
- 安装/激活只在创造模式会话做，使用 plugin_manager；不改 DSH 官方源码。

## 6. 验收（P0）

L1：
- bundle 可安装/激活；/handoff 与 handoff_pack 可调用；
- 生成目录含 HANDOFF.md + manifest.json；
- manifest 哈希可复算。

L2：
- 路径逃逸/符号链接逃逸被拒；
- .env/token/密码被脱敏；
- 重复 verify 结果稳定；
- 新会话只读 HANDOFF.md + manifest，能回答“上次做到哪、下一步”。

L3：
- read-only 模式下写操作被拒；
- workspace-write 下不能写工作区外用户目录（或按策略明确允许的用户目录）；
- 不产生密钥泄漏。

## 7. 待创造模式会话确认

1. 插件源码放 plugins/dsh-handoff-kit 还是独立仓库？
2. 用户级目录具体用 ~/.dsh/handoff/<project-key> 还是 <workspace>/.dsh/handoff？
3. P0 是否严格不接 goal/task board/job（建议是）？
4. 是否接受“生成后人工确认再让新会话消费”的草稿模式？
5. 包名 dsh-handoff-kit 是否可用？
