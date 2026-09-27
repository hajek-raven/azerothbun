# Spell system gap inventory

Audited 2026-09-27 against the current `src/` worktree and AzerothCore's `Spell.cpp`, `SpellEffects.cpp`, `SpellInfo.cpp`, `SpellInfoCorrections.cpp`, `SpellMgr.cpp`, `SpellScript.cpp`, `SpellAuras.cpp`, and `SpellAuraEffects.cpp`. This is a port inventory, not a claim that a green test suite proves spell parity. AzerothCore's own `EffectNULL`/`EffectUnused` and `HandleNULL`/`HandleUnused` entries are identified separately because there is no effect handler to port for those IDs. `HandleNoImmediateEffect` is **not** a no-op: those auras act in periodic ticks or other Unit/Spell paths.

Dispatcher accounting: of effect IDs **1–164**, ten have partial TypeScript behavior, 129 have AzerothCore behavior with no live TypeScript dispatch, and 25 are reference no-ops. Of aura IDs **1–316**, three have partial TypeScript behavior, 276 have AzerothCore behavior without a TypeScript gameplay handler, and 37 are reference no-ops. IDs 0 are empty slots. Every ID is listed below; the broader integration gaps follow from the named C++ modules and the live session path.

## Baseline

The baseline is the smallest spell system that later work only *adds to*: new effect handlers, new aura handlers, and new data, never a second cast path. It is the AzerothCore pipeline end to end for **unit-to-unit spells**: any unit (player or creature) casts on itself, on a friendly player, or on a hostile creature, and every stage between the cast packet and the persisted aura is the ported C++ stage, not a shortcut. A spell whose effects or auras fall outside the baseline sets is still refused with `SPELL_FAILED_ERROR` before it spends anything.

**B1 — `SpellInfo` semantics** (`SpellInfo.cpp`, `SpellMgr.cpp`)
- The `SpellImplicitTargetInfo` table for all 111 targets and the `SpellEffectInfo` implicit-target / used-object table for all 165 effects.
- Explicit target mask, min/max range (friendly and hostile), effect radius, `CheckTarget`, `CheckExplicitTarget`, creature-type mask, dead/alive target rules, `GetSpellSpecific` and specific exclusivity, dispel/mechanic masks, and the default bonus coefficient.
- `spell_threat`, `spell_bonus_data`, `spell_group` / `spell_group_stack_rules`, `spell_linked_spell` (cast, hit, and aura links), `spell_target_position`, `spell_cone`, `spell_jump_distance`, and `creature_immunities` are applied, not only loaded.

**B2 — the `Spell` object** (`Spell.cpp`)
- `prepare` → `CheckCast` → cast time / GCD → `cast` → `SelectSpellTargets` → launch phase → `SMSG_SPELL_GO` → immediate or projectile-delayed hit phase → `finish`, plus `cancel`, `update`, pushback (`Delayed` / `DelayedChannel`), channels (`MSG_CHANNEL_START` / `MSG_CHANNEL_UPDATE`), and triggered casts that skip cost, cooldown, and GCD.
- Effect handle modes `LAUNCH`, `LAUNCH_TARGET`, `HIT`, and `HIT_TARGET`, with per-target hit info (miss condition, crit, damage, effect mask) and the go packet's hit and miss lists.
- Target selection for caster, explicit target, nearby, cone, area (source, destination, caster, target), chain, channel, and destinations (caster, target, dest, DB, home, with direction and radius). Check types enemy, ally, party, raid, entry, and default; max affected targets.
- `CheckCast` for death state, cooldowns, GCD, shapeshift, caster aura state and aura spells, combat restriction, explicit target, target checks, facing, pet presence, mount, range (melee, ranged, min), power (including health cost), caster auras (stun, silence, pacify, confuse, fear), dispel availability, and per-effect target rules. Line of sight is accepted until vmaps exist.

**B3 — unit spell math** (`Unit.cpp`, `Object.cpp`)
- `SpellHitResult`, `MagicSpellHitResult`, and `MeleeSpellHitResult`; immunity (school, mechanic, dispel, damage, effect); evade.
- `SpellDamageBonusDone/Taken`, `SpellHealingBonusDone/Taken`, bonus coefficients, spell power from auras, percent done/taken modifiers, crit chance and crit bonus, `CalculateSpellDamageTaken`, armor reduction for physical schools, resist rolls, absorbs (`SCHOOL_ABSORB`, `MANA_SHIELD`), `DealDamage` / `DealHeal` / `EnergizeBySpell` on players and creatures, threat, combat entry, and the damage / heal / energize / miss / periodic logs.

**B4 — auras** (`SpellAuras.cpp`, `SpellAuraEffects.cpp`, `Unit.cpp`)
- `Aura` / `AuraEffect` / `AuraApplication` on players and creatures: amount calculation, stacks, charges, refresh, duration by level and combo points, periodic timers and tick counts, the handler dispatch for all 317 aura IDs, and apply / reapply / remove handler modes.
- `CanStackWith` (same spell and caster, spell-specific exclusivity, `spell_group_stack_rules`), removal modes (default, cancel, expire, death, interrupt, dispel, enemy spell), aura interrupt flags, owner-side area auras with a periodic target map, and `SMSG_AURA_UPDATE` for every owner. Player auras keep their `character_aura` round trip.

**B5 — baseline effect handlers**: 1 `INSTAKILL`, 2 `SCHOOL_DAMAGE`, 3 `DUMMY`, 5 `TELEPORT_UNITS`, 6 `APPLY_AURA`, 7 `ENVIRONMENTAL_DAMAGE`, 8 `POWER_DRAIN`, 9 `HEALTH_LEECH`, 10 `HEAL`, 17 `WEAPON_DAMAGE_NOSCHOOL`, 22 `PARRY`, 23 `BLOCK`, 30 `ENERGIZE`, 31 `WEAPON_PERCENT_DAMAGE`, 35 `APPLY_AREA_AURA_PARTY`, 36 `LEARN_SPELL`, 38 `DISPEL`, 40 `DUAL_WIELD`, 58 `WEAPON_DAMAGE`, 62 `POWER_BURN`, 63 `THREAT`, 64 `TRIGGER_SPELL`, 65 `APPLY_AREA_AURA_RAID`, 67 `HEAL_MAX_HEALTH`, 68 `INTERRUPT_CAST`, 77 `SCRIPT_EFFECT`, 80 `ADD_COMBO_POINTS`, 108 `DISPEL_MECHANIC`, 114 `ATTACK_ME`, 119 `APPLY_AREA_AURA_PET`, 121 `NORMALIZED_WEAPON_DMG`, 125 `MODIFY_THREAT_PERCENT`, 128 `APPLY_AREA_AURA_FRIEND`, 129 `APPLY_AREA_AURA_ENEMY`, 136 `HEAL_PCT`, 137 `ENERGIZE_PCT`, 142 `TRIGGER_SPELL_WITH_VALUE`, 143 `APPLY_AREA_AURA_OWNER`, 164 `REMOVE_AURA`. `DUMMY` and `SCRIPT_EFFECT` run their generic C++ body; a spell bound in `spell_script_names` or `spell_scripts` still fails until its script is ported.

**B6 — baseline aura handlers**
- Periodic: 3 `PERIODIC_DAMAGE`, 8 `PERIODIC_HEAL`, 20 `OBS_MOD_HEALTH`, 21 `OBS_MOD_POWER`, 23 `PERIODIC_TRIGGER_SPELL`, 24 `PERIODIC_ENERGIZE`, 53 `PERIODIC_LEECH`, 64 `PERIODIC_MANA_LEECH`, 89 `PERIODIC_DAMAGE_PERCENT`, 162 `POWER_BURN`, 226 `PERIODIC_DUMMY`, 227 `PERIODIC_TRIGGER_SPELL_WITH_VALUE`; 4 `DUMMY` under the same script rule as effect 3.
- Control: 12 `MOD_STUN`, 25 `MOD_PACIFY`, 26 `MOD_ROOT`, 27 `MOD_SILENCE`, 60 `MOD_PACIFY_SILENCE`.
- Movement speed: 31 `MOD_INCREASE_SPEED`, 33 `MOD_DECREASE_SPEED`, 129 `MOD_SPEED_ALWAYS`, 171 `MOD_SPEED_NOT_STACK`.
- Stats: 13 `MOD_DAMAGE_DONE`, 22 `MOD_RESISTANCE`, 29 `MOD_STAT`, 34 `MOD_INCREASE_HEALTH`, 35 `MOD_INCREASE_ENERGY`, 80 `MOD_PERCENT_STAT`, 83 `MOD_BASE_RESISTANCE`, 99 `MOD_ATTACK_POWER`, 101 `MOD_RESISTANCE_PCT`, 124 `MOD_RANGED_ATTACK_POWER`, 133 `MOD_INCREASE_HEALTH_PERCENT`, 135 `MOD_HEALING_DONE`, 137 `MOD_TOTAL_STAT_PERCENTAGE`, 123 `MOD_TARGET_RESISTANCE`, 142 `MOD_BASE_RESISTANCE_PCT`, 143 `MOD_RESISTANCE_EXCLUSIVE`, 166 `MOD_ATTACK_POWER_PCT`, 167 `MOD_RANGED_ATTACK_POWER_PCT`, 250 `MOD_INCREASE_HEALTH_2`.
- Read by the B3 math: 14 `MOD_DAMAGE_TAKEN`, 50 `MOD_CRITICAL_HEALING_AMOUNT`, 79 `MOD_DAMAGE_PERCENT_DONE`, 87 `MOD_DAMAGE_PERCENT_TAKEN`, 115 `MOD_HEALING`, 118 `MOD_HEALING_PCT`, 136 `MOD_HEALING_DONE_PERCENT`, 163 `MOD_CRIT_DAMAGE_BONUS`, 179 `MOD_ATTACKER_SPELL_CRIT_CHANCE`, 186 `MOD_ATTACKER_SPELL_HIT_CHANCE`, 199 `MOD_INCREASES_SPELL_PCT_TO_HIT`, 259 `MOD_HOT_PCT`, 271 `MOD_DAMAGE_FROM_CASTER`, 283 `MOD_HEALING_RECEIVED`.
- Absorb, immunity, and threat: 10 `MOD_THREAT`, 11 `MOD_TAUNT`, 39 `SCHOOL_IMMUNITY`, 40 `DAMAGE_IMMUNITY`, 41 `DISPEL_IMMUNITY`, 69 `SCHOOL_ABSORB`, 77 `MECHANIC_IMMUNITY`, 97 `MANA_SHIELD`, 117 `MOD_MECHANIC_RESISTANCE`. (103 `MOD_TOTAL_THREAT` belongs to the threat-manager layer, since the creature threat list here is still a flat table.)

