# Movement

Movement follows the 3.3.5a handlers in AzerothCore (`MovementHandler.cpp` and `ReadMovementInfo`). The server keeps the local player's position and sends the same move opcode to other players who can see them.

## What works

Client move packets are parsed and stored when the packed guid is the logged-in character:

- Walk, strafe, turn, pitch, jump, swim, fall, facing
- Heartbeat (`MSG_MOVE_HEARTBEAT`) writes `x`, `y`, `z`, `orientation`, map, and zone to SQLite
- Fall reset, set fly, ascend, descend, change transport, spline done
- Speed, root, knockback, and movement-flag acknowledgements
- `CMSG_SET_ACTIVE_MOVER`, `CMSG_MOVE_NOT_ACTIVE_MOVER`, `CMSG_MOVE_TIME_SKIPPED`

Illegal flags from the client are removed, as in AzerothCore. The player has no auras, so fly, water walk, hover, feather fall, and client root do not stick.

Run speed above `7` (and the same check for the other eight speeds) closes the connection. A slower speed ack is corrected with `SMSG_FORCE_*_SPEED_CHANGE`.

Fall damage uses AzerothCore's formula. A drop of at least `13.48` yards deals damage. The server sends `SMSG_ENVIRONMENTAL_DAMAGE_LOG` and a health update. Shorter drops deal nothing.

Time sync: the server sends `SMSG_TIME_SYNC_REQ` about every 10 seconds after the client answers the previous one. The reply sets the clock delta used on later move timestamps.

Teleport packets exist for both cases in AzerothCore:

- Same map: `MSG_MOVE_TELEPORT_ACK`, then the client ack clears the pending teleport
- Other map: `SMSG_TRANSFER_PENDING` and `SMSG_NEW_WORLD`. `MSG_MOVE_WORLDPORT_ACK` moves the character and sends verify-world plus a new create block

Nothing in the game calls teleport yet. There is no spell or command that starts one.

## Code

- `src/world/movement.ts` — parse, flag checks, fall damage, teleport bytes
- `src/world/session.ts` — apply position, save, kick, teleport state

## Not done

- Showing this player to anyone else
- Real transports (the packet is read; there is no transport object)
- Root, knockback, or speed changes started by a spell
- Falling through the world, liquid, and maps other than the one the character is on
