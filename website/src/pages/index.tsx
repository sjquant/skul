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
  'skul is an AI bundle CLI for sharing Claude Code, Cursor, Codex, and OpenCode skills, commands, and agents across projects without committing local AI setup files.';

const siteKeywords = [
  'shared ai bundles',
  'ai bundle cli',
  'claude code skills',
  'cursor skills',
  'codex agents',
  'opencode agents',
  'ai workflow cli',
  'developer ai tooling',
];

const heroStats = [
  {
    value: 'One bundle, four tools',
    label: 'Ship the same AI setup to Claude Code, Cursor, Codex, and OpenCode from one source repo.',
  },
  {
    value: 'No repo noise',
    label: 'Keep local AI files out of Git while still giving every project the setup it needs.',
  },
  {
    value: 'Roll out updates fast',
    label: 'Refresh shared prompts, skills, and agents without copy-pasting folders across repos.',
  },
];

const heroChecklist = [
  'Share one bundle repo across Claude Code, Cursor, Codex, and OpenCode',
  'Keep AI setup local instead of committing tool-specific dotdirs',
  'Roll out prompt, skill, and agent updates with add, apply, and update',
];

const heroWorkflow = [
  {
    command: 'skul add github.com/sjquant/ai-bundles react-expert',
    detail: 'Pull a shared bundle into a project in one command.',
  },
  {
    command: 'skul apply',
    detail: 'Re-apply the same bundle setup in linked worktrees without manual copying.',
  },
  {
    command: 'skul update',
    detail: 'Refresh bundles when your team ships new prompts, skills, or agents.',
  },
];

const workflowSteps = [
  {
    title: 'Publish once',
    body: 'Keep reusable prompts, skills, and agents in one repo instead of scattering copies across projects.',
  },
  {
    title: 'Apply per project',
    body: 'Materialize only the files each tool expects, in the repo you are working in right now.',
  },
  {
    title: 'Update without cleanup drama',
    body: 'Re-apply or remove managed files predictably when shared AI setup changes.',
  },
];

const toolCards = [
  {
    title: 'Claude Code',
    body: 'Share Claude Code skills, commands, and agents across repos without committing them.',
  },
  {
    title: 'Cursor',
    body: 'Keep Cursor project setup consistent without maintaining a second copy of the same prompts.',
  },
  {
    title: 'Codex',
    body: 'Ship Codex skills and agents from the same source bundle you already use elsewhere.',
  },
  {
    title: 'OpenCode',
    body: 'Support OpenCode projects without inventing a separate packaging workflow.',
  },
];

const docsCards: Card[] = [
  {
    title: 'Installation',
    body: 'Install the CLI and get your machine ready in a few minutes.',
    href: '/docs/installation',
    label: 'Install skul',
  },
  {
    title: 'Quick Start',
    body: 'Apply your first shared AI bundle and target the tools you actually use.',
    href: '/docs/quick-start',
    label: 'Read quick start',
  },
  {
    title: 'Commands',
    body: 'Keep the full command surface nearby once skul becomes part of your daily workflow.',
    href: '/docs/commands',
    label: 'Browse commands',
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
      title="Share AI bundles without Git noise"
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
      <meta property="og:title" content="skul | AI bundles for Claude Code, Cursor, Codex, and OpenCode" />
      <meta property="og:description" content={siteDescription} />
      <meta property="og:url" content={siteUrl} />
      <meta property="og:image" content={socialImageUrl} />
      <meta
        property="og:image:alt"
        content="skul social card showing reusable AI bundles flowing into supported tool directories"
      />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content="skul | AI bundles for Claude Code, Cursor, Codex, and OpenCode" />
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
          <h1 className={styles.heroTitle}>Share AI bundles without Git noise</h1>
          <p className={styles.heroLead}>
            <code>skul</code> lets teams reuse AI bundles across Claude Code,
            Cursor, Codex, and OpenCode.
          </p>
          <p className={styles.heroSupport}>
            Keep shared prompts, skills, and agents in one bundle repo, apply them
            per project, and leave
            tool-local files out of Git.
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
        <h2 className={styles.commandTitle}>Go from shared bundle to working project fast</h2>
        <p className={styles.commandSummary}>
          Start with one bundle repo, apply it where needed, and keep project-level
          AI setup consistent without copy-pasting folders.
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
    </section>
  );
}

function ToolSection(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <p className={styles.sectionLabel}>Supported AI tools</p>
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>One bundle model across four coding tools</h2>
          <p className={styles.sectionBody}>
            Reuse the same bundle source across the tools your team already works in
            instead of rebuilding prompt folders for each one.
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
        <p className={styles.sectionLabel}>How it helps</p>
        <div className={styles.sectionHeading}>
          <h2 className={styles.sectionTitle}>Made for shared AI workflows that stay maintainable</h2>
          <p className={styles.sectionBody}>
            `skul` is useful when AI setup needs to be shared across repos, tools,
            and teammates without turning every project into a prompt graveyard.
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
          <h2 className={styles.sectionTitle}>Start with what gets you to value fastest</h2>
          <p className={styles.sectionBody}>
            Install first, try one bundle, then keep the command reference nearby
            when you are ready to wire skul into daily work.
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
