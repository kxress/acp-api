import process from "node:process";
export const RELEASE_TARGETS = [
  "windows-x86_64",
  "linux-x86_64",
  "macos-arm64",
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(value);
}

export function isWindowsTarget(target: string): target is "windows-x86_64" {
  return target === "windows-x86_64";
}

export function targetId(
  os: string = process.platform,
  arch: string = process.arch,
): ReleaseTarget {
  const normalizedOs = os === "win32" ? "windows" : os;
  const normalizedArch =
    arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  if (normalizedOs === "windows" && normalizedArch === "x86_64")
    return "windows-x86_64";
  if (normalizedOs === "linux" && normalizedArch === "x86_64")
    return "linux-x86_64";
  if (normalizedOs === "darwin" && normalizedArch === "aarch64")
    return "macos-arm64";
  throw new Error(
    `Unsupported native release platform '${normalizedOs}-${normalizedArch}'; supported targets are ${RELEASE_TARGETS.join(
      ", ",
    )}`,
  );
}
