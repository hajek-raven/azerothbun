/** Opcodes, flags, and limits the melee port reads (`Opcodes.h`, `UnitDefines.h`, `SharedDefines.h`, `CreatureData.h`). */

export const SMSG_MONSTER_MOVE = 0x0dd;
export const SMSG_EMOTE = 0x103;
export const SMSG_AI_REACTION = 0x13c;
export const CMSG_SET_SELECTION = 0x13d;
export const CMSG_ATTACKSWING = 0x141;
export const CMSG_ATTACKSTOP = 0x142;
export const SMSG_ATTACKSTART = 0x143;
export const SMSG_ATTACKSTOP = 0x144;
export const SMSG_ATTACKSWING_NOTINRANGE = 0x145;
export const SMSG_ATTACKSWING_BADFACING = 0x146;
export const SMSG_ATTACKSWING_DEADTARGET = 0x148;
export const SMSG_ATTACKSWING_CANT_ATTACK = 0x149;
export const SMSG_ATTACKERSTATEUPDATE = 0x14a;
export const SMSG_CANCEL_COMBAT = 0x14e;
export const CMSG_SETSHEATHED = 0x1e0;
export const SMSG_PARTYKILLLOG = 0x1f5;
export const SMSG_UPDATE_OBJECT = 0x0a9;
export const SMSG_DESTROY_OBJECT = 0x0aa;
export const SMSG_LOOT_LIST = 0x3f9;

/** `WeaponAttackType` */
export const BASE_ATTACK = 0;
export const OFF_ATTACK = 1;
export const RANGED_ATTACK = 2;

/** `MeleeHitOutcome` */
export const MELEE_HIT_EVADE = 0;
export const MELEE_HIT_MISS = 1;
export const MELEE_HIT_DODGE = 2;
export const MELEE_HIT_BLOCK = 3;
export const MELEE_HIT_PARRY = 4;
export const MELEE_HIT_GLANCING = 5;
export const MELEE_HIT_CRIT = 6;
export const MELEE_HIT_CRUSHING = 7;
export const MELEE_HIT_NORMAL = 8;
export type MeleeHitOutcome = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** `HitInfo` */
export const HITINFO_NORMALSWING = 0x00000000;
export const HITINFO_UNK1 = 0x00000001;
export const HITINFO_AFFECTS_VICTIM = 0x00000002;
export const HITINFO_OFFHAND = 0x00000004;
export const HITINFO_MISS = 0x00000010;
export const HITINFO_FULL_ABSORB = 0x00000020;
export const HITINFO_PARTIAL_ABSORB = 0x00000040;
export const HITINFO_FULL_RESIST = 0x00000080;
export const HITINFO_PARTIAL_RESIST = 0x00000100;
export const HITINFO_CRITICALHIT = 0x00000200;
export const HITINFO_GLANCING = 0x00004000;
export const HITINFO_CRUSHING = 0x00008000;
export const HITINFO_SWINGNOHITSOUND = 0x00080000;
export const HITINFO_BLOCK = 0x00002000;
export const HITINFO_RAGE_GAIN = 0x00800000;
export const HITINFO_FAKE_DAMAGE = 0x01000000;

/** `VictimState` */
export const VICTIMSTATE_INTACT = 0;
export const VICTIMSTATE_HIT = 1;
export const VICTIMSTATE_DODGE = 2;
export const VICTIMSTATE_PARRY = 3;
export const VICTIMSTATE_INTERRUPT = 4;
export const VICTIMSTATE_BLOCKS = 5;
export const VICTIMSTATE_EVADES = 6;
export const VICTIMSTATE_IS_IMMUNE = 7;
export const VICTIMSTATE_DEFLECTS = 8;

export const SPELL_SCHOOL_NORMAL = 0;
export const SPELL_SCHOOL_MASK_NORMAL = 0x01;

/** `UnitFlags` */
export const UNIT_FLAG_NON_ATTACKABLE = 0x00000002;
export const UNIT_FLAG_PLAYER_CONTROLLED = 0x00000008;
export const UNIT_FLAG_IMMUNE_TO_PC = 0x00000100;
export const UNIT_FLAG_IMMUNE_TO_NPC = 0x00000200;
export const UNIT_FLAG_PACIFIED = 0x00020000;
export const UNIT_FLAG_IN_COMBAT = 0x00080000;
export const UNIT_FLAG_NOT_SELECTABLE = 0x02000000;
export const UNIT_FLAG_SKINNABLE = 0x04000000;

