export type LogScope = "auth" | "world" | "hot" | "server";

export function log(scope: LogScope, message: string): void {
  console.log(formatLog(scope, message));
}

export function logBanner(scope: LogScope, message: string): void {
  const line = formatLog(scope, message);
  const bar = "=".repeat(line.length);
  console.log(`\n${bar}\n${line}\n${bar}\n`);
}

function formatLog(scope: LogScope, message: string): string {
  return `${new Date().toISOString()} ${scope} ${message}`;
}

export function hexOpcode(opcode: number): string {
  return `0x${opcode.toString(16).padStart(3, "0")}`;
}
