/** `GitRevision`: the version line `.server info` prints. */
let revision: string | null = null;

function hash(): string {
  if (revision === null) {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    revision = result.success ? result.stdout.toString().trim() : "unknown";
  }
  return revision;
}

export const GitRevision = {
  /** @ac common/GitRevision.cpp GitRevision::GetFullVersion */
  GetFullVersion(): string {
    return `wow-ts rev. ${hash()} (Bun ${Bun.version}, ${process.platform} ${process.arch}) (worldserver-daemon)`;
  },
};
