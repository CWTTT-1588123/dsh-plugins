# dsh-plugins

DeepSeek Harness（DSH）插件独立仓库。与业务项目（如 `D:\repos\stand`）物理分离：
**插件源码、设计文档、路线图、验收记录全部集中在这里**，业务仓库不再承载插件文件。

## 仓库约定

- 每个插件一个目录：`plugins/<包名>/`；一个 DSH bundle 是一个独立 npm 包
  （`package.json` + `cordis.patch.yml` + `index.js`）。
- 文档：`docs/<插件简称>/{design,acceptance}/`；跨插件的关键取舍写 `docs/adr/`。
- 路线：`ROADMAP.md` 是阶段与状态的**唯一权威**；版本变更记 `CHANGELOG.md`。
- 本地 git 提交，**不自动 push**（沿用 stand 仓库既有约定）。

## 插件清单

| 插件 | 阶段 | 版本 | 说明 |
|---|---|---|---|
| `dsh-handoff-kit` | P0 | 0.1.0 | 会话交接包生成器（`HANDOFF.md` + `manifest.json`），host-only，无 UI |

## 开发会话约定

DSH 的文件沙箱边界 = **会话工作区**。因此：

- 开发本仓库插件：新开一个 **工作区 = `D:\repos\dsh-plugins`** 的 DSH 会话；
- 业务仓库（stand）的会话只做业务，不写插件代码；
- 插件安装使用绝对目录链接（与工作区无关）：

```
plugin_manager install_bundle  target: D:\repos\dsh-plugins\plugins\dsh-handoff-kit
```

新会话实施 P0 的完整提示词见 [`docs/handoff-kit/START_PROMPT.md`](docs/handoff-kit/START_PROMPT.md)。

## 目录

```
dsh-plugins/
├── README.md
├── ROADMAP.md
├── CHANGELOG.md
├── docs/
│   ├── adr/                     # 关键决策记录
│   └── handoff-kit/
│       ├── design/              # 设计文档（历史 3 份 + 现行实施计划）
│       ├── acceptance/          # 每阶段验收记录
│       └── START_PROMPT.md      # 新会话实施入口
└── plugins/
    └── dsh-handoff-kit/
```
