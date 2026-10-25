import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";

import styles from "./index.module.css";

const siteDescription =
  "Apply shared skills, subagents, commands, instructions, and MCP servers to Claude Code, Cursor, Codex, and other AI coding tools, without committing them to Git.";

const points = [
  {
    title: "Not just skills",
    body: "Skills, subagents, commands, instructions, and MCP in each tool's own format. Project or global.",
  },
  {
    title: "Invisible to Git",
    body: "Files go in .git/info/exclude. Even a committed AGENTS.md takes your personal layer without a diff.",
  },
  {
    title: "Fully reversible",
    body: "Skul fingerprints what it writes, so remove and reset put everything back.",
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const siteUrl = `${siteConfig.url}${siteConfig.baseUrl}`;
  const socialImageUrl = `${siteUrl}img/social-preview.png`;

  return (
    <Layout
      title="Your AI setup, kept out of Git"
      description={siteDescription}
    >
      <Head>
        <meta
          property="og:title"
          content="skul: your AI setup, kept out of Git"
        />
        <meta property="og:description" content={siteDescription} />
        <meta property="og:image" content={socialImageUrl} />
      </Head>
      <main className={styles.page}>
        <div className={styles.wrap}>
          <h1 className={styles.title}>Your AI setup, kept out of Git.</h1>
          <p className={styles.lead}>
            Apply shared skills, subagents, instructions, and MCP servers to any
            coding tool, without a single line in <code>git status</code>.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primary} to="/docs/intro">
              Get started
            </Link>
            <Link className={styles.secondary} to="/docs/how-it-works">
              How it works →
            </Link>
          </div>

          <pre className={styles.terminal}>
            <span className={styles.prompt}>$ </span>npm i -g @solaqua/skul
            {"\n"}
            <span className={styles.prompt}>$ </span>skul add acme/ai-bundles
            react-expert
            {"\n"}
            <span className={styles.comment}>
              # .claude/ .cursor/ AGENTS.md written, then hidden
            </span>
            {"\n"}
            <span className={styles.prompt}>$ </span>git status
            {"\n"}
            nothing to commit, working tree clean
          </pre>

          <div className={styles.points}>
            {points.map((point) => (
              <section key={point.title} className={styles.point}>
                <h2>{point.title}</h2>
                <p>{point.body}</p>
              </section>
            ))}
          </div>

          <p className={styles.tools}>
            <strong>Works with</strong> Claude Code, Cursor, Codex, OpenCode,
            GitHub Copilot, Kiro, Antigravity, Grok Build, Qwen Code, Cline,
            Kimi Code CLI, ZCode.{" "}
            <Link to="/docs/tools">See where each one lands →</Link>
          </p>
        </div>
      </main>
    </Layout>
  );
}