/** `UnitDynFlags` */
export const UNIT_DYNFLAG_LOOTABLE = 0x0001;
export const UNIT_DYNFLAG_TAPPED = 0x0004;
export const UNIT_DYNFLAG_TAPPED_BY_PLAYER = 0x0008;
export const UNIT_DYNFLAG_DEAD = 0x0020;

/** `CreatureFlagsExtra` */
export const CREATURE_FLAG_EXTRA_CIVILIAN = 0x00000002;
export const CREATURE_FLAG_EXTRA_NO_PARRY = 0x00000004;
export const CREATURE_FLAG_EXTRA_NO_PARRY_HASTEN = 0x00000008;
export const CREATURE_FLAG_EXTRA_NO_BLOCK = 0x00000010;
export const CREATURE_FLAG_EXTRA_NO_CRUSHING_BLOWS = 0x00000020;
export const CREATURE_FLAG_EXTRA_NO_XP = 0x00000040;
export const CREATURE_FLAG_EXTRA_TRIGGER = 0x00000080;
export const CREATURE_FLAG_EXTRA_CANNOT_ENTER_COMBAT = 0x00002000;
export const CREATURE_FLAG_EXTRA_NO_CRIT = 0x00020000;
export const CREATURE_FLAG_EXTRA_NO_PLAYER_DAMAGE_REQ = 0x00200000;
export const CREATURE_FLAG_EXTRA_NO_DODGE = 0x00800000;
export const CREATURE_FLAG_EXTRA_DONT_CALL_ASSISTANCE = 0x02000000;
export const CREATURE_FLAG_EXTRA_IGNORE_ALL_ASSISTANCE_CALLS = 0x04000000;

/** `CreatureEliteType` */
export const CREATURE_ELITE_NORMAL = 0;
export const CREATURE_ELITE_ELITE = 1;
export const CREATURE_ELITE_RAREELITE = 2;
export const CREATURE_ELITE_WORLDBOSS = 3;
export const CREATURE_ELITE_RARE = 4;

/** `CreatureType` */
export const CREATURE_TYPE_HUMANOID = 7;
export const CREATURE_TYPE_CRITTER = 8;
export const CREATURE_TYPE_NON_COMBAT_PET = 12;
export const CREATURE_TYPE_TOTEM = 11;

/** `AiReaction` */
export const AI_REACTION_HOSTILE = 2;

/** `Emote` */
export const EMOTE_ONESHOT_WOUND_CRITICAL = 11;
export const EMOTE_ONESHOT_PARRY_SHIELD = 43;

export const POWER_MANA = 0;
export const POWER_RAGE = 1;

/** `ObjectDefines.h` / `Unit.h` / `Creature.h` */
export const DEFAULT_COMBAT_REACH = 1.5;
/** `INTERACTION_DISTANCE` (ObjectDefines.h) */
export const INTERACTION_DISTANCE = 5.5;
export const DEFAULT_PLAYER_BOUNDING_RADIUS = 0.389;
export const NOMINAL_MELEE_RANGE = 5;
export const LEEWAY_BONUS_RANGE = 2.66;
export const MAX_AGGRO_RADIUS = 45;
export const CREATURE_Z_ATTACK_RANGE = 3;
export const ATTACK_DISPLAY_DELAY = 200;
export const CREATURE_REGEN_INTERVAL = 2000;
/** `Creature::CanCreatureAttack`: no proximity aggro for 5 seconds after a respawn. */
export const RESPAWN_AGGRO_GRACE_SECONDS = 5;

/** `ReputationRank` */
export const REP_HATED = 0;
export const REP_HOSTILE = 1;
export const REP_UNFRIENDLY = 2;
export const REP_NEUTRAL = 3;
export const REP_FRIENDLY = 4;
export type ReputationRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** `ContentLevels` */
export const CONTENT_1_60 = 0;
export const CONTENT_61_70 = 1;
export const CONTENT_71_80 = 2;
