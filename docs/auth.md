# Auth

The auth server speaks the 3.3.5a logon protocol on port **3724**. It follows AzerothCore's auth server: SRP6, then the realm list.

## What works

- `AUTH_LOGON_CHALLENGE` and `AUTH_LOGON_PROOF`
- `AUTH_RECONNECT_CHALLENGE` and `AUTH_RECONNECT_PROOF`
- `REALM_LIST` with one realm, `Azeroth`, at `127.0.0.1:8085`
- Rejects unknown accounts and any client build other than **12340**
- Stores the session key so the world server can check the same login

Usernames are compared as upper-case Latin letters, same as AzerothCore.

## Data

Accounts, the realm row, and characters live in `data/auth.sqlite`. The file is created on startup. The seeded accounts are `TEST` / `TEST` and `TEST2` / `TEST2`.

## Code

- `src/crypto/srp6.ts` — SRP6 math and the session key
- `src/auth/packets.ts` — packet bytes
- `src/auth/session.ts` — one connection
- `src/auth/server.ts` — `Bun.listen`

## Not done

Password change, account ban, more than one realm, and the extra auth opcodes AzerothCore handles after the realm list.
