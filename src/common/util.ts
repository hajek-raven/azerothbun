/**
 * Game-facing helpers from `Util.h` / `Util.cpp`.
 * Console code-page conversion, PID files, and RTTI names stay on the host and are not part of this port.
 */

export const ComparisionType = {
  Eq: 0,
  High: 1,
  Low: 2,
  HighEq: 3,
  LowEq: 4,
} as const;

export type ComparisionType = (typeof ComparisionType)[keyof typeof ComparisionType];

const INVISIBLE = new Set([" ", "\t", "\u0007", "\n"]);

export function stripLineInvisibleChars(value: string): string {
  let out = "";
  let space = false;
  for (const char of value) {
    if (INVISIBLE.has(char)) {
      if (!space) {
        out += " ";
        space = true;
      }
      continue;
    }
    out += char;
    space = false;
  }
  if (out.includes("|TInterface")) {
    return "";
  }
  return out;
}

/** `Acore::Tokenize`. `keepEmpty` false drops separators that sit next to each other. */
export function tokenize(value: string, sep: string, keepEmpty: boolean): string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let end = value.indexOf(sep); end !== -1; end = value.indexOf(sep, start)) {
    if (keepEmpty || start < end) {
      tokens.push(value.slice(start, end));
    }
    start = end + sep.length;
  }
  if (keepEmpty || start < value.length) {
    tokens.push(value.slice(start));
  }
  return tokens;
}

function stringToUint32(value: string): number | null {
  if (value.length === 0 || !/^[0-9]+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffffffff) {
    return null;
  }
  return parsed;
}

/** Copper total from `1g 2s 3c`. `null` when a unit repeats or a token is not a number. */
export function moneyStringToMoney(moneyString: string): number | null {
  let money = 0;
  let hadG = false;
  let hadS = false;
  let hadC = false;
  for (const token of tokenize(moneyString, " ", false)) {
    const mark = token[token.length - 1];
    let unit = 0;
    switch (mark) {
      case "g":
        if (hadG) {
          return null;
        }
        hadG = true;
        unit = 100 * 100;
        break;
      case "s":
        if (hadS) {
          return null;
        }
        hadS = true;
        unit = 100;
        break;
      case "c":
        if (hadC) {
          return null;
        }
        hadC = true;
        unit = 1;
        break;
      default:
        return null;
    }
    const amount = stringToUint32(token.slice(0, -1));
    if (amount === null) {
      return null;
    }
    money += unit * amount;
  }
  return money;
}

/** Float result of `CalculatePct`. Integer callers truncate toward zero, matching the cast back to `T`. */
export function calculatePct(base: number, pct: number): number {
  return Math.fround((Math.fround(base) * Math.fround(pct)) / 100);
}

export function addPct(base: number, pct: number): number {
  return base + calculatePct(base, pct);
}

export function applyPct(base: number, pct: number): number {
  return calculatePct(base, pct);
}

export function roundToInterval(num: number, floor: number, ceil: number): number {
  return Math.min(Math.max(num, floor), ceil);
}

export function utf8Length(value: string): number {
  return Array.from(value).length;
}

export function utf8Truncate(value: string, len: number): string {
  const points = Array.from(value);
  if (points.length <= len) {
    return value;
  }
  return points.slice(0, len).join("");
}

export function isBasicLatinCharacter(wchar: number): boolean {
  return (wchar >= 0x61 && wchar <= 0x7a) || (wchar >= 0x41 && wchar <= 0x5a);
}

export function isExtendedLatinCharacter(wchar: number): boolean {
  if (isBasicLatinCharacter(wchar)) {
    return true;
  }
  if (wchar >= 0x00c0 && wchar <= 0x00d6) {
    return true;
  }
  if (wchar >= 0x00d8 && wchar <= 0x00de) {
    return true;
  }
  if (wchar === 0x00df) {
    return true;
  }
  if (wchar >= 0x00e0 && wchar <= 0x00f6) {
    return true;
  }
  if (wchar >= 0x00f8 && wchar <= 0x00fe) {
    return true;
  }
  if (wchar >= 0x0100 && wchar <= 0x012f) {
    return true;
  }
  return wchar === 0x1e9e;
}

