/**
 * `ChatCommandArgs.h` / `ChatCommandArgs.cpp`: how each command parameter type is read off the argument string.
 * A command lists its parameters as `Arg` values; `Optional(arg)` marks one that may be left out.
 */
import type { ItemTemplate } from "../../../data/world.ts";
import type { AchievementEntry } from "../../../gen/DBCStructure.gen.ts";
import type { SpellInfo } from "../../../spells/spell-info.ts";
import type { QuestTemplate } from "../../../world/quests.ts";
import { stringEqualI, stringStartsWithI } from "../../../common/util.ts";
import {
  LANG_CMDPARSER_ACHIEVEMENT_NO_EXIST,
  LANG_CMDPARSER_GAME_TELE_ID_NO_EXIST,
  LANG_CMDPARSER_GAME_TELE_NO_EXIST,
  LANG_CMDPARSER_ITEM_NO_EXIST,
  LANG_CMDPARSER_QUEST_NO_EXIST,
  LANG_CMDPARSER_SPELL_NO_EXIST,
  LANG_CMDPARSER_STRING_VALUE_INVALID,
} from "../../Miscellaneous/Language.ts";
import { sAchievementStore } from "../../DataStores/DBCStores.ts";
import { sObjectMgr, type GameTele } from "../../Globals/ObjectMgr.ts";
import { sSpellMgr } from "../../Spells/SpellMgr.ts";
import { achievement, enchant, glyph, item, quest, spell, talent, tele, trade } from "../Hyperlinks.ts";
import type { ChatHandler } from "../Chat.ts";
import { failure, FormatAcoreString, success, tokenize, type ChatCommandResult } from "./ChatCommandHelpers.ts";
import { Hyperlink, Variant, type VariantValue } from "./ChatCommandTags.ts";

/** `ArgInfo<T>`: reads one parameter. */
export type Arg<T> = {
  /** `GetTypeName<T>()` in parse errors. */
  typeName: string;
  tryConsume(handler: ChatHandler, args: string): ChatCommandResult<T> | Promise<ChatCommandResult<T>>;
};

/** An `Arg` that never waits. */
export type SyncArg<T> = { typeName: string; tryConsume(handler: ChatHandler, args: string): ChatCommandResult<T> };

/** `Optional<T>` in a handler signature: the parser first tries the argument, then tries leaving it out. */
export type OptionalArg<T> = { optional: Arg<T>; typeName: string };

export function Optional<T>(arg: Arg<T>): OptionalArg<T> {
  return { optional: arg, typeName: `Optional<${arg.typeName}>` };
}

export type AnyArg = Arg<unknown> | OptionalArg<unknown>;
export type ArgValueOf<A> = A extends OptionalArg<infer T> ? T | null : A extends Arg<infer T> ? T : never;
export type ArgValues<A extends readonly AnyArg[]> = { [K in keyof A]: ArgValueOf<A[K]> };

// ------------------------------------------------------------------------------------------ numbers

/** `Acore::StringTo<T>(token, 0)`: `0x` hex and `0b` binary prefixes, whole token, in range. */
function integerFromString(str: string, min: bigint, max: bigint): number | bigint | null {
  let base = 10;
  let body = str;
  if (body.slice(0, 2).toLowerCase() === "0x") {
    base = 16;
    body = body.slice(2);
  } else if (body.slice(0, 2).toLowerCase() === "0b") {
    base = 2;
    body = body.slice(2);
  }
  if (body.length === 0) return null;
  const pattern = base === 16 ? /^-?[0-9a-fA-F]+$/ : base === 2 ? /^-?[01]+$/ : /^-?\d+$/;
  if (!pattern.test(body)) return null;
  const negative = body.startsWith("-");
  if (negative && min === 0n) return null;
  const digits = negative ? body.slice(1) : body;
  let value = BigInt(base === 10 ? digits : `0${base === 16 ? "x" : "b"}${digits}`);
  if (negative) value = -value;
  if (value < min || value > max) return null;
  return max > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
}

function integerArg(typeName: string, bits: number, signed: boolean): SyncArg<number> {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  return {
    typeName,
    tryConsume(handler, args) {
      const { token, tail } = tokenize(args);
      if (token.length === 0) return failure();
      const value = integerFromString(token, min, max);
      if (value === null) return failure(FormatAcoreString(handler, LANG_CMDPARSER_STRING_VALUE_INVALID, token, typeName));
      return success(Number(value), tail);
    },
  };
}

export const uint8Arg = integerArg("unsigned char", 8, false);
export const int8Arg = integerArg("signed char", 8, true);
export const uint16Arg = integerArg("unsigned short", 16, false);
export const int16Arg = integerArg("short", 16, true);
export const uint32Arg = integerArg("unsigned int", 32, false);
export const int32Arg = integerArg("int", 32, true);

