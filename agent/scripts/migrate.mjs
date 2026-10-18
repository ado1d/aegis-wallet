// npm run migrate — apply pending SQL migrations (idempotent).
// Requires DATABASE_URL (Neon, docker postgres, etc).

import { migrate } from "../src/store.js";

console.log("aegis migrate — applying pending migrations…");
try {
  await migrate();
  process.exit(0);
} catch (err) {
  console.error("migration failed:", err.message);
  process.exit(1);
}