export function isCyrillicCharacter(wchar: number): boolean {
  if (wchar >= 0x0410 && wchar <= 0x044f) {
    return true;
  }
  return wchar === 0x0401 || wchar === 0x0451;
}

export function isEastAsianCharacter(wchar: number): boolean {
  if (wchar >= 0x1100 && wchar <= 0x11f9) {
    return true;
  }
  if (wchar >= 0x3041 && wchar <= 0x30ff) {
    return true;
  }
  if (wchar >= 0x3131 && wchar <= 0x318e) {
    return true;
  }
  if (wchar >= 0x31f0 && wchar <= 0x31ff) {
    return true;
  }
  if (wchar >= 0x3400 && wchar <= 0x4db5) {
    return true;
  }
  if (wchar >= 0x4e00 && wchar <= 0x9fc3) {
    return true;
  }
  if (wchar >= 0xac00 && wchar <= 0xd7a3) {
    return true;
  }
  return wchar >= 0xff01 && wchar <= 0xffee;
}

export function isNumericCode(wchar: number): boolean {
  return wchar >= 0x30 && wchar <= 0x39;
}

export function isNumericChar(char: string): boolean {
  return char >= "0" && char <= "9";
}

export function isEvenNumber(n: number): boolean {
  return n % 2 === 0;
}

export function isNumericString(value: string): boolean {
  for (const char of value) {
    if (!isNumericChar(char)) {
      return false;
    }
  }
  return true;
}

export function isNumericOrSpace(wchar: number): boolean {
  return isNumericCode(wchar) || wchar === 0x20;
}

function everyCode(value: string, accept: (code: number) => boolean, numericOrSpace: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (!accept(code) && (!numericOrSpace || !isNumericOrSpace(code))) {
      return false;
    }
  }
  return true;
}

export function isBasicLatinString(value: string, numericOrSpace: boolean): boolean {
  return everyCode(value, isBasicLatinCharacter, numericOrSpace);
}

export function isExtendedLatinString(value: string, numericOrSpace: boolean): boolean {
  return everyCode(value, isExtendedLatinCharacter, numericOrSpace);
}

export function isCyrillicString(value: string, numericOrSpace: boolean): boolean {
  return everyCode(value, isCyrillicCharacter, numericOrSpace);
}

export function isEastAsianString(value: string, numericOrSpace: boolean): boolean {
  return everyCode(value, isEastAsianCharacter, numericOrSpace);
}

export function charToUpper(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCharCode(code - 0x20);
  }
  return char;
}

export function charToLower(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCharCode(code + 0x20);
  }
  return char;
}

export function wcharToUpper(wchar: number): number {
  if (wchar >= 0x61 && wchar <= 0x7a) {
    return wchar - 0x0020;
  }
  if (wchar === 0x00df) {
    return 0x1e9e;
  }
  if (wchar >= 0x00e0 && wchar <= 0x00f6) {
    return wchar - 0x0020;
  }
  if (wchar >= 0x00f8 && wchar <= 0x00fe) {
    return wchar - 0x0020;
  }
  if (wchar >= 0x0101 && wchar <= 0x012f && wchar % 2 === 1) {
    return wchar - 0x0001;
  }
  if (wchar >= 0x0430 && wchar <= 0x044f) {
    return wchar - 0x0020;
  }
  if (wchar === 0x0451) {
    return 0x0401;
  }
  return wchar;
}

export function wcharToUpperOnlyLatin(wchar: number): number {
  return isBasicLatinCharacter(wchar) ? wcharToUpper(wchar) : wchar;
}

export function wcharToLower(wchar: number): number {
  if (wchar >= 0x41 && wchar <= 0x5a) {
    return wchar + 0x0020;
  }
  if (wchar >= 0x00c0 && wchar <= 0x00d6) {
    return wchar + 0x0020;
  }
  if (wchar >= 0x00d8 && wchar <= 0x00de) {
    return wchar + 0x0020;
  }
  if (wchar >= 0x0100 && wchar <= 0x012e && wchar % 2 === 0) {
    return wchar + 0x0001;
  }
  if (wchar === 0x1e9e) {
    return 0x00df;
  }
  if (wchar === 0x0401) {
    return 0x0451;
  }
  if (wchar >= 0x0410 && wchar <= 0x042f) {
    return wchar + 0x0020;
  }
  return wchar;
}

