/**
 * `ChatCommand.h` / `ChatCommand.cpp`: the command tree built from every `CommandScript` table plus the `command`
 * world table (security level and help text), and the lookup that runs a typed chat line.
 */
import { command as commandTable } from "../../../database/schema/world.ts";
import type { WorldTables } from "../../../database/world-tables.ts";
import { log, logError, logWarn } from "../../../log.ts";
import { stringEqualI, stringStartsWithI } from "../../../common/util.ts";
import {
  LANG_AVAILABLE_CMDS,
  LANG_CMD_AMBIGUOUS,
  LANG_CMD_HELP_GENERIC,
  LANG_CMD_INVALID,
  LANG_CMD_NO_HELP_AVAILABLE,
  LANG_CMDPARSER_EITHER,
  LANG_CMDPARSER_OR,
  LANG_SUBCMD_AMBIGUOUS,
  LANG_SUBCMD_INVALID,
  LANG_SUBCMDS_LIST,
  LANG_SUBCMDS_LIST_ENTRY,
  LANG_SUBCMDS_LIST_ENTRY_ELLIPSIS,
} from "../../Miscellaneous/Language.ts";
import { RBAC_PERM_COMMAND_RBAC } from "../../Accounts/RBACDefines.ts";
import type { ChatHandler } from "../Chat.ts";
import { COMMAND_DELIMITER, GetAcoreString, SendErrorMessageToHandler, success, tokenize, type ChatCommandResult } from "./ChatCommandHelpers.ts";
import type { AnyArg, Arg, ArgValues, OptionalArg } from "./ChatCommandArgs.ts";

/** `Acore::ChatCommands::Console` */
export const Console = { No: false, Yes: true } as const;
export type Console = (typeof Console)[keyof typeof Console];

export type CommandHandler = (handler: ChatHandler, ...args: never[]) => boolean | Promise<boolean>;

/** `CommandInvoker`: the handler and the parsers for its parameters. */
type CommandInvoker = { handler: (handler: ChatHandler, ...args: unknown[]) => boolean | Promise<boolean>; args: readonly AnyArg[] };

/** @ac game/Chat/ChatCommands/ChatCommand.h Acore::ChatCommands::ChatCommandBuilder */
export type ChatCommandBuilder =
  | { name: string; invoker: CommandInvoker; help: number; securityLevel: number; allowConsole: Console }
  | { name: string; subCommands: ChatCommandTable };

export type ChatCommandTable = readonly ChatCommandBuilder[];

/**
 * `{ "name", Handler, perm, Console::X }`: the parameter parsers are listed in `args`, in the handler's order after
 * the `ChatHandler`.
 */
export function ChatCommand<const A extends readonly AnyArg[]>(
  name: string,
  args: A,
  handler: (handler: ChatHandler, ...values: ArgValues<A>) => boolean | Promise<boolean>,
  securityLevel: number,
  allowConsole: Console,
  help = 0,
): ChatCommandBuilder {
  return { name, invoker: { handler: handler as CommandInvoker["handler"], args }, help, securityLevel, allowConsole };
}

/** `{ "name", subTable }` */
export function SubCommands(name: string, subCommands: ChatCommandTable): ChatCommandBuilder {
  return { name, subCommands };
}

function isOptional(arg: AnyArg): arg is OptionalArg<unknown> {
  return "optional" in arg;
}

/** @ac game/Chat/ChatCommands/ChatCommand.h Acore::Impl::ChatCommands::ConsumeFromOffset / MultiConsumer */
async function consumeFromOffset(args: readonly AnyArg[], offset: number, values: unknown[], handler: ChatHandler, str: string): Promise<ChatCommandResult<void>> {
  if (offset >= args.length) {
    // the entire string must be consumed
    return str.length === 0 ? success(undefined, str) : { ok: false, error: null };
  }
  const arg = args[offset]!;
  if (!isOptional(arg)) {
    const next = await (arg as Arg<unknown>).tryConsume(handler, str);
    if (!next.ok) return next;
    values[offset] = next.value;
    return consumeFromOffset(args, offset + 1, values, handler, next.tail);
  }
  // try with the argument
  let result1: ChatCommandResult<unknown> = await arg.optional.tryConsume(handler, str);
  if (result1.ok) {
    values[offset] = result1.value;
    result1 = await consumeFromOffset(args, offset + 1, values, handler, result1.tail);
    if (result1.ok) return success(undefined, result1.tail);
  }
  // try again omitting the argument
  values[offset] = null;
  const result2 = await consumeFromOffset(args, offset + 1, values, handler, str);
  if (result2.ok) return result2;
  if (result1.error !== null && result2.error !== null) {
    return {
      ok: false,
      error: `${GetAcoreString(handler, LANG_CMDPARSER_EITHER)} "${result2.error}"\n${GetAcoreString(handler, LANG_CMDPARSER_OR)} "${result1.error}"`,
    };
  }
  if (result1.error !== null) return { ok: false, error: result1.error };
  return result2;
}