**Outside the baseline** (each is a later layer on the same pipeline): procs (`spell_proc`, `PROC_TRIGGER_*`, `ADD_TARGET_TRIGGER`), spell mods (`ADD_FLAT_MODIFIER` / `ADD_PCT_MODIFIER`), `SpellScript` / `AuraScript` and the class script files, pets / summons / totems / guardians, game objects and dynamic objects (persistent area auras, open lock), items as targets (create, enchant, disenchant), movement-driven effects (charge, jump, knockback, leap, pull, fear and confuse movement), stealth / invisibility / shapeshift / mount / transform auras, reflect / deflect / redirect, diminishing returns, PvP and duels, talents and glyphs, runes, ammo, and trajectories.

## What exists today

The baseline above is implemented. Every row marked `Baseline` in the catalogs below runs the ported AzerothCore handler.

- **Data** (`spell-info.ts`, `world-data.ts`, `enums.ts`, `target-data.ts`): `SpellStore` derives `SpellInfo` with custom attributes (`LoadSpellInfoCustomAttributes`), binary and negative effects, the explicit target mask, spell-specific and aura-state classification, immunity info, and cooldown overrides. It also loads `spell_threat`, `spell_cone`, `spell_jump_distance`, `spell_proc` charges, `creature_classlevelstats`, and `creature_immunities`. `SpellWorldData` answers spell-group stack rules, linked spells, target positions, pet auras, and script bindings. `src/tools/gen-spell-enums.ts` and `gen-spell-target-data.ts` generate the C++ enums and the 111-target and 165-effect tables from the AzerothCore headers and sources.
- **`Spell`** (`spell.ts`): `prepare` → `CheckCast` → cast time and GCD → `cast` → `SelectSpellTargets` → launch phase → `SMSG_SPELL_GO` → the immediate or projectile-delayed hit phase → `finish`. It also covers `cancel`, `update`, the `SpellEvent` timing, pushback, channels, `SMSG_SPELLLOGEXECUTE`, threat, reagents, cooldowns, next-melee-swing spells, and linked cast and hit spells. `unsupportedReason` refuses a spell, before it spends anything, if its trigger tree reaches any effect, aura, target category, script binding, hard-coded id branch, or class damage branch that is outside the baseline.
- **Effects** (`spell-effects.ts`): the B5 handlers.
- **Unit math** (`unit-math.ts`): hit results, crits, bonuses and coefficients, armor, resists, absorbs, and `DealDamage` / `HealBySpell` / `EnergizeBySpell`, including `ModSpellDuration`.
- **Auras** (`aura.ts`, `aura-effects.ts`): `Aura`, `AuraApplication`, and `AuraEffect` with the B6 handlers, stacking and exclusivity, area auras, periodic ticks, interrupts, and `SMSG_AURA_UPDATE`.
- **Units** (`unit.ts`, `combat/creature-spell-unit.ts`, `world/player-spell-unit.ts`): the shared `SpellUnit` holds aura containers, immunities, aura states, controlled states, speed, current spells, spell history (cooldowns, GCD, school lockout), and evade-aura removal. `CreatureStats` ports the creature `StatSystem`. `PlayerStatHost` drives `PlayerStats` modifier groups, buff fields, and spell power from auras.
- **World integration**: `CombatWorld` is the `SpellMap`. It resolves unit guids, runs area searches, lists threatened creatures, and ticks creature spells and auras. Creature melee and player melee go through `MeleeDamageBonusDone/Taken`, aura-modified armor, absorbs, and `DealDamage`. That covers pushback, rage, interrupts, and deaths. Stun, root, pacify, and casting stop creature swings and chasing. Taunts fixate the victim, aura run speed moves creatures, and evading clears evade auras.
- **Session**: `WorldSession` casts through `PlayerSpellUnit` for spells and item spells. It handles cancel cast, cancel channel, and cancel aura, and sends `SMSG_AURA_UPDATE_ALL` at login. Auras round-trip through `character_aura` (`_LoadAuras`/`_SaveAuras`) and cooldowns through `character_spell_cooldown`. Speed-change acks are checked against the aura-modified speed, and movement and standing up remove the auras that break on them.
- **Tests**: `spell.test.ts` covers the engine against the real `Spell.dbc` through `test-units.ts`: cast time, GCD, missiles, periodic damage and heals, stat auras, stun, area root, channels, movement interrupts, immunity, death, and refusal.

## Missing integration and rules

These are later layers on the same pipeline:
- procs;
- spell mods;
- `SpellScript` / `AuraScript` and the class family branches refused by `classDamageBranch`;
- pets, summons, totems, game objects, and dynamic objects;
- item targets;
- movement effects;
- stealth, shapeshift, and mounts;
- reflect;
- diminishing returns;
- PvP and duels;
- talents, glyphs, runes, ammo, and trajectories;
- `GetAuraRankForLevel` and `conditions`-based target checks (`TARGET_CHECK_ENTRY` targets are refused);
- line of sight (vmaps).

Creature AI spell casting (`SmartAI` / `CreatureAI` spell selection) is not wired. Creatures can be spell targets and aura owners, and the engine can cast for them, but no AI picks spells yet.

Reagent consumption updates the in-memory inventory, which is saved with the character. The client item update and the `item_instance` count for a partly used stack still belong to the items layer.

## Effect ID catalog

`Partial` means only the narrow behavior named here exists; it does not mean AzerothCore parity. `Missing` means no live TypeScript effect dispatch. `Reference no-op` means AzerothCore maps the ID to `EffectNULL` or `EffectUnused`. Effect 0 is the empty slot.

