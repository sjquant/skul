import type { MaterializeBundleResult } from "./bundle-materialization";

/** Registry fields that describe MCP files and directories Skul created. */
export interface McpOwnershipRegistryFields {
  created_mcp_files?: string[];
  created_mcp_directories?: string[];
}

/**
 * Owns the mutable bookkeeping for MCP paths created during materialization.
 *
 * Callers only record materialization results, release paths after cleanup, and
 * serialize the final registry fields. The set representation stays private so
 * lifecycle commands do not need to coordinate it themselves.
 */
export interface McpMaterializationOwnership {
  recordMaterialization(
    result: Pick<
      MaterializeBundleResult,
      "createdMcpFiles" | "createdMcpDirectories"
    >,
  ): void;
  hasCreatedFile(relativePath: string): boolean;
  listCreatedDirectories(): string[];
  removeCreatedFile(relativePath: string): void;
  removeCreatedDirectory(relativePath: string): void;
  toRegistryFields(): McpOwnershipRegistryFields;
}

/** Creates MCP ownership bookkeeping from the persisted materialized state. */
export function createMcpMaterializationOwnership(
  fields?: McpOwnershipRegistryFields,
): McpMaterializationOwnership {
  const createdFiles = new Set(fields?.created_mcp_files ?? []);
  const createdDirectories = new Set(fields?.created_mcp_directories ?? []);

  return {
    recordMaterialization(result) {
      for (const filePath of result.createdMcpFiles) {
        createdFiles.add(filePath);
      }
      for (const directory of result.createdMcpDirectories) {
        createdDirectories.add(directory);
      }
    },
    hasCreatedFile(relativePath) {
      return createdFiles.has(relativePath);
    },
    listCreatedDirectories() {
      return Array.from(createdDirectories);
    },
    removeCreatedFile(relativePath) {
      createdFiles.delete(relativePath);
    },
    removeCreatedDirectory(relativePath) {
      createdDirectories.delete(relativePath);
    },
    toRegistryFields() {
      return {
        ...(createdFiles.size > 0
          ? { created_mcp_files: Array.from(createdFiles).sort() }
          : {}),
        ...(createdDirectories.size > 0
          ? { created_mcp_directories: Array.from(createdDirectories).sort() }
          : {}),
      };
    },
  };
}
