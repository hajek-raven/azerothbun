/** `MotdMgr`: the realm's message of the day (`motd`, `motd_localized`) and the `SMSG_MOTD` packet per locale. */
import type { Db } from "../../database/database.ts";
import { queryFields } from "../../database/database.ts";
import { LOGIN_SEL_MOTD, LOGIN_SEL_MOTD_LOCALE } from "../../gen/LoginDatabase.gen.ts";
import { log, logError } from "../../log.ts";
import { ByteWriter } from "../../net/byte-buffer.ts";
import { tokenize } from "../../common/util.ts";
import { GetLocaleByName, IsLocaleValid } from "../../common/Common.ts";
import { LOCALE_enUS } from "../../shared/SharedDefines.ts";
import { getMSTime, getMSTimeDiffToNow } from "../time/timer.ts";

export const SMSG_MOTD = 0x33d;

export class MotdMgr {
  private readonly motdMap = new Map<number, string>();
  private readonly motdPackets = new Map<number, Uint8Array>();

  /** @ac game/Motd/MotdMgr.cpp MotdMgr::SetMotd */
  SetMotd(motd: string, locale: number): void {
    this.motdMap.set(locale, motd);
    this.motdPackets.set(locale, MotdMgr.CreateWorldPacket(motd));
  }

  /** @ac game/Motd/MotdMgr.cpp MotdMgr::LoadMotd */
  async LoadMotd(db: Db, realmId: number): Promise<void> {
    const oldMSTime = getMSTime();
    const [fields] = await queryFields(db, LOGIN_SEL_MOTD, realmId);
    if (fields) {
      this.SetMotd(String(fields[0] ?? ""), LOCALE_enUS);
      await this.LoadMotdLocale(db, realmId);
    } else {
      log("server", ">> Loaded 0 motd definitions. DB table `motd` is empty for this realm!");
      log("server", ">> Loaded 0 motd locale definitions. DB table `motd` needs an entry to be able to load DB table `motd_locale`!");
    }
    log("server", `>> Loaded motd definitions in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Motd/MotdMgr.cpp MotdMgr::LoadMotdLocale */
  async LoadMotdLocale(db: Db, realmId: number): Promise<void> {
    const oldMSTime = getMSTime();
    let count = 0;
    const rows = await queryFields(db, LOGIN_SEL_MOTD_LOCALE, realmId);
    for (const fields of rows) {
      const locale = String(fields[0]);
      const localizedText = String(fields[1] ?? "");
      if (!IsLocaleValid(locale)) {
        logError("server", `DB table \`motd_localized\` has invalid locale (${locale}), skipped.`);
        continue;
      }
      const localeId = GetLocaleByName(locale);
      if (localeId === LOCALE_enUS) continue;
      this.SetMotd(localizedText, localeId);
      ++count;
    }
    log("server", `>> Loaded ${count} motd locale definitions in ${getMSTimeDiffToNow(oldMSTime)} ms`);
  }

  /** @ac game/Motd/MotdMgr.cpp MotdMgr::GetMotd */
  GetMotd(locale: number): string {
    return this.motdMap.get(locale) ?? this.motdMap.get(LOCALE_enUS) ?? "";
  }

  /** @ac game/Motd/MotdMgr.cpp MotdMgr::GetMotdPacket */
  GetMotdPacket(locale: number): Uint8Array {
    return this.motdPackets.get(locale) ?? this.motdPackets.get(LOCALE_enUS) ?? MotdMgr.CreateWorldPacket("");
  }

  /** @ac game/Motd/MotdMgr.cpp MotdMgr::CreateWorldPacket (the AzerothCore line is appended, as in the C++) */
  static CreateWorldPacket(text: string): Uint8Array {
    const motd = `${text}@|cffFF4A2DThis server runs on AzerothCore|r |cff3CE7FFwww.azerothcore.org|r`;
    const tokens = tokenize(motd, "@", true);
    const data = new ByteWriter().writeU32(tokens.length);
    for (const token of tokens) data.writeCString(token);
    return data.toUint8Array();
  }
}

export const sMotdMgr = new MotdMgr();
