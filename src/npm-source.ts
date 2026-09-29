import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Source host segment that marks a cached source as an npm package. */
export const NPM_SOURCE_HOST = "npm";

const NPM_SOURCE_PREFIX = "npm:";
const UNSCOPED_NPM_SOURCE_OWNER = "-";
const NPM_NAME_SEGMENT_RE = /^[a-zA-Z0-9-][a-zA-Z0-9._-]*$/;
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_REGISTRY_ENV = "SKUL_NPM_REGISTRY";
const NPM_CONFIG_REGISTRY_ENV = "npm_config_registry";
const NPM_TOKEN_ENV = "SKUL_NPM_TOKEN";
const NPM_DEFAULT_DIST_TAG = "latest";
const NPM_METADATA_FILE = ".skul-source.json";
const NPM_USER_AGENT = "skul";
const NPM_ABBREVIATED_METADATA_ACCEPT =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

export interface NpmResolvedVersion {
  /** Tarball SHA-1 digest, used as the source revision identifier. */
  commit: string;
  /** "branch" for a moving dist-tag, "commit" for an exact version. */
  kind: "branch" | "commit";
  requestedRef: string | null;
  version: string;
  tarball: string;
  integrity?: string;
}

export interface NpmSourceMetadata {
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
  return source.startsWith(`${NPM_SOURCE_HOST}/`);
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

  if (ref === "") {
    throw new Error(`Unsupported npm source: ${input}`);
  }

  return {
    source: npmPackageNameToSource(name, input),
    ...(ref !== undefined ? { ref } : {}),
  };
}

/** Validates an already-normalized `npm/<scope|->/<name>` source identifier. */
export function normalizeNpmSource(source: string): string {
  return npmPackageNameToSource(getNpmPackageName(source), source);
}

function npmPackageNameToSource(name: string, input: string): string {
  const [first, second, ...rest] = name.split("/");
  const scoped = first?.startsWith("@") ?? false;
  const scope = scoped ? first!.slice(1) : undefined;
  const packageName = scoped ? second : first;

  if (
    rest.length > 0 ||
    (!scoped && second !== undefined) ||
    (scope !== undefined && !NPM_NAME_SEGMENT_RE.test(scope)) ||
    !packageName ||
    !NPM_NAME_SEGMENT_RE.test(packageName)
  ) {
    throw new Error(`Unsupported npm source: ${input}`);
  }

  return `${NPM_SOURCE_HOST}/${scope !== undefined ? `@${scope}` : UNSCOPED_NPM_SOURCE_OWNER}/${packageName}`;
}

/** Returns the npm package name (e.g. `@scope/name`) for an npm source identifier. */
export function getNpmPackageName(source: string): string {
  const [host, owner, name, ...rest] = source.split("/");

  if (host !== NPM_SOURCE_HOST || !owner || !name || rest.length > 0) {
    throw new Error(`Invalid npm source: ${source}`);
  }

  return owner === UNSCOPED_NPM_SOURCE_OWNER ? name : `${owner}/${name}`;
}

/** Returns the registry metadata URL used as the remote URL of an npm source. */
export function getNpmPackumentUrl(source: string): string {
  return new URL(
    getNpmPackageName(source).replace("/", "%2f"),
    getNpmRegistryBaseUrl(),
  ).href;
}

/**
 * Resolves a dist-tag (default `latest`) or an exact version to one published
 * package version. Dist-tags move like branches; exact versions are immutable.
 */
export async function resolveNpmSourceRef(
  source: string,
  requestedRef?: string | null,
): Promise<NpmResolvedVersion> {
  const packument = await fetchNpmPackument(source);
  const selector = requestedRef ?? NPM_DEFAULT_DIST_TAG;
  const taggedVersion = packument["dist-tags"]?.[selector];
  const version = taggedVersion ?? selector;
  const dist = packument.versions?.[version]?.dist;

  if (!dist) {
    throw new Error(
      `npm version or dist-tag not found for ${getNpmPackageName(source)}: ${selector}`,
    );
  }

  return {
    ...requireNpmDist(source, version, dist),
    kind: taggedVersion !== undefined ? "branch" : "commit",
    requestedRef: requestedRef ?? null,
    version,
  };
}

/** Finds the published version whose tarball digest matches a recorded revision. */
export async function resolveNpmSourceRevision(
  source: string,
  commit: string,
  requestedRef: string | null,
): Promise<NpmResolvedVersion> {
  const packument = await fetchNpmPackument(source);
  const normalizedCommit = commit.toLowerCase();

  for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
    if (manifest.dist?.shasum?.toLowerCase().startsWith(normalizedCommit)) {
      return {
        ...requireNpmDist(source, version, manifest.dist),
        kind: "commit",
        requestedRef,
        version,
      };
    }
  }

  throw new Error(
    `npm version not found for ${getNpmPackageName(source)} with shasum ${commit}`,
  );
}

