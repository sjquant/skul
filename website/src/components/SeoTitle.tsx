import Head from "@docusaurus/Head";
import { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

export default function SeoTitle({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  const { siteConfig } = useDocusaurusContext();
  const pageTitle =
    title === siteConfig.title ? title : `${siteConfig.title} | ${title}`;
  const imageAlt = translate({
    id: "seo.socialImageAlt",
    message: "skul: Your AI setup, kept out of Git",
  });

  return (
    <Head>
      <title>{pageTitle}</title>
      <meta property="og:title" content={pageTitle} />
      <meta name="twitter:title" content={pageTitle} />
      {description && <meta name="twitter:description" content={description} />}
      <meta property="og:image:alt" content={imageAlt} />
      <meta name="twitter:image:alt" content={imageAlt} />
      <meta
        name="keywords"
        content={translate({
          id: "seo.keywords",
          message:
            "shared ai bundles, ai bundle cli, claude code skills, cursor skills, codex agents, opencode agents, copilot skills, kiro agents, ai workflow cli",
        })}
      />
    </Head>
  );
}