export function wstrToUpper(value: string): string {
  return Array.from(value, (char) => String.fromCodePoint(wcharToUpper(char.codePointAt(0)!))).join("");
}

export function wstrToLower(value: string): string {
  return Array.from(value, (char) => String.fromCodePoint(wcharToLower(char.codePointAt(0)!))).join("");
}

const NAME_ENDINGS = [
  ["\u0430", "\u043e", "\u044f", "\u0435", "\u044c", "\u0439"],
  ["\u0430", "\u044f", "\u044b", "\u0438"],
  ["\u0435", "\u0443", "\u044e", "\u0438"],
  ["\u0443", "\u044e", "\u043e", "\u0435", "\u044c", "\u044f", "\u0430"],
  ["\u043e\u0439", "\u0451\u0439", "\u0435\u0439", "\u043e\u043c", "\u0451\u043c", "\u0435\u043c", "\u044e"],
  ["\u0435", "\u0438"],
] as const;

/** Cyrillic declension stem from `GetMainPartOfName`. Other scripts are returned unchanged. */
export function getMainPartOfName(wname: string, declension: number): string {
  const codes = Array.from(wname);
  if (codes.length === 0 || !isCyrillicCharacter(codes[0]!.codePointAt(0)!) || declension > 5) {
    return wname;
  }
  const endings = NAME_ENDINGS[declension];
  if (!endings) {
    return wname;
  }
  for (const ending of endings) {
    if (ending.length > codes.length) {
      continue;
    }
    if (codes.slice(codes.length - ending.length).join("") === ending) {
      return codes.slice(0, codes.length - ending.length).join("");
    }
  }
  return wname;
}

export function utf8ToUpperOnlyLatin(value: string): string {
  return Array.from(value, (char) => String.fromCodePoint(wcharToUpperOnlyLatin(char.codePointAt(0)!))).join("");
}

/** Case-sensitive search after `wstrToLower` on the haystack. The needle is compared as given. */
export function utf8FitTo(value: string, search: string): boolean {
  return wstrToLower(value).includes(search);
}

function isIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
}

function isIPv6(address: string): boolean {
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) {
    if (zone === 0 || zone !== text.lastIndexOf("%") || zone === text.length - 1) {
      return false;
    }
    text = text.slice(0, zone);
  }
  if (text === "::") {
    return true;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return false;
  }
  const parseSide = (side: string): string[] | null => {
    if (side === "") {
      return [];
    }
    const parts = side.split(":");
    if (parts.some((part) => part.length === 0)) {
      return null;
    }
    return parts;
  };
  const left = parseSide(halves[0]!);
  if (!left) {
    return false;
  }
  const right = halves.length === 2 ? parseSide(halves[1]!) : null;
  if (halves.length === 2 && !right) {
    return false;
  }
  const groups = right ? [...left, ...right] : left;
  let extra = 0;
  const last = groups[groups.length - 1];
  if (last?.includes(".")) {
    if (!isIPv4(last)) {
      return false;
    }
    groups.pop();
    extra = 2;
  }
  const count = groups.length + extra;
  if (halves.length === 2) {
    if (count >= 8) {
      return false;
    }
  } else if (count !== 8) {
    return false;
  }
  return groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group));
}

/** `make_address`: IPv4, IPv6, and an optional zone id. */
export function isIPAddress(ipaddress: string | null | undefined): boolean {
  if (!ipaddress) {
    return false;
  }
  return isIPv4(ipaddress) || isIPv6(ipaddress);
}

export function byteArrayToHexStr(bytes: ArrayLike<number>, reverse = false): string {
  let text = "";
  if (reverse) {
    for (let i = bytes.length - 1; i >= 0; i--) {
      text += bytes[i]!.toString(16).padStart(2, "0").toUpperCase();
    }
    return text;
  }
  for (let i = 0; i < bytes.length; i++) {
    text += bytes[i]!.toString(16).padStart(2, "0").toUpperCase();
  }
  return text;
}

