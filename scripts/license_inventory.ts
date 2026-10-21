export interface RuntimeLicenseEntry {
  name: string;
  version: string;
  license: string;
  source: string;
  licenseFiles: string[];
  attribution: string;
}

export interface RuntimeLicenseInventory {
  projectLicense: "WTFPL";
  dependencies: RuntimeLicenseEntry[];
}

export function parseRuntimeLicenseInventory(
  text: string,
): RuntimeLicenseInventory {
  const value = JSON.parse(text) as RuntimeLicenseInventory;
  if (value.projectLicense !== "WTFPL" || !Array.isArray(value.dependencies))
    throw new Error("Runtime license inventory must preserve project WTFPL");
  for (const dependency of value.dependencies) {
    if (
      !dependency.name ||
      !dependency.version ||
      !dependency.license ||
      !dependency.source ||
      !dependency.attribution ||
      !Array.isArray(dependency.licenseFiles) ||
      dependency.licenseFiles.length === 0
    )
      throw new Error("Runtime license inventory entry is incomplete");
  }
  return value;
}

export function assertRuntimeLicenseInventoryMatchesLock(
  lockText: string,
  packageText: string,
  inventory: RuntimeLicenseInventory,
): void {
  const lock = JSON.parse(lockText) as {
    packages?: Record<string, { version?: string; dev?: boolean }>;
  };
  const locked = Object.entries(lock.packages ?? {})
    .filter(
      ([path, item]) => path.startsWith("node_modules/") && item.dev !== true,
    )
    .map(([path, item]) => {
      const segments = path
        .slice("node_modules/".length)
        .split("/node_modules/");
      return {
        name: segments.at(-1) ?? "",
        version: item.version ?? "",
      };
    });
  const inventoried = inventory.dependencies.map(({ name, version }) => ({
    name,
    version,
  }));
  const key = ({ name, version }: { name: string; version: string }) =>
    `${name}@${version}`;
  const lockedKeys = locked.map(key).sort();
  const inventoryKeys = inventoried.map(key).sort();
  const packageJson = JSON.parse(packageText) as {
    dependencies?: Record<string, string>;
  };
  const configured = new Set(
    Object.entries(packageJson.dependencies ?? {}).map(
      ([name, version]) => `${name}@${version}`,
    ),
  );
  const inventoriedNames = new Set(inventoryKeys);
  const missingConfigured = [...configured].filter(
    (entry) => !inventoriedNames.has(entry),
  );
  if (missingConfigured.length) {
    throw new Error(
      `Runtime imports are missing from license inventory: ${missingConfigured.join(
        ", ",
      )}`,
    );
  }
  if (lockedKeys.join("\n") !== inventoryKeys.join("\n")) {
    throw new Error(
      `Runtime license inventory does not match package-lock.json runtime graph. Locked: ${lockedKeys.join(
        ", ",
      )}; inventoried: ${inventoryKeys.join(", ")}`,
    );
  }
}

export function renderThirdPartyNotices(
  inventory: RuntimeLicenseInventory,
  options: { includeNodeRuntime?: boolean } = {},
): string {
  const lines = [
    "acp-api bundles the runtime dependencies listed below when building the",
    "standalone Node package.",
    "",
    "The original acp-api source is licensed under WTFPL. Third-party licenses remain",
    "separate.",
    "",
  ];
  if (options.includeNodeRuntime) {
    lines.push(
      "Native standalone releases embed Node.js. Its Node.js and bundled third-party license texts are in licenses/Node.js-LICENSE.txt.",
      "",
    );
  }
  for (const dependency of inventory.dependencies) {
    lines.push(
      `${dependency.name} ${dependency.version}`,
      `  License: ${dependency.license}`,
      `  Source: ${dependency.source}`,
      `  ${dependency.attribution}`,
      `  License text: ${dependency.licenseFiles.join(" and ")}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
