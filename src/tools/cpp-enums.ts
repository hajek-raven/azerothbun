/** Reads `enum` bodies out of AzerothCore headers and writes them as `export const NAME = value;` lines. */
export const AZEROTHCORE_SRC = new URL("../../azerothcore/src", import.meta.url).pathname;

/** Header path under `azerothcore/src` and the enum names to take from it. */
export type EnumSource = [file: string, enums: string[]];

export class CppEnums {
  private readonly values = new Map<string, number>();
  private readonly emitted = new Set<string>();

  /** `export const` lines for every listed enum, in header order, each block headed by `// EnumName`. */
  async emit(sources: readonly EnumSource[]): Promise<string[]> {
    const out: string[] = [];
    for (const [file, enums] of sources) {
      const text = await Bun.file(`${AZEROTHCORE_SRC}/${file}`).text();
      for (const name of enums) {
        const re = new RegExp(`enum (?:class )?${name}\\b[^{;]*\\{([\\s\\S]*?)\\n\\};`);
        const match = re.exec(text);
        if (!match) throw new Error(`enum ${name} not found in ${file}`);
        const body = match[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
        out.push(`// ${name}`);
        let prev = -1;
        const joined = body
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, ""))
          .filter((line) => !line.trim().startsWith("#"))
          .join(" ");
        for (const part of joined.split(",")) {
          const item = part.trim();
          if (!item) continue;
          const [lhs, ...rhs] = item.split("=");
          const key = lhs!.trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`bad key ${item} in ${name}`);
          const value = rhs.length ? this.evalExpr(rhs.join("=")) : prev + 1;
          this.values.set(key, value);
          prev = value;
          if (this.emitted.has(key)) continue;
          this.emitted.add(key);
          const literal = value >= 0x100 && Number.isInteger(value) && value > 0 ? `0x${value.toString(16).padStart(8, "0")}` : String(value);
          out.push(`export const ${key} = ${literal};`);
        }
        out.push("");
      }
    }
    return out;
  }

  private evalExpr(expr: string): number {
    let e = expr.replace(/\/\/.*$/, "").trim();
    e = e.replace(/(0x[0-9a-fA-F]+|\d+)(u|U|ul|UL|ULL|ull|LL|ll|f)\b/g, "$1");
    e = e.replace(/uint32\(([^)]*)\)/g, "($1)");
    e = e.replace(/0x[0-9a-fA-F]+|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?/g, (name) => {
      if (/^[0-9]/.test(name)) return name;
      const bare = name.includes("::") ? name.split("::")[1]! : name;
      if (!this.values.has(bare)) throw new Error(`unknown ${name} in ${expr}`);
      return `(${this.values.get(bare)})`;
    });
    return Function(`"use strict"; return (${e});`)() as number;
  }
}
