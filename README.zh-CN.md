<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/skul-mark-dark.svg" />
    <img src="assets/brand/skul-mark.svg" width="60" alt="" />
  </picture>
</p>

<h1 align="center">skul</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>AI 配置随你用，Git 仓库不添乱。</strong><br />
  把常用的技能和指令带到每个项目，无需让团队改用同一款编程工具。
</p>

编程工具各有各的配置目录：`.claude/`、`.cursor/`、`.codex/`……在多个工具和仓库之间来回复制配置，很快就会出现版本不一致。提交到仓库，又把个人偏好变成了整个团队都要面对的问题。

Skul 是一个 CLI，把可复用的 AI 配置整理成 Git 仓库或 npm 包形式的**配置包（bundle）**，再按各工具支持的格式和路径写入文件。它通过本地 Git 排除规则，让新建且未被跟踪的文件不出现在 `git status` 中，无需修改 `.gitignore`。

## 先试一个技能

需要 **Node.js 20+**、**Git** 和一款受支持的编程工具。下面以 **Claude Code** 为例，需要能够访问 npm 和 GitHub。请在 Git 项目内运行：

```bash
npm install --global @solaqua/skul
skul add sjquant/ghosts writing --agent claude-code --include skills/rewrite
skul status
git status --short
```

这会获取公开的 [`writing` 配置包](https://github.com/sjquant/ghosts/tree/main/writing)，仅将其中用于改写提示词的技能安装到 `.claude/skills/` 下。`skul status` 显示安装结果。新建且未被跟踪的技能文件不会出现在 `git status --short` 中，项目的其他改动仍会正常显示。如果覆盖了 Git 已跟踪的技能文件，则可能产生差异。

在项目中打开 Claude Code，试着输入：

```text
/ghosts:rewrite 请改写这个提示词：解释这个函数。简短一点。给一个例子。
```

如果使用其他工具，请参照[支持的工具指南（英文）](https://skul.solaqua.dev/docs/tools)修改 `--agent`。技能的调用方式因工具而异。

只安装你信任的配置包：技能和指令会影响编程智能体的行为，MCP 配置可以指定智能体启动的命令或连接的服务器。

## 配置带着走，不必反复复制

- **一份来源，多个工具。** 将技能、子智能体、命令、指令和 MCP 服务器放进同一个配置包。Skul 按各工具支持的格式写入；[具体支持范围因工具而异（英文）](https://skul.solaqua.dev/docs/tools)。
- **个人配置留在本地。** 无需在每个项目中提交生成的配置，只把配置包分享给需要的人。使用 `--global` 可安装到用户级配置中。
- **新工作树，同一套配置。** Skul 会记录仓库所选的配置包。在新建的关联工作树内运行 `skul apply`，即可写入同样的配置。

```bash
skul update           # 获取并应用所选配置包的新修订版本
skul remove writing   # 从当前工作树中移除示例配置包
```

`skul remove` 还会从仓库保存的配置包列表中移除该配置包，其他工作树中已安装的文件则会保留。`skul reset` 会清理当前工作树中由 Skul 管理的内容，但保留这份列表，以便之后用 `skul apply` 重新应用。

移除配置包时，会恢复之前保存的原始文件。如果受管理的文件被修改过，移除前会请求确认；在非交互模式下则会拒绝移除。传入 `--yes` 会跳过这项确认。

## 应用整个配置包之前

配置包还可以向 Git 已跟踪的 `AGENTS.md` / `CLAUDE.md` 文件叠加指令，或合并 MCP 设置。对于已跟踪的文件，Skul 使用基于 `skip-worktree` 的影子文件机制：拉取更新请用 `skul sync`；执行其他会移动 `HEAD` 的 Git 命令时，需要在前后暂停和刷新影子文件。不要手动编辑由这一机制管理的文件。同一时间，一个已跟踪文件的影子只能由一个配置包拥有。使用前请阅读[已跟踪文件的处理方式（英文）](https://skul.solaqua.dev/docs/how-it-works#root-instructions)。

## 支持的工具

Claude Code · Cursor · Codex · OpenCode · GitHub Copilot · Kiro · Antigravity · Grok Build · Qwen Code · Cline · Kimi Code CLI · ZCode

## 定制你自己的配置

以下详细文档目前提供英文、韩文和日文版本，链接指向英文版。

- [快速入门](https://skul.solaqua.dev/docs/intro) — 安装与首次使用
- [编写配置包](https://skul.solaqua.dev/docs/bundles) — 自定义技能、指令和 MCP 服务器
- [命令参考](https://skul.solaqua.dev/docs/commands) — 选择、更新、移除与全局安装
- [如何避免进入 Git](https://skul.solaqua.dev/docs/how-it-works) — 排除规则、状态与影子文件机制

[ISC 许可证](LICENSE)。
