import { customType } from "drizzle-orm/mysql-core";

/**
 * `binary(n)` and `varbinary(n)` as raw bytes. The stock drizzle columns decode them as text, which breaks
 * `account.salt`, `verifier`, `session_key`, and `totp_secret`.
 */
export const binaryBytes = customType<{ data: Uint8Array; driverData: Uint8Array; config: { length?: number } }>({
  dataType: (config) => `binary(${config?.length ?? 1})`,
  fromDriver: (value) => new Uint8Array(value),
});

export const varbinaryBytes = customType<{ data: Uint8Array; driverData: Uint8Array; config: { length?: number } }>({
  dataType: (config) => `varbinary(${config?.length ?? 255})`,
  fromDriver: (value) => new Uint8Array(value),
});
