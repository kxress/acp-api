import assert from "node:assert/strict";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertCleanTreeStatus, smokeApiCommand } from "../scripts/release.ts";
import { assertTagMatchesVersion } from "../scripts/github_release_assets.ts";
import {
  loadLicenseInventory,
  releaseNames,
  renderThirdPartyNotices,
  validatePackageManifest,
} from "../scripts/release_package.ts";
import { VERSION } from "../src/version.ts";

test("release assets and manifests use the acp-api identity", () => {
  assert.deepEqual(releaseNames("0.1.0", "windows-x86_64"), {
    executable: "acp-api.exe",
    archive: "acp-api-0.1.0-windows-x86_64.zip",
    checksum: "acp-api-0.1.0-windows-x86_64.zip.sha256",
    manifest: "acp-api-0.1.0-windows-x86_64.manifest.json",
  });
  assert.equal(
    releaseNames("0.1.0", "linux-x86_64").archive,
    "acp-api-0.1.0-linux-x86_64.tar.gz",
  );
  assert.equal(releaseNames("0.1.0", "macos-arm64").executable, "acp-api");
  assert.equal(
    validatePackageManifest({
      product: "acp-api",
      version: VERSION,
      target: "linux-x86_64",
      commit: "a".repeat(40),
      executable: "acp-api",
      executableSha256: "b".repeat(64),
    }).product,
    "acp-api",
  );
  assert.throws(() =>
    validatePackageManifest({
      product: "acp-mcp",
      version: VERSION,
      target: "linux-x86_64",
      commit: "a".repeat(40),
      executable: "acp-api",
      executableSha256: "b".repeat(64),
    }),
  );
});

test("release tags and source validation retain the release safeguards", () => {
  assertTagMatchesVersion(`v${VERSION}`, VERSION);
  assert.throws(() => assertTagMatchesVersion("v9.9.9", VERSION));
  assert.doesNotThrow(() => assertCleanTreeStatus(""));
  assert.throws(() => assertCleanTreeStatus(" M src/main.ts"));
});

test("release license inventory matches this project and its notices", async () => {
  const inventory = await loadLicenseInventory();
  const notices = renderThirdPartyNotices(inventory);
  const checkedIn = await readFile(
    new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url),
    "utf8",
  );
  assert.equal(notices, checkedIn.replace(/\r\n/g, "\n"));
  assert.deepEqual(
    inventory.dependencies.map((dependency) => dependency.name),
    ["@agentclientprotocol/sdk", "zod"],
  );
  assert.doesNotMatch(notices, /acp-mcp|MCP-SDK/);
});

test("release smoke serves both API model routes through a fake ACP agent", async () => {
  const sourceEntry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  await smokeApiCommand(process.execPath, [sourceEntry]);
});
