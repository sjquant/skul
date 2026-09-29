import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  CachedSourceRevision,
  FetchRemoteSourceOptions,
  RemoteSourceStatus,
  UpdateCachedRemoteSourceResult,
} from "./bundle-fetch";
import {
  extractTarball,
  getErrorText,
  replaceSourceDirectory,
  SOURCE_METADATA_FILE,
  stripRepositoryRootInstructions,
} from "./source-archive";

const NPM_SOURCE_PREFIX = "npm:";
// Scoped packages cache under `npm/<scope>/<name>`; `-` cannot be a scope, so
// unscoped packages use it as their owner segment.
const UNSCOPED_OWNER = "-";
const NPM_NAME_RE =
  /^(?:@([a-zA-Z0-9][a-zA-Z0-9._-]*)\/)?([a-zA-Z0-9][a-zA-Z0-9._-]*)$/;
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

interface NpmResolvedVersion {
  /** Tarball SHA-1 digest, used as the source revision identifier. */
  commit: string;
  /** "branch" for a moving dist-tag, "commit" for an exact version. */
  kind: "branch" | "commit";
  requestedRef: string | null;
  version: string;
  tarball: string;
  integrity?: string;
}

interface NpmSourceMetadata {
  transport: "npm-tarball";
  source: string;
  requested_ref: string | null;
  version: string;
  shasum: string;
  fetched_at: string;
}

interface NpmPackument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmPackageVersion>;
}

interface NpmPackageVersion {
  dist?: { shasum?: string; tarball?: string; integrity?: string };
}

/** Returns true when a normalized source identifier names an npm package. */
export function isNpmSource(source: string): boolean {
  return source.startsWith("npm/");
}

/**
 * Parses `npm:<name>[@<version-or-dist-tag>]` into a normalized source and an
 * optional ref selector. Returns undefined for inputs without the `npm:` prefix.
 */
export function parseNpmSourceSpec(
  input: string,
): { source: string; ref?: string } | undefined {
  if (!input.startsWith(NPM_SOURCE_PREFIX)) {
    return undefined;
  }

  const spec = input.slice(NPM_SOURCE_PREFIX.length);
  const refSeparator = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = refSeparator === -1 ? spec : spec.slice(0, refSeparator);
  const ref = refSeparator === -1 ? undefined : spec.slice(refSeparator + 1);
  const nameMatch = name.match(NPM_NAME_RE);

  if (!nameMatch || ref === "") {
    throw new Error(`Unsupported npm source: ${input}`);
  }

  return {
    source: `npm/${nameMatch[1] ?? UNSCOPED_OWNER}/${nameMatch[2]}`,
    ...(ref !== undefined ? { ref } : {}),
  };
}

function getNpmPackageName(source: string): string {
  const [, owner, name] = source.split("/");

  return owner === UNSCOPED_OWNER ? name! : `@${owner}/${name}`;
}

/** Resolves the cached revision of one npm source from its fetch metadata. */
export function readNpmSourceRevision(
  source: string,
  targetDir: string,
): CachedSourceRevision {
  const metadata = readNpmSourceMetadata(targetDir, source);

  return {
    cached: true,
    targetDir,
    currentCommit: metadata?.shasum,
    currentRef: metadata?.version,
    remoteUrl: getNpmPackumentUrl(source),
  };
}

/** Resolves the version the source's ref selector (or stored one) points at. */
export async function inspectNpmSource(
  options: FetchRemoteSourceOptions,
  cached: CachedSourceRevision,
): Promise<RemoteSourceStatus> {
  const requestedRef =
    options.ref ??
    readNpmSourceMetadata(cached.targetDir, options.source)?.requested_ref;

  return toRemoteStatus(
    options.source,
    cached,
    await resolveNpmVersion(options, requestedRef ?? null),
  );
}

/**
 * Moves the cache to the version the ref selector resolves to. An update
 * follows the ref recorded at the last fetch and skips an unchanged tarball; a
 * refetch falls back to `latest` and always downloads, restoring any root
 * instructions an earlier fetch stripped.
 */