| ID | AzerothCore name | AzerothCore handler | TypeScript status |
| ---: | --- | --- | --- |
| 0 | SPELL_EFFECT_NONE | EffectNULL | Empty slot |
| 1 | SPELL_EFFECT_INSTAKILL | EffectInstaKill | Baseline |
| 2 | SPELL_EFFECT_SCHOOL_DAMAGE | EffectSchoolDMG | Baseline |
| 3 | SPELL_EFFECT_DUMMY | EffectDummy | Baseline: generic body; spells bound in `spell_script_names` / `spell_scripts` or with a hard-coded id branch are refused |
| 4 | SPELL_EFFECT_PORTAL_TELEPORT | EffectUnused | Reference no-op |
| 5 | SPELL_EFFECT_TELEPORT_UNITS | EffectTeleportUnits | Baseline |
| 6 | SPELL_EFFECT_APPLY_AURA | EffectApplyAura | Baseline |
| 7 | SPELL_EFFECT_ENVIRONMENTAL_DAMAGE | EffectEnvironmentalDMG | Baseline |
| 8 | SPELL_EFFECT_POWER_DRAIN | EffectPowerDrain | Baseline |
| 9 | SPELL_EFFECT_HEALTH_LEECH | EffectHealthLeech | Baseline |
| 10 | SPELL_EFFECT_HEAL | EffectHeal | Baseline |
| 11 | SPELL_EFFECT_BIND | EffectBind | Missing |
| 12 | SPELL_EFFECT_PORTAL | EffectNULL | Reference no-op |
| 13 | SPELL_EFFECT_RITUAL_BASE | EffectUnused | Reference no-op |
| 14 | SPELL_EFFECT_RITUAL_SPECIALIZE | EffectUnused | Reference no-op |
| 15 | SPELL_EFFECT_RITUAL_ACTIVATE_PORTAL | EffectUnused | Reference no-op |
| 16 | SPELL_EFFECT_QUEST_COMPLETE | EffectQuestComplete | Missing |
| 17 | SPELL_EFFECT_WEAPON_DAMAGE_NOSCHOOL | EffectWeaponDmg | Baseline |
| 18 | SPELL_EFFECT_RESURRECT | EffectResurrect | Missing |
| 19 | SPELL_EFFECT_ADD_EXTRA_ATTACKS | EffectAddExtraAttacks | Missing |
| 20 | SPELL_EFFECT_DODGE | EffectUnused | Reference no-op |
| 21 | SPELL_EFFECT_EVADE | EffectUnused | Reference no-op |
| 22 | SPELL_EFFECT_PARRY | EffectParry | Baseline |
| 23 | SPELL_EFFECT_BLOCK | EffectBlock | Baseline |
| 24 | SPELL_EFFECT_CREATE_ITEM | EffectCreateItem | Missing |
| 25 | SPELL_EFFECT_WEAPON | EffectUnused | Reference no-op |
| 26 | SPELL_EFFECT_DEFENSE | EffectUnused | Reference no-op |
| 27 | SPELL_EFFECT_PERSISTENT_AREA_AURA | EffectPersistentAA | Missing |
| 28 | SPELL_EFFECT_SUMMON | EffectSummonType | Missing |
| 29 | SPELL_EFFECT_LEAP | EffectLeap | Missing |
| 30 | SPELL_EFFECT_ENERGIZE | EffectEnergize | Baseline |
| 31 | SPELL_EFFECT_WEAPON_PERCENT_DAMAGE | EffectWeaponDmg | Baseline |
| 32 | SPELL_EFFECT_TRIGGER_MISSILE | EffectTriggerMissileSpell | Missing |
| 33 | SPELL_EFFECT_OPEN_LOCK | EffectOpenLock | Missing |
| 34 | SPELL_EFFECT_SUMMON_CHANGE_ITEM | EffectSummonChangeItem | Missing |
| 35 | SPELL_EFFECT_APPLY_AREA_AURA_PARTY | EffectApplyAreaAura | Baseline |
| 36 | SPELL_EFFECT_LEARN_SPELL | EffectLearnSpell | Baseline |
| 37 | SPELL_EFFECT_SPELL_DEFENSE | EffectUnused | Reference no-op |
| 38 | SPELL_EFFECT_DISPEL | EffectDispel | Baseline |
| 39 | SPELL_EFFECT_LANGUAGE | EffectUnused | Reference no-op |
| 40 | SPELL_EFFECT_DUAL_WIELD | EffectDualWield | Baseline |
| 41 | SPELL_EFFECT_JUMP | EffectJump | Missing |
| 42 | SPELL_EFFECT_JUMP_DEST | EffectJumpDest | Missing |
| 43 | SPELL_EFFECT_TELEPORT_UNITS_FACE_CASTER | EffectTeleUnitsFaceCaster | Missing |
| 44 | SPELL_EFFECT_SKILL_STEP | EffectLearnSkill | Missing |
| 45 | SPELL_EFFECT_ADD_HONOR | EffectAddHonor | Missing |
| 46 | SPELL_EFFECT_SPAWN | EffectUnused | Reference no-op |
| 47 | SPELL_EFFECT_TRADE_SKILL | EffectTradeSkill | Missing |
| 48 | SPELL_EFFECT_STEALTH | EffectUnused | Reference no-op |
| 49 | SPELL_EFFECT_DETECT | EffectUnused | Reference no-op |
| 50 | SPELL_EFFECT_TRANS_DOOR | EffectTransmitted | Missing |
| 51 | SPELL_EFFECT_FORCE_CRITICAL_HIT | EffectUnused | Reference no-op |
| 52 | SPELL_EFFECT_GUARANTEE_HIT | EffectUnused | Reference no-op |
| 53 | SPELL_EFFECT_ENCHANT_ITEM | EffectEnchantItemPerm | Missing |
| 54 | SPELL_EFFECT_ENCHANT_ITEM_TEMPORARY | EffectEnchantItemTmp | Missing |
| 55 | SPELL_EFFECT_TAMECREATURE | EffectTameCreature | Missing |
| 56 | SPELL_EFFECT_SUMMON_PET | EffectSummonPet | Missing |
| 57 | SPELL_EFFECT_LEARN_PET_SPELL | EffectLearnPetSpell | Missing |
| 58 | SPELL_EFFECT_WEAPON_DAMAGE | EffectWeaponDmg | Baseline |
| 59 | SPELL_EFFECT_CREATE_RANDOM_ITEM | EffectCreateRandomItem | Missing |
| 60 | SPELL_EFFECT_PROFICIENCY | EffectProficiency | Missing |
| 61 | SPELL_EFFECT_SEND_EVENT | EffectSendEvent | Missing |
| 62 | SPELL_EFFECT_POWER_BURN | EffectPowerBurn | Baseline |
| 63 | SPELL_EFFECT_THREAT | EffectThreat | Baseline |
| 64 | SPELL_EFFECT_TRIGGER_SPELL | EffectTriggerSpell | Baseline |
| 65 | SPELL_EFFECT_APPLY_AREA_AURA_RAID | EffectApplyAreaAura | Baseline |
| 66 | SPELL_EFFECT_CREATE_MANA_GEM | EffectRechargeManaGem | Missing |
| 67 | SPELL_EFFECT_HEAL_MAX_HEALTH | EffectHealMaxHealth | Baseline |
| 68 | SPELL_EFFECT_INTERRUPT_CAST | EffectInterruptCast | Baseline |
| 69 | SPELL_EFFECT_DISTRACT | EffectDistract | Missing |
| 70 | SPELL_EFFECT_PULL | EffectPull | Missing |
| 71 | SPELL_EFFECT_PICKPOCKET | EffectPickPocket | Missing |
| 72 | SPELL_EFFECT_ADD_FARSIGHT | EffectAddFarsight | Missing |
| 73 | SPELL_EFFECT_UNTRAIN_TALENTS | EffectUntrainTalents | Missing |
| 74 | SPELL_EFFECT_APPLY_GLYPH | EffectApplyGlyph | Missing |
| 75 | SPELL_EFFECT_HEAL_MECHANICAL | EffectHealMechanical | Missing |
| 76 | SPELL_EFFECT_SUMMON_OBJECT_WILD | EffectSummonObjectWild | Missing |
| 77 | SPELL_EFFECT_SCRIPT_EFFECT | EffectScriptEffect | Baseline: generic body; spells bound in `spell_script_names` / `spell_scripts` or with a hard-coded id branch are refused |
| 78 | SPELL_EFFECT_ATTACK | EffectUnused | Reference no-op |
| 79 | SPELL_EFFECT_SANCTUARY | EffectSanctuary | Missing |
| 80 | SPELL_EFFECT_ADD_COMBO_POINTS | EffectAddComboPoints | Baseline |
| 81 | SPELL_EFFECT_CREATE_HOUSE | EffectUnused | Reference no-op |
| 82 | SPELL_EFFECT_BIND_SIGHT | EffectNULL | Reference no-op |
| 83 | SPELL_EFFECT_DUEL | EffectDuel | Missing |
| 84 | SPELL_EFFECT_STUCK | EffectStuck | Missing |
| 85 | SPELL_EFFECT_SUMMON_PLAYER | EffectSummonPlayer | Missing |
| 86 | SPELL_EFFECT_ACTIVATE_OBJECT | EffectActivateObject | Missing |
| 87 | SPELL_EFFECT_GAMEOBJECT_DAMAGE | EffectGameObjectDamage | Missing |
| 88 | SPELL_EFFECT_GAMEOBJECT_REPAIR | EffectGameObjectRepair | Missing |
| 89 | SPELL_EFFECT_GAMEOBJECT_SET_DESTRUCTION_STATE | EffectGameObjectSetDestructionState | Missing |
| 90 | SPELL_EFFECT_KILL_CREDIT | EffectKillCreditPersonal | Missing |
| 91 | SPELL_EFFECT_THREAT_ALL | EffectUnused | Reference no-op |
| 92 | SPELL_EFFECT_ENCHANT_HELD_ITEM | EffectEnchantHeldItem | Missing |
| 93 | SPELL_EFFECT_FORCE_DESELECT | EffectForceDeselect | Missing |
| 94 | SPELL_EFFECT_SELF_RESURRECT | EffectSelfResurrect | Missing |
| 95 | SPELL_EFFECT_SKINNING | EffectSkinning | Missing |
| 96 | SPELL_EFFECT_CHARGE | EffectCharge | Missing |
| 97 | SPELL_EFFECT_CAST_BUTTON | EffectCastButtons | Missing |
| 98 | SPELL_EFFECT_KNOCK_BACK | EffectKnockBack | Missing |
| 99 | SPELL_EFFECT_DISENCHANT | EffectDisEnchant | Missing |
| 100 | SPELL_EFFECT_INEBRIATE | EffectInebriate | Missing |
| 101 | SPELL_EFFECT_FEED_PET | EffectFeedPet | Missing |
| 102 | SPELL_EFFECT_DISMISS_PET | EffectDismissPet | Missing |
| 103 | SPELL_EFFECT_REPUTATION | EffectReputation | Missing |
| 104 | SPELL_EFFECT_SUMMON_OBJECT_SLOT1 | EffectSummonObject | Missing |
| 105 | SPELL_EFFECT_SUMMON_OBJECT_SLOT2 | EffectSummonObject | Missing |
| 106 | SPELL_EFFECT_SUMMON_OBJECT_SLOT3 | EffectSummonObject | Missing |
| 107 | SPELL_EFFECT_SUMMON_OBJECT_SLOT4 | EffectSummonObject | Missing |
| 108 | SPELL_EFFECT_DISPEL_MECHANIC | EffectDispelMechanic | Baseline |
| 109 | SPELL_EFFECT_RESURRECT_PET | EffectResurrectPet | Missing |
| 110 | SPELL_EFFECT_DESTROY_ALL_TOTEMS | EffectDestroyAllTotems | Missing |
| 111 | SPELL_EFFECT_DURABILITY_DAMAGE | EffectDurabilityDamage | Missing |
| 112 | SPELL_EFFECT_112 | EffectUnused | Reference no-op |
| 113 | SPELL_EFFECT_RESURRECT_NEW | EffectResurrectNew | Missing |
| 114 | SPELL_EFFECT_ATTACK_ME | EffectTaunt | Baseline |
| 115 | SPELL_EFFECT_DURABILITY_DAMAGE_PCT | EffectDurabilityDamagePCT | Missing |
| 116 | SPELL_EFFECT_SKIN_PLAYER_CORPSE | EffectSkinPlayerCorpse | Missing |
| 117 | SPELL_EFFECT_SPIRIT_HEAL | EffectSpiritHeal | Missing |
| 118 | SPELL_EFFECT_SKILL | EffectSkill | Missing |
| 119 | SPELL_EFFECT_APPLY_AREA_AURA_PET | EffectApplyAreaAura | Baseline |
| 120 | SPELL_EFFECT_TELEPORT_GRAVEYARD | EffectUnused | Reference no-op |
| 121 | SPELL_EFFECT_NORMALIZED_WEAPON_DMG | EffectWeaponDmg | Baseline |
| 122 | SPELL_EFFECT_122 | EffectUnused | Reference no-op |
| 123 | SPELL_EFFECT_SEND_TAXI | EffectSendTaxi | Missing |
| 124 | SPELL_EFFECT_PULL_TOWARDS | EffectPullTowards | Missing |
| 125 | SPELL_EFFECT_MODIFY_THREAT_PERCENT | EffectModifyThreatPercent | Baseline |
| 126 | SPELL_EFFECT_STEAL_BENEFICIAL_BUFF | EffectStealBeneficialBuff | Missing |
| 127 | SPELL_EFFECT_PROSPECTING | EffectProspecting | Missing |
| 128 | SPELL_EFFECT_APPLY_AREA_AURA_FRIEND | EffectApplyAreaAura | Baseline |
| 129 | SPELL_EFFECT_APPLY_AREA_AURA_ENEMY | EffectApplyAreaAura | Baseline |
| 130 | SPELL_EFFECT_REDIRECT_THREAT | EffectRedirectThreat | Missing |
| 131 | SPELL_EFFECT_PLAY_SOUND | EffectPlaySound | Missing |
| 132 | SPELL_EFFECT_PLAY_MUSIC | EffectPlayMusic | Missing |
| 133 | SPELL_EFFECT_UNLEARN_SPECIALIZATION | EffectUnlearnSpecialization | Missing |
| 134 | SPELL_EFFECT_KILL_CREDIT2 | EffectKillCredit | Missing |
| 135 | SPELL_EFFECT_CALL_PET | EffectNULL | Reference no-op |
| 136 | SPELL_EFFECT_HEAL_PCT | EffectHealPct | Baseline |
| 137 | SPELL_EFFECT_ENERGIZE_PCT | EffectEnergizePct | Baseline |
| 138 | SPELL_EFFECT_LEAP_BACK | EffectLeapBack | Missing |
| 139 | SPELL_EFFECT_CLEAR_QUEST | EffectQuestClear | Missing |
| 140 | SPELL_EFFECT_FORCE_CAST | EffectForceCast | Missing |
| 141 | SPELL_EFFECT_FORCE_CAST_WITH_VALUE | EffectForceCast | Missing |
| 142 | SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE | EffectTriggerSpell | Baseline |
| 143 | SPELL_EFFECT_APPLY_AREA_AURA_OWNER | EffectApplyAreaAura | Baseline |
| 144 | SPELL_EFFECT_KNOCK_BACK_DEST | EffectKnockBack | Missing |
| 145 | SPELL_EFFECT_PULL_TOWARDS_DEST | EffectPullTowards | Missing |
| 146 | SPELL_EFFECT_ACTIVATE_RUNE | EffectActivateRune | Missing |
| 147 | SPELL_EFFECT_QUEST_FAIL | EffectQuestFail | Missing |
| 148 | SPELL_EFFECT_TRIGGER_MISSILE_SPELL_WITH_VALUE | EffectTriggerMissileSpell | Missing |
| 149 | SPELL_EFFECT_CHARGE_DEST | EffectChargeDest | Missing |
| 150 | SPELL_EFFECT_QUEST_START | EffectQuestStart | Missing |
| 151 | SPELL_EFFECT_TRIGGER_SPELL_2 | EffectTriggerRitualOfSummoning | Missing |
| 152 | SPELL_EFFECT_SUMMON_RAF_FRIEND | EffectSummonRaFFriend | Missing |
| 153 | SPELL_EFFECT_CREATE_TAMED_PET | EffectCreateTamedPet | Missing |
| 154 | SPELL_EFFECT_DISCOVER_TAXI | EffectDiscoverTaxi | Missing |
| 155 | SPELL_EFFECT_TITAN_GRIP | EffectTitanGrip | Missing |
| 156 | SPELL_EFFECT_ENCHANT_ITEM_PRISMATIC | EffectEnchantItemPrismatic | Missing |
| 157 | SPELL_EFFECT_CREATE_ITEM_2 | EffectCreateItem2 | Missing |
| 158 | SPELL_EFFECT_MILLING | EffectMilling | Missing |
| 159 | SPELL_EFFECT_ALLOW_RENAME_PET | EffectRenamePet | Missing |
| 160 | SPELL_EFFECT_FORCE_CAST_2 | EffectForceCast | Missing |
| 161 | SPELL_EFFECT_TALENT_SPEC_COUNT | EffectSpecCount | Missing |
| 162 | SPELL_EFFECT_TALENT_SPEC_SELECT | EffectActivateSpec | Missing |
| 163 | SPELL_EFFECT_163 | EffectNULL | Reference no-op |
| 164 | SPELL_EFFECT_REMOVE_AURA | EffectRemoveAura | Baseline |

