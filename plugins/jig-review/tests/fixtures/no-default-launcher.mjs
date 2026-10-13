import { fileURLToPath } from "node:url";

// Lifecycle fixtures submit synthetic native reviews. Never let a developer's
// installed Jig turn those assignments into live, authenticated CLI reviews.
// Tests of explicit launchers supply their own fake executable afterward.
process.env.JIG_LAUNCHER_BIN = fileURLToPath(new URL("unavailable-jig", import.meta.url));
