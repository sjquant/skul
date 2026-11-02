import { translate } from "@docusaurus/Translate";
import SeoTitle from "@site/src/components/SeoTitle";
import NotFound from "@theme-original/NotFound";

export default function NotFoundPage() {
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
