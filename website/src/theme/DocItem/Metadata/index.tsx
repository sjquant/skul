import { useDoc } from "@docusaurus/plugin-content-docs/client";
import SeoTitle from "@site/src/components/SeoTitle";
import StructuredData, {
  type HowToStep,
} from "@site/src/components/StructuredData";
import DocItemMetadata from "@theme-original/DocItem/Metadata";

const gettingStartedSteps: HowToStep[] = [
  {
    name: "Install",
    text: "npm install --global @solaqua/skul\n\nNeeds Node.js 20+ and Git.",
    url: "#install",
  },
  {
    name: "Apply a bundle",
    text: "Run this inside a Git project:\n\nskul add sjquant/ghosts writing\n\nThis uses a public example bundle. Skul clones sjquant/ghosts into ~/.skul/library/, asks which tools to target, writes the writing bundle's files, and adds them to .git/info/exclude. Run git status: nothing changed.",
    url: "#apply-a-bundle",
  },
  {
    name: "Use it",
    text: "Open your coding tool in the project. The bundle's skills are ready to use; in Claude Code, for example, run /ghosts:rewrite.",
    url: "#use-it",
  },
];

export default function Metadata() {
  const { metadata } = useDoc();
  return (
    <>
      <DocItemMetadata />
      <SeoTitle title={metadata.title} />
      <StructuredData
        title={metadata.title}
        description={metadata.description}
        permalink={metadata.permalink}
        article
        steps={metadata.id === "intro" ? gettingStartedSteps : undefined}
      />
    </>
  );
}
