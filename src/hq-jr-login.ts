/** True when login is exactly the hq-jr GitHub App (hq-jr or hq-jr[bot]). */
export function isHqJrLogin(login: string | null | undefined): boolean {
  return /^hq-jr(?:\[bot\])?$/i.test(login ?? "");
}
