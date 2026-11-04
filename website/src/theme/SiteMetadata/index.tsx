import useFallbackLocale from "@site/src/hooks/useFallbackLocale";
import SiteMetadata from "@theme-original/SiteMetadata";

export default function LocalizedSiteMetadata() {
  const fallbackLocale = useFallbackLocale();

  // The localized static-host 404 fallback supplies its own locale metadata.
  if (fallbackLocale) {
    return null;
  }

  return <SiteMetadata />;
}
