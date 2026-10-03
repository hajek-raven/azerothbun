/**
 * `SecretMgr` on the world server side: `TOTPMasterSecret` from the config, checked against the argon2 digest the
 * authserver keeps in `secret_digest` (the authserver owns the secret and moves the database to a new one).
 */
import type { Db } from "../../database/database.ts";
import { queryFields } from "../../database/database.ts";
import { LOGIN_SEL_SECRET_DIGEST } from "../../gen/LoginDatabase.gen.ts";
import { logError } from "../../log.ts";
import { KEY_SIZE_BYTES } from "../../common/Cryptography/AES.ts";

export const SECRET_TOTP_MASTER_KEY = 0;

export type Secret = { available: boolean; value: Uint8Array | null };

export class SecretMgr {
  private readonly secrets = new Map<number, Secret>();
  private configValue: (key: string) => string = () => "";

  /** The option lookup (`sConfigMgr->GetOption<std::string>`). */
  setConfig(get: (key: string) => string): void {
    this.configValue = get;
    this.secrets.clear();
  }

  /** @ac shared/Secrets/SecretMgr.cpp SecretMgr::GetSecret */
  async GetSecret(db: Db, i: number): Promise<Secret> {
    const loaded = this.secrets.get(i);
    if (loaded) return loaded;
    const secret = await this.AttemptLoad(db, i);
    this.secrets.set(i, secret);
    return secret;
  }

  /** @ac shared/Secrets/SecretMgr.cpp SecretMgr::AttemptLoad (the world server does not own the secret, so it never transitions it) */
  private async AttemptLoad(db: Db, i: number): Promise<Secret> {
    const configKey = "TOTPMasterSecret";
    const [row] = await queryFields(db, LOGIN_SEL_SECRET_DIGEST, i);
    const oldDigest = row ? String(row[0]) : null;
    const hex = this.configValue(configKey).trim();
    if (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex)) {
      logError("server", `Invalid value for '${configKey}' - specify a hexadecimal integer of up to 128 bits with no prefix.`);
      return { available: false, value: null };
    }
    const current: bigint | null = hex.length > 0 ? BigInt(`0x${hex}`) % (1n << 128n) : null;
    const currentHex = current === null ? null : current.toString(16).toUpperCase();
    if ((oldDigest === null) !== (currentHex === null) || (oldDigest !== null && currentHex !== null && !(await Bun.password.verify(currentHex, oldDigest).catch(() => false)))) {
      if (currentHex !== null) logError("server", `Invalid value for '${configKey}' specified - this is not actually the secret being used in your auth DB.`);
      else logError("server", `No value for '${configKey}' specified - please specify the secret currently being used in your auth DB.`);
      return { available: false, value: null };
    }
    if (current === null) return { available: true, value: null };
    // `BigNumber::ToByteArray<16>()` (little endian)
    const value = new Uint8Array(KEY_SIZE_BYTES);
    let rest = current;
    for (let b = 0; b < KEY_SIZE_BYTES; b++) {
      value[b] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return { available: true, value };
  }
}

export const sSecretMgr = new SecretMgr();
