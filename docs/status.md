# Implementation status

Checklist for a 1:1 port of this AzerothCore tree. The client is WoW **3.3.5a build 12340**.

`[x]` means the running server in `src/` already does it. `[ ]` is still to port. A checked item is the full AzerothCore table and the behavior listed on that line.

## Runtime

- [x] Auth and world sockets on Bun
- [x] MySQL `acore_auth`, `acore_characters`, and `acore_world` through drizzle-orm on `Bun.SQL`, filled and updated by the `DBUpdater` port
- [x] Hot reload that closes the previous listeners
- [x] World tick for game time, the shutdown timer, and update-time stats
- [x] World tick that updates each session (player regeneration)
- [ ] World tick that updates maps, respawns, auras, and scripts
- [x] Server config for rates, distances, and limits (`configs/worldserver.conf`, `configs/authserver.conf`, `AC_` env)
- [x] WDBC reader for Spell, Faction, SkillLineAbility, SkillRaceClassInfo, CharStartOutfit, ChrClasses, and ChrRaces from `data/dbc`
- [ ] DBC stores the rest of the logic reads (map, talent, taxi, achievement, item display, and the rest)
- [ ] Map height, liquid, vmaps, and pathfinding mmaps
- [x] Console: `server shutdown` and `account create`
- [x] SFMT random, event processor, event map, task scheduler, timers, and string/money/utf8 helpers
- [ ] In-game GM commands, and the rest of the console command set

## Auth

- [x] SRP6 logon challenge, proof, and reconnect
- [x] Realm list for build 12340
- [ ] Create an account from the client (seeded accounts are `TEST` and `TEST2`)
- [ ] Ban, mute, IP ban, IP lock, and failed-logon lockout
- [ ] RBAC permissions
- [ ] Auth logs, uptime, and realm character counts written while the server runs
- [x] Full `db_auth` tables, including realm list, bans, mutes, RBAC, logs, motd, and uptime

## Characters

- [x] Enumerate the seeded level 1 human warrior
- [x] Create and delete a character from `playercreateinfo`
- [ ] Rename, customize, faction change, and race change
- [x] Full `characters` row loaded and saved for place and health: money, flags, taxi mask, explored zones, watched faction, and the rest of the columns
- [x] Gear shown on the character list
- [x] Rest state, logout timer, and combat logout
- [x] Death, corpse, resurrect, and graveyards
- [x] Experience, level up (`SMSG_LOG_XPGAIN`, `SMSG_LEVELUP_INFO`, new stats, talent points), and rested XP on kills
- [ ] Exploration XP (needs area ids from map data)
- [ ] Talents, dual spec, and glyphs
- [ ] Action bars and macros that persist
- [x] Skills and skill caps: `character_skills`, `playercreateinfo_skills`, SkillLine / SkillRaceClassInfo / SkillTiers, level caps, and language skills
- [ ] Weapon and defense skill gains (the code is ported; it waits for combat to call it)
- [x] Known spells from the action bar and `playercreateinfo_spell_custom` (cooldowns still empty)
- [x] Reputation slots from Faction.dbc when `data/dbc` is loaded; standing stays on `character_reputation`
- [x] Home bind from `playercreateinfo` via `character_homebind` (innkeeper bind still missing)
- [x] Health, mana, rage, energy, and runic power from `player_class_stats` and `player_race_stats`
- [x] Stat system: attributes, armor, resistances, attack power, weapon damage, ratings, crit, dodge, parry, and block from class, race, level, and equipped items (gt tables and ScalingStat from `data/dbc`)
- [x] Health, mana, rage, energy, and runic power regeneration on the world tick
- [ ] Stat changes from auras, enchantments, gems, item sets, and shapeshift forms
- [x] Save the character, not only the last position

## Enter world

- [x] Session auth, addon info, and client cache version
- [x] Login burst through the loading screen
- [x] Player create block for the seeded warrior
- [x] Name query, time query, zone update, ping, realm split, and logout
- [x] Time sync
- [ ] Account data read and write (UI settings)
- [x] Tutorials stored per account (`account_tutorial`, `CMSG_TUTORIAL_FLAG`/`CLEAR`/`RESET`)
- [x] Spells and action buttons filled from the character
- [ ] Factions are filled when `data/dbc` is present; talents, achievements, and equipment sets are still empty
- [ ] Cinematic and taxi nodes on first login
- [ ] Motd and feature-system flags from config
- [x] Bind point from `character_homebind`

## Movement

