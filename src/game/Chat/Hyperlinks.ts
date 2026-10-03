/**
 * Chat hyperlinks (`Hyperlinks.h`, `Hyperlinks.cpp`, `HyperlinkTags.cpp`): `|c<color>|H<tag>:<data>|h[<text>]|h|r`.
 * `ParseSingleHyperlink` splits one link off a string; each link tag turns the data part into a value; `CheckAllLinks`
 * validates every link in a chat message.
 */
import type { AchievementEntry, GlyphPropertiesEntry, GlyphSlotEntry, ItemRandomPropertiesEntry, ItemRandomSuffixEntry, TalentEntry } from "../../gen/DBCStructure.gen.ts";
import type { ItemTemplate } from "../../data/world.ts";
import type { SpellInfo } from "../../spells/spell-info.ts";
import type { QuestTemplate } from "../../world/quests.ts";
import { SPELL_ATTR0_IS_TRADESKILL, SPELL_EFFECT_TRADE_SKILL } from "../../spells/defines.ts";
import { hasAttribute } from "../../spells/spell-info.ts";
import { CHAT_LINK_COLOR_ACHIEVEMENT, CHAT_LINK_COLOR_ENCHANT, CHAT_LINK_COLOR_GLYPH, CHAT_LINK_COLOR_SPELL, CHAT_LINK_COLOR_TALENT, CHAT_LINK_COLOR_TRADE } from "../../shared/SharedDefines.ts";
import { ServerConfig } from "../world/world-config.ts";
import { sWorld } from "../world/world.ts";
import {
  sAchievementStore,
  sGlyphPropertiesStore,
  sGlyphSlotStore,
  sItemRandomPropertiesStore,
  sItemRandomSuffixStore,
  sSkillLineAbilityStore,
  sSkillLineStore,
  sTalentStore,
} from "../DataStores/DBCStores.ts";
import { sObjectMgr } from "../Globals/ObjectMgr.ts";
import { sSpellMgr } from "../Spells/SpellMgr.ts";

export const MAX_TALENT_RANK = 5;

/** `ItemQualityColors` (`SharedDefines.h`). */
export const ItemQualityColors = [0xff9d9d9d, 0xffffffff, 0xff1eff00, 0xff0070dd, 0xffa335ee, 0xffff8000, 0xffe6cc80, 0xffe6cc80] as const;
/** `QuestDifficultyColors` (`SharedDefines.h`). */
export const QuestDifficultyColors = [0xff40c040, 0xff808080, 0xffffff00, 0xffff8040, 0xffff2020] as const;

export type AchievementLinkData = {
  Achievement: AchievementEntry;
  CharacterId: bigint;
  IsFinished: boolean;
  Year: number;
  Month: number;
  Day: number;
  Criteria: [number, number, number, number];
};
export type GlyphLinkData = { Glyph: GlyphPropertiesEntry; Slot: GlyphSlotEntry };
export type ItemLinkData = {
  Item: ItemTemplate;
  EnchantId: number;
  GemEnchantId: [number, number, number];
  RandomProperty: ItemRandomPropertiesEntry | null;
  RandomSuffix: ItemRandomSuffixEntry | null;
  RandomSuffixBaseAmount: number;
  RenderLevel: number;
  IsBuggedInspectLink: boolean;
};
export type QuestLinkData = { Quest: QuestTemplate; QuestLevel: number };
export type TalentLinkData = { Talent: TalentEntry; Rank: number; Spell: SpellInfo | null };
export type TradeskillLinkData = { Spell: SpellInfo; CurValue: number; MaxValue: number; Owner: bigint; KnownRecipes: string };
/** `|cffffff00|Hfound:<rawguid>:<entry>:|h[name]|h|r` — a world object, shift-clicked back as a command. */
export type FoundLinkData = { RawGuid: bigint; Entry: number };

/** A link tag (`LinkTags::*`): the tag name and how its data becomes a value. */
export type LinkTag<T> = {
  tag: string;
  storeTo(data: string): T | null;
  isTextValid?(value: T, text: string): boolean;
  isColorValid?(value: T, color: number): boolean;
};

