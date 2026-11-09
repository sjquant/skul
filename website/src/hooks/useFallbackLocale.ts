import { useLocation } from "@docusaurus/router";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import useIsBrowser from "@docusaurus/useIsBrowser";

export default function useFallbackLocale() {
  const { i18n } = useDocusaurusContext();
  const { pathname } = useLocation();
  const isBrowser = useIsBrowser();

  return isBrowser
    ? (["ko", "ja", "zh-Hans"] as const).find((locale) => {
        const baseUrl = i18n.localeConfigs[locale].baseUrl;
        return (
          i18n.currentLocale !== locale &&
          (pathname === baseUrl.slice(0, -1) || pathname.startsWith(baseUrl))
        );
      })
    : undefined;
}
