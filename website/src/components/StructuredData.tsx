import Head from "@docusaurus/Head";
import { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

export interface HowToStep {
  name: string;
  text: string;
  url: string;
}

export default function StructuredData({
  title,
  description,
  permalink,
  article = false,
  steps,
}: {
  title: string;
  description: string;
  permalink: string;
  article?: boolean;
  steps?: HowToStep[];
}) {
  const { siteConfig, i18n } = useDocusaurusContext();
  const siteUrl = new URL(siteConfig.baseUrl, siteConfig.url).href;
  const defaultLocale = i18n.localeConfigs[i18n.defaultLocale];
  const canonicalSiteUrl = new URL(defaultLocale.baseUrl, defaultLocale.url)
    .href;
  const pageUrl = new URL(permalink, siteUrl).href;
  const websiteId = `${siteUrl}#website`;
  const softwareId = `${canonicalSiteUrl}#software`;
  const sourceId = `${canonicalSiteUrl}#sourcecode`;
  const authorId = "https://github.com/sjquant#person";
  const repositoryUrl = "https://github.com/sjquant/skul";
  const licenseUrl = `${repositoryUrl}/blob/main/LICENSE`;
  const articleId = `${pageUrl}#article`;
  const graph = [
    {
      "@type": "WebSite",
      "@id": websiteId,
      name: siteConfig.title,
      description: translate({
        id: "home.title",
        message: "Your AI setup, kept out of Git",
      }),
      url: siteUrl,
      inLanguage: i18n.currentLocale,
      publisher: { "@id": authorId },
      about: { "@id": softwareId },
    },
    {
      "@type": "Person",
      "@id": authorId,
      name: "sjquant",
      url: "https://github.com/sjquant",
    },
    {
      "@type": "SoftwareApplication",
      "@id": softwareId,
      name: siteConfig.title,
      identifier: "@solaqua/skul",
      description: translate({
        id: "seo.software.description",
        message:
          "Your AI setup, kept out of Git: apply shared skills, subagents, instructions, and MCP servers to your coding tools.",
      }),
      url: canonicalSiteUrl,
      applicationCategory: "DeveloperApplication",
      softwareRequirements: translate({
        id: "seo.software.requirements",
        message: "Node.js 20+ and Git.",
      }),
      installUrl: new URL("docs/intro#install", siteUrl).href,
      license: licenseUrl,
      author: { "@id": authorId },
      subjectOf: { "@id": sourceId },
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": sourceId,
      name: siteConfig.title,
      codeRepository: repositoryUrl,
      url: repositoryUrl,
      programmingLanguage: "TypeScript",
      runtimePlatform: "Node.js 20+",
      license: licenseUrl,
      author: { "@id": authorId },
      targetProduct: { "@id": softwareId },
    },
    {
      "@type": "WebPage",
      "@id": `${pageUrl}#webpage`,
      name: title,
      description,
      url: pageUrl,
      inLanguage: i18n.currentLocale,
      isPartOf: { "@id": websiteId },
      about: { "@id": softwareId },
      mainEntity: { "@id": article ? articleId : softwareId },
    },
    ...(article
      ? [
          {
            "@type": steps ? ["TechArticle", "HowTo"] : "TechArticle",
            "@id": articleId,
            headline: title,
            name: title,
            description,
            url: pageUrl,
            inLanguage: i18n.currentLocale,
            isPartOf: { "@id": websiteId },
            mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
            about: { "@id": softwareId },
            author: { "@id": authorId },
            ...(steps
              ? {
                  step: steps.map((step) => ({
                    "@type": "HowToStep",
                    "@id": new URL(step.url, pageUrl).href,
                    inLanguage: i18n.currentLocale,
                    ...step,
                    url: new URL(step.url, pageUrl).href,
                  })),
                }
              : {}),
          },
        ]
      : []),
  ];

  return (
    <Head>
      <script type="application/ld+json">
        {JSON.stringify({
          "@context": "https://schema.org",
          "@graph": graph,
        }).replace(/</g, "\\u003c")}
      </script>
    </Head>
  );
}