/** @ac game/Chat/Hyperlinks.h HyperlinkInfo */
export type HyperlinkInfo = { tail: string; color: number; tag: string; data: string; text: string };

function toHex(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 0x10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 0x1a;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 0x1a;
  return 0;
}

/** @ac game/Chat/Hyperlinks.cpp Acore::Hyperlinks::ParseSingleHyperlink */
export function ParseSingleHyperlink(input: string): HyperlinkInfo | null {
  let str = input;
  let color = 0;
  if (str.slice(0, 2) !== "|c") return null;
  str = str.slice(2);
  if (str.length < 8) return null;
  for (let i = 0; i < 8; i++) {
    const hex = toHex(str[i]!);
    if (!hex) return null;
    color = ((color << 4) | (hex & 0xf)) >>> 0;
  }
  str = str.slice(8);
  if (str.slice(0, 2) !== "|H") return null;
  str = str.slice(2);
  const delimPos = str.indexOf("|");
  if (delimPos < 0) return null;
  let tag = str.slice(0, delimPos);
  str = str.slice(delimPos + 1);
  let data = "";
  const dataStart = tag.indexOf(":");
  if (dataStart >= 0) {
    data = tag.slice(dataStart + 1);
    tag = tag.slice(0, dataStart);
  }
  if (str.slice(0, 1) !== "h") return null;
  str = str.slice(1);
  const end = str.indexOf("|");
  if (end < 0) return null;
  if (str.slice(end, end + 4) !== "|h|r") return null;
  if (str[0] !== "[" || str[end - 1] !== "]") return null;
  const text = str.slice(1, end - 1);
  return { tail: str.slice(end + 4), color, tag, data, text };
}

// ------------------------------------------------------------------------------------------ base tags

/** `Acore::StringTo<T>(data)` for an integer of `bits` width (base 10, whole string, in range). */
export function stringToInteger(data: string, bits: number, signed: boolean): number | null {
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(data)) return null;
  const value = BigInt(data);
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (value < min || value > max) return null;
  return Number(value);
}

function uintTag(tag: string, bits = 32): LinkTag<number> {
  return { tag, storeTo: (data) => stringToInteger(data, bits, false) };
}

/** `make_base_tag` tags. */
export const area = uintTag("area");
export const areatrigger = uintTag("areatrigger");
export const creature = uintTag("creature");
export const creature_entry = uintTag("creature_entry");
export const gameevent = uintTag("gameevent", 16);
export const gameobject = uintTag("gameobject");
export const gameobject_entry = uintTag("gameobject_entry");
export const itemset = uintTag("itemset");
export const player: LinkTag<string> = { tag: "player", storeTo: (data) => data };
export const skill = uintTag("skill");
export const taxinode = uintTag("taxinode");
export const tele = uintTag("tele");
export const title = uintTag("title");

/** @ac game/Chat/HyperlinkTags.cpp HyperlinkDataTokenizer */
class HyperlinkDataTokenizer {
  constructor(private str: string) {}

  private next(): string | null {
    if (this.isEmpty()) return null;
    const off = this.str.indexOf(":");
    if (off >= 0) {
      const token = this.str.slice(0, off);
      this.str = this.str.slice(off + 1);
      return token;
    }
    const token = this.str;
    this.str = "";
    return token;
  }

  uint(bits = 32): number | null {
    const token = this.next();
    return token === null ? null : stringToInteger(token, bits, false);
  }

  int(bits = 32): number | null {
    const token = this.next();
    return token === null ? null : stringToInteger(token, bits, true);
  }

  bool(): boolean | null {
    const token = this.next();
    if (token === null) return null;
    const lower = token.toLowerCase();
    if (token === "1" || ["y", "on", "yes", "true"].includes(lower)) return true;
    if (token === "0" || ["n", "off", "no", "false"].includes(lower)) return false;
    return null;
  }

