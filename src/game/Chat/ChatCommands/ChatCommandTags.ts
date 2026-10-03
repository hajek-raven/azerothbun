/**
 * `ChatCommandTags.h` / `ChatCommandTags.cpp`: container tags (`ExactSequence`, `Tail`, `QuotedString`,
 * `AccountIdentifier`, `PlayerIdentifier`, `Hyperlink`, `Variant`).
 */
import { utf8ToUpperOnlyLatin, stringEqualI, stringStartsWith } from "../../../common/util.ts";
import {
  LANG_CMDPARSER_ACCOUNT_ID_NO_EXIST,
  LANG_CMDPARSER_ACCOUNT_NAME_NO_EXIST,
  LANG_CMDPARSER_CHAR_GUID_NO_EXIST,
  LANG_CMDPARSER_CHAR_NAME_INVALID,
  LANG_CMDPARSER_CHAR_NAME_NO_EXIST,
  LANG_CMDPARSER_EITHER,
  LANG_CMDPARSER_EXACT_SEQ_MISMATCH,
  LANG_CMDPARSER_LINKDATA_INVALID,
  LANG_CMDPARSER_OR,
} from "../../Miscellaneous/Language.ts";
import { getId, getName } from "../../Accounts/AccountMgr.ts";
import { hasLoginDatabase, LoginDatabase } from "../../../database/DatabaseEnv.ts";
import { sCharacterCache } from "../../Cache/CharacterCache.ts";
import { ObjectAccessor } from "../../Globals/ObjectAccessor.ts";
import { normalizePlayerName } from "../../Globals/ObjectMgr.ts";
import type { Player } from "../../Entities/Player/Player.ts";
import { ParseSingleHyperlink, player as playerTag, type LinkTag } from "../Hyperlinks.ts";
import type { ChatHandler } from "../Chat.ts";
import { failure, FormatAcoreString, GetAcoreString, success, tokenize, type ChatCommandResult } from "./ChatCommandHelpers.ts";
import { uint32Arg, stringViewArg, type Arg } from "./ChatCommandArgs.ts";

/** @ac game/Chat/ChatCommands/ChatCommandTags.h Acore::ChatCommands::ExactSequence */
export function ExactSequence(sequence: string): Arg<string> {
  return {
    typeName: `"${sequence}"`,
    tryConsume(handler, args) {
      if (args.length === 0) return failure();
      let start = args.slice(0, sequence.length);
      if (stringEqualI(start, sequence)) {
        const { token, tail } = tokenize(args.slice(sequence.length));
        if (token.length === 0) return success(sequence, tail);
        start = args.slice(0, sequence.length + token.length);
      }
      return failure(FormatAcoreString(handler, LANG_CMDPARSER_EXACT_SEQ_MISMATCH, sequence, start));
    },
  };
}

/** @ac game/Chat/ChatCommands/ChatCommandTags.h Acore::ChatCommands::Tail */
export const Tail: Arg<string> = {
  typeName: "Tail",
  tryConsume: (_handler, args) => success(args, ""),
};

/** @ac game/Chat/ChatCommands/ChatCommandTags.h Acore::ChatCommands::WTail */
export const WTail: Arg<string> = Tail;

