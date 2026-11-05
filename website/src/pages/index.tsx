import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import SeoTitle from "@site/src/components/SeoTitle";
import StructuredData from "@site/src/components/StructuredData";
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
  const title = translate({
    id: "home.title",
    message: "Your AI setup, kept out of Git",
  });
  const description = translate({
    id: "home.description",
    message:
      "Keep AI skills, subagents, instructions, and MCP servers in one bundle and use it in any project without Git noise.",
  });
  return (
    <Layout title={title} description={description}>
      <SeoTitle title={title} description={description} />
      <StructuredData
        title={title}
        description={description}
        permalink={siteConfig.baseUrl}
      />
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.inner}>
            <div>
              <p className={styles.label}>
                <Translate id="home.label">
                  Open-source CLI for AI coding tools
                </Translate>
              </p>
              <h1>
                <Translate id="home.heroFirst">Your AI setup,</Translate>
                <br />
                <Translate id="home.heroSecond">kept out of Git.</Translate>
              </h1>
              <p className={styles.lead}>
                <Translate
                  id="home.lead"
                  values={{
                    count: TOOL_COUNT,
                    status: <code>git status</code>,
                  }}
                >
                  {
                    "Stop copying AI config between repos. Keep skills, subagents, instructions, and MCP servers in one bundle, then add it to any project for {count} coding tools with a clean {status}."
                  }
                </Translate>
              </p>
              <div className={styles.actions}>
                <Link className={styles.primary} to="/docs/intro">
                  <Translate id="home.apply">Apply your first bundle</Translate>{" "}
                  <span aria-hidden="true">→</span>
                </Link>
                <Link
                  className={styles.secondary}
                  href="https://github.com/sjquant/skul"
                >
                  <Translate id="home.github">View on GitHub</Translate>{" "}
                  <span aria-hidden="true">↗</span>
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
              <p className={styles.label}>
                <Translate id="home.source">From a single source</Translate>
              </p>
              <h2>
                <Translate id="home.everywhere">
                  One bundle. Everywhere you code.
                </Translate>
              </h2>
              <p>
                <Translate
                  id="home.translateLayout"
                  values={{ global: <code>--global</code> }}
                >
                  {
                    "Write your setup once. Skul translates it into the layout each tool expects, per project or globally with {global}."
                  }
                </Translate>
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
                  <Translate id="home.bundle">Your Skul bundle</Translate>
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
              <Translate
                id="home.otherTools"
                values={{ tools: OTHER_TOOLS.join(", ") }}
              >
                {"Also works with {tools}."}
              </Translate>
            </p>
            <p className={styles.centerLink}>
              <Link to="/docs/tools">
                <Translate id="home.toolPaths" values={{ count: TOOL_COUNT }}>
                  {"See paths for all {count} tools →"}
                </Translate>
              </Link>
            </p>
          </div>
        </section>

        <section className={styles.section}>
          <div className={`${styles.inner} ${styles.highlight}`}>
            <div>
              <p className={styles.label}>
                <Translate id="home.shared">For shared repos</Translate>
              </p>
              <h2>
                <Translate id="home.rulesFirst">Your rules, on top</Translate>
                <br />
                <Translate id="home.rulesSecond">of the team's.</Translate>
              </h2>
              <p className={styles.body}>
                <Translate
                  id="home.trackedInstructions"
                  values={{
                    file: <code>AGENTS.md</code>,
                    sync: <code>skul sync</code>,
                  }}
                >
                  {
                    "Already commit an {file}? Skul adds your instructions to your local copy. Your tools read both, and your teammates see no diff. Pull with {sync} to pick up upstream changes."
                  }
                </Translate>
              </p>
              <Link
                className={styles.textLink}
                to="/docs/how-it-works#tracked-the-shadow"
              >
                <Translate id="home.trackedLink">
                  How tracked instructions work →
                </Translate>
              </Link>
            </div>
            <div className={styles.layers}>
              <div>
                <LayerIcon kind="team" />
                <strong>
                  <Translate id="home.team">Team instructions</Translate>
                </strong>
                <small>
                  <Translate id="home.committed">
                    Committed to the repo
                  </Translate>
                </small>
              </div>
              <span aria-hidden="true">+</span>
              <div>
                <LayerIcon kind="person" />
                <strong>
                  <Translate id="home.layer">Your layer</Translate>
                </strong>
                <small>
                  <Translate id="home.local">
                    From your bundle, local to you
                  </Translate>
                </small>
              </div>
              <span aria-hidden="true">↓</span>
              <div>
                <span className={styles.layerIcon}>
                  <Logo />
                </span>
                <strong>
                  <Translate id="home.reads">
                    What your coding tool reads
                  </Translate>
                </strong>
                <small>
                  <Translate id="home.both">
                    Both, with no change in Git
                  </Translate>
                </small>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.inner}>
            <div>
              <p className={styles.label}>
                <Translate id="home.safe">Safe to try</Translate>
              </p>
              <h2>
                <Translate id="home.commit">Nothing to commit.</Translate>
                <br />
                <Translate id="home.undo">Easy to undo.</Translate>
              </h2>
              <p className={styles.body}>
                <Translate
                  id="home.exclude"
                  values={{
                    exclude: <code>.git/info/exclude</code>,
                    ignore: <code>.gitignore</code>,
                  }}
                >
                  {
                    "Skul lists what it writes in {exclude}, never {ignore}. Remove a bundle and your original files come back."
                  }
                </Translate>
              </p>
              <Link className={styles.textLink} to="/docs/how-it-works">
                <Translate id="home.howLink">
                  See how it stays out of Git →
                </Translate>
              </Link>
            </div>
            <div className={styles.fileTrees}>
              <div>
                <strong>
                  <Translate id="home.toolsSee">What your tools see</Translate>
                </strong>
                <pre>
                  {
                    "my-project/\n  .agents/skills/\n  .claude/skills/\n  .cursor/skills/\n  src/\n  README.md"
                  }
                </pre>
              </div>
              <div>
                <strong>
                  <Translate id="home.gitSees">What Git sees</Translate>
                </strong>
                <pre>{"my-project/\n  src/\n  README.md"}</pre>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.final}`}>
          <div className={styles.centerHeading}>
            <h2>
              <Translate id="home.try">Try it in your next project.</Translate>
            </h2>
            <p>
              <Translate id="home.requirements">
                Needs Node.js 20+ and Git.
              </Translate>
            </p>
            <Terminal>
              <span className={styles.prompt}>$</span> npm install --global
              @solaqua/skul{"\n"}
              <span className={styles.prompt}>$</span> skul add sjquant/ghosts
              writing
            </Terminal>
            <p>
              <Translate
                id="home.exampleBundle"
                values={{ bundle: <code>writing</code> }}
              >
                {
                  "{bundle} is a public example bundle. Swap in your own repo at any time."
                }
              </Translate>
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} to="/docs/intro">
                <Translate id="home.quickstart">Read the quick start</Translate>{" "}
                <span aria-hidden="true">→</span>
              </Link>
              <Link className={styles.secondary} to="/docs/bundles">
                <Translate id="home.write">Write your own bundle</Translate>
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