function requireNpmDist(
  source: string,
  version: string,
  dist: NonNullable<NpmPackageVersion["dist"]>,
): Pick<NpmResolvedVersion, "commit" | "tarball" | "integrity"> {
  if (!dist.shasum || !/^[0-9a-f]{40}$/i.test(dist.shasum) || !dist.tarball) {
    throw new Error(
      `npm registry returned incomplete metadata for ${getNpmPackageName(source)}@${version}`,
    );
  }

  return {
    commit: dist.shasum.toLowerCase(),
    tarball: dist.tarball,
    ...(dist.integrity !== undefined ? { integrity: dist.integrity } : {}),
  };
}

async function fetchNpmPackument(source: string): Promise<NpmPackument> {
  const response = await fetchNpmRegistry(
    getNpmPackumentUrl(source),
    NPM_ABBREVIATED_METADATA_ACCEPT,
  );

  return JSON.parse(
    (await readNpmResponse(response)).toString("utf8"),
  ) as NpmPackument;
}

/**
 * Downloads, verifies, and extracts one package tarball, then swaps it into
 * `targetDir`. The previous cache survives any failure.
 */
export async function replaceWithNpmSource(
  source: string,
  targetDir: string,
  resolved: NpmResolvedVersion,
  prepareSourceDir: (sourceDir: string) => void,
): Promise<NpmSourceMetadata> {
  const suffix = `${process.pid}-${Date.now()}`;
  const tempDir = `${targetDir}.tmp-${suffix}`;
  const archiveFile = `${tempDir}.tgz`;
  const backupDir = `${targetDir}.backup-${suffix}`;
  const metadata: NpmSourceMetadata = {
    transport: "npm-tarball",
    source,
    requested_ref: resolved.requestedRef,
    version: resolved.version,
    shasum: resolved.commit,
    fetched_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    const tarball = await downloadNpmTarball(resolved);
    fs.writeFileSync(archiveFile, tarball);
    extractNpmTarball(archiveFile, tempDir);
    prepareSourceDir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, NPM_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
    }
    fs.renameSync(tempDir, targetDir);

    return metadata;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(backupDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(backupDir, targetDir);
    }
    throw new Error(`Failed to fetch ${source}: ${getErrorText(error)}`, {
      cause: error,
    });
  } finally {
    fs.rmSync(archiveFile, { force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

async function downloadNpmTarball(
  resolved: NpmResolvedVersion,
): Promise<Buffer> {
  const tarball = await readNpmResponse(
    await fetchNpmRegistry(resolved.tarball, "application/octet-stream"),
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

function extractNpmTarball(archiveFile: string, targetDir: string): void {
  const extractDir = `${targetDir}.extract`;
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("tar", ["-xzf", archiveFile, "-C", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // npm tarballs wrap their contents in one directory, usually `package/`.
    const wrapperDirs = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    if (wrapperDirs.length !== 1) {
      throw new Error("npm tarball did not contain one wrapper directory");
    }

    fs.renameSync(path.join(extractDir, wrapperDirs[0]!.name), targetDir);
  } catch (error) {
    throw new Error(`Failed to extract npm tarball: ${getErrorText(error)}`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

/** Reads the npm fetch metadata recorded in a cached source, if any. */
export function readNpmSourceMetadata(
  targetDir: string,
  expectedSource: string,
): NpmSourceMetadata | undefined {
  const metadataPath = path.join(targetDir, NPM_METADATA_FILE);

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
    !/^[0-9a-f]{40}$/.test(parsed.shasum) ||
    (parsed.requested_ref !== null && typeof parsed.requested_ref !== "string")
  ) {
    throw new Error(`Invalid npm source metadata in ${targetDir}`);
  }

  return parsed;
}

async function fetchNpmRegistry(
  url: string,
  accept: string,
): Promise<Response> {
  const token = process.env[NPM_TOKEN_ENV];
  const registryOrigin = new URL(getNpmRegistryBaseUrl()).origin;
  // Only send credentials to the configured registry, never to a tarball host
  // that the registry metadata points elsewhere.
  const authorization =
    token && new URL(url).origin === registryOrigin
      ? { Authorization: `Bearer ${token}` }
      : {};

  try {
    return await fetch(url, {
      headers: {
        Accept: accept,
        "User-Agent": NPM_USER_AGENT,
        ...authorization,
      },
    });
  } catch (error) {
    throw new Error(`npm registry request failed: ${getErrorText(error)}`);
  }
}

async function readNpmResponse(response: Response): Promise<Buffer> {
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
    process.env[NPM_REGISTRY_ENV]?.trim() ||
    process.env[NPM_CONFIG_REGISTRY_ENV]?.trim() ||
    DEFAULT_NPM_REGISTRY;

  return configured.endsWith("/") ? configured : `${configured}/`;
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
