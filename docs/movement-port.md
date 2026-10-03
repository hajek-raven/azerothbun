# Movement port: Spline layer and WaypointMgr

Port of `azerothcore/src/server/game/Movement/Spline/*` and `Movement/Waypoints/*` to `src/game/Movement/`. It follows
`AGENTS.md` and `docs/porting-workflow.md`: C++-mirrored paths, C++ names (methods with a lower-case first letter,
underscore names such as `_Spline` and `_updateState` and free functions such as `computeFallTime` unchanged), `@ac` tags.
`MotionMaster` and the movement generators are a separate stream (`src/game/Movement/MotionMaster.ts`,
`MovementGenerators/*`).

## Files

| TypeScript | C++ |
| --- | --- |
| `Spline/MovementTypedefs.ts` | `MovementTypedefs.h` (`SecToMS`, `MSToSec`, `counter`, `UInt32Counter`) |
| `Spline/MovementUtil.ts` | `MovementUtil.cpp` (`gravity`, `splineIdGen`, `computeFallTime`, `computeFallElevation`, flag name tables) |
| `Spline/MoveSplineFlag.ts` | `MoveSplineFlag.h`, `MoveSplineFlag::ToString` |
| `Spline/Spline.ts` | `Spline.h`, `Spline.cpp`, `SplineImpl.h` (`SplineBase`, `Spline<length_type>`) |
| `Spline/MoveSplineInitArgs.ts` | `MoveSplineInitArgs.h`, `MoveSplineInitArgs::Validate` / `_checkPathBounds` (`MoveSpline.cpp`) |
| `Spline/MoveSpline.ts` | `MoveSpline.h`, `MoveSpline.cpp` |
| `Spline/MovementPacketBuilder.ts` | `MovementPacketBuilder.h`, `.cpp` (`PacketBuilder`, `WriteLinearPath`, ...), `ByteBuffer::appendPackXYZ` |
| `Spline/MoveSplineInit.ts` | `MoveSplineInit.h`, `.cpp` (`MoveSplineInit`, `TransportPathTransform`, `HoverMovementTransform`, `SelectSpeedType`) |
| `Waypoints/WaypointDefines.ts` | `WaypointDefines.h` |
| `Waypoints/WaypointMgr.ts` | `WaypointMgr.h`, `.cpp` (`Load`, `LoadWaypointAddons`, `ReloadPath`, `GetPath`) |
| `../Entities/Unit/UnitDefines.ts` | `UnitDefines.h` `UnitMoveType`, `MovementFlags`, `MovementFlags2`; `AnimTier` of `MotionMaster.h` |

## API notes for the integration step

- `MoveSplineInit` is constructed with a `MoveSplineUnit` (declared in `MoveSplineInit.ts`; extends `PathSource` of
  `PathGenerator.ts`). Every `Unit` member the C++ touches is listed there with its `@ac` tag. The packet leaves only through
  `unit.sendMessageToSet({ opcode, payload }, true)`.
- Overloads are single methods: `setFacing(angle | Vector3 | unit)`, `moveTo(start, dest, ...)` / `moveTo(dest, ...)` /
  `moveTo(x, y, z, ...)`. C++ `operator&` / `operator|` of `MoveSplineFlag` are `and()` / `or()`; `raw()` reads the word.
- `MoveSpline`: `initialize`, `updateState(diff, handler?)`, `computePosition`, `duration`, `timePassed`, `timeElapsed`,
  `finalized`, `initialized`, `isCyclic`, `isFalling`, `finalDestination`, `currentDestination`, `currentPathIdx`,
  `maxPathIdx`, `getPath`, `_Spline`, `_Finalize`, `_Interrupt`, `onTransport`. The C++ field `velocity` is `_velocity`
  (the method `Velocity()` is `velocity()`). The `protected` members `PacketBuilder` reads are public.
