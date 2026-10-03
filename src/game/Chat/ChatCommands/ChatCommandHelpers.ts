/** `ChatCommandHelpers.h`: tokenizing and the result type every argument parser returns. */
import { StringFormat, type FormatArg } from "../../../common/Utilities/StringFormat.ts";
import type { ChatHandler } from "../Chat.ts";

export const COMMAND_DELIMITER = " ";

/** @ac game/Chat/ChatCommands/ChatCommandHelpers.h Acore::Impl::ChatCommands::tokenize */
export function tokenize(args: string): { token: string; tail: string } {
  const delimPos = args.indexOf(COMMAND_DELIMITER);
  if (delimPos < 0) return { token: args, tail: "" };
  const token = args.slice(0, delimPos);
  let tailPos = delimPos;
  while (tailPos < args.length && args[tailPos] === COMMAND_DELIMITER) tailPos++;
  return { token, tail: tailPos < args.length ? args.slice(tailPos) : "" };
}

/**
 * `ChatCommandResult`: success carries the parsed value and the rest of the argument string; failure carries an
 * error message, or none (the command then prints its usage).
 */
export type ChatCommandResult<T = void> = { ok: true; value: T; tail: string } | { ok: false; error: string | null };

export function success<T>(value: T, tail: string): ChatCommandResult<T> {
  return { ok: true, value, tail };
}

export function failure<T = never>(error: string | null = null): ChatCommandResult<T> {
  return { ok: false, error };
}

/** @ac game/Chat/ChatCommands/ChatCommandHelpers.cpp Acore::Impl::ChatCommands::SendErrorMessageToHandler */
export function SendErrorMessageToHandler(handler: ChatHandler, str: string): void {
  handler.sendSysMessage(str);
  handler.setSentErrorMessage(true);
}

/** @ac game/Chat/ChatCommands/ChatCommandHelpers.cpp Acore::Impl::ChatCommands::GetAcoreString */
export function GetAcoreString(handler: ChatHandler, which: number): string {
  return handler.getAcoreString(which);
}

/** @ac game/Chat/ChatCommands/ChatCommandHelpers.h Acore::Impl::ChatCommands::FormatAcoreString */
export function FormatAcoreString(handler: ChatHandler, which: number, ...args: FormatArg[]): string {
  return StringFormat(GetAcoreString(handler, which), ...args);
}
