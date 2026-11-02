import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

export default function SeoTitle({ title }: { title: string }) {
  const { siteConfig } = useDocusaurusContext();
  const pageTitle =
    title === siteConfig.title ? title : `${siteConfig.title} | ${title}`;

  return (
    <Head>
      <title>{pageTitle}</title>
      <meta property="og:title" content={pageTitle} />
      <meta name="twitter:title" content={pageTitle} />
    </Head>
  );
}
