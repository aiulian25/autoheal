import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MESSAGES, PASSWORD_MINIMUM_LENGTH } from "../../shared/constants.js";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/** Every rule the password breaks, in plain words; empty when it is acceptable. */
export function passwordProblems(password: string, username: string): string[] {
  const lowered = password.toLowerCase();
  const rules: [broken: boolean, message: string][] = [
    [password.length < PASSWORD_MINIMUM_LENGTH, PASSWORD_MESSAGES.tooShort],
    [password.length > PASSWORD_MAXIMUM_LENGTH, PASSWORD_MESSAGES.tooLong],
    [COMMON_PASSWORDS.has(lowered), PASSWORD_MESSAGES.common],
    [username.length > 0 && lowered.includes(username.toLowerCase()), PASSWORD_MESSAGES.containsUsername],
    [password.length > 0 && new Set(password).size === 1, PASSWORD_MESSAGES.oneCharacter],
  ];
  return rules.filter(([broken]) => broken).map(([, message]) => message);
}
