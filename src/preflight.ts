/**
 * Runtime preflight. `node:sqlite` is a built-in only from Node 22.5+. On
 * older/LTS Node it does not exist and the process would crash with an opaque
 * module-resolution stack trace. Feature-detect it once, here, and exit with
 * a single actionable line instead. Imported first in cli.ts (ES module
 * side-effect order) so this runs before the store module is evaluated.
 *
 * Honest scope: this was authored/tested on Node 25.2.1. The failure branch
 * is reasoned, not exercised here — but it degrades to a clear message rather
 * than a stack trace, which is the point.
 */

import { createRequire } from "node:module";

try {
  createRequire(import.meta.url)("node:sqlite");
} catch {
  process.stderr.write(
    [
      "",
      "gtm-ops-router needs Node's built-in SQLite (Node >= 22.5).",
      `Detected Node ${process.versions.node}.`,
      "Fix:  nvm install 22 && nvm use 22   (or any Node >= 22.5), then re-run.",
      "Tradeoff is deliberate: zero native deps for clone-and-run. See README.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
