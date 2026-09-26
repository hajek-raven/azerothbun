import { expect, test } from "bun:test";
import {
  byteArrayToHexStr,
  calculatePct,
  compareValues,
  ComparisionType,
  Flag96,
  getMainPartOfName,
  hexStrToByteArray,
  isIPAddress,
  moneyStringToMoney,
  roundToInterval,
  stringContainsStringI,
  stringEqualI,
  stripLineInvisibleChars,
  utf8ToUpperOnlyLatin,
  utf8Truncate,
  wcharToUpper,
} from "./util.ts";

test("money, invisible characters, and percent helpers", () => {
  expect(moneyStringToMoney("1g 2s 3c")).toBe(10203);
  expect(moneyStringToMoney("1g 1g")).toBeNull();
  expect(moneyStringToMoney("")).toBe(0);
  expect(stripLineInvisibleChars("a  b\nb")).toBe("a b b");
  expect(stripLineInvisibleChars("x |TInterface\\Icons\\x")).toBe("");
  expect(calculatePct(200, 10)).toBe(20);
  expect(roundToInterval(12, 0, 10)).toBe(10);
});

test("names, case, hex, and addresses", () => {
  expect(getMainPartOfName("\u041c\u0430\u0448\u0430", 0)).toBe("\u041c\u0430\u0448");
  expect(getMainPartOfName("Thrall", 0)).toBe("Thrall");
  expect(wcharToUpper(0x00df)).toBe(0x1e9e);
  expect(utf8ToUpperOnlyLatin("ab\u044f")).toBe("AB\u044f");
  expect(utf8Truncate("abcdef", 3)).toBe("abc");
  expect(byteArrayToHexStr([0x0a, 0xff])).toBe("0AFF");
  expect(Array.from(hexStrToByteArray("0AFF", 2, true))).toEqual([0xff, 0x0a]);
  expect(stringEqualI("AbC", "abc")).toBe(true);
  expect(stringContainsStringI("Hello", "ell")).toBe(true);
  expect(isIPAddress("127.0.0.1")).toBe(true);
  expect(isIPAddress("::1")).toBe(true);
  expect(isIPAddress("127.0.0.256")).toBe(false);
  expect(isIPAddress("")).toBe(false);
});

test("flag96 and compareValues", () => {
  const flag = new Flag96(0b0011, 0, 0);
  expect(flag.hasFlag(0b0010)).toBe(true);
  expect(flag.and(new Flag96(0b0001)).equals(new Flag96(0b0001))).toBe(true);
  expect(flag.lessThan(new Flag96(0b0100))).toBe(true);
  expect(compareValues(ComparisionType.HighEq, 3, 3)).toBe(true);
  expect(compareValues(ComparisionType.Low, 1, 2)).toBe(true);
});