export async function updateNpmSource(
  options: FetchRemoteSourceOptions,
  targetDir: string,
  mode: "update" | "refetch",
): Promise<UpdateCachedRemoteSourceResult> {
  const metadata = readNpmSourceMetadata(targetDir, options.source);
  const cached: CachedSourceRevision = metadata
    ? readNpmSourceRevision(options.source, targetDir)
    : { cached: fs.existsSync(targetDir), targetDir };
  const requestedRef =
    options.ref ?? (mode === "update" ? metadata?.requested_ref : null) ?? null;
  const resolved = await resolveNpmVersion(options, requestedRef);
  const status = toRemoteStatus(options.source, cached, resolved);

  if (mode === "update" && metadata?.shasum === resolved.commit) {
    return { ...status, previousCommit: metadata.shasum, updated: false };
  }

  await replaceNpmSource(options, targetDir, resolved);

  return {
    ...status,
    cached: true,
    currentCommit: resolved.commit,
    currentRef: resolved.version,
    previousCommit: metadata?.shasum,
    updated: true,
  };
}

/** Moves the cache back to the published version with a recorded tarball digest. */
export async function restoreNpmSource(
  options: FetchRemoteSourceOptions,
  targetDir: string,
  commit: string,
): Promise<void> {
  const metadata = readNpmSourceMetadata(targetDir, options.source);

  if (metadata?.shasum === commit) {
    return;
  }

  const packument = await fetchNpmPackument(options.source);
  const match = Object.entries(packument.versions ?? {}).find(
    ([, manifest]) => manifest.dist?.shasum?.toLowerCase() === commit,
  );

  if (!match) {
    throw new Error(
      `npm version not found for ${getNpmPackageName(options.source)} with shasum ${commit}`,
    );
  }

  await replaceNpmSource(options, targetDir, {
    ...requireNpmDist(options.source, match[0], match[1].dist!),
    kind: "commit",
    requestedRef: options.ref ?? metadata?.requested_ref ?? null,
    version: match[0],
  });
}

function toRemoteStatus(
  source: string,
  cached: CachedSourceRevision,
  resolved: NpmResolvedVersion,
): RemoteSourceStatus {
  return {
    ...cached,
    remoteUrl: getNpmPackumentUrl(source),
    remoteCommit: resolved.commit,
    refKind: resolved.kind,
    resolvedRef: resolved.version,
  };
}

/**
 * Resolves a dist-tag (default `latest`) or an exact version to one published
 * package version. Dist-tags move like branches; exact versions are immutable.
 */
async function resolveNpmVersion(
  options: FetchRemoteSourceOptions,
  requestedRef: string | null,
): Promise<NpmResolvedVersion> {
  if (options.protocol === "ssh") {
    throw new Error(
      `npm sources cannot be fetched over SSH: ${options.source}\nHint: omit --ssh for npm sources`,
    );
  }

  const packument = await fetchNpmPackument(options.source);
  const selector = requestedRef ?? "latest";
  const taggedVersion = packument["dist-tags"]?.[selector];
  const version = taggedVersion ?? selector;
  const dist = packument.versions?.[version]?.dist;

  if (!dist) {
    throw new Error(
      `npm version or dist-tag not found for ${getNpmPackageName(options.source)}: ${selector}`,
    );
  }

  return {
    ...requireNpmDist(options.source, version, dist),
    kind: taggedVersion !== undefined ? "branch" : "commit",
    requestedRef,
    version,
  };
}

function requireNpmDist(
  source: string,
  version: string,
  dist: NonNullable<NpmPackageVersion["dist"]>,
): Pick<NpmResolvedVersion, "commit" | "tarball" | "integrity"> {
  const shasum = dist.shasum?.toLowerCase();

  if (!shasum || !isSha1Hex(shasum) || !dist.tarball) {
    throw new Error(
      `npm registry returned incomplete metadata for ${getNpmPackageName(source)}@${version}`,
    );
  }

  return {
    commit: shasum,
    tarball: dist.tarball,
    ...(dist.integrity !== undefined ? { integrity: dist.integrity } : {}),
  };
}

async function fetchNpmPackument(source: string): Promise<NpmPackument> {
  const body = await fetchNpmBuffer(
    getNpmPackumentUrl(source),
    "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
  );

  return JSON.parse(body.toString("utf8")) as NpmPackument;
}

