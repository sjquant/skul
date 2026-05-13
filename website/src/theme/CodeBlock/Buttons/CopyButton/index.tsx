import { translate } from "@docusaurus/Translate";
import { useCodeBlockContext } from "@docusaurus/theme-common/internal";
import Button from "@theme/CodeBlock/Buttons/Button";
import type { Props } from "@theme/CodeBlock/Buttons/CopyButton";
import IconCopy from "@theme/Icon/Copy";
import IconSuccess from "@theme/Icon/Success";
import clsx from "clsx";
import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import styles from "./styles.module.css";

function title() {
  return translate({
    id: "theme.CodeBlock.copy",
    message: "Copy",
    description: "The copy button label on code blocks",
  });
}

function ariaLabel(isCopied: boolean) {
  return isCopied
    ? translate({
        id: "theme.CodeBlock.copied",
        message: "Copied",
        description: "The copied button label on code blocks",
      })
    : translate({
        id: "theme.CodeBlock.copyButtonAriaLabel",
        message: "Copy code to clipboard",
        description: "The ARIA label for copy code blocks button",
      });
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const copied = copyTextFallback(text);

      if (copied) {
        return;
      }
    }
  }

  const copied = copyTextFallback(text);

  if (copied) {
    return;
  }

  throw new Error("Clipboard copy failed");
}

function copyTextFallback(text: string) {
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textArea = document.createElement("textarea");

  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.setAttribute("aria-hidden", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "-9999px";
  textArea.style.opacity = "0";

  document.body.append(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  let copied = false;

  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textArea.remove();
  activeElement?.focus();

  return copied;
}

function useCopyButton() {
  const {
    metadata: { code },
  } = useCodeBlockContext();
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeout = useRef<number | undefined>(undefined);

  const copyCode = useCallback(() => {
    copyToClipboard(code).then(() => {
      setIsCopied(true);
      copyTimeout.current = window.setTimeout(() => {
        setIsCopied(false);
      }, 1000);
    });
  }, [code]);

  useEffect(() => () => window.clearTimeout(copyTimeout.current), []);

  return { copyCode, isCopied };
}

export default function CopyButton({ className }: Props): ReactNode {
  const { copyCode, isCopied } = useCopyButton();

  return (
    <Button
      aria-label={ariaLabel(isCopied)}
      title={title()}
      className={clsx(
        className,
        styles.copyButton,
        isCopied && styles.copyButtonCopied,
      )}
      onClick={copyCode}
    >
      <span className={styles.copyButtonIcons} aria-hidden="true">
        <IconCopy className={styles.copyButtonIcon} />
        <IconSuccess className={styles.copyButtonSuccessIcon} />
      </span>
    </Button>
  );
}