/** `uint64` parameters (`ObjectGuid::LowType` is 32-bit; this is for raw 64-bit values). */
export const uint64Arg: SyncArg<bigint> = {
  typeName: "unsigned long",
  tryConsume(handler, args) {
    const { token, tail } = tokenize(args);
    if (token.length === 0) return failure();
    const value = integerFromString(token, 0n, (1n << 64n) - 1n);
    if (value === null) return failure(FormatAcoreString(handler, LANG_CMDPARSER_STRING_VALUE_INVALID, token, "unsigned long"));
    return success(BigInt(value), tail);
  },
};

/** `float` (`std::stold` over the whole token, finite). */
export const floatArg: SyncArg<number> = {
  typeName: "float",
  tryConsume(handler, args) {
    const { token, tail } = tokenize(args);
    if (token.length === 0) return failure();
    const value = /^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|0[xX][0-9a-fA-F]+)$/.test(token) ? Number(token) : Number.NaN;
    if (!Number.isFinite(value)) return failure(FormatAcoreString(handler, LANG_CMDPARSER_STRING_VALUE_INVALID, token, "float"));
    return success(Math.fround(value), tail);
  },
};

/** `bool` (`StringTo<bool>`: 1/0, y/n, on/off, yes/no, true/false). */
export const boolArg: SyncArg<boolean> = {
  typeName: "bool",
  tryConsume(handler, args) {
    const { token, tail } = tokenize(args);
    if (token.length === 0) return failure();
    const lower = token.toLowerCase();
    if (token === "1" || lower === "y" || lower === "on" || lower === "yes" || lower === "true") return success(true, tail);
    if (token === "0" || lower === "n" || lower === "off" || lower === "no" || lower === "false") return success(false, tail);
    return failure(FormatAcoreString(handler, LANG_CMDPARSER_STRING_VALUE_INVALID, token, "bool"));
  },
};

// ------------------------------------------------------------------------------------------ strings

/** `std::string_view` / `std::string`: one token. */
export const stringViewArg: SyncArg<string> = {
  typeName: "std::string_view",
  tryConsume(_handler, args) {
    const { token, tail } = tokenize(args);
    if (token.length === 0) return failure();
    return success(token, tail);
  },
};

export const stringArg = stringViewArg;

// ------------------------------------------------------------------------------------------ enums

/**
 * An enum parameter (`ArgInfo<T, enable_if_t<is_enum_v<T>>>`): a unique case-insensitive prefix of a value name, or the
 * numeric value.
 */
