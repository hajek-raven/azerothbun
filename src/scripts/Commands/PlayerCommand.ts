/** `PlayerCommand.cpp`: the learn and unlearn helpers `cs_learn` and `cs_player` share. */
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { GetTalentSpellCost } from "../../game/DataStores/DBCStores.ts";
import type { Player } from "../../game/Entities/Player/Player.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sSpellMgr } from "../../game/Spells/SpellMgr.ts";
import type { SpellInfo } from "../../spells/spell-info.ts";

/** @ac scripts/Commands/PlayerCommand.cpp Acore::PlayerCommand::HandleLearnSpellCommand */
export function HandleLearnSpellCommand(handler: ChatHandler, targetPlayer: Player, spell: SpellInfo, allRanks: string | null): boolean {
  if (!sSpellMgr.isSpellValid(spell)) {
    handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
    return false;
  }
  if (allRanks === null && targetPlayer.hasSpell(spell.id)) {
    if (targetPlayer === handler.getPlayer()) handler.sendErrorMessage(L.LANG_YOU_KNOWN_SPELL);
    else handler.sendErrorMessage(L.LANG_TARGET_KNOWN_SPELL, handler.getNameLink(targetPlayer));
    return false;
  }
  targetPlayer.learnSpell(spell.id);
  if (allRanks !== null) {
    let spellId = spell.id;
    while ((spellId = sSpellMgr.getNextSpellInChain(spellId))) targetPlayer.learnSpell(spellId);
  }
  if (GetTalentSpellCost(sSpellMgr.getFirstSpellInChain(spell.id))) targetPlayer.sendTalentsInfoData(false);
  return true;
}

/** @ac scripts/Commands/PlayerCommand.cpp Acore::PlayerCommand::HandleUnlearnSpellCommand */
export function HandleUnlearnSpellCommand(handler: ChatHandler, target: Player, spell: SpellInfo, allRanks: string | null): boolean {
  let spellId = spell.id;
  if (allRanks !== null) spellId = sSpellMgr.getFirstSpellInChain(spellId);
  if (target.hasSpell(spellId)) target.removeSpell(spellId);
  else handler.sendSysMessage(L.LANG_FORGET_SPELL);
  if (GetTalentSpellCost(spellId)) target.sendTalentsInfoData(false);
  return true;
}