- [x] Apply the local player's movement packets
- [x] Reject illegal movement flags
- [x] Kick a run speed above 7, and correct a slower speed ack
- [x] Fall damage
- [x] Near and far teleport packets
- [x] A spell, taxi, hearth, or command that actually starts a teleport
- [x] Broadcast movement to other players
- [ ] Server splines, charge, knockback, and root
- [ ] Swim, fly, and water walk only while an aura allows them
- [ ] Ground height, liquid, and not falling through the world
- [ ] Transports and elevators as the mover
- [ ] Teleport and wall-climb checks beyond the speed cap

## Maps and visibility

- [x] Spawn creatures and gameobjects within 100 yards on continents and 170 in instances
- [x] Destroy them when they leave that range
- [x] Show phase bit 1 and normal spawn-mask bit 0 only
- [ ] Grid load, unload, and active objects
- [ ] Battleground visibility at 250 yards
- [ ] Phases from auras, quests, and GM, not a fixed mask of 1
- [ ] Dungeon and raid spawn modes (heroic, 10, 25)
- [ ] Creatures and objects flagged visible from the whole map
- [x] Other players: create, update, and destroy within the same visibility range as creatures
- [ ] Gear, auras, and sheath state on other players

## World data

- [x] Full columns on every world table, loaded from `sql/base/db_world` when the server starts
- [x] Import the dumps with AzerothCore's event, pool, phase, and missing-model filters
- [x] Creature, gameobject, and item rows used for spawn and query
- [x] `creature_classlevelstats` for health, mana, damage, armor, attack power, and the five stats on the create packet
- [ ] `creature_template_addon`, `creature_addon`, and `gameobject_addon` (emote, mount, auras, bytes, parent rotation, flags)
- [x] Quest items in the creature and gameobject query (`creature_questitem`, `gameobject_questitem`)
- [x] School resistances from `creature_template` on the create packet
- [ ] Template gold, spells, and `flags_extra`
- [ ] Name locales
- [ ] Spawn groups
- [ ] Conditions

## Creatures

- [x] Create packet with model, faction, saved health, speeds, and virtual weapons
- [x] Creature query
- [ ] Stand, wander, and follow waypoints
- [ ] Formations, escorts, and linked pulls
- [x] Respawn and corpse decay (`Corpse.Decay.*`, faster once looted, `spawntimesecs`)
- [x] Aggro, threat, leash, evade, and call for help (proximity aggro for reputation factions needs `Faction.dbc` in `data/dbc`)
- [x] Melee attacks, chase, and facing
- [ ] Ranged and spell attacks
- [ ] Loot, skinning, and pickpocket
- [x] Gossip menus, options, npc text, points of interest, and hello conditions
- [x] Quest giver status, quest list, details, accept, progress, and turn-in
- [ ] Vendor, trainer, banker, flight master, stable, and spirit healer windows (gossip closes, or sends an empty vendor list)
- [ ] Cursor flags for vendor and repair
- [ ] SmartAI and creature scripts
- [ ] Guards assisting players
- [ ] Rare, elite, and boss rank
- [ ] Summons and temporary spawns
- [ ] Creature text and emotes

## Game objects

- [x] Create packet with display, state, rotation, and type
- [x] Gameobject query
- [ ] Use doors, buttons, chests, chairs, mailboxes, meeting stones, and goobers
- [ ] Locks and lockpicking
- [ ] Traps, fishing nodes, and summoning rituals
- [ ] Destructible buildings
- [ ] Respawn, and door state saved inside an instance
- [ ] Linked traps and gameobject scripts
- [ ] Transports and elevators
- [x] Quest status icon on creatures and objects (`CMSG_QUESTGIVER_STATUS_QUERY`)

## Items

- [x] Item query, including the templates creature weapons point at
- [x] Bags, backpack, bank, and keyring
- [x] Equip and show that gear on the player
- [ ] Item instances: durability, charges, enchants, gems, and random properties
- [x] Use an item, and take cooldown from the spell when the template cooldown is -1
- [ ] Stacks, unique caps, and soulbound
- [x] Buy, sell, repair, and buyback
- [ ] Refunds and soulbound trade time
- [ ] Sets, enchantments, and sockets
- [ ] Currency tokens and conjured items
- [ ] Equipment sets

## Loot

- [x] Creature, object, pickpocket, skinning, fishing, disenchant, milling, and prospecting tables
- [x] Reference loot and loot groups
- [x] Free for all, round robin, group loot, need before greed, and master looter
- [x] Personal loot and who is allowed to open it

## Spells and auras

Detailed gap inventory: [spell-system-gaps.md](spell-system-gaps.md).

