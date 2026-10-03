/** `cs_learn.cpp`: `.learn`, `.learn all …`, `.unlearn`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional, SpellInfoArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { ExactSequence, PlayerIdentifier, PlayerIdentifierArg, WTail } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { GetSkillLineAbilitiesBySkillLine, sChrClassesStore, sSkillLineStore } from "../../game/DataStores/DBCStores.ts";
import type { Player } from "../../game/Entities/Player/Player.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sSpellMgr } from "../../game/Spells/SpellMgr.ts";
import { LANG_DESCRIPTION, SkillType } from "../../characters/skills.ts";
import { utf8FitTo, wstrToLower } from "../../common/util.ts";
import { TOTAL_LOCALES } from "../../shared/SharedDefines.ts";
import type { SpellInfo } from "../../spells/spell-info.ts";
import { HandleLearnSpellCommand, HandleUnlearnSpellCommand } from "./PlayerCommand.ts";

const SKILL_CATEGORY_PROFESSION = 11;
const SKILL_CATEGORY_SECONDARY = 9;

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  // `.learn all my class|talents` need the talent system (`character_talent`, specs), which is not ported.
  const learnAllMyCommandTable: ChatCommandTable = [
    ChatCommand("pettalents", [], HandleLearnAllMyPetTalentsCommand, R.RBAC_PERM_COMMAND_LEARN_MY_PETTALENTS, Console.No),
    ChatCommand("trainer", [], HandleLearnAllMyTrainerSpellsCommand, R.RBAC_PERM_COMMAND_LEARN_ALL_MY_SPELLS, Console.No),
    ChatCommand("quest", [], HandleLearnAllMyQuestSpells, R.RBAC_PERM_COMMAND_LEARN_ALL_MY_SPELLS, Console.No),
  ];
  const learnAllCommandTable: ChatCommandTable = [
    SubCommands("my", learnAllMyCommandTable),
    ChatCommand("gm", [], HandleLearnAllGMCommand, R.RBAC_PERM_COMMAND_LEARN_ALL_GM, Console.No),
    ChatCommand("crafts", [], HandleLearnAllCraftsCommand, R.RBAC_PERM_COMMAND_LEARN_ALL_CRAFTS, Console.No),
    ChatCommand("default", [Optional(PlayerIdentifierArg)], HandleLearnAllDefaultCommand, R.RBAC_PERM_COMMAND_LEARN_ALL_DEFAULT, Console.No),
    ChatCommand("lang", [], HandleLearnAllLangCommand, R.RBAC_PERM_COMMAND_LEARN_ALL_LANG, Console.No),
    ChatCommand("recipes", [WTail], HandleLearnAllRecipesCommand, R.RBAC_PERM_COMMAND_LEARN_ALL_RECIPES, Console.No),
  ];
  const learnCommandTable: ChatCommandTable = [
    SubCommands("all", learnAllCommandTable),
    ChatCommand("", [SpellInfoArg, Optional(ExactSequence("all"))], HandleLearnCommand, R.RBAC_PERM_COMMAND_LEARN, Console.No),
  ];
  return [
    SubCommands("learn", learnCommandTable),
    ChatCommand("unlearn", [SpellInfoArg, Optional(ExactSequence("all"))], HandleUnLearnCommand, R.RBAC_PERM_COMMAND_UNLEARN, Console.No),
  ];
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnCommand */
function HandleLearnCommand(handler: ChatHandler, spell: SpellInfo, allRanks: string | null): boolean {
  const targetPlayer = handler.getSelectedPlayer();
  if (!targetPlayer) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  return HandleLearnSpellCommand(handler, targetPlayer, spell, allRanks);
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllGMCommand */
function HandleLearnAllGMCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  for (const i of sSpellMgr.spellIds()) {
    const spellInfo = sSpellMgr.getSpellInfo(i);
    if (!spellInfo || !sSpellMgr.isSpellValid(spellInfo)) continue;
    if (!sSpellMgr.isAbilityOfSkillType(i, SkillType.SKILL_INTERNAL)) continue;
    player.learnSpell(i);
  }
  handler.sendSysMessage(L.LANG_LEARNING_GM_SKILLS);
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllMyQuestSpells */
function HandleLearnAllMyQuestSpells(handler: ChatHandler): boolean {
  const player = handler.getPlayer()!;
  for (const quest of sObjectMgr.getQuestTemplates().values()) {
    if (quest.allowableClasses && player.satisfyQuestClass(quest)) player.learnQuestRewardedSpells(quest);
  }
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllMyTrainerSpellsCommand */
function HandleLearnAllMyTrainerSpellsCommand(handler: ChatHandler): boolean {
  const player = handler.getPlayer()!;
  if (!sChrClassesStore.lookupEntry(player.getClass())) return true;
  const trainers = sObjectMgr.getClassTrainers(player.getClass());
  let hadNew: boolean;
  do {
    hadNew = false;
    for (const trainer of trainers) {
      if (!trainer.IsTrainerValidForPlayer(player)) continue;
      for (const trainerSpell of trainer.GetSpells()) {
        if (!trainer.CanTeachSpell(player, trainerSpell)) continue;
        if (trainerSpell.IsCastable()) player.castSpell(player, trainerSpell.SpellId, true);
        else player.learnSpell(trainerSpell.SpellId);
        // a script can refuse the learn or force the spell's state, so only go around
        // again when the spell actually stopped being teachable
        if (!trainer.CanTeachSpell(player, trainerSpell)) hadNew = true;
      }
    }
  } while (hadNew);
  handler.sendSysMessage(L.LANG_COMMAND_LEARN_CLASS_SPELLS);
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllMyPetTalentsCommand */
function HandleLearnAllMyPetTalentsCommand(handler: ChatHandler): boolean {
  // Pets are not ported, so the player never has one (`Player::GetPet`).
  handler.sendErrorMessage(L.LANG_NO_PET_FOUND);
  return false;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllLangCommand */
function HandleLearnAllLangCommand(handler: ChatHandler): boolean {
  const player = handler.getPlayer()!;
  for (const langDesc of LANG_DESCRIPTION) {
    if (langDesc.spellId) {
      player.learnSpell(langDesc.spellId);
      player.setSkill(langDesc.skillId, 0, 300, 300);
    }
  }
  handler.sendSysMessage(L.LANG_COMMAND_LEARN_ALL_LANG);
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllDefaultCommand */
function HandleLearnAllDefaultCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): boolean {
  const target = (playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler))?.getConnectedPlayer();
  if (!target) return false;
  target.learnDefaultSkills();
  target.learnCustomSpells();
  target.learnQuestRewardedSpells();
  handler.pSendSysMessage(L.LANG_COMMAND_LEARN_ALL_DEFAULT_AND_QUEST, handler.getNameLink(target));
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllCraftsCommand */
function HandleLearnAllCraftsCommand(handler: ChatHandler): boolean {
  const target = handler.getSession()!.getPlayer()!;
  for (const skillInfo of sSkillLineStore) {
    // only prof. with recipes have
    if ((skillInfo.categoryId === SKILL_CATEGORY_PROFESSION || skillInfo.categoryId === SKILL_CATEGORY_SECONDARY) && skillInfo.canLink) {
      HandleLearnSkillRecipesHelper(target, skillInfo.id);
      const maxLevel = target.getPureMaxSkillValue(skillInfo.id);
      target.setSkill(skillInfo.id, target.getSkillStep(skillInfo.id), maxLevel, maxLevel);
    }
  }
  handler.sendSysMessage(L.LANG_COMMAND_LEARN_ALL_CRAFT);
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnAllRecipesCommand */
function HandleLearnAllRecipesCommand(handler: ChatHandler, namePartArg: string): boolean {
  //  Learns all recipes of specified profession and sets skill to max
  //  Example: .learn all_recipes enchanting
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendSysMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  if (!namePartArg) return false;
  // converting string that we try to find to lower case
  const namePart = wstrToLower(namePartArg);
  let targetSkillInfo = null;
  let name: string | null = null;
  for (let i = 1; i < sSkillLineStore.getNumRows(); ++i) {
    const skillInfo = sSkillLineStore.lookupEntry(i);
    if (!skillInfo) continue;
    // only prof with recipes have set
    if ((skillInfo.categoryId !== SKILL_CATEGORY_PROFESSION && skillInfo.categoryId !== SKILL_CATEGORY_SECONDARY) || !skillInfo.canLink) continue;
    let locale = 0;
    for (; locale < TOTAL_LOCALES; ++locale) {
      name = skillInfo.name[locale] ?? null;
      if (!name) continue;
      if (utf8FitTo(name, namePart)) break;
    }
    if (locale < TOTAL_LOCALES) {
      targetSkillInfo = skillInfo;
      break;
    }
  }
  if (!(name && targetSkillInfo)) return false;
  HandleLearnSkillRecipesHelper(target, targetSkillInfo.id);
  const maxLevel = target.getPureMaxSkillValue(targetSkillInfo.id);
  target.setSkill(targetSkillInfo.id, target.getSkillStep(targetSkillInfo.id), maxLevel, maxLevel);
  handler.pSendSysMessage(L.LANG_COMMAND_LEARN_ALL_RECIPES, name);
  return true;
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleLearnSkillRecipesHelper */
function HandleLearnSkillRecipesHelper(player: Player, skillId: number): void {
  // Rank spells (Apprentice -> Grand Master) must be learned so that the skill-cleanup loop in Player::SetSkill can
  // walk forward and strip every rank on profession unlearn.
  for (const rankSpell of sSpellMgr.getSkillRankSpells(skillId)) player.learnSpell(rankSpell);
  const classmask = player.getClassMask();
  for (const skillLine of GetSkillLineAbilitiesBySkillLine(skillId)) {
    // not high rank
    if (skillLine.SupercededBySpell) continue;
    // skip racial skills
    if (skillLine.RaceMask !== 0) continue;
    // skip wrong class skills
    if (skillLine.ClassMask && (skillLine.ClassMask & classmask) === 0) continue;
    const spellInfo = sSpellMgr.getSpellInfo(skillLine.Spell);
    if (!spellInfo || !sSpellMgr.isSpellValid(spellInfo)) continue;
    player.learnSpell(skillLine.Spell);
  }
}

/** @ac scripts/Commands/cs_learn.cpp learn_commandscript::HandleUnLearnCommand */
function HandleUnLearnCommand(handler: ChatHandler, spell: SpellInfo, allRanks: string | null): boolean {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  return HandleUnlearnSpellCommand(handler, target, spell, allRanks);
}

/** @ac scripts/Commands/cs_learn.cpp AddSC_learn_commandscript */
export function AddSC_learn_commandscript(): void {
  registerCommandScript(GetCommands);
}
