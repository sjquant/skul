import type {ReactNode} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

import styles from './index.module.css';

type Card = {
  title: string;
  body: string;
  href: string;
  label: string;
};

const siteDescription =
  'skul is a CLI for delivering reusable AI bundles into Claude Code, Cursor, Codex, and OpenCode projects without committing tool-local files.';

const siteKeywords = [
  'ai bundle cli',
  'claude code skills',
  'cursor commands',
  'codex agents',
  'opencode bundles',
  'developer tooling',
];

const heroStats = [
  {
    value: 'Tool-native output',
    label: 'Write skills, commands, and agents into the directories each AI tool already understands.',
  },
  {
    value: 'Git-safe local materialization',
    label: 'Hide generated files with .git/info/exclude instead of teaching every repo a new ignore convention.',
  },
  {
    value: 'Per-worktree state',
    label: 'Keep desired bundle state at the repo level while tracking actual writes per worktree.',
  },
];

const heroChecklist = [
  'Fetch bundles from GitHub or reuse a cached local source',
  'Target Claude Code, Cursor, Codex, and OpenCode with one bundle model',
  'Update, remove, and re-apply managed files without hand editing tool dotdirs',
];

const heroWorkflow = [
  {
    command: 'skul add github.com/sjquant/ai-bundles react-expert',
    detail: 'Fetch a source once, cache it globally, and materialize the bundle into the current project.',
  },
  {
    command: 'skul status',
    detail: 'Inspect desired state and the files that are materialized in this worktree.',
  },
  {
    command: 'skul update',
    detail: 'Pull the latest upstream revision for remote-backed bundles and re-apply the managed files.',
  },
];

const workflowSteps = [
  {
    title: 'Fetch or reuse a source',
    body: 'Clone a bundle repository once into a shared cache, then reuse it across projects and worktrees.',
  },
  {
    title: 'Materialize into real tool directories',
    body: 'Translate canonical bundle content into each tool-native path instead of forcing tools to learn a shared format.',
  },
  {
    title: 'Track and clean up safely',
    body: 'Fingerprint written files, detect divergence, and remove only what skul owns.',
  },
];

const toolCards = [
  {
    title: 'Claude Code',
    body: 'Copy skills, commands, and agents into .claude paths without committing them.',
  },
  {
    title: 'Cursor',
    body: 'Deliver the same bundle into .cursor targets when the repo uses Cursor-native workflows.',
  },
  {
    title: 'Codex',
    body: 'Materialize skills into .agents and agents into .codex with the same source bundle.',
  },
  {
    title: 'OpenCode',
    body: 'Support OpenCode projects through its own .opencode directory layout.',
  },
];

const docsCards: Card[] = [
  {
    title: 'Installation',
    body: 'Set up skul locally and verify the CLI is available.',
    href: '/docs/installation',
    label: 'Install skul',
  },
  {
    title: 'Quick Start',
    body: 'Follow the shortest path from first bundle add to update and cleanup.',
    href: '/docs/quick-start',
    label: 'Read quick start',
  },
  {
    title: 'Bundle Structure',
    body: 'See how canonical and native bundle layouts map into supported tools.',
    href: '/docs/bundle-structure',
    label: 'Browse bundle format',
  },
];

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const siteUrl = `${siteConfig.url}${siteConfig.baseUrl}`;
  const socialImageUrl = `${siteUrl}img/social-card.svg`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'skul',
    applicationCategory: 'DeveloperApplication',
    description: siteDescription,
    url: siteUrl,
    codeRepository: 'https://github.com/sjquant/skul',
    keywords: siteKeywords,
    image: socialImageUrl,
  };

  return (
    <Layout
      title="Project-scoped AI bundle delivery"
      description={siteDescription}>
      <SiteHead
        jsonLd={jsonLd}
        siteUrl={siteUrl}
        socialImageUrl={socialImageUrl}
      />
      <main className={styles.page}>
        <HeroSection />
        <ToolSection />
        <WorkflowSection />
        <DocsSection />
      </main>
    </Layout>
  );
}

