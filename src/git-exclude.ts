import fs from "node:fs";
import path from "node:path";

const START_MARKER = "# >>> SKUL START";
const END_MARKER = "# <<< SKUL END";
const SKUL_BLOCK_PATTERN = /(?:^|\n)# >>> SKUL START\n[\s\S]*?\n# <<< SKUL END(?:\n)?/g;

export function configureSkulExcludeBlock(options: { gitDir: string; files: string[] }): boolean {
  const excludeFile = resolveExcludeFile(options.gitDir);
  const normalizedFiles = normalizeExcludeFiles(options.files);
  const nextContent = appendSkulExcludeBlock(readExcludeFile(excludeFile), normalizedFiles);

  return writeExcludeFile(excludeFile, nextContent);
}

export function removeSkulExcludeBlock(options: { gitDir: string }): boolean {
  const excludeFile = resolveExcludeFile(options.gitDir);

  if (!fs.existsSync(excludeFile)) {
    return false;
  }

  const existingContent = readExcludeFile(excludeFile);
  const nextContent = removeSkulExcludeContent(existingContent);

  if (existingContent === nextContent) {
    return false;
  }

  return writeExcludeFile(excludeFile, nextContent);
}

export function hasSkulExcludeBlock(options: { gitDir: string }): boolean {
  const excludeFile = resolveExcludeFile(options.gitDir);

  if (!fs.existsSync(excludeFile)) {
    return false;
  }

  return new RegExp(SKUL_BLOCK_PATTERN.source).test(readExcludeFile(excludeFile));
}

function resolveExcludeFile(gitDir: string): string {
  return path.join(gitDir, "info", "exclude");
}

function readExcludeFile(excludeFile: string): string {
  return fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
}

function writeExcludeFile(excludeFile: string, content: string): true {
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.writeFileSync(excludeFile, content);
  return true;
}

function stripSkulExcludeBlock(content: string): string {
  return content.replace(SKUL_BLOCK_PATTERN, "");
}

function appendSkulExcludeBlock(content: string, files: string[]): string {
  const preservedContent = stripSkulExcludeBlock(content).trimEnd();
  const block = buildSkulExcludeBlock(files);

  return preservedContent ? `${preservedContent}\n\n${block}\n` : `${block}\n`;
}

function removeSkulExcludeContent(content: string): string {
  const preservedContent = stripSkulExcludeBlock(content).trimEnd();

  return preservedContent ? `${preservedContent}\n` : "";
}

function buildSkulExcludeBlock(files: string[]): string {
  return [START_MARKER, ...files, END_MARKER].join("\n");
}

function normalizeExcludeFiles(files: string[]): string[] {
  return Array.from(
    new Set(
      files
        .map((file) => normalizeExcludePattern(file))
        .filter((file) => file.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeExcludePattern(file: string): string {
  return file.split(path.sep).join("/");
}