function getNpmPackumentUrl(source: string): string {
  return new URL(
    getNpmPackageName(source).replace("/", "%2f"),
    getNpmRegistryBaseUrl(),
  ).href;
}

async function replaceNpmSource(
  options: FetchRemoteSourceOptions,
  targetDir: string,
  resolved: NpmResolvedVersion,
): Promise<void> {
  const metadata: NpmSourceMetadata = {
    transport: "npm-tarball",
    source: options.source,
    requested_ref: resolved.requestedRef,
    version: resolved.version,
    shasum: resolved.commit,
    fetched_at: new Date().toISOString(),
  };

  try {
    await replaceSourceDirectory(targetDir, async (tempDir, archiveFile) => {
      fs.writeFileSync(archiveFile, await downloadNpmTarball(resolved));
      extractTarball(archiveFile, tempDir, "npm tarball");
      stripRepositoryRootInstructions(tempDir, options.includeRootInstructions);
      fs.writeFileSync(
        path.join(tempDir, SOURCE_METADATA_FILE),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch ${options.source}: ${getErrorText(error)}`,
      { cause: error },
    );
  }
}

async function downloadNpmTarball(
  resolved: NpmResolvedVersion,
): Promise<Buffer> {
  const tarball = await fetchNpmBuffer(
    resolved.tarball,
    "application/octet-stream",
  );
  const shasum = createHash("sha1").update(tarball).digest("hex");

  if (shasum !== resolved.commit) {
    throw new Error(
      `npm tarball shasum mismatch: expected ${resolved.commit}, got ${shasum}`,
    );
  }

  const sha512Integrity = resolved.integrity
    ?.split(/\s+/)
    .find((entry) => entry.startsWith("sha512-"));
  if (
    sha512Integrity !== undefined &&
    `sha512-${createHash("sha512").update(tarball).digest("base64")}` !==
      sha512Integrity
  ) {
    throw new Error("npm tarball integrity mismatch");
  }

  return tarball;
}

function readNpmSourceMetadata(
  targetDir: string,
  expectedSource: string,
): NpmSourceMetadata | undefined {
  const metadataPath = path.join(targetDir, SOURCE_METADATA_FILE);

  if (!fs.existsSync(metadataPath)) {
    return undefined;
  }

  let parsed: NpmSourceMetadata;
  try {
    parsed = JSON.parse(
      fs.readFileSync(metadataPath, "utf8"),
    ) as NpmSourceMetadata;
  } catch {
    throw new Error(`Invalid npm source metadata in ${targetDir}`);
  }

  if (
    parsed.transport !== "npm-tarball" ||
    parsed.source !== expectedSource ||
    typeof parsed.version !== "string" ||
    typeof parsed.fetched_at !== "string" ||
    typeof parsed.shasum !== "string" ||
    !isSha1Hex(parsed.shasum) ||
    (parsed.requested_ref !== null && typeof parsed.requested_ref !== "string")
  ) {
    throw new Error(`Invalid npm source metadata in ${targetDir}`);
  }

  return parsed;
}

function isSha1Hex(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

async function fetchNpmBuffer(url: string, accept: string): Promise<Buffer> {
  const token = process.env.SKUL_NPM_TOKEN;
  // Only send credentials to the configured registry, never to a tarball host
  // that the registry metadata points elsewhere.
  const authorization =
    token && new URL(url).origin === new URL(getNpmRegistryBaseUrl()).origin
      ? { Authorization: `Bearer ${token}` }
      : {};
  let response: Response;

  try {
    response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": "skul", ...authorization },
    });
  } catch (error) {
    throw new Error(`npm registry request failed: ${getErrorText(error)}`);
  }

  const body = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(
      `npm registry request failed (${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      })`,
    );
  }

  return body;
}

function getNpmRegistryBaseUrl(): string {
  const configured =
    process.env.SKUL_NPM_REGISTRY?.trim() ||
    process.env.npm_config_registry?.trim() ||
    DEFAULT_NPM_REGISTRY;

  return configured.endsWith("/") ? configured : `${configured}/`;
}
