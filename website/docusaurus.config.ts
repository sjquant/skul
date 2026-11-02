import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "skul",
  tagline: "Your AI setup, kept out of Git",
  favicon: "img/favicon.ico",
  headTags: [
    {
      tagName: "link",
      attributes: {
        rel: "icon",
        type: "image/svg+xml",
        href: "/img/favicon.svg",
      },
    },
  ],
  future: {
    v4: true,
  },
  url: "https://skul.solaqua.dev",
  baseUrl: "/",
  organizationName: "sjquant",
  projectName: "skul",
  deploymentBranch: "gh-pages",
  trailingSlash: false,
  onBrokenLinks: "throw",
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/sjquant/skul/tree/main/website/",
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: "img/social-preview.png",
    metadata: [
      { property: "og:site_name", content: "skul" },
      { property: "og:type", content: "website" },
      {
        name: "keywords",
        content:
          "shared ai bundles, ai bundle cli, claude code skills, cursor skills, codex agents, opencode agents, copilot skills, kiro agents, ai workflow cli",
      },
      {
        name: "twitter:card",
        content: "summary_large_image",
      },
    ],
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: "skul",
      logo: {
        alt: "skul logo",
        src: "img/logo.svg",
        srcDark: "img/logo-dark.svg",
      },
      items: [
        { to: "/docs/intro", label: "Docs", position: "left" },
        { to: "/docs/commands", label: "Commands", position: "left" },
        { to: "/docs/tools", label: "Tools", position: "left" },
        {
          href: "https://github.com/sjquant/skul",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      copyright: `ISC License · sjquant`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