export function hexStrToByteArray(value: string, outlen: number, reverse = false): Uint8Array {
  if (value.length !== outlen * 2) {
    throw new Error("hex string length does not match the output size");
  }
  const out = new Uint8Array(outlen);
  if (reverse) {
    let j = 0;
    for (let i = value.length - 2; i >= 0; i -= 2) {
      out[j] = Number.parseInt(value.slice(i, i + 2), 16);
      j += 1;
    }
    return out;
  }
  for (let i = 0; i < outlen; i++) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function stringEqualI(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (charToLower(a[i]!) !== charToLower(b[i]!)) {
      return false;
    }
  }
  return true;
}

export function stringStartsWith(haystack: string, needle: string): boolean {
  return haystack.slice(0, needle.length) === needle;
}

export function stringStartsWithI(haystack: string, needle: string): boolean {
  return stringEqualI(haystack.slice(0, needle.length), needle);
}

export function stringContainsStringI(haystack: string, needle: string): boolean {
  const foldedHay = Array.from(haystack, charToLower).join("");
  const foldedNeedle = Array.from(needle, charToLower).join("");
  return foldedHay.includes(foldedNeedle);
}

export function stringCompareLessI(a: string, b: string): boolean {
  const left = Array.from(a, charToLower).join("");
  const right = Array.from(b, charToLower).join("");
  if (left < right) {
    return true;
  }
  return false;
}

export function compareValues(type: ComparisionType, val1: number, val2: number): boolean {
  switch (type) {
    case ComparisionType.Eq:
      return val1 === val2;
    case ComparisionType.High:
      return val1 > val2;
    case ComparisionType.Low:
      return val1 < val2;
    case ComparisionType.HighEq:
      return val1 >= val2;
    case ComparisionType.LowEq:
      return val1 <= val2;
    default: {
      const unreachable: never = type;
      throw new Error(`invalid comparison ${String(unreachable)}`);
    }
  }
}

/** 96-bit flag from `flag96`. */
export class Flag96 {
  constructor(
    public part0 = 0,
    public part1 = 0,
    public part2 = 0,
  ) {}

  isEqual(p1 = 0, p2 = 0, p3 = 0): boolean {
    return this.part0 === p1 && this.part1 === p2 && this.part2 === p3;
  }

  hasFlag(p1 = 0, p2 = 0, p3 = 0): boolean {
    return (this.part0 & p1) !== 0 || (this.part1 & p2) !== 0 || (this.part2 & p3) !== 0;
  }

  set(p1 = 0, p2 = 0, p3 = 0): void {
    this.part0 = p1;
    this.part1 = p2;
    this.part2 = p3;
  }

  lessThan(right: Flag96): boolean {
    const parts = [this.part0, this.part1, this.part2];
    const other = [right.part0, right.part1, right.part2];
    for (let i = 3; i > 0; i--) {
      if (parts[i - 1]! < other[i - 1]!) {
        return true;
      }
      if (parts[i - 1]! > other[i - 1]!) {
        return false;
      }
    }
    return false;
  }

  equals(right: Flag96): boolean {
    return this.part0 === right.part0 && this.part1 === right.part1 && this.part2 === right.part2;
  }

  and(right: Flag96): Flag96 {
    return new Flag96(this.part0 & right.part0, this.part1 & right.part1, this.part2 & right.part2);
  }

  or(right: Flag96): Flag96 {
    return new Flag96(this.part0 | right.part0, this.part1 | right.part1, this.part2 | right.part2);
  }

  xor(right: Flag96): Flag96 {
    return new Flag96(this.part0 ^ right.part0, this.part1 ^ right.part1, this.part2 ^ right.part2);
  }

  not(): Flag96 {
    return new Flag96(~this.part0 >>> 0, ~this.part1 >>> 0, ~this.part2 >>> 0);
  }

  isSet(): boolean {
    return this.part0 !== 0 || this.part1 !== 0 || this.part2 !== 0;
  }
}
