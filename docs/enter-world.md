# Enter world

After the realm list, the client connects to the world server on port **8085**. Packet headers are encrypted with the session key (ARC4, first 1024 bytes dropped), same as AzerothCore.

## What works

1. Server sends `SMSG_AUTH_CHALLENGE`.
2. Client sends `CMSG_AUTH_SESSION`. The server checks the account, build 12340, and the session digest.
3. Server sends `SMSG_AUTH_RESPONSE`, addon info, and the client cache version.
4. `CMSG_CHAR_ENUM` returns the account's characters. `CMSG_CHAR_CREATE` and `CMSG_CHAR_DELETE` create and delete one from `playercreateinfo`.
5. `CMSG_PLAYER_LOGIN` sends the enter-world burst from `Player::SendInitialPacketsBeforeAddToMap` in AzerothCore:
   - `SMSG_LOGIN_VERIFY_WORLD` at the saved position
   - account data times, feature status, dance moves, the `character_homebind` point, tutorials
   - known spells and action buttons from the character; factions, achievements, equipment sets, and talents are still empty
   - game speed, one `SMSG_UPDATE_OBJECT` that creates the player, and a time sync request
6. `CMSG_REALM_SPLIT` gets a normal realm-split answer.
7. `CMSG_READY_FOR_ACCOUNT_DATA_TIMES` gets account data times again.
8. `CMSG_PING` gets `SMSG_PONG`.
9. `CMSG_NAME_QUERY` returns the character name.
10. `CMSG_QUERY_TIME` and `CMSG_WORLD_STATE_UI_TIMER_UPDATE` return the current time.
11. `CMSG_ZONEUPDATE` stores the zone.
12. `CMSG_LOGOUT_REQUEST` saves the position and sends logout complete. The client can return to the character screen.

The player create block uses the 3.3.5 update fields (`PLAYER_END`, 1326 fields). It sets guid, type, scale, health and max health, power type and power, level, faction, the ChrRaces display id for that race and gender, race, class, gender, and skin bytes. Health and power come from `player_class_stats` plus `player_race_stats`. The own player is created with `UPDATEFLAG_SELF`. Another player in range is created the same way without that flag.

Right-clicking a creature sends `CMSG_GOSSIP_HELLO` or `CMSG_QUESTGIVER_HELLO`. The server answers with the gossip menu (`gossip_menu`, `gossip_menu_option`, `npc_text`) and any quests that creature starts or ends. Accept, abandon, and turn-in update `character_queststatus` and the quest log fields. A character who already has quests also gets those fields in a values update after the create.

## Code

- `src/crypto/world-crypt.ts` — header encryption
- `src/world/server.ts` — TCP session and packet framing
- `src/world/session.ts` — opcode handlers
- `src/world/packets.ts` — login packet bytes
- `src/world/update-object.ts` — `SMSG_UPDATE_OBJECT`

## Not done

Spells and the action bar are filled from the character. Faction standings are filled when `data/dbc` contains Faction.dbc. Gear is still empty. Creatures, objects, and other players within visibility range are sent after the player create. The rest of the port is in [status.md](status.md).
