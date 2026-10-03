/** `cs_cast.cpp`: `.cast [back|dist|self|target|dest]`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { floatArg, Optional, SpellInfoArg, stringArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import type { CommandUnit } from "../../game/Entities/Player/Player.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sSpellMgr } from "../../game/Spells/SpellMgr.ts";
import { stringStartsWith } from "../../common/util.ts";
import { CAST_RESULT_NAMES, SPELL_CAST_OK, SPELL_FAILED_BAD_TARGETS } from "../../spells/defines.ts";
import { TRIGGERED_FULL_DEBUG_MASK } from "../../spells/enums.ts";
import type { SpellInfo } from "../../spells/spell-info.ts";

const TRIGGERED_NONE = 0;

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const castCommandTable: ChatCommandTable = [
    ChatCommand("back", [SpellInfoArg, Optional(stringArg)], HandleCastBackCommand, R.RBAC_PERM_COMMAND_CAST_BACK, Console.No),
    ChatCommand("dist", [SpellInfoArg, floatArg, Optional(stringArg)], HandleCastDistCommand, R.RBAC_PERM_COMMAND_CAST_DIST, Console.No),
    ChatCommand("self", [SpellInfoArg, Optional(stringArg)], HandleCastSelfCommand, R.RBAC_PERM_COMMAND_CAST_SELF, Console.No),
    ChatCommand("target", [SpellInfoArg, Optional(stringArg)], HandleCastTargetCommad, R.RBAC_PERM_COMMAND_CAST_TARGET, Console.No),
    ChatCommand("dest", [SpellInfoArg, floatArg, floatArg, floatArg, Optional(stringArg)], HandleCastDestCommand, R.RBAC_PERM_COMMAND_CAST_DEST, Console.No),
    ChatCommand("", [SpellInfoArg, Optional(stringArg)], HandleCastCommand, R.RBAC_PERM_COMMAND_CAST, Console.No),
  ];
  return [SubCommands("cast", castCommandTable)];
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::CheckSpellCastResult */
function CheckSpellCastResult(handler: ChatHandler, result: number): boolean {
  if (result !== SPELL_CAST_OK) {
    handler.pSendSysMessage(L.LANG_CMD_CAST_ERROR_CODE, CAST_RESULT_NAMES.get(result) ?? String(result), result);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::CheckSpellExistsAndIsValid */
function CheckSpellExistsAndIsValid(handler: ChatHandler, spell: SpellInfo | null): boolean {
  if (!spell) {
    handler.sendErrorMessage(L.LANG_COMMAND_NOSPELLFOUND);
    return false;
  }
  if (!sSpellMgr.isSpellValid(spell)) {
    handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::GetTriggerFlags */
function GetTriggerFlags(triggeredStr: string | null): number | null {
  if (triggeredStr !== null) {
    // check if "triggered" starts with *triggeredStr (e.g. "trig", "trigger", etc.)
    return stringStartsWith("triggered", triggeredStr) ? TRIGGERED_FULL_DEBUG_MASK : null;
  }
  return TRIGGERED_NONE;
}

/** `Unit::CastSpell(target | x, y, z, spellId, triggerFlags)` with the result, then the command user's queued spell packets. */
function castSpell(handler: ChatHandler, caster: CommandUnit, target: CommandUnit | null, spell: SpellInfo, triggerFlags: number, dest: { x: number; y: number; z: number } | null = null): number {
  const unit = caster.spellUnit();
  if (!unit) return SPELL_FAILED_BAD_TARGETS;
  const result = unit.castSpellInfo(target?.spellUnit() ?? null, spell, { triggerFlags, dest });
  const session = handler.getSession();
  if (session) for (const packet of session.drainSpellOutbox().packets) session.sendRaw(packet);
  return result;
}

/** The shared tail of every cast handler. */
function finish(handler: ChatHandler, result: number): boolean {
  if (!CheckSpellCastResult(handler, result)) {
    handler.setSentErrorMessage(true);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::HandleCastCommand */
function HandleCastCommand(handler: ChatHandler, spell: SpellInfo, triggeredStr: string | null): boolean {
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  if (!CheckSpellExistsAndIsValid(handler, spell)) return false;
  const triggerFlags = GetTriggerFlags(triggeredStr);
  if (triggerFlags === null) return false;
  return finish(handler, castSpell(handler, handler.getSession()!.getPlayer()!, target, spell, triggerFlags));
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::HandleCastBackCommand */
function HandleCastBackCommand(handler: ChatHandler, spell: SpellInfo, triggeredStr: string | null): boolean {
  const caster = handler.getSelectedCreature();
  if (!caster) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  if (!CheckSpellExistsAndIsValid(handler, spell)) return false;
  const triggerFlags = GetTriggerFlags(triggeredStr);
  if (triggerFlags === null) return false;
  return finish(handler, castSpell(handler, caster, handler.getSession()!.getPlayer()!, spell, triggerFlags));
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::HandleCastDistCommand */
function HandleCastDistCommand(handler: ChatHandler, spell: SpellInfo, dist: number, triggeredStr: string | null): boolean {
  if (!CheckSpellExistsAndIsValid(handler, spell)) return false;
  const triggerFlags = GetTriggerFlags(triggeredStr);
  if (triggerFlags === null) return false;
  const player = handler.getSession()!.getPlayer()!;
  const pos = player.getClosePoint(dist);
  return finish(handler, castSpell(handler, player, null, spell, triggerFlags, pos));
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::HandleCastSelfCommand */
function HandleCastSelfCommand(handler: ChatHandler, spell: SpellInfo, triggeredStr: string | null): boolean {
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  if (!CheckSpellExistsAndIsValid(handler, spell)) return false;
  const triggerFlags = GetTriggerFlags(triggeredStr);
  if (triggerFlags === null) return false;
  return finish(handler, castSpell(handler, target, target, spell, triggerFlags));
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::HandleCastTargetCommad */
function HandleCastTargetCommad(handler: ChatHandler, spell: SpellInfo, triggeredStr: string | null): boolean {
  const caster = handler.getSelectedCreature();
  if (!caster) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const victimGuid = caster.motion()?.victim ?? null;
  const victim = victimGuid !== null ? ObjectAccessor.FindPlayerByLowGUID(victimGuid) : null;
  if (!victim) {
    handler.sendErrorMessage(L.LANG_SELECTED_TARGET_NOT_HAVE_VICTIM);
    return false;
  }
  if (!CheckSpellExistsAndIsValid(handler, spell)) return false;
  const triggerFlags = GetTriggerFlags(triggeredStr);
  if (triggerFlags === null) return false;
  return finish(handler, castSpell(handler, caster, victim, spell, triggerFlags));
}

/** @ac scripts/Commands/cs_cast.cpp cast_commandscript::HandleCastDestCommand */
function HandleCastDestCommand(handler: ChatHandler, spell: SpellInfo, x: number, y: number, z: number, triggeredStr: string | null): boolean {
  const caster = handler.getSelectedUnit();
  if (!caster) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  if (!CheckSpellExistsAndIsValid(handler, spell)) return false;
  const triggerFlags = GetTriggerFlags(triggeredStr);
  if (triggerFlags === null) return false;
  return finish(handler, castSpell(handler, caster, null, spell, triggerFlags, { x, y, z }));
}

/** @ac scripts/Commands/cs_cast.cpp AddSC_cast_commandscript */
export function AddSC_cast_commandscript(): void {
  registerCommandScript(GetCommands);
}
