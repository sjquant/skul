import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";
import styles from "./index.module.css";

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title="Your AI setup, kept out of Git"
      description="Reuse AI skills, agents, instructions, and MCP servers across projects without Git noise."
    >
      <Head>
        <meta
          property="og:title"
          content="skul: your AI setup, kept out of Git"
        />
        <meta
          property="og:description"
          content="Apply shared skills, subagents, instructions, and MCP servers to your coding tools without committing them to Git."
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
                One setup. Many tools. Less Git noise.
              </p>
              <h1>
                Your AI setup,
                <br />
                kept out of Git.
              </h1>
              <p className={styles.lead}>
                Skul applies reusable skills, agents, instructions, and MCP
                servers across your coding tools, while keeping local AI
                configuration out of your Git diff.
              </p>
              <div className={styles.actions}>
                <Link className={styles.primary} to="/docs/intro">
                  Get started <span aria-hidden="true">→</span>
                </Link>
                <Link
                  className={styles.secondary}
                  href="https://github.com/sjquant/skul"
                >
                  View on GitHub <span aria-hidden="true">↗</span>
                </Link>
              </div>
            </div>
            <div className={styles.terminal}>
              <div className={styles.terminalBar}>
                <span />
                <span />
                <span />
                <b>skul</b>
              </div>
              <pre>
                <span>$</span> skul add acme/ai-bundles react-expert{"\n"}
                <span className={styles.terminalOutput}>
                  Applied react-expert for claude-code, codex, cursor
                </span>
                {"\n"}
                <span>$</span> git status{"\n"}
                <span className={styles.terminalOutput}>
                  nothing to commit, working tree clean
                </span>
              </pre>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.centerHeading}>
              <p className={styles.label}>From a single source</p>
              <h2>One bundle. Everywhere you code.</h2>
              <p>
                Keep reusable skills, agents, instructions, and MCP servers in
                one bundle, then apply them to the coding tools you use.
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
                    orient="auto-start-reverse"
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
                  d="M 405 200 C 300 200 330 85 238 85 M 405 200 C 300 200 330 315 238 315 M 595 200 C 700 200 670 85 762 85 M 595 200 C 700 200 670 315 762 315"
                  markerEnd="url(#arrow)"
                />
              </svg>
              <div className={styles.toolColumn}>
                <Tool name="Claude Code" path=".claude/" />
                <Tool name="Codex" path=".agents/" />
              </div>
              <div className={styles.bundle}>
                <img src="/img/logo.svg" alt="" />
                <strong>Your Skul bundle</strong>
                <BundleItem name="skills/" />
                <BundleItem name="agents/" />
                <BundleItem name="AGENTS.md" file />
                <BundleItem name="mcp.json" file />
              </div>
              <div className={styles.toolColumn}>
                <Tool name="Cursor" path=".cursor/" />
                <Tool name="OpenCode" path=".opencode/" />
              </div>
            </div>
            <p className={styles.centerLink}>
              <Link to="/docs/tools">See supported tools and paths →</Link>
            </p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={`${styles.inner} ${styles.highlight}`}>
            <div>
              <p className={styles.label}>Built for individuals and teams</p>
              <h2>
                Team knowledge,
                <br />
                your personal edge.
              </h2>
              <p className={styles.body}>
                Keep the instructions your team commits. Add your own layer for
                the way you work, without a visible Git diff.
              </p>
              <Link className={styles.textLink} to="/docs/how-it-works">
                Learn about tracked instructions →
              </Link>
            </div>
            <div className={styles.layers}>
              <div>
                <LayerIcon kind="team" />
                <strong>Team instructions</strong>
                <small>Committed project rules</small>
              </div>
              <span aria-hidden="true">+</span>
              <div>
                <LayerIcon kind="person" />
                <strong>Your personal layer</strong>
                <small>Preferences and workflows from your bundle</small>
              </div>
              <span aria-hidden="true">↓</span>
              <div>
                <span className={styles.layerIcon}>
                  <img src="/img/logo.svg" alt="" />
                </span>
                <strong>Ready for your coding tool</strong>
                <small>Team base with your instructions applied</small>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.inner}>
            <div>
              <p className={styles.label}>Keep it clean</p>
              <h2>
                Powerful AI setup.
                <br />
                Less repository clutter.
              </h2>
              <p className={styles.body}>
                Skul writes tool configuration where your tools expect it and
                keeps managed project files out of your Git diff.
              </p>
              <Link className={styles.textLink} to="/docs/how-it-works">
                See how it works →
              </Link>
            </div>
            <div className={styles.fileTrees}>
              <div>
                <strong>Your project</strong>
                <pre>
                  {"my-project/\n  src/\n  tests/\n  package.json\n  README.md"}
                </pre>
              </div>
              <div>
                <strong>Applied locally</strong>
                <pre>
                  {
                    "my-project/\n  .claude/skills/\n  .agents/skills/\n  AGENTS.md"
                  }
                </pre>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.centerHeading}>
              <p className={styles.label}>Works where you work</p>
              <h2>Fits the tools you use.</h2>
              <p>
                Apply a shared bundle to supported coding tools, with files
                placed where each tool expects them.
              </p>
            </div>
            <div className={styles.toolGrid}>
              <Tool
                name="Claude Code"
                path="Skills, agents, instructions & MCP"
              />
              <Tool name="Codex" path="Skills, agents, instructions & MCP" />
              <Tool
                name="GitHub Copilot"
                path="Skills, agents, instructions & MCP"
              />
              <Tool name="Cursor" path="Skills, agents, instructions & MCP" />
              <Tool name="OpenCode" path="Skills, agents, instructions & MCP" />
            </div>
            <p className={styles.centerLink}>
              <Link to="/docs/tools">See all supported tools and paths →</Link>
            </p>
          </div>
        </section>

        <section className={`${styles.section} ${styles.final}`}>
          <div className={styles.centerHeading}>
            <h2>Get started with Skul.</h2>
            <p>Install the CLI, then apply your first bundle.</p>
            <div className={styles.actions}>
              <Link className={styles.primary} to="/docs/intro">
                Get started →
              </Link>
            </div>
            <Link
              className={styles.textLink}
              href="https://github.com/sjquant/skul"
            >
              Open source on GitHub ↗
            </Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}

function Tool({ name, path }: { name: string; path: string }): ReactNode {
  return (
    <div className={styles.tool}>
      <strong>
        <span className={styles.toolIcon}>
          <img
            src={`/img/tools/${name === "Claude Code" ? "claude" : name === "GitHub Copilot" ? "githubcopilot" : name.toLowerCase()}.svg`}
            alt=""
          />
        </span>
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