function SiteHead({
  jsonLd,
  siteUrl,
  socialImageUrl,
}: {
  jsonLd: Record<string, unknown>;
  siteUrl: string;
  socialImageUrl: string;
}): ReactNode {
  return (
    <Head>
      <meta name="keywords" content={siteKeywords.join(', ')} />
      <meta property="og:type" content="website" />
      <meta property="og:title" content="skul | Project-scoped AI bundle delivery" />
      <meta property="og:description" content={siteDescription} />
      <meta property="og:url" content={siteUrl} />
      <meta property="og:image" content={socialImageUrl} />
      <meta
        property="og:image:alt"
        content="skul social card showing reusable AI bundles flowing into supported tool directories"
      />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content="skul | Project-scoped AI bundle delivery" />
      <meta name="twitter:description" content={siteDescription} />
      <meta name="twitter:image" content={socialImageUrl} />
      <meta
        name="twitter:image:alt"
        content="skul social card showing reusable AI bundles flowing into supported tool directories"
      />
      <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
    </Head>
  );
}

function HeroSection(): ReactNode {
  return (
    <section className={styles.hero}>
      <div className={clsx('container', styles.heroInner)}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>AI tooling CLI</p>
          <h1 className={styles.heroTitle}>Project-scoped AI bundles without Git noise</h1>
          <p className={styles.heroLead}>
            <code>skul</code> applies reusable skills, commands, and agents into
            Claude Code, Cursor, Codex, and OpenCode projects.
          </p>
          <p className={styles.heroSupport}>
            It keeps source bundles reusable, tool directories local, and worktree
            state explicit so AI setup stays portable without leaking into Git history.
          </p>
          <div className={styles.ctaRow}>
            <Link
              className={clsx('button button--lg', styles.primaryButton)}
              to="/docs/installation">
              Install
            </Link>
            <Link
              className={clsx('button button--lg', styles.secondaryButton)}
              to="/docs/quick-start">
              Quick Start
            </Link>
          </div>
          <ul className={styles.heroChecklist}>
            {heroChecklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <HeroWorkflowPanel />
      </div>
      <div className={clsx('container', styles.proofStrip)}>
        {heroStats.map((point) => (
          <article key={point.value} className={styles.proofPill}>
            <h2>{point.value}</h2>
            <p>{point.label}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function HeroWorkflowPanel(): ReactNode {
  return (
    <section className={styles.commandPanel} aria-label="Workflow preview">
      <div className={styles.commandIntro}>
        <p className={styles.commandEyebrow}>Typical session</p>
        <h2 className={styles.commandTitle}>Bundle once, materialize per project</h2>
        <p className={styles.commandSummary}>
          The same command surface handles first-time fetch, repeat application,
          status inspection, and upstream refresh.
        </p>
      </div>
      <div className={styles.workflowList}>
        {heroWorkflow.map((item) => (
          <article key={item.command} className={styles.workflowItem}>
            <code className={styles.workflowCommand}>{item.command}</code>
            <p>{item.detail}</p>
          </article>
        ))}
      </div>
      <div className={styles.commandFootnote}>
        <span className={styles.commandFootnoteLabel}>Registry locations</span>
        <code>~/.skul/library</code>
        <code>~/.skul/registry.json</code>
      </div>
    </section>
  );
}

function ToolSection(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <p className={styles.sectionLabel}>Supported targets</p>
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>One bundle model, four tool layouts</h2>
          <p className={styles.sectionBody}>
            `skul` does not invent a runtime around your editor. It maps reusable
            bundle content into the directories those tools already load.
          </p>
        </div>
        <div className={styles.toolGrid}>
          {toolCards.map((card) => (
            <article key={card.title} className={styles.toolCard}>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <p className={styles.sectionLabel}>Flow</p>
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>Built for repeatable local setup</h2>
          <p className={styles.sectionBody}>
            The core loop is simple: fetch content, materialize it locally, and keep
            enough state to update or remove it safely later.
          </p>
        </div>
        <div className={styles.stepGrid}>
          {workflowSteps.map((step, index) => (
            <article key={step.title} className={styles.stepCard}>
              <span className={styles.stepIndex}>0{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DocsSection(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <p className={styles.sectionLabel}>Docs</p>
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>Start with the parts that matter</h2>
          <p className={styles.sectionBody}>
            The docs are organized around initial setup, daily commands, and the
            bundle format expected by the CLI.
          </p>
        </div>
        <div className={styles.docsGrid}>
          {docsCards.map((card) => (
            <article key={card.title} className={styles.docsCard}>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
              <Link className={styles.docsLink} to={card.href}>
                {card.label}
              </Link>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
