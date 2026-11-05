import Head from "@docusaurus/Head";
import { useLocation } from "@docusaurus/router";
import { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import OpenGraphLocale from "@site/src/components/OpenGraphLocale";
import SeoTitle from "@site/src/components/SeoTitle";
import useFallbackLocale from "@site/src/hooks/useFallbackLocale";
import NotFound from "@theme-original/NotFound";

export default function NotFoundPage() {
  const fallbackLocale = useFallbackLocale();
  if (fallbackLocale) {
    return <LocalizedFallback locale={fallbackLocale} />;
  }

  return (
    <>
      <NotFound />
      <SeoTitle
        title={translate({
          id: "theme.NotFound.title",
          message: "Page Not Found",
        })}
      />
    </>
  );
}

const fallbackCopy = {
  ko: {
    title: "페이지를 찾을 수 없습니다.",
    description: "원하는 페이지를 찾을 수 없습니다.",
    help: "이 주소로 연결한 사이트의 관리자에게 링크가 올바르지 않다고 알려주세요.",
    languages: "언어 선택",
    home: "한국어 홈",
    docs: "시작하기",
  },
  ja: {
    title: "ページが見つかりません",
    description: "お探しのページは見つかりませんでした。",
    help: "このURLへのリンクが掲載されていたサイトの管理者に、リンクが切れていることをお知らせください。",
    languages: "言語を選択",
    home: "日本語ホーム",
    docs: "はじめに",
  },
};

function LocalizedFallback({ locale }: { locale: "ko" | "ja" }) {
  const { siteConfig, i18n } = useDocusaurusContext();
  const { pathname, search, hash } = useLocation();
  const baseUrl = i18n.localeConfigs[locale].baseUrl;
  const copy = fallbackCopy[locale];
  const canonicalUrl = new URL(pathname, siteConfig.url).href;
  const title = `${siteConfig.title} | ${copy.title}`;
  const counterparts = i18n.locales.map((targetLocale) => {
    const targetConfig = i18n.localeConfigs[targetLocale];
    const home = new URL(targetConfig.baseUrl, siteConfig.url);
    let path = home.pathname;
    try {
      const candidate = new URL(
        targetConfig.baseUrl + pathname.slice(baseUrl.length),
        siteConfig.url,
      );
      if (
        candidate.origin === home.origin &&
        !candidate.pathname.startsWith("//")
      ) {
        path = candidate.pathname;
      }
    } catch {
      // Invalid URL suffixes recover to the target language's home page.
    }
    return {
      locale: targetLocale,
      label: targetConfig.label,
      path,
      url: new URL(path, home).href,
    };
  });
  const defaultUrl = counterparts.find(
    (target) => target.locale === i18n.defaultLocale,
  ).url;

  return (
    <>
      <Head>
        <html lang={locale} />
        <title>{title}</title>
        <meta name="robots" content="noindex, follow" />
        <meta name="description" content={copy.description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={copy.description} />
        <meta property="og:url" content={canonicalUrl} />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={copy.description} />
        <link rel="canonical" href={canonicalUrl} />
        {counterparts.map((target) => (
          <link
            key={target.locale}
            rel="alternate"
            hrefLang={target.locale}
            href={target.locale === locale ? canonicalUrl : target.url}
          />
        ))}
        <link rel="alternate" hrefLang="x-default" href={defaultUrl} />
      </Head>
      <OpenGraphLocale locale={locale} />
      <main lang={locale} className="container margin-vert--xl">
        <nav aria-label={copy.languages}>
          {counterparts.map((target) => (
            <span key={target.locale} className="margin-right--sm">
              {target.locale === locale ? (
                <span lang={locale} aria-current="page">
                  {target.label}
                </span>
              ) : (
                <a lang={target.locale} href={`${target.path}${search}${hash}`}>
                  {target.label}
                </a>
              )}
            </span>
          ))}
        </nav>
        <h1 className="hero__title">{copy.title}</h1>
        <p>{copy.description}</p>
        <p>{copy.help}</p>
        <p>
          <a href={baseUrl}>{copy.home}</a>
          {" · "}
          <a href={`${baseUrl}docs/intro`}>{copy.docs}</a>
        </p>
      </main>
    </>
  );
}