  guid(): bigint | null {
    const token = this.next();
    if (token === null || !/^[0-9a-fA-F]{1,16}$/.test(token)) return null;
    return BigInt(`0x${token}`);
  }

  string(): string | null {
    return this.next();
  }

  isEmpty(): boolean {
    return this.str.length === 0;
  }
}

// ------------------------------------------------------------------------------------------ complex tags

function spellTextValid(info: SpellInfo, text: string): boolean {
  return text === info.name;
}

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::achievement::StoreTo */
export const achievement: LinkTag<AchievementLinkData> = {
  tag: "achievement",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const achievementId = t.uint();
    if (achievementId === null) return null;
    const entry = sAchievementStore.lookupEntry(achievementId);
    if (!entry) return null;
    const characterId = t.guid();
    const isFinished = t.bool();
    const month = t.uint(8);
    const day = t.uint(8);
    if (characterId === null || isFinished === null || month === null || day === null) return null;
    if (month > 12 || day > 31) return null;
    const year = t.int(8);
    if (year === null) return null;
    if (isFinished && year < 0) return null;
    const criteria = [t.uint(), t.uint(), t.uint(), t.uint()];
    if (criteria.some((value) => value === null) || !t.isEmpty()) return null;
    return {
      Achievement: entry,
      CharacterId: characterId,
      IsFinished: isFinished,
      Year: isFinished ? year : 0,
      Month: month,
      Day: day,
      Criteria: criteria as [number, number, number, number],
    };
  },
  isTextValid: (data, text) => text.length > 0 && data.Achievement.name.includes(text),
  isColorValid: (_data, color) => color === CHAT_LINK_COLOR_ACHIEVEMENT,
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::enchant::StoreTo */
export const enchant: LinkTag<SpellInfo> = {
  tag: "enchant",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const spellId = t.uint();
    if (spellId === null || !t.isEmpty()) return null;
    const info = sSpellMgr.getSpellInfo(spellId);
    return info && hasAttribute(info, 0, SPELL_ATTR0_IS_TRADESKILL) ? info : null;
  },
  isTextValid(info, text) {
    if (spellTextValid(info, text)) return true;
    const abilities = [...sSkillLineAbilityStore].filter((row) => row.Spell === info.id);
    if (abilities.length === 0) return false;
    for (const ability of abilities) {
      const skillLine = sSkillLineStore.lookupEntry(ability.SkillLine);
      if (!skillLine) return false;
      for (const skillName of skillLine.name) {
        // alternate form [Skill Name: Spell Name]
        if (skillName && text === `${skillName}: ${info.name}`) return true;
      }
    }
    return false;
  },
  isColorValid: (_info, color) => color === CHAT_LINK_COLOR_ENCHANT,
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::glyph::StoreTo */
export const glyph: LinkTag<GlyphLinkData> = {
  tag: "glyph",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const slot = t.uint();
    const prop = t.uint();
    if (slot === null || prop === null || !t.isEmpty()) return null;
    const Slot = sGlyphSlotStore.lookupEntry(slot);
    const Glyph = sGlyphPropertiesStore.lookupEntry(prop);
    return Slot && Glyph ? { Glyph, Slot } : null;
  },
  isTextValid(data, text) {
    const info = sSpellMgr.getSpellInfo(data.Glyph.SpellId);
    return info ? spellTextValid(info, text) : false;
  },
  isColorValid: (_data, color) => color === CHAT_LINK_COLOR_GLYPH,
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::item::StoreTo */
export const item: LinkTag<ItemLinkData> = {
  tag: "item",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const itemId = t.uint();
    if (itemId === null) return null;
    const Item = sObjectMgr.getItemTemplate(itemId);
    if (!Item) return null;
    const EnchantId = t.uint();
    const gems = [t.uint(), t.uint(), t.uint()];
    const dummy = t.uint();
    let randomPropertyId = t.int();
    const RandomSuffixBaseAmount = t.uint();
    const RenderLevel = t.uint(8);
    if (EnchantId === null || gems.some((gem) => gem === null) || dummy === null || randomPropertyId === null || RandomSuffixBaseAmount === null || RenderLevel === null) return null;
    if (!t.isEmpty() || dummy) return null;
    let IsBuggedInspectLink = false;
    if (randomPropertyId > 0x7fff && randomPropertyId <= 0xffff) {
      // the id we received is actually static_cast<uint16>(i16RandomPropertyId)
      randomPropertyId = (randomPropertyId << 16) >> 16;
      IsBuggedInspectLink = true;
    }
    let RandomSuffix: ItemRandomSuffixEntry | null = null;
    let RandomProperty: ItemRandomPropertiesEntry | null = null;
    if (randomPropertyId < 0) {
      if (!Item.randomSuffix) return null;
      if (randomPropertyId < -sItemRandomSuffixStore.getNumRows()) return null;
      RandomSuffix = sItemRandomSuffixStore.lookupEntry(-randomPropertyId);
      if (!RandomSuffix) return null;
    } else if (randomPropertyId > 0) {
      if (!Item.randomProperty) return null;
      RandomProperty = sItemRandomPropertiesStore.lookupEntry(randomPropertyId);
      if (!RandomProperty) return null;
    }
    if ((RandomSuffix && !RandomSuffixBaseAmount) || (RandomSuffixBaseAmount && !RandomSuffix)) return null;
    return { Item, EnchantId, GemEnchantId: gems as [number, number, number], RandomProperty, RandomSuffix, RandomSuffixBaseAmount, RenderLevel, IsBuggedInspectLink };
  },
  isTextValid(data, text) {
    const name = data.Item.name;
    if (!name) return false;
    const suffixes = data.IsBuggedInspectLink ? null : (data.RandomProperty?.Name ?? data.RandomSuffix?.Name ?? null);
    if (suffixes) {
      const suffix = suffixes[0] ?? "";
      return suffix.length > 0 && text === `${name} ${suffix}`;
    }
    return text === name;
  },
  isColorValid: (data, color) => color === ItemQualityColors[data.Item.quality],
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::quest::StoreTo */
export const quest: LinkTag<QuestLinkData> = {
  tag: "quest",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const questId = t.uint();
    if (questId === null) return null;
    const Quest = sObjectMgr.getQuestTemplate(questId);
    if (!Quest) return null;
    const QuestLevel = t.int(16);
    if (QuestLevel === null || QuestLevel < -1 || !t.isEmpty()) return null;
    return { Quest, QuestLevel };
  },
  isTextValid: (data, text) => text.length > 0 && text === data.Quest.logTitle,
  isColorValid: (_data, color) => (QuestDifficultyColors as readonly number[]).includes(color),
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::spell::StoreTo */
export const spell: LinkTag<SpellInfo> = {
  tag: "spell",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const spellId = t.uint();
    if (spellId === null || !t.isEmpty()) return null;
    return sSpellMgr.getSpellInfo(spellId);
  },
  isTextValid: spellTextValid,
  isColorValid: (_info, color) => color === CHAT_LINK_COLOR_SPELL,
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::talent::StoreTo */
export const talent: LinkTag<TalentLinkData> = {
  tag: "talent",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const talentId = t.uint();
    const rank = t.int(8);
    if (talentId === null || rank === null || !t.isEmpty()) return null;
    if (rank < -1 || rank >= MAX_TALENT_RANK) return null;
    const Talent = sTalentStore.lookupEntry(talentId);
    if (!Talent) return null;
    const Rank = rank + 1;
    let Spell: SpellInfo | null = null;
    if (Rank > 0) {
      const spellId = Talent.RankID[Rank - 1] ?? 0;
      if (!spellId) return null;
      Spell = sSpellMgr.getSpellInfo(spellId);
      if (!Spell) return null;
    }
    return { Talent, Rank, Spell };
  },
  isTextValid(data, text) {
    const info = data.Spell ?? sSpellMgr.getSpellInfo(data.Talent.RankID[0] ?? 0);
    return info ? spellTextValid(info, text) : false;
  },
  isColorValid: (_data, color) => color === CHAT_LINK_COLOR_TALENT,
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::trade::StoreTo */
export const trade: LinkTag<TradeskillLinkData> = {
  tag: "trade",
  storeTo(text) {
    const t = new HyperlinkDataTokenizer(text);
    const spellId = t.uint();
    if (spellId === null) return null;
    const Spell = sSpellMgr.getSpellInfo(spellId);
    if (!Spell || Spell.effects[0].effect !== SPELL_EFFECT_TRADE_SKILL) return null;
    const CurValue = t.uint(16);
    const MaxValue = t.uint(16);
    const Owner = t.guid();
    const KnownRecipes = t.string();
    if (CurValue === null || MaxValue === null || Owner === null || KnownRecipes === null || !t.isEmpty()) return null;
    return { Spell, CurValue, MaxValue, Owner, KnownRecipes };
  },
  isTextValid: (data, text) => spellTextValid(data.Spell, text),
  isColorValid: (_data, color) => color === CHAT_LINK_COLOR_TRADE,
};