## Aura ID catalog

`Partial` means only the narrow owner and behavior named in that row is implemented. Aura slotting and database round-tripping are generic infrastructure; they do not implement the aura behavior. `Reference no-op` means AzerothCore maps the ID to `HandleNULL` or `HandleUnused`. `HandleNoImmediateEffect` is listed as missing unless its periodic behavior is supported.

| ID | AzerothCore name | AzerothCore handler | TypeScript status |
| ---: | --- | --- | --- |
| 0 | SPELL_AURA_NONE | HandleNULL | Empty slot |
| 1 | SPELL_AURA_BIND_SIGHT | HandleBindSight | Missing |
| 2 | SPELL_AURA_MOD_POSSESS | HandleModPossess | Missing |
| 3 | SPELL_AURA_PERIODIC_DAMAGE | HandleNoImmediateEffect | Baseline |
| 4 | SPELL_AURA_DUMMY | HandleAuraDummy | Baseline: generic body; scripted spells are refused |
| 5 | SPELL_AURA_MOD_CONFUSE | HandleModConfuse | Missing |
| 6 | SPELL_AURA_MOD_CHARM | HandleModCharm | Missing |
| 7 | SPELL_AURA_MOD_FEAR | HandleModFear | Missing |
| 8 | SPELL_AURA_PERIODIC_HEAL | HandleNoImmediateEffect | Baseline |
| 9 | SPELL_AURA_MOD_ATTACKSPEED | HandleModAttackSpeed | Missing |
| 10 | SPELL_AURA_MOD_THREAT | HandleModThreat | Baseline |
| 11 | SPELL_AURA_MOD_TAUNT | HandleModTaunt | Baseline |
| 12 | SPELL_AURA_MOD_STUN | HandleAuraModStun | Baseline |
| 13 | SPELL_AURA_MOD_DAMAGE_DONE | HandleModDamageDone | Baseline |
| 14 | SPELL_AURA_MOD_DAMAGE_TAKEN | HandleNoImmediateEffect | Baseline |
| 15 | SPELL_AURA_DAMAGE_SHIELD | HandleNoImmediateEffect | Missing |
| 16 | SPELL_AURA_MOD_STEALTH | HandleModStealth | Missing |
| 17 | SPELL_AURA_MOD_STEALTH_DETECT | HandleModStealthDetect | Missing |
| 18 | SPELL_AURA_MOD_INVISIBILITY | HandleModInvisibility | Missing |
| 19 | SPELL_AURA_MOD_INVISIBILITY_DETECT | HandleModInvisibilityDetect | Missing |
| 20 | SPELL_AURA_OBS_MOD_HEALTH | HandleNoImmediateEffect | Baseline |
| 21 | SPELL_AURA_OBS_MOD_POWER | HandleNoImmediateEffect | Baseline |
| 22 | SPELL_AURA_MOD_RESISTANCE | HandleAuraModResistance | Baseline |
| 23 | SPELL_AURA_PERIODIC_TRIGGER_SPELL | HandleNoImmediateEffect | Baseline |
| 24 | SPELL_AURA_PERIODIC_ENERGIZE | HandleNoImmediateEffect | Baseline |
| 25 | SPELL_AURA_MOD_PACIFY | HandleAuraModPacify | Baseline |
| 26 | SPELL_AURA_MOD_ROOT | HandleAuraModRoot | Baseline |
| 27 | SPELL_AURA_MOD_SILENCE | HandleAuraModSilence | Baseline |
| 28 | SPELL_AURA_REFLECT_SPELLS | HandleNoImmediateEffect | Missing |
| 29 | SPELL_AURA_MOD_STAT | HandleAuraModStat | Baseline |
| 30 | SPELL_AURA_MOD_SKILL | HandleAuraModSkill | Missing |
| 31 | SPELL_AURA_MOD_INCREASE_SPEED | HandleAuraModIncreaseSpeed | Baseline |
| 32 | SPELL_AURA_MOD_INCREASE_MOUNTED_SPEED | HandleAuraModIncreaseMountedSpeed | Missing |
| 33 | SPELL_AURA_MOD_DECREASE_SPEED | HandleAuraModDecreaseSpeed | Baseline |
| 34 | SPELL_AURA_MOD_INCREASE_HEALTH | HandleAuraModIncreaseHealth | Baseline |
| 35 | SPELL_AURA_MOD_INCREASE_ENERGY | HandleAuraModIncreaseEnergy | Baseline |
| 36 | SPELL_AURA_MOD_SHAPESHIFT | HandleAuraModShapeshift | Missing |
| 37 | SPELL_AURA_EFFECT_IMMUNITY | HandleAuraModEffectImmunity | Missing |
| 38 | SPELL_AURA_STATE_IMMUNITY | HandleAuraModStateImmunity | Missing |
| 39 | SPELL_AURA_SCHOOL_IMMUNITY | HandleAuraModSchoolImmunity | Baseline |
| 40 | SPELL_AURA_DAMAGE_IMMUNITY | HandleAuraModDmgImmunity | Baseline |
| 41 | SPELL_AURA_DISPEL_IMMUNITY | HandleAuraModDispelImmunity | Baseline |
| 42 | SPELL_AURA_PROC_TRIGGER_SPELL | HandleNoImmediateEffect | Missing |
| 43 | SPELL_AURA_PROC_TRIGGER_DAMAGE | HandleNoImmediateEffect | Missing |
| 44 | SPELL_AURA_TRACK_CREATURES | HandleAuraTrackCreatures | Missing |
| 45 | SPELL_AURA_TRACK_RESOURCES | HandleAuraTrackResources | Missing |
| 46 | SPELL_AURA_46 | HandleNULL | Reference no-op |
| 47 | SPELL_AURA_MOD_PARRY_PERCENT | HandleAuraModParryPercent | Missing |
| 48 | SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT | HandleNoImmediateEffect | Missing |
| 49 | SPELL_AURA_MOD_DODGE_PERCENT | HandleAuraModDodgePercent | Missing |
| 50 | SPELL_AURA_MOD_CRITICAL_HEALING_AMOUNT | HandleNoImmediateEffect | Baseline |
| 51 | SPELL_AURA_MOD_BLOCK_PERCENT | HandleAuraModBlockPercent | Missing |
| 52 | SPELL_AURA_MOD_WEAPON_CRIT_PERCENT | HandleAuraModWeaponCritPercent | Missing |
| 53 | SPELL_AURA_PERIODIC_LEECH | HandleNoImmediateEffect | Baseline |
| 54 | SPELL_AURA_MOD_HIT_CHANCE | HandleModHitChance | Missing |
| 55 | SPELL_AURA_MOD_SPELL_HIT_CHANCE | HandleModSpellHitChance | Missing |
| 56 | SPELL_AURA_TRANSFORM | HandleAuraTransform | Missing |
| 57 | SPELL_AURA_MOD_SPELL_CRIT_CHANCE | HandleModSpellCritChance | Missing |
| 58 | SPELL_AURA_MOD_INCREASE_SWIM_SPEED | HandleAuraModIncreaseSwimSpeed | Missing |
| 59 | SPELL_AURA_MOD_DAMAGE_DONE_CREATURE | HandleNoImmediateEffect | Missing |
| 60 | SPELL_AURA_MOD_PACIFY_SILENCE | HandleAuraModPacifyAndSilence | Baseline |
| 61 | SPELL_AURA_MOD_SCALE | HandleAuraModScale | Missing |
| 62 | SPELL_AURA_PERIODIC_HEALTH_FUNNEL | HandleNoImmediateEffect | Missing |
| 63 | SPELL_AURA_63 | HandleNULL | Reference no-op |
| 64 | SPELL_AURA_PERIODIC_MANA_LEECH | HandleNoImmediateEffect | Baseline |
| 65 | SPELL_AURA_MOD_CASTING_SPEED_NOT_STACK | HandleModCastingSpeed | Missing |
| 66 | SPELL_AURA_FEIGN_DEATH | HandleFeignDeath | Missing |
| 67 | SPELL_AURA_MOD_DISARM | HandleAuraModDisarm | Missing |
| 68 | SPELL_AURA_MOD_STALKED | HandleAuraModStalked | Missing |
| 69 | SPELL_AURA_SCHOOL_ABSORB | HandleNoImmediateEffect | Baseline |
| 70 | SPELL_AURA_EXTRA_ATTACKS | HandleUnused | Reference no-op |
| 71 | SPELL_AURA_MOD_SPELL_CRIT_CHANCE_SCHOOL | HandleModSpellCritChanceShool | Missing |
| 72 | SPELL_AURA_MOD_POWER_COST_SCHOOL_PCT | HandleModPowerCostPCT | Missing |
| 73 | SPELL_AURA_MOD_POWER_COST_SCHOOL | HandleModPowerCost | Missing |
| 74 | SPELL_AURA_REFLECT_SPELLS_SCHOOL | HandleNoImmediateEffect | Missing |
| 75 | SPELL_AURA_MOD_LANGUAGE | HandleNoImmediateEffect | Missing |
| 76 | SPELL_AURA_FAR_SIGHT | HandleFarSight | Missing |
| 77 | SPELL_AURA_MECHANIC_IMMUNITY | HandleModMechanicImmunity | Baseline |
| 78 | SPELL_AURA_MOUNTED | HandleAuraMounted | Missing |
| 79 | SPELL_AURA_MOD_DAMAGE_PERCENT_DONE | HandleModDamagePercentDone | Baseline |
| 80 | SPELL_AURA_MOD_PERCENT_STAT | HandleModPercentStat | Baseline |
| 81 | SPELL_AURA_SPLIT_DAMAGE_PCT | HandleNoImmediateEffect | Missing |
| 82 | SPELL_AURA_WATER_BREATHING | HandleWaterBreathing | Missing |
| 83 | SPELL_AURA_MOD_BASE_RESISTANCE | HandleModBaseResistance | Baseline |
| 84 | SPELL_AURA_MOD_REGEN | HandleNoImmediateEffect | Missing |
| 85 | SPELL_AURA_MOD_POWER_REGEN | HandleModPowerRegen | Missing |
| 86 | SPELL_AURA_CHANNEL_DEATH_ITEM | HandleChannelDeathItem | Missing |
| 87 | SPELL_AURA_MOD_DAMAGE_PERCENT_TAKEN | HandleNoImmediateEffect | Baseline |
| 88 | SPELL_AURA_MOD_HEALTH_REGEN_PERCENT | HandleNoImmediateEffect | Missing |
| 89 | SPELL_AURA_PERIODIC_DAMAGE_PERCENT | HandleNoImmediateEffect | Baseline |
| 90 | SPELL_AURA_90 | HandleNULL | Reference no-op |
| 91 | SPELL_AURA_MOD_DETECT_RANGE | HandleNoImmediateEffect | Missing |
| 92 | SPELL_AURA_PREVENTS_FLEEING | HandlePreventFleeing | Missing |
| 93 | SPELL_AURA_MOD_UNATTACKABLE | HandleModUnattackable | Missing |
| 94 | SPELL_AURA_INTERRUPT_REGEN | HandleNoImmediateEffect | Missing |
| 95 | SPELL_AURA_GHOST | HandleAuraGhost | Missing |
| 96 | SPELL_AURA_SPELL_MAGNET | HandleNoImmediateEffect | Missing |
| 97 | SPELL_AURA_MANA_SHIELD | HandleNoImmediateEffect | Baseline |
| 98 | SPELL_AURA_MOD_SKILL_TALENT | HandleAuraModSkill | Missing |
| 99 | SPELL_AURA_MOD_ATTACK_POWER | HandleAuraModAttackPower | Baseline |
| 100 | SPELL_AURA_AURAS_VISIBLE | HandleUnused | Reference no-op |
| 101 | SPELL_AURA_MOD_RESISTANCE_PCT | HandleModResistancePercent | Baseline |
| 102 | SPELL_AURA_MOD_MELEE_ATTACK_POWER_VERSUS | HandleNoImmediateEffect | Missing |
| 103 | SPELL_AURA_MOD_TOTAL_THREAT | HandleAuraModTotalThreat | Missing |
| 104 | SPELL_AURA_WATER_WALK | HandleAuraWaterWalk | Missing |
| 105 | SPELL_AURA_FEATHER_FALL | HandleAuraFeatherFall | Missing |
| 106 | SPELL_AURA_HOVER | HandleAuraHover | Missing |
| 107 | SPELL_AURA_ADD_FLAT_MODIFIER | HandleNoImmediateEffect | Missing |
| 108 | SPELL_AURA_ADD_PCT_MODIFIER | HandleNoImmediateEffect | Missing |
| 109 | SPELL_AURA_ADD_TARGET_TRIGGER | HandleNoImmediateEffect | Missing |
| 110 | SPELL_AURA_MOD_POWER_REGEN_PERCENT | HandleModPowerRegenPCT | Missing |
| 111 | SPELL_AURA_ADD_CASTER_HIT_TRIGGER | HandleNoImmediateEffect | Missing |
| 112 | SPELL_AURA_OVERRIDE_CLASS_SCRIPTS | HandleNoImmediateEffect | Missing |
| 113 | SPELL_AURA_MOD_RANGED_DAMAGE_TAKEN | HandleNoImmediateEffect | Missing |
| 114 | SPELL_AURA_MOD_RANGED_DAMAGE_TAKEN_PCT | HandleNoImmediateEffect | Missing |
| 115 | SPELL_AURA_MOD_HEALING | HandleNoImmediateEffect | Baseline |
| 116 | SPELL_AURA_MOD_REGEN_DURING_COMBAT | HandleNoImmediateEffect | Missing |
| 117 | SPELL_AURA_MOD_MECHANIC_RESISTANCE | HandleNoImmediateEffect | Baseline |
| 118 | SPELL_AURA_MOD_HEALING_PCT | HandleNoImmediateEffect | Baseline |
| 119 | SPELL_AURA_119 | HandleNULL | Reference no-op |
| 120 | SPELL_AURA_UNTRACKABLE | HandleAuraUntrackable | Missing |
| 121 | SPELL_AURA_EMPATHY | HandleAuraEmpathy | Missing |
| 122 | SPELL_AURA_MOD_OFFHAND_DAMAGE_PCT | HandleModOffhandDamagePercent | Missing |
| 123 | SPELL_AURA_MOD_TARGET_RESISTANCE | HandleModTargetResistance | Baseline |
| 124 | SPELL_AURA_MOD_RANGED_ATTACK_POWER | HandleAuraModRangedAttackPower | Baseline |
| 125 | SPELL_AURA_MOD_MELEE_DAMAGE_TAKEN | HandleNoImmediateEffect | Missing |
| 126 | SPELL_AURA_MOD_MELEE_DAMAGE_TAKEN_PCT | HandleNoImmediateEffect | Missing |
| 127 | SPELL_AURA_RANGED_ATTACK_POWER_ATTACKER_BONUS | HandleNoImmediateEffect | Missing |
| 128 | SPELL_AURA_MOD_POSSESS_PET | HandleModPossessPet | Missing |
| 129 | SPELL_AURA_MOD_SPEED_ALWAYS | HandleAuraModIncreaseSpeed | Baseline |
| 130 | SPELL_AURA_MOD_MOUNTED_SPEED_ALWAYS | HandleAuraModIncreaseMountedSpeed | Missing |
| 131 | SPELL_AURA_MOD_RANGED_ATTACK_POWER_VERSUS | HandleNoImmediateEffect | Missing |
| 132 | SPELL_AURA_MOD_INCREASE_ENERGY_PERCENT | HandleAuraModIncreaseEnergyPercent | Missing |
| 133 | SPELL_AURA_MOD_INCREASE_HEALTH_PERCENT | HandleAuraModIncreaseHealthPercent | Baseline |
| 134 | SPELL_AURA_MOD_MANA_REGEN_INTERRUPT | HandleAuraModRegenInterrupt | Missing |
| 135 | SPELL_AURA_MOD_HEALING_DONE | HandleModHealingDone | Baseline |
| 136 | SPELL_AURA_MOD_HEALING_DONE_PERCENT | HandleNoImmediateEffect | Baseline |
| 137 | SPELL_AURA_MOD_TOTAL_STAT_PERCENTAGE | HandleModTotalPercentStat | Baseline |
| 138 | SPELL_AURA_MOD_MELEE_HASTE | HandleModMeleeSpeedPct | Missing |
| 139 | SPELL_AURA_FORCE_REACTION | HandleForceReaction | Missing |
| 140 | SPELL_AURA_MOD_RANGED_HASTE | HandleAuraModRangedHaste | Missing |
| 141 | SPELL_AURA_MOD_RANGED_AMMO_HASTE | HandleRangedAmmoHaste | Missing |
| 142 | SPELL_AURA_MOD_BASE_RESISTANCE_PCT | HandleAuraModBaseResistancePCT | Baseline |
| 143 | SPELL_AURA_MOD_RESISTANCE_EXCLUSIVE | HandleAuraModResistanceExclusive | Baseline |
| 144 | SPELL_AURA_SAFE_FALL | HandleNoImmediateEffect | Missing |
| 145 | SPELL_AURA_MOD_PET_TALENT_POINTS | HandleAuraModPetTalentsPoints | Missing |
| 146 | SPELL_AURA_ALLOW_TAME_PET_TYPE | HandleNoImmediateEffect | Missing |
| 147 | SPELL_AURA_MECHANIC_IMMUNITY_MASK | HandleModStateImmunityMask | Missing |
| 148 | SPELL_AURA_RETAIN_COMBO_POINTS | HandleAuraRetainComboPoints | Missing |
| 149 | SPELL_AURA_REDUCE_PUSHBACK | HandleNoImmediateEffect | Missing |
| 150 | SPELL_AURA_MOD_SHIELD_BLOCKVALUE_PCT | HandleShieldBlockValuePercent | Missing |
| 151 | SPELL_AURA_TRACK_STEALTHED | HandleAuraTrackStealthed | Missing |
| 152 | SPELL_AURA_MOD_DETECTED_RANGE | HandleNoImmediateEffect | Missing |
| 153 | SPELL_AURA_SPLIT_DAMAGE_FLAT | HandleNoImmediateEffect | Missing |
| 154 | SPELL_AURA_MOD_STEALTH_LEVEL | HandleModStealthLevel | Missing |
| 155 | SPELL_AURA_MOD_WATER_BREATHING | HandleNoImmediateEffect | Missing |
| 156 | SPELL_AURA_MOD_REPUTATION_GAIN | HandleNoImmediateEffect | Missing |
| 157 | SPELL_AURA_PET_DAMAGE_MULTI | HandleNULL | Reference no-op |
| 158 | SPELL_AURA_MOD_SHIELD_BLOCKVALUE | HandleShieldBlockValue | Missing |
| 159 | SPELL_AURA_NO_PVP_CREDIT | HandleNoImmediateEffect | Missing |
| 160 | SPELL_AURA_MOD_AOE_AVOIDANCE | HandleNoImmediateEffect | Missing |
| 161 | SPELL_AURA_MOD_HEALTH_REGEN_IN_COMBAT | HandleNoImmediateEffect | Missing |
| 162 | SPELL_AURA_POWER_BURN | HandleNoImmediateEffect | Baseline |
| 163 | SPELL_AURA_MOD_CRIT_DAMAGE_BONUS | HandleNoImmediateEffect | Baseline |
| 164 | SPELL_AURA_164 | HandleUnused | Reference no-op |
| 165 | SPELL_AURA_MELEE_ATTACK_POWER_ATTACKER_BONUS | HandleNoImmediateEffect | Missing |
| 166 | SPELL_AURA_MOD_ATTACK_POWER_PCT | HandleAuraModAttackPowerPercent | Baseline |
| 167 | SPELL_AURA_MOD_RANGED_ATTACK_POWER_PCT | HandleAuraModRangedAttackPowerPercent | Baseline |
| 168 | SPELL_AURA_MOD_DAMAGE_DONE_VERSUS | HandleNoImmediateEffect | Missing |
| 169 | SPELL_AURA_MOD_CRIT_PERCENT_VERSUS | HandleNoImmediateEffect | Missing |
| 170 | SPELL_AURA_DETECT_AMORE | HandleDetectAmore | Missing |
| 171 | SPELL_AURA_MOD_SPEED_NOT_STACK | HandleAuraModIncreaseSpeed | Baseline |
| 172 | SPELL_AURA_MOD_MOUNTED_SPEED_NOT_STACK | HandleAuraModIncreaseMountedSpeed | Missing |
| 173 | SPELL_AURA_173 | HandleNULL | Reference no-op |
| 174 | SPELL_AURA_MOD_SPELL_DAMAGE_OF_STAT_PERCENT | HandleModSpellDamagePercentFromStat | Missing |
| 175 | SPELL_AURA_MOD_SPELL_HEALING_OF_STAT_PERCENT | HandleModSpellHealingPercentFromStat | Missing |
| 176 | SPELL_AURA_SPIRIT_OF_REDEMPTION | HandleSpiritOfRedemption | Missing |
| 177 | SPELL_AURA_AOE_CHARM | HandleCharmConvert | Missing |
| 178 | SPELL_AURA_MOD_DEBUFF_RESISTANCE | HandleNoImmediateEffect | Missing |
| 179 | SPELL_AURA_MOD_ATTACKER_SPELL_CRIT_CHANCE | HandleNoImmediateEffect | Baseline |
| 180 | SPELL_AURA_MOD_FLAT_SPELL_DAMAGE_VERSUS | HandleNoImmediateEffect | Missing |
| 181 | SPELL_AURA_181 | HandleNULL | Reference no-op |
| 182 | SPELL_AURA_MOD_RESISTANCE_OF_STAT_PERCENT | HandleAuraModResistenceOfStatPercent | Missing |
| 183 | SPELL_AURA_MOD_CRITICAL_THREAT | HandleNULL | Reference no-op |
| 184 | SPELL_AURA_MOD_ATTACKER_MELEE_HIT_CHANCE | HandleNoImmediateEffect | Missing |
| 185 | SPELL_AURA_MOD_ATTACKER_RANGED_HIT_CHANCE | HandleNoImmediateEffect | Missing |
| 186 | SPELL_AURA_MOD_ATTACKER_SPELL_HIT_CHANCE | HandleNoImmediateEffect | Baseline |
| 187 | SPELL_AURA_MOD_ATTACKER_MELEE_CRIT_CHANCE | HandleNoImmediateEffect | Missing |
| 188 | SPELL_AURA_MOD_ATTACKER_RANGED_CRIT_CHANCE | HandleNoImmediateEffect | Missing |
| 189 | SPELL_AURA_MOD_RATING | HandleModRating | Missing |
| 190 | SPELL_AURA_MOD_FACTION_REPUTATION_GAIN | HandleNoImmediateEffect | Missing |
| 191 | SPELL_AURA_USE_NORMAL_MOVEMENT_SPEED | HandleAuraModUseNormalSpeed | Missing |
| 192 | SPELL_AURA_MOD_MELEE_RANGED_HASTE | HandleModMeleeRangedSpeedPct | Missing |
| 193 | SPELL_AURA_MELEE_SLOW | HandleModCombatSpeedPct | Missing |
| 194 | SPELL_AURA_MOD_TARGET_ABSORB_SCHOOL | HandleNoImmediateEffect | Missing |
| 195 | SPELL_AURA_MOD_TARGET_ABILITY_ABSORB_SCHOOL | HandleNoImmediateEffect | Missing |
| 196 | SPELL_AURA_MOD_COOLDOWN | HandleNoImmediateEffect | Missing |
| 197 | SPELL_AURA_MOD_ATTACKER_SPELL_AND_WEAPON_CRIT_CHANCE | HandleNoImmediateEffect | Missing |
| 198 | SPELL_AURA_198 | HandleNULL | Reference no-op |
| 199 | SPELL_AURA_MOD_INCREASES_SPELL_PCT_TO_HIT | HandleNoImmediateEffect | Baseline |
| 200 | SPELL_AURA_MOD_XP_PCT | HandleNoImmediateEffect | Missing |
| 201 | SPELL_AURA_FLY | HandleAuraAllowFlight | Missing |
| 202 | SPELL_AURA_IGNORE_COMBAT_RESULT | HandleNoImmediateEffect | Missing |
| 203 | SPELL_AURA_MOD_ATTACKER_MELEE_CRIT_DAMAGE | HandleNoImmediateEffect | Missing |
| 204 | SPELL_AURA_MOD_ATTACKER_RANGED_CRIT_DAMAGE | HandleNoImmediateEffect | Missing |
| 205 | SPELL_AURA_MOD_SCHOOL_CRIT_DMG_TAKEN | HandleNULL | Reference no-op |
| 206 | SPELL_AURA_MOD_INCREASE_FLIGHT_SPEED | HandleAuraModIncreaseFlightSpeed | Missing |
| 207 | SPELL_AURA_MOD_INCREASE_MOUNTED_FLIGHT_SPEED | HandleAuraModIncreaseFlightSpeed | Missing |
| 208 | SPELL_AURA_MOD_FLIGHT_SPEED_ALWAYS | HandleAuraModIncreaseFlightSpeed | Missing |
| 209 | SPELL_AURA_MOD_MOUNTED_FLIGHT_SPEED_ALWAYS | HandleAuraModIncreaseFlightSpeed | Missing |
| 210 | SPELL_AURA_MOD_FLIGHT_SPEED_NOT_STACKING | HandleAuraModIncreaseFlightSpeed | Missing |
| 211 | SPELL_AURA_MOD_FLIGHT_SPEED_MOUNTED_NOT_STACKING | HandleAuraModIncreaseFlightSpeed | Missing |
| 212 | SPELL_AURA_MOD_RANGED_ATTACK_POWER_OF_STAT_PERCENT | HandleAuraModRangedAttackPowerOfStatPercent | Missing |
| 213 | SPELL_AURA_MOD_RAGE_FROM_DAMAGE_DEALT | HandleNoImmediateEffect | Missing |
| 214 | SPELL_AURA_214 | HandleNULL | Reference no-op |
| 215 | SPELL_AURA_ARENA_PREPARATION | HandleArenaPreparation | Missing |
| 216 | SPELL_AURA_HASTE_SPELLS | HandleModCastingSpeed | Missing |
| 217 | SPELL_AURA_MOD_MELEE_HASTE_2 | HandleNULL | Reference no-op |
| 218 | SPELL_AURA_HASTE_RANGED | HandleAuraModRangedHaste | Missing |
| 219 | SPELL_AURA_MOD_MANA_REGEN_FROM_STAT | HandleModManaRegen | Missing |
| 220 | SPELL_AURA_MOD_RATING_FROM_STAT | HandleModRatingFromStat | Missing |
| 221 | SPELL_AURA_MOD_DETAUNT | HandleModDetaunt | Missing |
| 222 | SPELL_AURA_222 | HandleUnused | Reference no-op |
| 223 | SPELL_AURA_RAID_PROC_FROM_CHARGE | HandleNoImmediateEffect | Missing |
| 224 | SPELL_AURA_224 | HandleUnused | Reference no-op |
| 225 | SPELL_AURA_RAID_PROC_FROM_CHARGE_WITH_VALUE | HandleNoImmediateEffect | Missing |
| 226 | SPELL_AURA_PERIODIC_DUMMY | HandleNoImmediateEffect | Baseline: generic body; scripted spells are refused |
| 227 | SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE | HandleNoImmediateEffect | Baseline |
| 228 | SPELL_AURA_DETECT_STEALTH | HandleNoImmediateEffect | Missing |
| 229 | SPELL_AURA_MOD_AOE_DAMAGE_AVOIDANCE | HandleNoImmediateEffect | Missing |
| 230 | SPELL_AURA_230 | HandleAuraModIncreaseMaxHealth | Missing |
| 231 | SPELL_AURA_PROC_TRIGGER_SPELL_WITH_VALUE | HandleNoImmediateEffect | Missing |
| 232 | SPELL_AURA_MECHANIC_DURATION_MOD | HandleNoImmediateEffect | Missing |
| 233 | SPELL_AURA_CHANGE_MODEL_FOR_ALL_HUMANOIDS | HandleUnused | Reference no-op |
| 234 | SPELL_AURA_MECHANIC_DURATION_MOD_NOT_STACK | HandleNoImmediateEffect | Missing |
| 235 | SPELL_AURA_MOD_DISPEL_RESIST | HandleNoImmediateEffect | Missing |
| 236 | SPELL_AURA_CONTROL_VEHICLE | HandleAuraControlVehicle | Missing |
| 237 | SPELL_AURA_MOD_SPELL_DAMAGE_OF_ATTACK_POWER | HandleModSpellDamagePercentFromAttackPower | Missing |
| 238 | SPELL_AURA_MOD_SPELL_HEALING_OF_ATTACK_POWER | HandleModSpellHealingPercentFromAttackPower | Missing |
| 239 | SPELL_AURA_MOD_SCALE_2 | HandleAuraModScale | Missing |
| 240 | SPELL_AURA_MOD_EXPERTISE | HandleAuraModExpertise | Missing |
| 241 | SPELL_AURA_FORCE_MOVE_FORWARD | HandleForceMoveForward | Missing |
| 242 | SPELL_AURA_MOD_SPELL_DAMAGE_FROM_HEALING | HandleNULL | Reference no-op |
| 243 | SPELL_AURA_MOD_FACTION | HandleAuraModFaction | Missing |
| 244 | SPELL_AURA_COMPREHEND_LANGUAGE | HandleComprehendLanguage | Missing |
| 245 | SPELL_AURA_MOD_AURA_DURATION_BY_DISPEL | HandleNoImmediateEffect | Missing |
| 246 | SPELL_AURA_MOD_AURA_DURATION_BY_DISPEL_NOT_STACK | HandleNoImmediateEffect | Missing |
| 247 | SPELL_AURA_CLONE_CASTER | HandleAuraCloneCaster | Missing |
| 248 | SPELL_AURA_MOD_COMBAT_RESULT_CHANCE | HandleNoImmediateEffect | Missing |
| 249 | SPELL_AURA_CONVERT_RUNE | HandleAuraConvertRune | Missing |
| 250 | SPELL_AURA_MOD_INCREASE_HEALTH_2 | HandleAuraModIncreaseHealth | Baseline |
| 251 | SPELL_AURA_MOD_ENEMY_DODGE | HandleNoImmediateEffect | Missing |
| 252 | SPELL_AURA_MOD_SPEED_SLOW_ALL | HandleModCombatSpeedPct | Missing |
| 253 | SPELL_AURA_MOD_BLOCK_CRIT_CHANCE | HandleNoImmediateEffect | Missing |
| 254 | SPELL_AURA_MOD_DISARM_OFFHAND | HandleAuraModDisarm | Missing |
| 255 | SPELL_AURA_MOD_MECHANIC_DAMAGE_TAKEN_PERCENT | HandleNoImmediateEffect | Missing |
| 256 | SPELL_AURA_NO_REAGENT_USE | HandleNoReagentUseAura | Missing |
| 257 | SPELL_AURA_MOD_TARGET_RESIST_BY_SPELL_CLASS | HandleNULL | Reference no-op |
| 258 | SPELL_AURA_258 | HandleNULL | Reference no-op |
| 259 | SPELL_AURA_MOD_HOT_PCT | HandleNoImmediateEffect | Baseline |
| 260 | SPELL_AURA_SCREEN_EFFECT | HandleNoImmediateEffect | Missing |
| 261 | SPELL_AURA_PHASE | HandlePhase | Missing |
| 262 | SPELL_AURA_ABILITY_IGNORE_AURASTATE | HandleNoImmediateEffect | Missing |
| 263 | SPELL_AURA_ALLOW_ONLY_ABILITY | HandleAuraAllowOnlyAbility | Missing |
| 264 | SPELL_AURA_264 | HandleUnused | Reference no-op |
| 265 | SPELL_AURA_265 | HandleUnused | Reference no-op |
| 266 | SPELL_AURA_266 | HandleUnused | Reference no-op |
| 267 | SPELL_AURA_MOD_IMMUNE_AURA_APPLY_SCHOOL | HandleNoImmediateEffect | Missing |
| 268 | SPELL_AURA_MOD_ATTACK_POWER_OF_STAT_PERCENT | HandleAuraModAttackPowerOfStatPercent | Missing |
| 269 | SPELL_AURA_MOD_IGNORE_TARGET_RESIST_MODIFIERS | HandleNoImmediateEffect | Missing |
| 270 | SPELL_AURA_MOD_ABILITY_IGNORE_TARGET_RESIST | HandleNoImmediateEffect | Missing |
| 271 | SPELL_AURA_MOD_DAMAGE_FROM_CASTER | HandleNoImmediateEffect | Baseline |
| 272 | SPELL_AURA_IGNORE_MELEE_RESET | HandleNoImmediateEffect | Missing |
| 273 | SPELL_AURA_X_RAY | HandleUnused | Reference no-op |
| 274 | SPELL_AURA_ABILITY_CONSUME_NO_AMMO | HandleNoImmediateEffect | Missing |
| 275 | SPELL_AURA_MOD_IGNORE_SHAPESHIFT | HandleNoImmediateEffect | Missing |
| 276 | SPELL_AURA_MOD_DAMAGE_DONE_FOR_MECHANIC | HandleNULL | Reference no-op |
| 277 | SPELL_AURA_MOD_MAX_AFFECTED_TARGETS | HandleNoImmediateEffect | Missing |
| 278 | SPELL_AURA_MOD_DISARM_RANGED | HandleAuraModDisarm | Missing |
| 279 | SPELL_AURA_INITIALIZE_IMAGES | HandleNoImmediateEffect | Missing |
| 280 | SPELL_AURA_MOD_ARMOR_PENETRATION_PCT | HandleNoImmediateEffect | Missing |
| 281 | SPELL_AURA_MOD_HONOR_GAIN_PCT | HandleNoImmediateEffect | Missing |
| 282 | SPELL_AURA_MOD_BASE_HEALTH_PCT | HandleAuraIncreaseBaseHealthPercent | Missing |
| 283 | SPELL_AURA_MOD_HEALING_RECEIVED | HandleNoImmediateEffect | Baseline |
| 284 | SPELL_AURA_LINKED | HandleAuraLinked | Missing |
| 285 | SPELL_AURA_MOD_ATTACK_POWER_OF_ARMOR | HandleAuraModAttackPowerOfArmor | Missing |
| 286 | SPELL_AURA_ABILITY_PERIODIC_CRIT | HandleNoImmediateEffect | Missing |
| 287 | SPELL_AURA_DEFLECT_SPELLS | HandleNoImmediateEffect | Missing |
| 288 | SPELL_AURA_IGNORE_HIT_DIRECTION | HandleNoImmediateEffect | Missing |
| 289 | SPELL_AURA_PREVENT_DURABILITY_LOSS | HandleNoImmediateEffect | Missing |
| 290 | SPELL_AURA_MOD_CRIT_PCT | HandleAuraModCritPct | Missing |
| 291 | SPELL_AURA_MOD_XP_QUEST_PCT | HandleNoImmediateEffect | Missing |
| 292 | SPELL_AURA_OPEN_STABLE | HandleAuraOpenStable | Missing |
| 293 | SPELL_AURA_OVERRIDE_SPELLS | HandleAuraOverrideSpells | Missing |
| 294 | SPELL_AURA_PREVENT_REGENERATE_POWER | HandleModManaRegen | Missing |
| 295 | SPELL_AURA_295 | HandleNULL | Reference no-op |
| 296 | SPELL_AURA_SET_VEHICLE_ID | HandleAuraSetVehicle | Missing |
| 297 | SPELL_AURA_BLOCK_SPELL_FAMILY | HandleNULL | Reference no-op |
| 298 | SPELL_AURA_STRANGULATE | HandleNULL | Reference no-op |
| 299 | SPELL_AURA_299 | HandleNULL | Reference no-op |
| 300 | SPELL_AURA_SHARE_DAMAGE_PCT | HandleNoImmediateEffect | Missing |
| 301 | SPELL_AURA_SCHOOL_HEAL_ABSORB | HandleNoImmediateEffect | Missing |
| 302 | SPELL_AURA_302 | HandleNULL | Reference no-op |
| 303 | SPELL_AURA_MOD_DAMAGE_DONE_VERSUS_AURASTATE | HandleNoImmediateEffect | Missing |
| 304 | SPELL_AURA_MOD_FAKE_INEBRIATE | HandleAuraModFakeInebriation | Missing |
| 305 | SPELL_AURA_MOD_MINIMUM_SPEED | HandleAuraModIncreaseSpeed | Missing |
| 306 | SPELL_AURA_306 | HandleNULL | Reference no-op |
| 307 | SPELL_AURA_HEAL_ABSORB_TEST | HandleNULL | Reference no-op |
| 308 | SPELL_AURA_MOD_CRIT_CHANCE_FOR_CASTER | HandleNoImmediateEffect | Missing |
| 309 | SPELL_AURA_309 | HandleNULL | Reference no-op |
| 310 | SPELL_AURA_MOD_CREATURE_AOE_DAMAGE_AVOIDANCE | HandleNoImmediateEffect | Missing |
| 311 | SPELL_AURA_311 | HandleNULL | Reference no-op |
| 312 | SPELL_AURA_312 | HandleNULL | Reference no-op |
| 313 | SPELL_AURA_313 | HandleNULL | Reference no-op |
| 314 | SPELL_AURA_PREVENT_RESURRECTION | HandlePreventResurrection | Missing |
| 315 | SPELL_AURA_UNDERWATER_WALKING | HandleNoImmediateEffect | Missing |
| 316 | SPELL_AURA_PERIODIC_HASTE | HandleNoImmediateEffect | Missing |
