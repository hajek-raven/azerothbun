/**
 * `Acore::StringFormat`: the `{fmt}` replacement fields AzerothCore strings use (`{}`, `{0}`, `{:08x}`, `{:.2f}`).
 * A bad format string gives the same "Wrong format occurred" text the C++ catch block returns.
 */
export type FormatArg = string | number | bigint | boolean | null | undefined;

/** @ac common/Utilities/StringFormat.h Acore::StringFormat */
export function StringFormat(fmt: string, ...args: readonly FormatArg[]): string {
  try {
    return vformat(fmt, args);
  } catch (error) {
    const what = error instanceof Error ? error.message : String(error);
    return `Wrong format occurred (${what}). Fmt string: '${fmt}'`;
  }
}

function vformat(fmt: string, args: readonly FormatArg[]): string {
  let out = "";
  let next = 0;
  let manual: boolean | null = null;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]!;
    if (ch === "}") {
      if (fmt[i + 1] !== "}") throw new Error("unmatched '}' in format string");
      out += "}";
      i++;
      continue;
    }
    if (ch !== "{") {
      out += ch;
      continue;
    }
    if (fmt[i + 1] === "{") {
      out += "{";
      i++;
      continue;
    }
    const close = fmt.indexOf("}", i);
    if (close < 0) throw new Error("invalid format string");
    const field = fmt.slice(i + 1, close);
    i = close;
    const colon = field.indexOf(":");
    const id = colon < 0 ? field : field.slice(0, colon);
    const spec = colon < 0 ? "" : field.slice(colon + 1);
    let index: number;
    if (id.length === 0) {
      if (manual === true) throw new Error("cannot switch from manual to automatic argument indexing");
      manual = false;
      index = next++;
    } else {
      if (!/^\d+$/.test(id)) throw new Error("invalid format string");
      if (manual === false) throw new Error("cannot switch from automatic to manual argument indexing");
      manual = true;
      index = Number(id);
    }
    if (index >= args.length) throw new Error("argument not found");
    out += formatValue(args[index], spec);
  }
  return out;
}

type Spec = { fill: string; align: string; sign: string; alt: boolean; zero: boolean; width: number; precision: number | null; type: string };

function parseSpec(spec: string): Spec {
  const re = /^(?:(.)?([<>^]))?([+\- ])?(#)?(0)?(\d+)?(?:\.(\d+))?([a-zA-Z%]?)$/su;
  const m = re.exec(spec);
  if (!m) throw new Error("invalid format specifier");
  return {
    fill: m[1] ?? " ",
    align: m[2] ?? "",
    sign: m[3] ?? "-",
    alt: m[4] !== undefined,
    zero: m[5] !== undefined,
    width: m[6] ? Number(m[6]) : 0,
    precision: m[7] !== undefined ? Number(m[7]) : null,
    type: m[8] ?? "",
  };
}

function formatValue(value: FormatArg, specText: string): string {
  const spec = parseSpec(specText);
  if (typeof value === "string" || value === null || value === undefined) {
    let text = value ?? "";
    if (spec.precision !== null) text = [...text].slice(0, spec.precision).join("");
    return pad(text, spec, "<", false);
  }
  if (typeof value === "boolean") {
    if (spec.type && spec.type !== "s") return formatNumber(value ? 1 : 0, spec);
    return pad(value ? "true" : "false", spec, "<", false);
  }
  return formatNumber(value, spec);
}

function formatNumber(value: number | bigint, spec: Spec): string {
  const negative = typeof value === "bigint" ? value < 0n : value < 0 || Object.is(value, -0);
  const abs = typeof value === "bigint" ? (negative ? -value : value) : Math.abs(value);
  let body: string;
  let prefix = "";
  switch (spec.type) {
    case "x":
    case "X":
    case "b":
    case "B":
    case "o": {
      const radix = spec.type === "o" ? 8 : spec.type.toLowerCase() === "b" ? 2 : 16;
      const int = typeof abs === "bigint" ? abs : BigInt(Math.trunc(abs));
      body = int.toString(radix);
      if (spec.type === "X") body = body.toUpperCase();
      if (spec.alt) prefix = spec.type === "o" ? "0" : `0${spec.type}`;
      break;
    }
    case "f":
    case "F":
      body = Number(abs).toFixed(spec.precision ?? 6);
      break;
    case "e":
    case "E":
      body = Number(abs).toExponential(spec.precision ?? 6).replace(/e([+-])(\d)$/, "e$10$2");
      if (spec.type === "E") body = body.toUpperCase();
      break;
    case "g":
    case "G":
      body = String(Number(Number(abs).toPrecision(spec.precision ?? 6)));
      break;
    case "c":
      body = String.fromCodePoint(Number(abs));
      break;
    case "":
    case "d":
    case "s":
      if (typeof abs === "bigint") body = abs.toString();
      else if (spec.precision !== null && !Number.isInteger(abs)) body = String(Number(abs.toPrecision(spec.precision)));
      else body = shortest(abs);
      break;
    default:
      throw new Error("invalid type specifier");
  }
  const sign = negative ? "-" : spec.sign === "+" ? "+" : spec.sign === " " ? " " : "";
  if (spec.zero && !spec.align) {
    const width = Math.max(0, spec.width - sign.length - prefix.length);
    return sign + prefix + body.padStart(width, "0");
  }
  return pad(sign + prefix + body, spec, ">", true);
}

/** fmt's shortest round-trip text; a value that is exactly a `float` prints the way fmt prints the `float`. */
function shortest(value: number): string {
  if (Number.isInteger(value) || !Number.isFinite(value)) return Number.isFinite(value) ? String(value) : value > 0 ? "inf" : "nan";
  if (Math.fround(value) === value) {
    for (let digits = 1; digits <= 9; digits++) {
      const text = value.toPrecision(digits);
      if (Math.fround(Number(text)) === value) return String(Number(text));
    }
  }
  return String(value);
}

function pad(text: string, spec: Spec, defaultAlign: string, _numeric: boolean): string {
  const length = [...text].length;
  if (spec.width <= length) return text;
  const fill = spec.fill.repeat(spec.width - length);
  const align = spec.align || defaultAlign;
  if (align === "<") return text + fill;
  if (align === ">") return fill + text;
  const left = Math.floor((spec.width - length) / 2);
  return spec.fill.repeat(left) + text + spec.fill.repeat(spec.width - length - left);
}
