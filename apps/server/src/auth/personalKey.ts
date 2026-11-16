import * as Redacted from "effect/Redacted";

/** Sessions and grants a personal key creates share this subject. */
export const PERSONAL_KEY_SUBJECT = "personal-key";
export const PERSONAL_KEY_BOOTSTRAP_METHOD = "personal-key";

export function personalKeyValue(config: {
  readonly personalKey?: Redacted.Redacted<string> | undefined;
}): string | undefined {
  return config.personalKey === undefined ? undefined : Redacted.value(config.personalKey);
}
