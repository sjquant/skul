import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

const openGraphLocales: Record<string, string> = {
  en: "en_US",
  ko: "ko_KR",
  ja: "ja_JP",
};

export default function OpenGraphLocale({ locale }: { locale?: string }) {
  const { i18n } = useDocusaurusContext();
  const currentLocale = locale ?? i18n.currentLocale;

  return (
    <Head>
      <meta property="og:locale" content={openGraphLocales[currentLocale]} />
      {i18n.locales
        .filter((language) => language !== currentLocale)
        .map((language) => (
          <meta
            key={language}
            property="og:locale:alternate"
            content={openGraphLocales[language]}
          />
        ))}
    </Head>
  );
}
