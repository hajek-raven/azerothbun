/** `Common.cpp`: locale names. */
import { LOCALE_enUS, TOTAL_LOCALES } from "../shared/SharedDefines.ts";

/** @ac common/Common.cpp localeNames */
export const localeNames = ["enUS", "koKR", "frFR", "deDE", "zhCN", "zhTW", "esES", "esMX", "ruRU"] as const;

/** @ac common/Common.cpp IsLocaleValid */
export function IsLocaleValid(locale: string): boolean {
  return (localeNames as readonly string[]).includes(locale);
}

/** @ac common/Common.cpp GetLocaleByName */
export function GetLocaleByName(name: string): number {
  const index = (localeNames as readonly string[]).indexOf(name);
  return index >= 0 ? index : LOCALE_enUS;
}

/** @ac common/Common.cpp GetNameByLocaleConstant */
export function GetNameByLocaleConstant(locale: number): string {
  return locale < TOTAL_LOCALES ? localeNames[locale]! : "enUS";
}

/** @ac common/Common.cpp accountFlagNames */
export const accountFlagNames: readonly { full: string; shortName: string }[] = [
  "GM", "NOKICK", "COLLECTOR", "TRIAL", "CANCELLED", "IGR", "WHOLESALER", "PRIVILEGED", "EU_FORBID_ELV", "EU_FORBID_BILLING",
  "RESTRICTED", "REFERRAL", "BLIZZARD", "RECURRING_BILLING", "NOELECTUP", "KR_CERTIFICATE", "EXPANSION_COLLECTOR",
  "DISABLE_VOICE", "DISABLE_VOICE_SPEAK", "REFERRAL_RESURRECT", "EU_FORBID_CC", "OPENBETA_DELL", "PROPASS", "PROPASS_LOCK",
  "PENDING_UPGRADE", "RETAIL_FROM_TRIAL", "EXPANSION2_COLLECTOR", "OVERMIND_LINKED", "DEMOS", "DEATH_KNIGHT_OK",
  "S2_REQUIRE_IGR", "S2_TRIAL",
].map((shortName) => ({ full: `ACCOUNT_FLAG_${shortName}`, shortName }));

export const MAX_ACCOUNT_FLAG = 32;