- `UpdateResult` values are `MoveSpline.Result_*`; `_updateState` takes `{ value }` for its `int32&`.
- Floats: C++ `float` results are rounded with `Math.fround` where they feed a result (spline evaluation, lengths, durations,
  fall and parabolic elevation, packed offsets). Float to `int32` conversion is `floatToInt32` (x86 `cvttss2si`: out of range
  gives `INT32_MIN`, which the C++ overflow check relies on). `cosf`/`sinf`/`atan2f` are the double `Math` functions rounded to
  float and can differ in the last ulp.
- `SMSG_MONSTER_MOVE` comes from `combat/constants.ts`; `SMSG_MONSTER_MOVE_TRANSPORT` (0x2ae) is a constant in `MoveSplineInit.ts`
  because the port has no opcode table yet.

## Stubbed or skipped (`@ac-skip`)

- `Unit` members (`movespline`, `getDirectTransport`, `getVehicleBase`, ...) are the interface `MoveSplineUnit`; `Creature` implements them (see the integration section below).
- `MovementInfo::GetSpeedType` (`Object.ts`) calls `SelectSpeedType` of `MoveSplineInit.ts`.
- Transports: `getDirectTransport()` returns `null` until `Transport`/`TransportBase` are ported.
- `sWaypointMgr().load()` and `.loadWaypointAddons()` run from `loadMovementData` (`Maps/MapSetup.ts`, called by `startMapSystem`).
- `WaypointMgr::DeletePath` does not exist in this AzerothCore revision.
- `FacingInfo` is not a union: `f`, `target` and `angle` are separate fields (the flags choose which one is read).

## Tests

`bun test src/game/Movement/Spline src/game/Movement/Waypoints`: linear, Catmull-Rom and cyclic evaluation, `MoveSpline`
initialization, update, position, falling and parabolic elevation, exact `SMSG_MONSTER_MOVE` / `SMSG_MONSTER_MOVE_TRANSPORT`
and stop bytes, create-block bytes, waypoint loading (`WorldTables.fromRows`, and `WaypointMgr.data.test.ts` over the real
`acore_world` when MySQL is running).

# Movement port: MotionMaster and the movement generators

