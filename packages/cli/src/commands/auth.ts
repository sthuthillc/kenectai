/**
 * `kenectai auth` — credential management for KENECT AI.
 *
 * Subverbs:
 *   - `login`   sign in via API key (OAuth coming next)
 *   - `status`  show the active credential + identity
 *   - `logout`  remove the stored credential
 *
 * Each subverb lives in `./auth/<name>.ts` and is dynamic-imported on
 * demand. Keeps cold-start fast and lets the auth library load only
 * when the user is doing auth work.
 */

import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";

export const examples: Example[] = [
  ["Sign in via browser (OAuth)", "kenectai auth login"],
  ["Save an API key (interactive)", "kenectai auth login --api-key"],
  ["Save an API key from stdin", "echo $KENECT_API_KEY | kenectai auth login --api-key"],
  ["Check who you're signed in as", "kenectai auth status"],
  ["Force-refresh the OAuth access token", "kenectai auth refresh"],
  ["Sign out", "kenectai auth logout"],
];

const HELP = `
${c.bold("kenectai auth")} ${c.dim("<subcommand> [args]")}

Manage KENECT AI credentials. Credentials live in
${c.accent("~/.kenectai/credentials")}.

${c.bold("SUBCOMMANDS:")}
  ${c.accent("login")}    ${c.dim("Sign in via browser (default) or --api-key for a long-lived key.")}
  ${c.accent("status")}   ${c.dim("Show the active credential's source, type, and identity.")}
  ${c.accent("refresh")}  ${c.dim("Force-refresh the OAuth access token.")}
  ${c.accent("logout")}   ${c.dim("Remove the stored credential (--keep-api-key for OAuth-only).")}

${c.bold("ENV VARS:")}
  ${c.accent("KENECT_API_KEY")}              Override the stored credential.
  ${c.accent("KENECT_API_URL")}              Override the API base URL.
  ${c.accent("KENECT_CONFIG_DIR")}           Override the credentials directory (default ~/.kenectai).
  ${c.accent("KENECT_OAUTH_CLIENT_ID")}      Override the OAuth client_id (for dev/test).
`;

export default defineCommand({
  meta: { name: "auth", description: "Sign in to KENECT AI and manage credentials" },
  subCommands: {
    login: () => import("./auth/login.js").then((m) => m.default),
    status: () => import("./auth/status.js").then((m) => m.default),
    logout: () => import("./auth/logout.js").then((m) => m.default),
    refresh: () => import("./auth/refresh.js").then((m) => m.default),
  },
  async run({ args }) {
    if (!args._?.[0]) console.log(HELP);
  },
});