export function EnumArg(typeName: string, values: ReadonlyMap<string, number>): SyncArg<number> {
  const names = [...values.keys()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const valid = new Set(values.values());
  const match = (s: string): number | null => {
    const candidates = names.filter((name) => stringStartsWithI(name, s));
    if (candidates.length === 0) return null;
    const exact = candidates.find((name) => stringEqualI(name, s));
    if (exact) return values.get(exact)!;
    return candidates.length === 1 ? values.get(candidates[0]!)! : null;
  };
  return {
    typeName,
    tryConsume(handler, args) {
      const next = stringViewArg.tryConsume(handler, args);
      if (next.ok) {
        const value = match(next.value);
        if (value !== null) return success(value, next.tail);
      }
      const numeric = int32Arg.tryConsume(handler, args);
      if (numeric.ok && valid.has(numeric.value)) return numeric;
      if (next.ok) return failure(FormatAcoreString(handler, LANG_CMDPARSER_STRING_VALUE_INVALID, next.value, typeName));
      return failure();
    },
  };
}

// ------------------------------------------------------------------------------------------ containers

/** @ac game/Chat/ChatCommands/ChatCommandArgs.h ArgInfo<std::vector<T>> (non-empty) */
export function VectorArg<T>(arg: Arg<T>): Arg<T[]> {
  return {
    typeName: `std::vector<${arg.typeName}>`,
    async tryConsume(handler, args) {
      const first = await arg.tryConsume(handler, args);
      if (!first.ok) return first;
      const values = [first.value];
      let tail = first.tail;
      for (;;) {
        const next = await arg.tryConsume(handler, tail);
        if (!next.ok) break;
        values.push(next.value);
        tail = next.tail;
      }
      return success(values, tail);
    },
  };
}

/** @ac game/Chat/ChatCommands/ChatCommandArgs.h ArgInfo<std::array<T, N>> */
export function ArrayArg<T>(arg: Arg<T>, count: number): Arg<T[]> {
  return {
    typeName: `std::array<${arg.typeName}, ${count}>`,
    async tryConsume(handler, args) {
      const values: T[] = [];
      let tail = args;
      for (let i = 0; i < count; i++) {
        const next = await arg.tryConsume(handler, tail);
        if (!next.ok) return next;
        values.push(next.value);
        tail = next.tail;
      }
      return success(values, tail);
    },
  };
}

// ------------------------------------------------------------------------------------------ game objects

/** @ac game/Chat/ChatCommands/ChatCommandArgs.cpp ArgInfo<AchievementEntry const*>::TryConsume */
export const AchievementArg: Arg<AchievementEntry | null> = {
  typeName: "AchievementEntry const*",
  async tryConsume(handler, args) {
    const val = (await Variant(Hyperlink(achievement), uint32Arg).tryConsume(handler, args)) as ChatCommandResult<VariantValue<unknown>>;
    if (!val.ok) return val;
    const data = val.value.index === 0 ? (val.value.value as { Achievement: AchievementEntry }).Achievement : sAchievementStore.lookupEntry(val.value.value as number);
    if (data) return success(data, val.tail);
    if (val.value.index === 1) return failure(FormatAcoreString(handler, LANG_CMDPARSER_ACHIEVEMENT_NO_EXIST, val.value.value as number));
    return failure();
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandArgs.cpp ArgInfo<GameTele const*>::TryConsume */
export const GameTeleArg: Arg<GameTele> = {
  typeName: "GameTele const*",
  async tryConsume(handler, args) {
    const val = (await Variant(Hyperlink(tele), stringViewArg).tryConsume(handler, args)) as ChatCommandResult<VariantValue<number | string>>;
    if (!val.ok) return val;
    const data = val.value.index === 0 ? sObjectMgr.getGameTele(val.value.value as number) : sObjectMgr.getGameTeleByName(val.value.value as string);
    if (data) return success(data, val.tail);
    if (val.value.index === 0) return failure(FormatAcoreString(handler, LANG_CMDPARSER_GAME_TELE_ID_NO_EXIST, val.value.value as number));
    return failure(FormatAcoreString(handler, LANG_CMDPARSER_GAME_TELE_NO_EXIST, val.value.value as string));
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandArgs.cpp ArgInfo<ItemTemplate const*>::TryConsume */
export const ItemTemplateArg: Arg<ItemTemplate> = {
  typeName: "ItemTemplate const*",
  async tryConsume(handler, args) {
    const val = (await Variant(Hyperlink(item), uint32Arg).tryConsume(handler, args)) as ChatCommandResult<VariantValue<unknown>>;
    if (!val.ok) return val;
    const data = val.value.index === 0 ? (val.value.value as { Item: ItemTemplate }).Item : sObjectMgr.getItemTemplate(val.value.value as number);
    if (data) return success(data, val.tail);
    if (val.value.index === 1) return failure(FormatAcoreString(handler, LANG_CMDPARSER_ITEM_NO_EXIST, val.value.value as number));
    return failure();
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandArgs.cpp ArgInfo<SpellInfo const*>::TryConsume */
export const SpellInfoArg: Arg<SpellInfo> = {
  typeName: "SpellInfo const*",
  async tryConsume(handler, args) {
    const val = (await Variant(Hyperlink(enchant), Hyperlink(glyph), Hyperlink(spell), Hyperlink(talent), Hyperlink(trade), uint32Arg).tryConsume(handler, args)) as ChatCommandResult<
      VariantValue<unknown>
    >;
    if (!val.ok) return val;
    let data: SpellInfo | null = null;
    switch (val.value.index) {
      case 0:
      case 2:
        data = val.value.value as SpellInfo;
        break;
      case 1:
        data = sSpellMgr.getSpellInfo((val.value.value as { Glyph: { SpellId: number } }).Glyph.SpellId);
        break;
      case 3: {
        const talentData = val.value.value as { Talent: { RankID: number[] }; Rank: number };
        data = sSpellMgr.getSpellInfo(talentData.Talent.RankID[talentData.Rank - 1] ?? 0);
        break;
      }
      case 4:
        data = (val.value.value as { Spell: SpellInfo }).Spell;
        break;
      default:
        data = sSpellMgr.getSpellInfo(val.value.value as number);
    }
    if (data) return success(data, val.tail);
    if (val.value.index === 5) return failure(FormatAcoreString(handler, LANG_CMDPARSER_SPELL_NO_EXIST, val.value.value as number));
    return failure();
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandArgs.cpp ArgInfo<Quest const*>::TryConsume */
export const QuestArg: Arg<QuestTemplate> = {
  typeName: "Quest const*",
  async tryConsume(handler, args) {
    const val = (await Variant(Hyperlink(quest), uint32Arg).tryConsume(handler, args)) as ChatCommandResult<VariantValue<unknown>>;
    if (!val.ok) return val;
    const data = val.value.index === 0 ? (val.value.value as { Quest: QuestTemplate }).Quest : sObjectMgr.getQuestTemplate(val.value.value as number);
    if (data) return success(data, val.tail);
    if (val.value.index === 1) return failure(FormatAcoreString(handler, LANG_CMDPARSER_QUEST_NO_EXIST, val.value.value as number));
    return failure();
  },
};