- [x] Load spells and cast them (baseline effect and aura sets; everything else is refused before it spends)
- [x] Cast time, interrupt, pushback, channels, and the global cooldown
- [x] Range, facing, and targets (line of sight waits for vmaps)
- [ ] Effects, damage, healing, and summon (baseline effects done; summons missing)
- [x] Auras, stacks, duration, and exclusive groups
- [ ] Procs, linked spells, and spell scripts (linked spells done; procs and scripts missing)
- [x] Threat from spells
- [ ] Totems, traps, and dynamic objects
- [ ] Pet spells
- [ ] Mounts, shapeshift, stealth, and invisibility
- [x] Spell coefficients and school damage

## Combat

- [x] Fall damage
- [x] Melee swings, main hand and off hand, with swing timers, range, and facing errors
- [x] Hit, miss, dodge, parry, block, glance, crush, and crit
- [x] Armor and resistance values on the player
- [x] Armor and melee crit resilience in the damage roll
- [x] Spell resistance and resilience damage reduction
- [x] Weapon damage and attack speed from the equipped item on the player
- [x] PvE combat state, tapping, kill XP, kill credit, and loot rolled at the kill
- [ ] PvP combat rules
- [ ] Duels
- [ ] Combat log
- [ ] Unit states such as stunned, rooted, and confused (stun and root done; confuse and fear movement missing)

## Quests

- [x] Quest template, objectives, and money, experience, spell, and reputation rewards
- [x] Accept, progress, complete, and abandon, stored in `character_queststatus*`
- [x] Reorder the quest log, and share or confirm a quest with party members who are already grouped (forming the party is still open)
- [x] Gossip text and quest greeting
- [x] Kill, talk, explore, and item counters (items wait for bags)
- [x] Daily, weekly, monthly, and seasonal lockouts
- [ ] Quest item and starter item delivery (no bags or mail yet, so the quest still completes)
- [ ] Shared kills in a group
- [x] Quest POI

## Pets and vehicles

- [ ] Hunter, warlock, and mage pets
- [ ] Stable, rename, and pet talents
- [ ] Saved pet spells and auras
- [ ] Vehicles, seats, and accessories
- [ ] Charm and possess

## Reputation, skills, and professions

- [x] Who is hostile, from faction templates (and reputation when `Faction.dbc` is loaded)
- [ ] Reputation gain, spillover, and rewards
- [ ] Primary and secondary professions
- [ ] Craft, discover, and bonus items
- [ ] Fishing skill by zone
- [ ] Lockpicking and poisons

## Chat and social

- [ ] Say, yell, whisper, emote, party, raid, guild, and officer
- [ ] Custom channels, moderation, and bans
- [ ] Friends, ignore, and who
- [ ] Chat filter
- [ ] Addon messages

## Groups and LFG

- [ ] Party and raid invite, kick, leader, and loot rules
- [ ] Ready check and target icons
- [ ] Loot rolls
- [ ] Dungeon finder queue

## Guilds

- [ ] Create, ranks, invite, and motd
- [ ] Guild bank, tabs, rights, and withdraw limits
- [ ] Charter petitions

## Mail and auction house

- [ ] Send, take, return, and expire mail
- [ ] Cash on delivery and attached items
- [ ] Auction list, bid, buyout, and expire
- [ ] Server mail from templates

## Trade

- [ ] Trade items and money with another player
- [ ] Trade spells such as enchanting

## Calendar

- [ ] Raid and guild events, invites, and lockouts

## PvP

- [ ] Battleground queue, start, score, and leave
- [ ] Arenas, teams, and seasons
- [ ] Outdoor PvP and world PvP objectives
- [ ] Honor, marks, and deserter
- [ ] Wintergrasp
- [ ] Arena spectator

## Instances

- [ ] Create the map, bind the player, and reset the lock
- [ ] Heroic and raid size
- [ ] Boss state and saved object state
- [ ] Meeting stone summon

## World systems

- [ ] Weather
- [ ] Game clock and the speed sent at login taken from config
- [ ] Transport paths
- [ ] World states
- [x] Graveyards
- [ ] Area triggers
- [ ] Game events that turn spawns on and off (the rows are in the database; the spawn list still shows the default set)
- [ ] Pools that pick a new member after one dies (the rows are in the database; the spawn list still keeps the initial pick)
- [ ] Autobroadcast
- [ ] Broadcast texts

## Achievements

- [ ] Criteria, progress, and rewards
- [ ] Send earned achievements at login (the packet is empty)

## GM, tickets, and Warden

- [ ] Tickets and GM security
- [ ] Warden
- [ ] Bug reports and lag reports
- [ ] Refer-a-friend

## Scripting

- [ ] Conditions
- [ ] Smart scripts
- [ ] Waypoint, gossip, and spell scripts stored in SQL
- [ ] C++ scripts for spells, bosses, instances, and zones
- [ ] Script texts and their locales
