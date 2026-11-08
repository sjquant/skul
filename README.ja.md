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
  <strong>AIの設定は自分好みに。Gitはすっきり。</strong><br />
  チームに同じコーディングツールを使ってもらわなくても、いつものスキルと指示を各プロジェクトへ。
</p>

コーディングツールごとに、設定の置き場所は `.claude/`、`.cursor/`、`.codex/`… と異なります。ツールやリポジトリを行き来するたびに設定をコピーしていると、内容がずれていきます。かといってコミットすると、個人の設定がチーム全体に関わるものになります。

Skulは、再利用したいAI設定をGitリポジトリやnpmパッケージの**バンドル**にまとめて管理するCLIです。各ツールが対応する形式と場所にファイルを配置し、新しく作成した未追跡ファイルは、ローカルのGit除外ルールで `git status` に出ないようにします。`.gitignore` は変更しません。

## まずはスキルを1つ試す

**Node.js 20以上**、**Git**、対応するコーディングツールが必要です。この例では **Claude Code** を使います。npmとGitHubへのネットワーク接続が必要です。Gitプロジェクト内で実行してください。

```bash
npm install --global @solaqua/skul
skul add sjquant/ghosts writing --agent claude-code --include skills/rewrite
skul status
git status --short
```

公開されている [`writing` バンドル](https://github.com/sjquant/ghosts/tree/main/writing)を取得し、プロンプトを推敲するスキルだけを `.claude/skills/` 配下にインストールします。`skul status` でインストール内容を確認できます。新しく作成した未追跡のスキルファイルは `git status --short` に表示されず、プロジェクトのほかの変更は引き続き表示されます。すでにGitが追跡しているスキルを上書きすると、差分が出ることがあります。

プロジェクトでClaude Codeを開き、次のように入力してみてください。

```text
/ghosts:rewrite 次のプロンプトを推敲して: この関数を説明して。短くまとめて。例を1つ入れて。
```

別のツールを使う場合は、[対応ツールのガイド](https://skul.solaqua.dev/ja/docs/tools)を参照して `--agent` を変更してください。スキルの呼び出し方はツールによって異なります。

信頼できるバンドルだけをインストールしてください。スキルや指示はコーディングエージェントの動作に影響し、MCP設定ではエージェントが起動するコマンドや接続先のサーバーを指定できます。

## コピーの手間を、持ち運べる設定に

- **複数のツールで同じソースを使う。** スキル、サブエージェント、コマンド、指示、MCPサーバーを1つのバンドルにまとめられます。Skulが各ツールの対応形式に配置します。[対応範囲はツールごとに異なります](https://skul.solaqua.dev/ja/docs/tools)。
- **個人の設定はローカルに。** 生成した設定をプロジェクトごとにコミットせず、必要な人とバンドルを共有できます。複数のプロジェクトで共通に使う場合は、`--global` で現在のユーザーのホームディレクトリにインストールできます。
- **新しいワークツリーでも、いつもの設定。** Skulはリポジトリで選んだバンドルを記録します。新しくリンクしたワークツリー内で `skul apply` を実行すれば、同じ設定を配置できます。

```bash
skul update           # 選択したバンドルの新しいリビジョンを取得して適用
skul remove writing   # 現在のワークツリーからサンプルのバンドルを削除
```

`skul remove` は、このリポジトリ用に保存したバンドル一覧からも対象を外します。ほかのワークツリーにインストール済みのファイルは、そのまま残ります。`skul reset` は現在のワークツリーからSkulが管理するファイルをクリーンアップしますが、保存済みのバンドル一覧は残すため、あとで `skul apply` で再適用できます。

バンドルを削除すると、保存しておいた元のファイルを復元します。管理中のファイルを編集していた場合、削除前に確認を求めます。非対話モードでは削除を拒否します。`--yes` を指定すると、この確認を省略します。

## バンドル全体を適用する前に

バンドルでは、Gitが追跡している `AGENTS.md` / `CLAUDE.md` に指示を重ねたり、MCP設定をマージしたりすることもできます。追跡中のファイルには `skip-worktree` によるシャドウを使用します。pullには `skul sync` を使い、それ以外の `HEAD` を移動するGitコマンドの前後ではシャドウの一時停止と更新が必要です。シャドウで管理しているファイルを直接編集しないでください。1つの追跡ファイルのシャドウを所有できるバンドルは、同時に1つだけです。この機能を使う前に、[追跡中のファイルの扱い](https://skul.solaqua.dev/ja/docs/how-it-works#root-instructions)を確認してください。

## 対応ツール

Claude Code · Cursor · Codex · OpenCode · GitHub Copilot · Kiro · Antigravity · Grok Build · Qwen Code · Cline · Kimi Code CLI · ZCode

## 自分の設定をまとめる

- [はじめに](https://skul.solaqua.dev/ja/docs/intro) — インストールと最初の使い方
- [バンドルの作成](https://skul.solaqua.dev/ja/docs/bundles) — 自分用のスキル、指示、MCPサーバー
- [コマンド](https://skul.solaqua.dev/ja/docs/commands) — 選択、更新、削除、グローバルインストール
- [Gitに残さない仕組み](https://skul.solaqua.dev/ja/docs/how-it-works) — 除外ルール、状態、追跡ファイルのシャドウ

[ISCライセンス](LICENSE)。