/** @ac game/Chat/ChatCommands/ChatCommandTags.cpp Acore::ChatCommands::QuotedString::TryConsume */
export const QuotedString: Arg<string> = {
  typeName: "QuotedString",
  tryConsume(handler, args) {
    if (args.length === 0) return failure();
    if (args[0] !== '"' && args[0] !== "'") return stringViewArg.tryConsume(handler, args) as ChatCommandResult<string>;
    const QUOTE = args[0];
    let value = "";
    for (let i = 1; i < args.length; ++i) {
      if (args[i] === QUOTE) {
        const { token, tail } = tokenize(args.slice(i + 1));
        return token.length === 0 ? success(value, tail) : failure();
      }
      if (args[i] === "\\") {
        ++i;
        if (!(i < args.length)) break;
      }
      value += args[i];
    }
    return failure();
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandTags.h Acore::ChatCommands::AccountIdentifier */
export type AccountIdentifier = { id: number; name: string };

/** @ac game/Chat/ChatCommands/ChatCommandTags.cpp Acore::ChatCommands::AccountIdentifier::TryConsume */
export const AccountIdentifierArg: Arg<AccountIdentifier> = {
  typeName: "AccountIdentifier",
  async tryConsume(handler, args) {
    const next = (await stringViewArg.tryConsume(handler, args)) as ChatCommandResult<string>;
    if (!next.ok) return next;
    const text = next.value;
    const login = hasLoginDatabase() ? LoginDatabase() : null;
    // first try parsing as account name
    let name = utf8ToUpperOnlyLatin(text);
    let id = login ? await getId(login, name) : 0;
    if (id) return success({ id, name }, next.tail);
    // try parsing as account id instead
    if (!/^\d+$/.test(text) || Number(text) > 0xffffffff) return failure(FormatAcoreString(handler, LANG_CMDPARSER_ACCOUNT_NAME_NO_EXIST, name));
    id = Number(text);
    const found = login ? await getName(login, id) : null;
    if (found === null) return failure(FormatAcoreString(handler, LANG_CMDPARSER_ACCOUNT_ID_NO_EXIST, id));
    name = found;
    return success({ id, name }, next.tail);
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandTags.h Acore::ChatCommands::PlayerIdentifier */
export class PlayerIdentifier {
  constructor(
    private readonly name: string,
    private readonly guid: number,
    private readonly player: Player | null,
  ) {}

  static of(player: Player): PlayerIdentifier {
    return new PlayerIdentifier(player.getName(), player.getGUIDLow(), player);
  }

  getName(): string {
    return this.name;
  }

  /** The player low guid (`ObjectGuid::GetCounter`). */
  getGUID(): number {
    return this.guid;
  }

  isConnected(): boolean {
    return this.player !== null;
  }

  getConnectedPlayer(): Player | null {
    return this.player;
  }

  /** @ac game/Chat/ChatCommands/ChatCommandTags.cpp PlayerIdentifier::FromTarget */
  static fromTarget(handler: ChatHandler): PlayerIdentifier | null {
    const target = handler.getPlayer()?.getSelectedPlayer() ?? null;
    return target ? PlayerIdentifier.of(target) : null;
  }

  /** @ac game/Chat/ChatCommands/ChatCommandTags.cpp PlayerIdentifier::FromSelf */
  static fromSelf(handler: ChatHandler): PlayerIdentifier | null {
    const player = handler.getPlayer();
    return player ? PlayerIdentifier.of(player) : null;
  }

  /** @ac game/Chat/ChatCommands/ChatCommandTags.h PlayerIdentifier::FromTargetOrSelf */
  static fromTargetOrSelf(handler: ChatHandler): PlayerIdentifier | null {
    return PlayerIdentifier.fromTarget(handler) ?? PlayerIdentifier.fromSelf(handler);
  }
}

/** @ac game/Chat/ChatCommands/ChatCommandTags.cpp Acore::ChatCommands::PlayerIdentifier::TryConsume */
export const PlayerIdentifierArg: Arg<PlayerIdentifier> = {
  typeName: "PlayerIdentifier",
  async tryConsume(handler, args) {
    const val = (await Variant(Hyperlink(playerTag), uint32Arg, stringViewArg).tryConsume(handler, args)) as ChatCommandResult<VariantValue<string | number>>;
    if (!val.ok) return val;
    if (val.value.index === 1) {
      const guid = val.value.value as number;
      const player = ObjectAccessor.FindPlayerByLowGUID(guid);
      let name: string | null;
      if (player) name = player.getName();
      else name = sCharacterCache.getCharacterNameByGuid(guid);
      if (name === null) return failure(FormatAcoreString(handler, LANG_CMDPARSER_CHAR_GUID_NO_EXIST, `Player Guid: ${guid}`));
      return success(new PlayerIdentifier(name, guid, player), val.tail);
    }
    const raw = val.value.value as string;
    const name = normalizePlayerName(raw);
    if (name === null) return failure(FormatAcoreString(handler, LANG_CMDPARSER_CHAR_NAME_INVALID, raw));
    const player = ObjectAccessor.FindPlayerByName(name);
    let guid: number;
    if (player) guid = player.getGUIDLow();
    else {
      guid = sCharacterCache.getCharacterGuidByName(name);
      if (!guid) return failure(FormatAcoreString(handler, LANG_CMDPARSER_CHAR_NAME_NO_EXIST, name));
    }
    return success(new PlayerIdentifier(name, guid, player), val.tail);
  },
};

/** @ac game/Chat/ChatCommands/ChatCommandTags.h Acore::ChatCommands::Hyperlink::TryConsume */
export function Hyperlink<T>(linktag: LinkTag<T>): Arg<T> {
  return {
    typeName: `Hyperlink<${linktag.tag}>`,
    tryConsume(handler, args) {
      const info = ParseSingleHyperlink(args);
      // invalid hyperlinks cannot be consumed
      if (!info) return failure();
      // check if we got the right tag
      if (info.tag !== linktag.tag) return failure();
      const value = linktag.storeTo(info.data);
      if (value === null) return failure(GetAcoreString(handler, LANG_CMDPARSER_LINKDATA_INVALID));
      // finally, skip any potential delimiters
      const { token, tail } = tokenize(info.tail);
      return success(value, token.length === 0 ? tail : info.tail);
    },
  };
}

/** A `Variant<Ts...>` value: which alternative matched and its value. */
export type VariantValue<T> = { index: number; value: T };

type ArgValue<A> = A extends Arg<infer T> ? T : never;

/** @ac game/Chat/ChatCommands/ChatCommandArgs.h ArgInfo<Variant<Ts...>>::TryConsume */
export function Variant<A extends Arg<unknown>[]>(...alternatives: A): Arg<VariantValue<ArgValue<A[number]>>> {
  type V = VariantValue<ArgValue<A[number]>>;
  const tryAtIndex = async (index: number, handler: ChatHandler, args: string): Promise<ChatCommandResult<V>> => {
    if (index >= alternatives.length) return failure();
    const thisResult = await alternatives[index]!.tryConsume(handler, args);
    if (thisResult.ok) return success({ index, value: thisResult.value as ArgValue<A[number]> }, thisResult.tail);
    const nestedResult = await tryAtIndex(index + 1, handler, args);
    if (nestedResult.ok || thisResult.error === null) return nestedResult;
    if (nestedResult.error === null) return failure(thisResult.error);
    if (stringStartsWith(nestedResult.error, '"')) {
      return failure(`"${thisResult.error}"\n${GetAcoreString(handler, LANG_CMDPARSER_OR)} ${nestedResult.error}`);
    }
    return failure(`"${thisResult.error}"\n${GetAcoreString(handler, LANG_CMDPARSER_OR)} "${nestedResult.error}"`);
  };
  return {
    typeName: `Variant<${alternatives.map((alternative) => alternative.typeName).join(", ")}>`,
    async tryConsume(handler, args) {
      const result = await tryAtIndex(0, handler, args);
      if (!result.ok && result.error !== null && result.error.includes("\n")) {
        return failure(`${GetAcoreString(handler, LANG_CMDPARSER_EITHER)} ${result.error}`);
      }
      return result;
    },
  };
}

/** `Variant<Hyperlink<tag>, uint32>` read as its number (`operator*` of an all-numeric variant). */
export function HyperlinkOrUint32(linktag: LinkTag<number>): Arg<number> {
  const variant = Variant(Hyperlink(linktag), uint32Arg);
  return {
    typeName: variant.typeName,
    async tryConsume(handler, args) {
      const result = (await variant.tryConsume(handler, args)) as ChatCommandResult<VariantValue<number>>;
      return result.ok ? success(result.value.value, result.tail) : result;
    },
  };
}
