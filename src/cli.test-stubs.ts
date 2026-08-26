import type { PromptClient } from "./cli";

export function createPromptClientStub(
  overrides: Partial<PromptClient> = {},
): PromptClient {
  return {
    selectBundle: async () => ({ bundle: "react-expert" }),
    selectBundleFromSelections: async (availableBundles) => {
      if (availableBundles.length === 0) {
        throw new Error("selectBundleFromSelections received no bundles");
      }

      return availableBundles[0]!;
    },
    selectBundleItems: async (_availableItems, selectedItems) => selectedItems,
    selectBundleItemChoices: async (_availableItems, selectedItems) =>
      selectedItems,
    selectAgents: async (agents) => agents,
    resolveFileConflict: async () => ({ action: "overwrite" }),
    confirmManagedFileRemoval: async () => true,
    ...overrides,
  };
}
