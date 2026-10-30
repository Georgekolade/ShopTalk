/* Country/currency/timezone data from country-data-list (MIT, zero deps).
   Full ISO coverage lives in the library - nothing is hardcoded here. */

import { countries, timezones } from "country-data-list";

export interface CountryOption {
  code: string;
  name: string;
  emoji: string;
  currencies: string[];
  callingCodes: string[];
  timezones: string[];
}

export const COUNTRY_OPTIONS: CountryOption[] = countries.all
  .filter((c) => c.status === "assigned" && c.name)
  .map((c) => ({
    code: c.alpha2,
    name: c.name,
    emoji: c.emoji ?? "",
    currencies: c.currencies ?? [],
    callingCodes: c.countryCallingCodes ?? [],
    timezones: timezones.getTimezonesByCountry(c.alpha2) ?? [],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function countryByCode(code: string): CountryOption | undefined {
  return COUNTRY_OPTIONS.find((c) => c.code === code);
}

export const ALL_TIMEZONES: string[] = Array.from(
  new Set(COUNTRY_OPTIONS.flatMap((c) => c.timezones)),
).sort();

export const ALL_CURRENCIES: string[] = Array.from(
  new Set(COUNTRY_OPTIONS.flatMap((c) => c.currencies)),
).sort();
