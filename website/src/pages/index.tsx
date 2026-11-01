import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import ThemedImage from "@theme/ThemedImage";
import type { ReactNode } from "react";
import styles from "./index.module.css";

const OTHER_TOOLS = [
  "GitHub Copilot",
  "Kiro",
  "Antigravity",
  "Grok Build",
  "Qwen Code",
  "Cline",
  "Kimi Code CLI",
  "ZCode",
];
const TOOL_COUNT = OTHER_TOOLS.length + 4;

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title="Your AI setup, kept out of Git"
      description="Keep AI skills, subagents, instructions, and MCP servers in one bundle and use it in any project without Git noise."
    >
      <Head>
        <meta
          property="og:title"
          content="skul: your AI setup, kept out of Git"
        />
        <meta
          property="og:description"
          content="Keep AI skills, subagents, instructions, and MCP servers in one bundle and use it in any project without Git noise."
        />
        <meta
          property="og:image"
          content={`${siteConfig.url}${siteConfig.baseUrl}img/social-preview.png`}
        />
      </Head>
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.inner}>
            <div>
              <p className={styles.label}>
                Open-source CLI for AI coding tools
              </p>
              <h1>
                Your AI setup,
                <br />
                kept out of Git.
              </h1>
              <p className={styles.lead}>
                Stop copying AI config between repos. Keep skills, subagents,
                instructions, and MCP servers in one bundle, then add it to any
                project for {TOOL_COUNT} coding tools with a clean{" "}
                <code>git status</code>.
              </p>
              <div className={styles.actions}>
                <Link className={styles.primary} to="/docs/intro">
                  Apply your first bundle <span aria-hidden="true">→</span>
                </Link>
                <Link
                  className={styles.secondary}
                  href="https://github.com/sjquant/skul"
                >
                  View on GitHub <span aria-hidden="true">↗</span>
                </Link>
              </div>
            </div>
            <Terminal>
              <span className={styles.prompt}>$</span> skul add sjquant/ghosts
              writing{"\n"}
              <span className={styles.terminalOutput}>
                Applied writing for claude-code, codex, cursor
              </span>
              {"\n\n"}
              <span className={styles.prompt}>$</span> ls .claude/skills{"\n"}
              <span className={styles.terminalOutput}>
                ghosts:cold-reader ghosts:eli5 ghosts:humanize-korean
                ghosts:make-skill ghosts:rewrite
              </span>
              {"\n\n"}
              <span className={styles.prompt}>$</span> git status{"\n"}
              <span className={styles.terminalOutput}>
                nothing to commit, working tree clean
              </span>
            </Terminal>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.centerHeading}>
              <p className={styles.label}>From a single source</p>
              <h2>One bundle. Everywhere you code.</h2>
              <p>
                Write your setup once. Skul translates it into the layout each
                tool expects, per project or globally with <code>--global</code>
                .
              </p>
            </div>
            <div className={styles.bundleDiagram}>
              <svg
                className={styles.connections}
                viewBox="0 0 1000 400"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="arrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path
                      d="M 1 1 L 9 5 L 1 9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </marker>
                </defs>
                <path
                  d="M 405 200 C 330 200 340 95 265 95"
                  markerEnd="url(#arrow)"
                />
                <path
                  d="M 405 200 C 330 200 340 305 265 305"
                  markerEnd="url(#arrow)"
                />
                <path
                  d="M 595 200 C 670 200 660 95 735 95"
                  markerEnd="url(#arrow)"
                />
                <path
                  d="M 595 200 C 670 200 660 305 735 305"
                  markerEnd="url(#arrow)"
                />
              </svg>
              <div className={styles.toolColumn}>
                <Tool name="Claude Code" icon="claude" path=".claude/" />
                <Tool name="Codex" icon="codex" path=".agents/, .codex/" />
              </div>
              <div className={styles.bundle}>
                <strong>
                  <Logo />
                  Your Skul bundle
                </strong>
                <BundleItem name="skills/" />
                <BundleItem name="agents/" />
                <BundleItem name="AGENTS.md" file />
                <BundleItem name="mcp.json" file />
              </div>
              <div className={styles.toolColumn}>
                <Tool name="Cursor" icon="cursor" path=".cursor/" />
                <Tool name="OpenCode" icon="opencode" path=".opencode/" />
              </div>
            </div>
            <p className={styles.alsoWorks}>
              Also works with {OTHER_TOOLS.join(", ")}.
            </p>
            <p className={styles.centerLink}>
              <Link to="/docs/tools">
                See paths for all {TOOL_COUNT} tools →
              </Link>
            </p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={`${styles.inner} ${styles.highlight}`}>
            <div>
              <p className={styles.label}>For shared repos</p>
              <h2>
                Your rules, on top
                <br />
                of the team's.
              </h2>
              <p className={styles.body}>
                Already commit an <code>AGENTS.md</code>? Skul adds your
                instructions to your local copy. Your tools read both, and your
                teammates see no diff. Pull with <code>skul sync</code> to pick
                up upstream changes.
              </p>
              <Link
                className={styles.textLink}
                to="/docs/how-it-works#tracked-the-shadow"
              >
                How tracked instructions work →
              </Link>
            </div>
            <div className={styles.layers}>
              <div>
                <LayerIcon kind="team" />
                <strong>Team instructions</strong>
                <small>Committed to the repo</small>
              </div>
              <span aria-hidden="true">+</span>
              <div>
                <LayerIcon kind="person" />
                <strong>Your layer</strong>
                <small>From your bundle, local to you</small>
              </div>
              <span aria-hidden="true">↓</span>
              <div>
                <span className={styles.layerIcon}>
                  <Logo />
                </span>
                <strong>What your coding tool reads</strong>
                <small>Both, with no change in Git</small>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.inner}>
            <div>
              <p className={styles.label}>Safe to try</p>
              <h2>
                Nothing to commit.
                <br />
                Easy to undo.
              </h2>
              <p className={styles.body}>
                Skul lists what it writes in <code>.git/info/exclude</code>,
                never <code>.gitignore</code>. Remove a bundle and your original
                files come back.
              </p>
              <Link className={styles.textLink} to="/docs/how-it-works">
                See how it stays out of Git →
              </Link>
            </div>
            <div className={styles.fileTrees}>
              <div>
                <strong>What your tools see</strong>
                <pre>
                  {
                    "my-project/\n  .agents/skills/\n  .claude/skills/\n  .cursor/skills/\n  src/\n  README.md"
                  }
                </pre>
              </div>
              <div>
                <strong>What Git sees</strong>
                <pre>{"my-project/\n  src/\n  README.md"}</pre>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.final}`}>
          <div className={styles.centerHeading}>
            <h2>Try it in your next project.</h2>
            <p>Needs Node.js 20+ and Git.</p>
            <Terminal>
              <span className={styles.prompt}>$</span> npm install --global
              @solaqua/skul{"\n"}
              <span className={styles.prompt}>$</span> skul add sjquant/ghosts
              writing
            </Terminal>
            <p>
              <code>writing</code> is a public example bundle. Swap in your own
              repo at any time.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} to="/docs/intro">
                Read the quick start <span aria-hidden="true">→</span>
              </Link>
              <Link className={styles.secondary} to="/docs/bundles">
                Write your own bundle
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}

function Logo(): ReactNode {
  return (
    <ThemedImage
      alt=""
      sources={{ light: "/img/logo.svg", dark: "/img/logo-dark.svg" }}
    />
  );
}

function Terminal({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className={styles.terminal}>
      <div className={styles.terminalBar}>
        <span />
        <span />
        <span />
        <b>skul</b>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function Tool({
  name,
  icon,
  path,
}: {
  name: string;
  icon: string;
  path: string;
}): ReactNode {
  return (
    <div className={styles.tool}>
      <strong>
        <img src={`/img/tools/${icon}.svg`} alt="" />
        {name}
      </strong>
      <code>{path}</code>
    </div>
  );
}

function LayerIcon({ kind }: { kind: "person" | "team" }): ReactNode {
  return (
    <span className={styles.layerIcon} aria-hidden="true">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 20v-1.6a6.5 6.5 0 0 1 13 0V20z" />
        {kind === "team" && (
          <path d="M4 13a3 3 0 0 1 0-5.5M20 13a3 3 0 0 0 0-5.5M2 19a5 5 0 0 1 2-4M22 19a5 5 0 0 0-2-4" />
        )}
      </svg>
    </span>
  );
}

function BundleItem({
  name,
  file = false,
}: {
  name: string;
  file?: boolean;
}): ReactNode {
  return (
    <code>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {file ? (
          <>
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v5h4M9 12h6M9 16h6" />
          </>
        ) : (
          <path d="M3 6h7l2 2h9v11H3z" />
        )}
      </svg>
      {name}
    </code>
  );
}
