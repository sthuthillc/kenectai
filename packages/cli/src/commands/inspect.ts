import type { Example } from "./_examples.js";
import { createInspectCommand } from "./layout.js";

export const examples: Example[] = [
  ["Inspect visual layout across the current composition", "kenectai inspect"],
  ["Inspect a specific project", "kenectai inspect ./my-video"],
  ["Output agent-readable JSON", "kenectai inspect --json"],
  ["Use explicit hero-frame timestamps", "kenectai inspect --at 1.5,4.0,7.25"],
  [
    "Also sample at tween boundaries to catch transient overlaps",
    "kenectai inspect --at-transitions",
  ],
  [
    "Verify motion intent (add a *.motion.json sidecar next to the composition)",
    "kenectai inspect --json",
  ],
  ["Run the compatibility alias", "kenectai layout --json"],
];

export default createInspectCommand("inspect");
