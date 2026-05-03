import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'skul',
  tagline: 'Project-scoped AI bundle delivery for Claude Code, Cursor, Codex, and OpenCode',
  favicon: 'img/favicon.ico',
  future: {
    v4: true,
  },
  url: 'https://sjquant.github.io',
  baseUrl: '/skul/',
  organizationName: 'sjquant',
  projectName: 'skul',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  customFields: {
    githubUrl: 'https://github.com/sjquant/skul',
  },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/sjquant/skul/tree/main/website/',
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: 'img/social-card.svg',
    metadata: [
      {
        name: 'keywords',
        content:
          'ai bundle cli, claude code bundles, cursor skills manager, codex skills sync, opencode agents, git-safe ai tooling',
      },
      {
        name: 'twitter:card',
        content: 'summary_large_image',
      },
    ],
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'skul',
      logo: {
        alt: 'skul logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'dropdown',
          position: 'left',
          label: 'Docs',
          items: [
            {
              label: 'Overview',
              to: '/docs/intro',
            },
            {
              label: 'Installation',
              to: '/docs/installation',
            },
            {
              label: 'Quick Start',
              to: '/docs/quick-start',
            },
            {
              label: 'Supported Tools',
              to: '/docs/supported-tools',
            },
            {
              label: 'Bundle Structure',
              to: '/docs/bundle-structure',
            },
            {
              label: 'How It Works',
              to: '/docs/how-it-works',
            },
            {
              label: 'Commands',
              to: '/docs/commands',
            },
            {
              label: 'FAQ',
              to: '/docs/faq',
            },
          ],
        },
        {
          href: 'https://github.com/sjquant/skul',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Overview',
              to: '/docs/intro',
            },
            {
              label: 'Quick Start',
              to: '/docs/quick-start',
            },
            {
              label: 'Commands',
              to: '/docs/commands',
            },
          ],
        },
        {
          title: 'Project',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/sjquant/skul',
            },
            {
              label: 'Issues',
              href: 'https://github.com/sjquant/skul/issues',
            },
          ],
        },
        {
          title: 'Topics',
          items: [
            {
              label: 'Supported Tools',
              to: '/docs/supported-tools',
            },
            {
              label: 'Bundle Structure',
              to: '/docs/bundle-structure',
            },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} sjquant. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