Port of `azerothcore/src/server/game/Movement/{MotionMaster,MovementGenerator,AbstractFollower}.{h,cpp}`,
`Movement/MovementGenerators/*` (all but `PathGenerator`, which is the maps stream's) and the part of
`Entities/Creature/CreatureGroups.{h,cpp}` that the formation generator needs (`creature_formations`, `FormationMgr`,
`CreatureGroup`). It sits on the spline layer above, on `PathGenerator`, and on `WaypointMgr`. The integration into `Unit`,
`Creature`, `Player`, the combat code and the session code is the integration section at the end of this file.

## Files

| TypeScript | C++ |
| --- | --- |
| `Movement/MotionMaster.ts` | `MotionMaster.{h,cpp}`: `MovementGeneratorType`, `MovementSlot`, `MMCleanFlag`, `ForcedMovement`, `RotateDirection`, `PathSource` (the enum class; `PathGenerator.ts` has an interface of the same name), `ChaseRange`, `ChaseAngle`, `MotionMaster` |
| `Movement/MovementGenerator.ts` | `MovementGenerator.{h,cpp}`: `MovementGenerator`, `MovementGeneratorMedium`, `MovementGeneratorCreator`, `MovementGeneratorFactory`, `sMovementGeneratorRegistry` |
| `Movement/AbstractFollower.ts` | `AbstractFollower.{h,cpp}` |
| `Movement/MovementOwner.ts` | the owner interfaces (see below), `MovementCreatureAI`, the `UNIT_STATE_ALL_STATE` of `HomeMovementGenerator` |
| `Movement/MovementGenerators/IdleMovementGenerator.ts` | `IdleMovementGenerator`, `RotateMovementGenerator`, `DistractMovementGenerator`, `AssistanceDistractMovementGenerator`, and `IdleMovementFactory` (from `MovementGenerator.cpp`: it lives here because of an import cycle) |
| `.../RandomMovementGenerator.ts` | `RandomMovementGenerator<Creature>` |
| `.../WaypointMovementGenerator.ts` | `PathMovementBase`, `WaypointMovementGenerator<Creature>`, `FlightPathMovementGenerator` |
| `.../HomeMovementGenerator.ts` | `HomeMovementGenerator<Creature>` |
| `.../PointMovementGenerator.ts` | `PointMovementGenerator<T>`, `AssistanceMovementGenerator`, `EffectMovementGenerator` |
| `.../TargetedMovementGenerator.ts` | `ChaseMovementGenerator<T>`, `FollowMovementGenerator<T>`, `ChaseMovementMode` |
| `.../FleeingMovementGenerator.ts` | `FleeingMovementGenerator<T>`, `TimedFleeingMovementGenerator` |
| `.../ConfusedMovementGenerator.ts` | `ConfusedMovementGenerator<T>` |
| `.../EscortMovementGenerator.ts` | `EscortMovementGenerator<T>` |
| `.../FormationMovementGenerator.ts` | `FormationMovementGenerator` |
| `Entities/Creature/CreatureGroups.ts` | `GroupAIFlags`, `FormationInfo`, `FormationMgr` (`sFormationMgr()`), `CreatureGroup`, and the formation members of `Creature` as free functions: `SearchFormation`, `IsFormationLeader`, `SignalFormationMovement`, `IsFormationLeaderMoveAllowed`, `Motion_Initialize` |
| `AI/CreatureAISelector.ts`, `AI/CreatureAIRegistry.ts` | the movement part of `FactorySelector::SelectMovementGenerator` and `AIRegistry::Initialize` (`AddMovementGeneratorFactories`) |
| `common/Dynamic/{FactoryHolder,ObjectRegistry}.ts` | `FactoryHolder.h`, `ObjectRegistry.h` |

This AzerothCore revision has the old `MotionMaster` (a stack of three slots, `MMCF_*` flags, `DelayedDelete` into an expire list),
not the later priority/delayed-action one. Port and tests follow this revision.

## API for the integration step

- C++ method names with a lower-case first letter: `unit.getMotionMaster().moveChase(target, new ChaseRange(5))`,
  `updateMotion(diff)`, `moveTargetedHome()`, `getCurrentMovementGeneratorType()`, `movementExpiredOnSlot(MOTION_SLOT_IDLE, false)`.
  The enums are `as const` objects with the C++ constants exported next to them (`CHASE_MOTION_TYPE`, `MOTION_SLOT_ACTIVE`, ...).
  `new MotionMaster(unit)` does not initialize: call `initialize()` (the C++ `Unit` constructor does not either; `Creature::Motion_Initialize`
  does, see `CreatureGroups.ts`). `destroy()` is `~MotionMaster`; generators have `destroy()` for the C++ destructor (the followers
  unregister there) and `MotionMaster` calls it wherever the C++ `delete`s.
- Overloads are one method: `movePoint(id, pos, ...)` / `movePoint(id, x, y, z, ...)`, `moveChase(target, ChaseRange | number | null, ChaseAngle | number | null)`,
  `moveLand`, `moveTakeoff`, `moveJump`, `moveCharge(x, y, z, ...)` / `moveCharge(PathGenerator, ...)`. `std::optional<T>` is `T | null`.
  Out parameters are returned values or objects written in place: `getDestination(out)`, `getResetPosition(out)`, `positionOkay(..., { value })`.
- Startup: call `AddMovementGeneratorFactories()` (`AI/CreatureAIRegistry.ts`) once before the first `MotionMaster::initialize`;
  `sFormationMgr().loadCreatureFormations(worldTables, (spawnId) => sObjectMgr.getCreatureData(spawnId) !== null)` after the creature
  spawn data is loaded (`creature_formations` is in `WORLD_TABLES`); `sWaypointMgr().load()` as before.
- Seams with module-level hooks: `FlightPathContext` (`WaypointMovementGenerator.ts`: `getTaxiPathNodesByPath` is `sTaxiPathNodesByPath`
  of `DBCStores.cpp`, which the port does not build yet, `getTaxiPath` is `ObjectMgr::GetTaxiPath`, `findBaseNonInstanceMap` is `sMapMgr`),
  `SmartWaypointMgrHook` (`PathSource::SMART_WAYPOINT_MGR`, null until SmartAI), `MapCollisionDataHooks.isPathfindingEnabled` (read
  by `HomeMovementGenerator`; it is the port of `DisableMgr::IsPathfindingEnabled`).
- `Creature` calls the formation helpers from the methods of the same name (`searchFormation()` -> `SearchFormation(this)`,
  `removeFromWorld` -> `sFormationMgr().removeCreatureFromGroup(this.m_formation, this)`, `isFormationLeader()`, `signalFormationMovement()`,
  `isFormationLeaderMoveAllowed()`, `motionInitialize()` -> `Motion_Initialize(this)`), and keeps `m_formation`.

## What the owners must provide

`MovementOwner`, `MovementOwnerCreature`, `MovementOwnerPlayer` (`MovementOwner.ts`) are standalone structural interfaces (they extend
`MoveSplineUnit`, hence `PathSource`, and a small `MovementObject`), not extensions of `UnitLike`: that would make `toCreature()` return the
real `Creature`, which does not satisfy them yet. Every member has an `@ac` tag. Parameters that are a `WorldObject` in the real
`WorldObject` methods are `MovementObject` (a position and a guid) here, so the real methods stay assignable. `test-movement-owner.ts`
(`FakeUnit implements MovementOwner`) shows a complete implementation.

Missing on `Creature` (`src/game/Entities/Creature/Creature.ts`) for `MovementOwnerCreature` (a type check of every member name):
`addUnitMovementFlag attack attackStop callAssistance canEnterWater canWalk castStop engageWithTarget followerAdded followerRemoved getAI
getAttackTime getBoundaryRadius getCharmerOrOwnerPlayerOrPlayerItself getCombatManager getCritterGUID getCurrentWaypointID getFollowAngle
getFormation getMeleeAttackPoint getMeleeRange getMotionMaster getMovementTemplate getSummonerUnit getTarget getUnit getVictim
hasSwimmingFlagOutOfCombat isClientControlled isControlledByPlayer isEngaged isFalling isFormationLeader isFormationLeaderMoveAllowed
isGuardian isInAccessiblePlaceFor isInCombat isMovementPreventedByCasting isMoving isPet isPossessed isStandState isStopped isSummon
isValidAttackTarget isVehicle movespline nearTeleportTo removeUnitFlag removeUnitMovementFlag sendMovementFlagUpdate setCannotReachTarget
setFacingTo setFormation setInFront setNoCallAssistance setStandState setTarget setTransportHomePosition setUnitFlag signalFormationMovement
stopMoving updateCurrentWaypointInfo updateWaypointID` (plus `m_movementInfo.getSpeedType` / `setFallTime`, `getMap()` returning
`MovementMap`, `toCreature()` / `toPlayer()` returning the narrow types).
The `Unit` members among them (everything but the creature-only `getCurrentWaypointID`, `getFormation`, `getMovementTemplate`,
`hasSwimmingFlagOutOfCombat`, `isFormationLeader*`, `setFormation`, `signalFormationMovement`, `update*Waypoint*`, `canWalk`, `canEnterWater`,
`isEngaged`, `getAttackTime`, `getCombatManager`, `setNoCallAssistance`, `callAssistance`, `setCannotReachTarget`, `setTransportHomePosition`,
`getSummonerUnit`) are the `Unit` class: `movespline` (a `MoveSpline`), `getMotionMaster()` (create `new MotionMaster(this)` in the constructor),
`followerAdded/Removed` (a `Set<AbstractFollower>`; `RemoveAllFollowers` calls `setTarget(null)` on each), `stopMoving`, `isStopped` (`!hasUnitState(UNIT_STATE_MOVING)`),
`setFacingTo`, `setInFront`, `nearTeleportTo`, `attack`, `attackStop`, `castStop`, `getVictim`, `getTarget`, `setTarget`, `isInCombat`,
`isMovementPreventedByCasting`, unit flags and movement flags, `getMeleeRange`, `getMeleeAttackPoint`, `isInAccessiblePlaceFor`,
`getBoundaryRadius`, `getCritterGUID`, `getFollowAngle`, `getUnit(guid)` (`ObjectAccessor::GetUnit`), `getAI()` and the AI hooks of `MovementCreatureAI`.
`MovementOwnerPlayer` needs, besides those: `m_taxi` (`PlayerTaxi`), `pvpInfo`, `getReputationPriceDiscount(factionTemplate)`, `dismount`, `updatePvPState`,
`updatePvP`, `setFallInformation`, `removePlayerFlag`, `updateAchievementCriteria`, `modifyMoney`, `isGameMaster`.
`Map` has everything `MovementMap` adds to `PathSourceMap` (`getId`, `getHeight`, `canReachPositionAndGetValidCoords`, `scriptsStart`,
`isBattlegroundOrArena`), but `WorldObject.getMap()` returns `MapLike`, which does not declare `canReachPositionAndGetValidCoords`
and `scriptsStart`.
`CreatureGroupsMap` (what the real `Map` satisfies): `CreatureGroupHolder` (typed `Map<number, unknown>` in `Map.ts`, holds the groups), `getCreatureRespawnTime`,
`saveCreatureRespawnTime`.

## Stubbed or skipped (`@ac-skip`)

- AI: every `CreatureAI` / `UnitAI` call is `ai()?.X?.(...)` over the optional hooks of `MovementCreatureAI` (`MovementInform`, `SummonMovementInform`,
  `JustReachedHome`, `WaypointPathStarted`, `WaypointStarted`, `WaypointReached`, `PathEndReached`, `WaypointPathEnded`, `DistancingStarted`,
  `DistancingEnded`, `AttackStart`, `EnterEvadeMode`). `CreatureAILike` (the grid layer) is not edited. `SelectAI` / `GameObjectAI` of the selector and the AI factories are not ported.
- Scripts: `Map::ScriptsStart(sWaypointScripts / sEventScripts, ...)` goes to `MovementMap.scriptsStart(null, ...)`.
- Transports: `UpdateHomePosition` of the waypoint generator does nothing for a creature on a transport (the `Transport` casts).
- Combat: `CombatManager::SetEvadeState` is `getCombatManager().setEvadeState`.
- TempSummon: `ToTempSummon()->GetSummonerUnit()` is `getSummonerUnit()`.
- SmartAI: `sSmartWaypointMgr` is `SmartWaypointMgrHook`.

## Deviations from the C++ (and why)

- A C++ template with `Player` and `Creature` specializations is one generic class; the specialized bodies branch on `owner.toCreature()` / `isPlayer()`
  (`Fleeing`/`Confused` `DoFinalize` and `_InitSpecific`, `Chase` `DoInitialize`, `Point` `MovementInform`). `Random`, `Waypoint`, `Home` exist for `Creature` only, as in C++.
- Multiple inheritance of `AbstractFollower` is composition (`_follower`, with `setTarget` / `getTarget` forwarders). Virtual destructors are `destroy()`.
- `IdleMovementFactory` is in `IdleMovementGenerator.ts` (the base class would not exist yet in `MovementGenerator.ts`, which would import it).
- `FactoryHolder` takes the registry in its constructor (a C++ template has one static `instance()` per instantiation).
- `std::map<Creature*, FormationInfo>` iterates in insertion order (C++: pointer order). `CreatureGroup::FormationReset` reads the flags of the first member, so the
  leader row should carry `GROUP_AI_FLAG_FOLLOW_LEADER` too (the data usually has `groupAI` 515 on every row).
- `UNIT_STATE_ALL_STATE` is `0xffffffff` in `MovementOwner.ts`: the generated enum table has `0x0fffffff`, which would not clear `UNIT_STATE_NO_COMBAT_MOVEMENT`
  and `UNIT_STATE_LOGOUT_TIMER` in `HomeMovementGenerator::_setTargetLocation`.
- `EffectMovementGenerator` keeps the `MoveSplineInit` it is given (C++ copies it); the callers never use it afterwards.
- `float` members are rounded with `Math.fround` where they are stored or compared (`ChaseRange`, `ChaseAngle`, wander distances, follow ranges); intermediate
  expressions use `fround` where the C++ result feeds a decision. `cosf` / `sinf` are the double functions rounded to float.
- Log categories are the scopes of `log.ts`: `movement.*` and `entities.*` are `movement`, `sql.sql` is `sql`, `maps.script` and `misc` are `maps`.
- `MoveCharge`, `MovePoint`, ... take `bigint` guids and `null` for `ObjectGuid::Empty` / `std::nullopt` where the C++ default is empty (`0n` for guids).

## Tests

`bun test src/game/Movement src/game/Entities/Creature` (all with a fake map and unit, `test-movement-owner.ts`, over the real `MoveSpline`, `MoveSplineInit` and
`PathGenerator`; `advance(diff)` is `Unit::UpdateSplineMovement` plus `MotionMaster::UpdateMotion`): `MotionMaster.test.ts` (stack, slots, priorities, delayed
deletion, clear / expire, the `Move*` entry points, `ChaseRange` / `ChaseAngle`), `MovementGenerator.test.ts` (factories, registry, selector),
`AbstractFollower.test.ts`, and per generator: idle / rotate / distract, home, random (seeded: distance, timers, links, cliffs, LOS), waypoint (path, delays,
repeat, pause, smooth splines, spline points, manager paths), flight path (taxi nodes, hops, costs, map ends, preload), point (arrival, pause, speed change with
a nav-mesh path, charge, assistance, effects), chase (range, angle, repath, distancing, lost target), follow (distance, angle, prediction, speed, teleport),
fleeing (nav mesh, timed), confused, escort, formation, and `CreatureGroups.test.ts` (loader with every skip rule, membership, assist, evade, respawn,
reset, `Motion_Initialize`).

# Movement port: integration into Creature, the combat world and the map

Creatures move in the running server through their `MotionMaster`. The map `Creature` is the source of truth for a creature's
position: `Map::Update` -> `Creature::Update` -> `Unit::Update` -> `UpdateSplineMovement` + `MotionMaster::UpdateMotion` ->
`Creature::SetPosition` -> `Map::CreatureRelocation`. The combat state (`CreatureUnit` in `src/combat/combat-world.ts`) reads its
position from the `Creature` (`unit.pos` is a getter) and calls the same `MotionMaster` entry points the C++ AI does.

## What runs

| Behaviour | C++ path | Where |
| --- | --- | --- |
| stand, wander, waypoints | `Creature::AddToWorld` -> `Motion_Initialize` -> `MotionMaster::Initialize` -> `FactorySelector::SelectMovementGenerator` (`creature.MovementType`, `wander_distance`, `creature_addon.path_id`) | `Creature.ts` (`addToWorld`, `AIM_Initialize`, `motion_Initialize`) |
| spline per tick | `Unit::UpdateSplineMovement` (with the `SplineHandler` escort inform), `UpdateSplinePosition`, `DisableSpline`, `StopMoving` | `Creature.ts` |
| chase | `CreatureAI::AttackStart` -> `Unit::Attack` + `MotionMaster::MoveChase` | `combat-world.ts` `updateEngaged` / `attackStart`, `game/AI/CoreAI/UnitAI.ts` |
| evade, home | `CreatureAI::EnterEvadeMode` -> `_EnterEvadeMode` + `MoveTargetedHome`; `HomeMovementGenerator::DoFinalize` clears `UNIT_STATE_EVADE` | `game/AI/CreatureAI.ts`, `combat-world.ts` `enterEvadeMode` / `evadeCombat` |
| death, respawn | `Unit::setDeathState(JUST_DIED)` (clear, idle, stop), `Creature::setDeathState(JUST_RESPAWNED)` (`Motion_Initialize`) | `Creature.unitDied`, `Creature.setDeathState`, `combat-world.ts` `killCreature` / `respawn` |
| formations | `SearchFormation` in `AddToWorld`, `RemoveCreatureFromGroup` in `RemoveFromWorld`, `FormationMovementGenerator` | `Creature.ts`, `CreatureGroups.ts` |
| packets | `MoveSplineInit::Launch` -> `SendMessageToSet` (the players of the creature's visible players map); the spline in the create block: `Object::BuildMovementUpdate` -> `PacketBuilder::WriteCreate` | `Creature.buildMovementUpdate`, `world/spawn.ts` `creatureCreateBlock` (4th argument is the creature) |
| visibility of a moving creature | `Unit::Update` delayed relocation timers, `ExecuteDelayedUnitRelocationEvent` (creature part), `ExecuteDelayedUnitAINotifyEvent` | `Creature.unitUpdate` |

`Creature` is not a subclass of a `Unit` class: the `Unit` members the movement code needs are on `Creature` with `@ac Unit::X` tags
(`getMotionMaster`, `movespline`, `m_movementInfo` flags, `StopMoving`, `IsStopped`, `IsMoving`, `SetFacingTo`, `SetInFront`,
`NearTeleportTo`, `SetWalk`, `SetSwim`, `SetCanFly`, `SetDisableGravity`, `SetHover`, `SetSpeed`, `UpdateSpeed`, `BuildMovementPacket`,
`SendMovementFlagUpdate`, ...), and the `Creature` members (`GetMovementTemplate`, `CanWalk`, `CanEnterWater`, `CanFly`, `CanHover`,
`UpdateMovementFlags`, `UpdateWaypointID`, `UpdateCurrentWaypointInfo`, `GetWaypointPath`, `Motion_Initialize`, `AIM_Initialize`,
`SetCannotReachTarget`, `m_formation`, ...). `asMovementOwner()` is the one cast to `MovementOwnerCreature` (the real `Creature`
does not satisfy the interface at compile time because `toUnit()`/`toPlayer()`/`getMap()` return the grid layer's types; the test
`Creature.movement.test.ts` checks that every other member exists). `MovementOwner.ts` has one set of movement flags: it re-exports
`UnitDefines.ts`, and the local copies in `Creature.ts`, `Object.ts` and `Map.ts` are gone (`session.ts` and `player-spell-unit.ts`
still define a private constant or two).

## Data

- `creature_template_movement` and `creature_movement_override` (`WORLD_TABLES`): `CreatureMovementData` (`Entities/Creature/CreatureData.ts`), loaded by
  `ObjectMgr::LoadCreatureTemplate` (join: a template without a row reads `Swim` and `Rooted` as false) and
  `ObjectMgr::LoadCreatureMovementOverrides` (`COALESCE` per column), checked by `CheckCreatureMovement`.
- `waypoint_data`, `waypoint_data_addon`, `creature_formations`, `creature_addon.path_id`: loaded at startup by `loadMovementData()`
  (`Maps/MapSetup.ts`, called by `startMapSystem` after the spawn stores and before the first grid), together with
  `AddMovementGeneratorFactories()` and `FlightPathContext.findBaseNonInstanceMap`.
- `MoveMaps.Enable` / `MapCollisionDataHooks.isPathfindingEnabled` and the nav mesh come from `MapCollisionData` (`PathGenerator` reads
  `Map::GetMapCollisionData().GetMMapData()`); `DataDir` is the same as the maps'.

## The combat world

- `CreatureUnit.pos`, `evading` and the motion state are the `Creature`'s (`UNIT_STATE_EVADE`, position, spline); `lastPos` keeps the
  last place while the creature has no map object (its grid is not loaded). `CreatureUnit.host` is the `CombatWorld`;
  `Creature.attack` / `attackStop` / `getVictim` / `isInCombat` / `engageWithTarget` / `callAssistance` call back through `m_combatUnit.host`
  (`CreatureWorld` in `creature-spell-unit.ts`).
- `CombatPlayer.mapObject()` is the player on the map (the `SessionMapPlayer`) that a creature chases (`AbstractFollower`). The session sets it.
- `Creature.update` skips the corpse and respawn timers while `m_combatUnit` is set (the combat world owns them), and runs `Unit::Update`
  (spline and motion) for the alive and corpse states.
- Gone: `chase`, `faceVictim`, `startMove`, `finishMove`, `position` math, `splineId`, `lastChaseMs`, `monsterMovePacket` and the leash
  movement; `CreatureAI::UpdateVictim` evades when a creature is engaged and its threat list is empty.

## The player

`SessionMapPlayer` has a `MovementOwnerPlayer`-compatible subset: `movespline`, an idle `getMotionMaster()` (created on first use),
`followerAdded/Removed` (and `removeAllFollowers` in `removeFromWorld`), `isMoving`, `isStopped`, `getVictim`, `getCombatReach`,
`getBoundaryRadius`, `isInAccessiblePlaceFor`, `getMeleeRange`. Not built: charge, knockback, taxi flights, jumps (`MoveCharge`,
`MoveKnockbackFrom`, `MoveTaxiFlight` have no trigger), `Player::m_taxi`, root and stun as `MOVEMENTFLAG_ROOT`.

## Deviations and `@ac-skip`

- `FactorySelector::SelectAI` is not ported: every creature gets a `ReactorAI` (`game/AI/CoreAI/ReactorAI.ts`, `CreatureAI.ts`, `UnitAI.ts`);
  `UpdateAI`, `MoveInLineOfSight` and `TriggerAlert` do nothing there: the combat world scans for aggro and updates the victim and the melee swing.
- `AddMovementGeneratorFactories()` also runs lazily in `Creature.motion_Initialize` (the C++ runs it once at startup).
- A creature chases only a player that has a map object (`CombatPlayer.mapObject`); other victims (none exist yet) would stay put.
- `Unit::GetMeleeAttackPoint` returns null (the attacker set is not tracked, so a target never has a second attacker to fan around).
- `Unit::SetRooted` / `SetStunned` are the spell unit's; `Creature.hasUnitState` reads the spell unit's `unitState` as well (`m_state | spell.unitState`), so
  the chase generator pauses on `UNIT_STATE_NOT_MOVE`, and the spell unit's `creatureStopMoving` calls `Unit::StopMoving`.
- Taxi (`FlightPathContext.getTaxiPathNodesByPath`, `getTaxiPath`), transports, escorts (`EscortMovementGenerator` is ported and wired but nothing starts an
  escort), SmartAI waypoints, `Creature::DespawnOnEvade` and pets/charm/vehicle following are not wired.
- `CreatureSpellUnit.speedRate` starts from the creature's rates; `SPLINE_SPEED_OPCODES` in `creature-spell-unit.ts` lists
  `SMSG_SPLINE_SET_TURN_RATE` / `SWIM_BACK_SPEED` swapped and a wrong pitch opcode; `Creature.setSpeed` uses the correct table.

## Tests

`bun test src/game/Entities/Creature/Creature.movement.test.ts` (contract, movement data, the update loop, startup, formation follow, death and respawn; a
flat `.map` written by `buildMapFile`, no nav mesh), `src/combat/combat-world.test.ts` (the combat flow over a map with real `Creature` objects and a real
`SessionMapPlayer`), and `src/combat/creature-movement.data.test.ts` (Northshire: chase over the nav mesh and the way home, a wanderer, a waypoint path
with delays, the spline packets and the create block; skips without `data/`).
