/**
 * Filesystem layout for the KENECT AI credential store.
 * `KENECT_CONFIG_DIR` overrides the directory.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Filename for the credential store.
 */
export const CREDENTIAL_FILENAME = "credentials";

export function configDir(): string {
  const override = process.env["KENECT_CONFIG_DIR"];
  if (override && override.length > 0) return override;
  return join(homedir(), ".kenectai");
}

export function credentialPath(): string {
  return join(configDir(), CREDENTIAL_FILENAME);
}