/** @ac game/Chat/ChatCommands/ChatCommand.h Acore::Impl::ChatCommands::CommandInvoker::operator() */
async function invoke(invoker: CommandInvoker, handler: ChatHandler, argsStr: string): Promise<boolean> {
  const values: unknown[] = new Array(invoker.args.length);
  const result = await consumeFromOffset(invoker.args, 0, values, handler, argsStr);
  if (result.ok) return invoker.handler(handler, ...values);
  if (result.error !== null) SendErrorMessageToHandler(handler, result.error);
  return false;
}

function compareI(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @ac game/Chat/ChatCommands/ChatCommand.h Acore::Impl::ChatCommands::ChatCommandNode */
export class ChatCommandNode {
  name = "";
  invoker: CommandInvoker | null = null;
  permission = { RequiredLevel: 0, AllowConsole: Console.No as Console };
  /** `std::variant<std::monostate, AcoreStrings, std::string>` */
  help: { kind: "none" } | { kind: "string-id"; id: number } | { kind: "text"; text: string } = { kind: "none" };
  /** Subcommands sorted case-insensitively (`StringCompareLessI_T`). */
  readonly subCommands: [string, ChatCommandNode][] = [];

  subCommand(token: string): ChatCommandNode | null {
    return this.subCommands.find(([key]) => stringEqualI(key, token))?.[1] ?? null;
  }

  getOrCreate(token: string): ChatCommandNode {
    const existing = this.subCommand(token);
    if (existing) return existing;
    const node = new ChatCommandNode();
    this.subCommands.push([token, node]);
    this.subCommands.sort((a, b) => compareI(a[0], b[0]));
    return node;
  }

  /** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::LoadFromBuilder */
  loadFromBuilder(builder: ChatCommandBuilder): void {
    if ("invoker" in builder) {
      if (this.invoker) throw new Error("Duplicate blank sub-command.");
      this.invoker = builder.invoker;
      this.permission = { RequiredLevel: builder.securityLevel, AllowConsole: builder.allowConsole };
      if (builder.help) this.help = { kind: "string-id", id: builder.help };
    } else {
      loadCommandsIntoMap(this, this, builder.subCommands);
    }
  }

  /** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::ResolveNames */
  resolveNames(name: string): void {
    if (this.invoker && this.help.kind === "none") logWarn("sql", `Table \`command\` is missing help text for command '${name}'.`);
    this.name = name;
    for (const [subToken, cmd] of this.subCommands) cmd.resolveNames(`${name}${COMMAND_DELIMITER}${subToken}`);
  }

  /** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::SendCommandHelp */
  sendCommandHelp(handler: ChatHandler): void {
    const hasInvoker = this.isInvokerVisible(handler);
    if (hasInvoker) {
      if (this.help.kind === "string-id") handler.sendSysMessage(this.help.id);
      else if (this.help.kind === "text") handler.sendSysMessage(this.help.text);
      else {
        handler.pSendSysMessage(LANG_CMD_HELP_GENERIC, this.name);
        handler.pSendSysMessage(LANG_CMD_NO_HELP_AVAILABLE, this.name);
      }
    }
    let header = false;
    for (const [, sub] of this.subCommands) {
      const subCommandHasSubCommand = sub.hasVisibleSubCommands(handler);
      if (!subCommandHasSubCommand && !sub.isInvokerVisible(handler)) continue;
      if (!header) {
        if (!hasInvoker) handler.pSendSysMessage(LANG_CMD_HELP_GENERIC, this.name);
        handler.sendSysMessage(LANG_SUBCMDS_LIST);
        header = true;
      }
      handler.pSendSysMessage(subCommandHasSubCommand ? LANG_SUBCMDS_LIST_ENTRY_ELLIPSIS : LANG_SUBCMDS_LIST_ENTRY, sub.name);
    }
  }

  isVisible(who: ChatHandler): boolean {
    return this.isInvokerVisible(who) || this.hasVisibleSubCommands(who);
  }

  /** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::IsInvokerVisible */
  isInvokerVisible(who: ChatHandler): boolean {
    if (!this.invoker) return false;
    if (who.isConsole() && this.permission.AllowConsole === Console.No) return false;
    if (who.isConsole() && this.permission.AllowConsole === Console.Yes) return true;
    // RBAC permissions start at 200, SEC_* levels are 0-4
    if (this.permission.RequiredLevel >= RBAC_PERM_COMMAND_RBAC) return who.hasPermission(this.permission.RequiredLevel);
    return !who.isConsole() && who.isAvailable(this.permission.RequiredLevel);
  }

  /** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::HasVisibleSubCommands */
  hasVisibleSubCommands(who: ChatHandler): boolean {
    return this.subCommands.some(([, sub]) => sub.isVisible(who));
  }
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp FilteredCommandListIterator */
function filtered(map: readonly [string, ChatCommandNode][], handler: ChatHandler, token: string): [string, ChatCommandNode][] {
  return map.filter(([key, node]) => stringStartsWithI(key, token) && node.isVisible(handler));
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::LoadCommandsIntoMap */
function loadCommandsIntoMap(blank: ChatCommandNode | null, map: ChatCommandNode, commands: ChatCommandTable): void {
  for (const builder of commands) {
    if (builder.name.length === 0) {
      if (!blank) throw new Error("Empty name command at top level is not permitted.");
      blank.loadFromBuilder(builder);
      continue;
    }
    const tokens = builder.name.split(COMMAND_DELIMITER).filter((token) => token.length > 0);
    if (tokens.length === 0) throw new Error(`Invalid command name '${builder.name}'.`);
    let sub = map;
    for (let i = 0; i < tokens.length - 1; ++i) sub = sub.getOrCreate(tokens[i]!);
    sub.getOrCreate(tokens[tokens.length - 1]!).loadFromBuilder(builder);
  }
}

/** The command scripts (`sScriptMgr->GetChatCommands()`); `cs_script_loader` fills it. */
const commandScripts: (() => ChatCommandTable)[] = [];

/** `new xxx_commandscript()`: registers a script's table. */
export function registerCommandScript(getCommands: () => ChatCommandTable): void {
  commandScripts.push(getCommands);
}

export function clearCommandScripts(): void {
  commandScripts.length = 0;
}

let COMMAND_MAP: ChatCommandNode | null = null;
let commandRows: WorldTables | null = null;

/** The world rows `LoadCommandMap` reads the `command` table from. */
export function setCommandTableSource(world: WorldTables | null): void {
  commandRows = world;
  COMMAND_MAP = null;
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::LoadCommandMap */
export function LoadCommandMap(): void {
  InvalidateCommandMap();
  const root = new ChatCommandNode();
  for (const getCommands of commandScripts) loadCommandsIntoMap(null, root, getCommands());
  for (const row of commandRows?.all(commandTable) ?? []) {
    const name = row.name;
    const help = row.help ?? "";
    const secLevel = row.security;
    let cmd: ChatCommandNode | null = null;
    let map: ChatCommandNode = root;
    for (const key of name.split(COMMAND_DELIMITER).filter((token) => token.length > 0)) {
      const found = map.subCommand(key);
      if (!found) {
        logError("sql", `Table \`command\` contains data for non-existant command '${name}'. Skipped.`);
        cmd = null;
        break;
      }
      cmd = found;
      map = found;
    }
    if (!cmd) continue;
    if (cmd.invoker && cmd.permission.RequiredLevel !== secLevel) {
      cmd.permission.RequiredLevel = secLevel;
    }
    if (cmd.help.kind === "text") logError("sql", `Table \`command\` contains duplicate data for command '${name}'. Skipped.`);
    if (cmd.help.kind === "none") cmd.help = { kind: "text", text: help };
    else logError("sql", `Table \`command\` contains legacy help text for command '${name}', which uses \`acore_string\`. Skipped.`);
  }
  for (const [name, cmd] of root.subCommands) cmd.resolveNames(name);
  COMMAND_MAP = root;
  log("commands", `Loaded ${root.subCommands.length} top-level chat commands`);
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::InvalidateCommandMap */
export function InvalidateCommandMap(): void {
  COMMAND_MAP = null;
}

function topLevel(): ChatCommandNode {
  if (!COMMAND_MAP) LoadCommandMap();
  return COMMAND_MAP!;
}

function trimDelimiters(cmdStr: string): string {
  let start = 0;
  let end = cmdStr.length;
  while (start < end && cmdStr[start] === COMMAND_DELIMITER) start++;
  while (end > start && cmdStr[end - 1] === COMMAND_DELIMITER) end--;
  return cmdStr.slice(start, end);
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::TryExecuteCommand */
export async function TryExecuteCommand(handler: ChatHandler, input: string): Promise<boolean> {
  let cmd: ChatCommandNode | null = null;
  let map: ChatCommandNode = topLevel();
  const cmdStr = trimDelimiters(input);
  let oldTail = cmdStr;
  while (oldTail.length > 0) {
    const { token, tail: newTail } = tokenize(oldTail);
    const matches = filtered(map.subCommands, handler, token);
    if (matches.length === 0) break;
    const [firstKey, firstNode] = matches[0]!;
    if (!stringEqualI(firstKey, token) && matches.length > 1) {
      if (cmd) handler.pSendSysMessage(LANG_SUBCMD_AMBIGUOUS, cmd.name, COMMAND_DELIMITER, token);
      else handler.pSendSysMessage(LANG_CMD_AMBIGUOUS, token);
      for (const [key, node] of matches) {
        handler.pSendSysMessage(node.hasVisibleSubCommands(handler) ? LANG_SUBCMDS_LIST_ENTRY_ELLIPSIS : LANG_SUBCMDS_LIST_ENTRY, key);
      }
      return true;
    }
    cmd = firstNode;
    map = firstNode;
    oldTail = newTail;
  }
  if (!cmd) return false;
  handler.setSentErrorMessage(false);
  if (cmd.isInvokerVisible(handler) && (await invoke(cmd.invoker!, handler, oldTail))) {
    if (!handler.isConsole()) handler.logCommandUsage(cmdStr);
  } else if (!handler.hasSentErrorMessage()) {
    cmd.sendCommandHelp(handler);
    handler.setSentErrorMessage(true);
  }
  return true;
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::SendCommandHelpFor */
export function SendCommandHelpFor(handler: ChatHandler, cmdStr: string): void {
  let cmd: ChatCommandNode | null = null;
  let map: ChatCommandNode = topLevel();
  for (const token of cmdStr.split(COMMAND_DELIMITER).filter((part) => part.length > 0)) {
    const matches = filtered(map.subCommands, handler, token);
    if (matches.length === 0) {
      if (cmd) {
        cmd.sendCommandHelp(handler);
        handler.pSendSysMessage(LANG_SUBCMD_INVALID, cmd.name, COMMAND_DELIMITER, token);
      } else {
        handler.pSendSysMessage(LANG_CMD_INVALID, token);
      }
      return;
    }
    const [firstKey, firstNode] = matches[0]!;
    if (!stringEqualI(firstKey, token) && matches.length > 1) {
      if (cmd) handler.pSendSysMessage(LANG_SUBCMD_AMBIGUOUS, cmd.name, COMMAND_DELIMITER, token);
      else handler.pSendSysMessage(LANG_CMD_AMBIGUOUS, token);
      for (const [key, node] of matches) {
        handler.pSendSysMessage(node.hasVisibleSubCommands(handler) ? LANG_SUBCMDS_LIST_ENTRY_ELLIPSIS : LANG_SUBCMDS_LIST_ENTRY, key);
      }
      return;
    }
    cmd = firstNode;
    map = firstNode;
  }
  if (cmd) {
    cmd.sendCommandHelp(handler);
  } else if (cmdStr.length === 0) {
    const all = filtered(map.subCommands, handler, "");
    if (all.length === 0) return;
    handler.sendSysMessage(LANG_AVAILABLE_CMDS);
    for (const [, node] of all) {
      handler.pSendSysMessage(node.hasVisibleSubCommands(handler) ? LANG_SUBCMDS_LIST_ENTRY_ELLIPSIS : LANG_SUBCMDS_LIST_ENTRY, node.name);
    }
  } else {
    handler.pSendSysMessage(LANG_CMD_INVALID, cmdStr);
  }
}

/** @ac game/Chat/ChatCommands/ChatCommand.cpp ChatCommandNode::GetAutoCompletionsFor */
export function GetAutoCompletionsFor(handler: ChatHandler, input: string): string[] {
  let path = "";
  let cmd: ChatCommandNode | null = null;
  let map: ChatCommandNode = topLevel();
  const cmdStr = trimDelimiters(input);
  let oldTail = cmdStr;
  while (oldTail.length > 0) {
    const { token, tail: newTail } = tokenize(oldTail);
    const matches = filtered(map.subCommands, handler, token);
    if (matches.length === 0) break;
    const [firstKey, firstNode] = matches[0]!;
    if (!stringEqualI(firstKey, token) && matches.length > 1) {
      return matches.map(([key]) => (path.length === 0 ? `${key}${COMMAND_DELIMITER}${newTail}` : `${path}${COMMAND_DELIMITER}${key}${COMMAND_DELIMITER}${newTail}`));
    }
    path = path.length === 0 ? firstKey : `${path}${COMMAND_DELIMITER}${firstKey}`;
    cmd = firstNode;
    map = firstNode;
    oldTail = newTail;
  }
  if (oldTail.length > 0) return cmd ? [`${path}${COMMAND_DELIMITER}${oldTail}`] : [];
  return filtered(map.subCommands, handler, "").map(([key]) => (path.length === 0 ? key : `${path}${COMMAND_DELIMITER}${key}`));
}

export { success, type ChatCommandResult };
