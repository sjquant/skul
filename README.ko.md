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
  <strong>내 AI 설정은 그대로, Git은 깔끔하게.</strong><br />
  팀의 도구 선택에 맞출 필요 없이, 쓰던 스킬과 지침을 프로젝트마다 가져가세요.
</p>

코딩 도구마다 `.claude/`, `.cursor/`, `.codex/`… 설정을 두는 곳이 다릅니다. 여러 도구와 저장소를 오가며 설정을 복사하다 보면 어느 쪽이 최신인지 헷갈리고, 커밋하자니 개인 설정이 팀 전체의 일이 됩니다.

Skul은 재사용할 AI 설정을 Git 저장소나 npm 패키지 형태의 **번들**로 관리하는 CLI입니다. 각 도구가 지원하는 형식과 경로에 파일을 배치하고, 새로 만든 미추적 파일은 로컬 Git 제외 규칙으로 `git status`에 나타나지 않게 합니다. `.gitignore`는 바꾸지 않습니다.

## 스킬 하나부터 써보기

**Node.js 20+**, **Git**, 지원하는 코딩 도구가 필요합니다. 아래 예제는 **Claude Code**용이며, npm과 GitHub에 접속할 수 있어야 합니다. Git 프로젝트 안에서 실행하세요.

```bash
npm install --global @solaqua/skul
skul add sjquant/ghosts writing --agent claude-code --include skills/rewrite
skul status
git status --short
```

공개 [`writing` 번들](https://github.com/sjquant/ghosts/tree/main/writing)을 받아 프롬프트 다듬기 스킬 하나만 `.claude/skills/` 아래에 설치합니다. `skul status`로 설치 내역을 확인하세요. 새로 만든 미추적 스킬 파일은 `git status --short`에 나타나지 않고, 프로젝트의 다른 변경 사항은 그대로 보입니다. 이미 Git이 추적하는 스킬을 덮어쓰면 변경 사항이 표시될 수 있습니다.

프로젝트에서 Claude Code를 열고 다음과 같이 입력해 보세요.

```text
/ghosts:rewrite 다음 프롬프트를 다듬어 줘: 이 함수를 설명해 줘. 짧게 써 줘. 예제를 하나 넣어 줘.
```

다른 도구를 쓴다면 [지원 도구 안내](https://skul.solaqua.dev/ko/docs/tools)를 보고 `--agent` 값을 바꾸세요. 스킬 호출 방식은 도구마다 다릅니다.

신뢰하는 번들만 설치하세요. 스킬과 지침은 코딩 에이전트의 동작에 영향을 주며, MCP 설정은 에이전트가 명령을 실행하거나 서버에 연결하도록 지정할 수 있습니다.

## 설정을 복사하는 대신, 함께 가져가기

- **여러 도구에 같은 소스로.** 스킬, 서브에이전트, 명령, 지침, MCP 서버를 한 번들에 담으세요. Skul이 지원하는 도구별 형식으로 배치합니다. [지원 범위는 도구마다 다릅니다](https://skul.solaqua.dev/ko/docs/tools).
- **개인 설정은 로컬에.** 프로젝트마다 생성된 설정을 커밋하지 않고, 필요한 사람끼리 번들을 공유할 수 있습니다. 여러 프로젝트에서 공통으로 쓰려면 `--global`로 현재 사용자의 홈 디렉터리에 설치하세요.
- **새 워크트리에도 같은 설정을.** Skul은 저장소에서 선택한 번들을 기억합니다. 새로 연결한 워크트리 안에서 `skul apply`를 실행하면 같은 설정이 배치됩니다.

```bash
skul update           # 선택한 번들의 새 리비전을 받아 적용
skul remove writing   # 현재 워크트리에서 예제 번들 제거
```

`skul remove`는 저장소에 저장된 번들 목록에서도 해당 번들을 뺍니다. 다른 워크트리에 이미 설치된 파일은 그대로 남습니다. `skul reset`은 현재 워크트리의 관리 항목을 정리하되, 나중에 `skul apply`로 다시 적용할 수 있도록 저장된 번들 목록은 유지합니다.

번들을 제거하면 보관해 둔 원본을 복원합니다. 관리 중인 파일을 수정했다면 제거 전에 확인을 요청하고, 비대화형 모드에서는 제거를 거부합니다. `--yes`를 주면 이 확인을 건너뜁니다.

## 번들 전체를 적용하기 전에

번들은 Git이 추적하는 `AGENTS.md` / `CLAUDE.md`에 지침을 덧붙이거나 MCP 설정을 병합할 수도 있습니다. 추적 중인 파일은 `skip-worktree` 섀도로 관리합니다. pull에는 `skul sync`를 쓰고, `HEAD`를 이동하는 다른 Git 명령 전후에는 섀도를 중단·갱신해야 합니다. 섀도로 관리되는 파일을 직접 편집하지 마세요. 한 파일의 섀도는 한 번에 하나의 번들만 소유할 수 있습니다. 사용 전에 [추적 중인 파일의 처리 방식](https://skul.solaqua.dev/ko/docs/how-it-works#root-instructions)을 읽어 보세요.

## 지원 도구

Claude Code · Cursor · Codex · OpenCode · GitHub Copilot · Kiro · Antigravity · Grok Build · Qwen Code · Cline · Kimi Code CLI · ZCode

## 내 설정으로 만들기

- [시작하기](https://skul.solaqua.dev/ko/docs/intro) — 설치와 첫 사용
- [번들 작성](https://skul.solaqua.dev/ko/docs/bundles) — 나만의 스킬, 지침, MCP 서버
- [명령어](https://skul.solaqua.dev/ko/docs/commands) — 선택, 업데이트, 제거, 전역 설치
- [Git에 남기지 않는 방식](https://skul.solaqua.dev/ko/docs/how-it-works) — 제외 규칙, 상태, 추적 파일의 섀도

[ISC 라이선스](LICENSE).
