/**
 * `kenectai cloud` — top-level dispatcher for cloud-render subverbs.
 *
 * Each subverb lives in `./cloud/<name>.ts`. The dispatcher loads them
 * dynamically so the cloud surface doesn't impact CLI cold-start when
 * the user is running `render` / `preview` / etc.
 *
 * Auth is the existing `cli/src/auth/` chain — `cloud` subverbs call
 * into `cloud/auth.ts` which bridges `resolveCredential` +
 * `buildAuthHeaders` into the generated client. There is no new
 * credentials store and no new env var.
 */

import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";

export const examples: Example[] = [
  ["Render the current directory in the cloud", "kenectai cloud render"],
  ["Render a specific project", "kenectai cloud render ./my-video"],
  [
    "Render at 60fps + high quality, save to a path",
    "kenectai cloud render ./my-video --fps 60 --quality high -o ./out.mp4",
  ],
  [
    "Fire-and-forget with a webhook",
    "kenectai cloud render ./my-video --callback-url https://example.com/kenect-hook --no-wait",
  ],
  ["Resubmit an already-uploaded zip", "kenectai cloud render --asset-id asst_abc123"],
  [
    "Render from a public HTTPS zip",
    "kenectai cloud render --url https://cdn.example.com/site.zip",
  ],
  ["List recent cloud renders", "kenectai cloud list"],
  ["Fetch one render's status + signed URLs", "kenectai cloud get hfr_abc123"],
  ["Soft-delete a render", "kenectai cloud delete hfr_abc123"],
];

const HELP = `
${c.bold("kenectai cloud")} ${c.dim("<subcommand> [args]")}

Render KENECT AI compositions on KENECT AI cloud infrastructure. The
project zip is uploaded, the render is dispatched, and the resulting
video is downloaded locally — without spinning up Chrome or ffmpeg
on your machine.

${c.bold("SUBCOMMANDS:")}
  ${c.accent("render")}    ${c.dim("Submit a project (or asset_id / url) and download the result")}
  ${c.accent("list")}      ${c.dim("List recent renders in your account")}
  ${c.accent("get")}       ${c.dim("Fetch one render's status + signed URLs")}
  ${c.accent("delete")}    ${c.dim("Soft-delete a render (GET 404s afterward)")}

${c.bold("AUTH:")}
  Uses the credential you signed in with via ${c.accent("kenectai auth login")}.
  Override the API base with ${c.accent("KENECT_API_URL")}.
`;

export default defineCommand({
  meta: { name: "cloud", description: "Render KENECT AI compositions on the KENECT AI cloud" },
  subCommands: {
    render: () => import("./cloud/render.js").then((m) => m.default),
    list: () => import("./cloud/list.js").then((m) => m.default),
    get: () => import("./cloud/get.js").then((m) => m.default),
    delete: () => import("./cloud/delete.js").then((m) => m.default),
  },
  async run({ args }) {
    if (!args._?.[0]) console.log(HELP);
  },
});