/** @ac game/Chat/HyperlinkTags.cpp Acore::Hyperlinks::LinkTags::found::StoreTo */
export const found: LinkTag<FoundLinkData> = {
  tag: "found",
  storeTo(text) {
    if (!text.endsWith(":")) return null;
    const parts = text.slice(0, -1).split(":");
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]!)) return null;
    const RawGuid = BigInt(parts[0]!);
    const entry = stringToInteger(parts[1]!, 32, false);
    if (RawGuid > 0xffffffffffffffffn || entry === null) return null;
    return { RawGuid, Entry: entry };
  },
  isTextValid: (_data, text) => text.length > 0,
  isColorValid: (_data, color) => color === CHAT_LINK_COLOR_ACHIEVEMENT,
};

const ALL_TAGS: readonly LinkTag<unknown>[] = [
  achievement,
  area,
  areatrigger,
  creature,
  creature_entry,
  enchant,
  found,
  gameevent,
  gameobject,
  gameobject_entry,
  glyph,
  item,
  itemset,
  player,
  quest,
  skill,
  spell,
  talent,
  taxinode,
  tele,
  title,
  trade,
] as readonly LinkTag<unknown>[];

/** @ac game/Chat/Hyperlinks.cpp ValidateAs */
function validateAs(tag: LinkTag<unknown>, info: HyperlinkInfo): boolean {
  const value = tag.storeTo(info.data);
  if (value === null) return false;
  const severity = sWorld().getIntConfig(ServerConfig.CONFIG_CHAT_STRICT_LINK_CHECKING_SEVERITY) | 0;
  if (severity >= 0) {
    if (tag.isColorValid && !tag.isColorValid(value, info.color)) return false;
    if (severity >= 1 && tag.isTextValid && !tag.isTextValid(value, info.text)) return false;
  }
  return true;
}

/** @ac game/Chat/Hyperlinks.cpp ValidateLinkInfo */
function validateLinkInfo(info: HyperlinkInfo): boolean {
  const tag = ALL_TAGS.find((candidate) => candidate.tag === info.tag);
  return tag ? validateAs(tag, info) : false;
}

/** @ac game/Chat/Hyperlinks.cpp Acore::Hyperlinks::CheckAllLinks */
export function CheckAllLinks(input: string): boolean {
  // Step 1: Disallow all control sequences except ||, |H, |h, |c and |r
  let pos = 0;
  while ((pos = input.indexOf("|", pos)) >= 0) {
    ++pos;
    if (pos === input.length) return false;
    const next = input[pos]!;
    if (next === "H" || next === "h" || next === "c" || next === "r" || next === "|") ++pos;
    else return false;
  }
  // Step 2: Parse all link sequences
  let str = input;
  let at: number;
  while ((at = str.indexOf("|")) >= 0) {
    if (str[at + 1] === "|") {
      str = str.slice(at + 2);
      continue;
    }
    const info = ParseSingleHyperlink(str.slice(at));
    if (!info || !validateLinkInfo(info)) return false;
    str = info.tail;
  }
  return true;
}
