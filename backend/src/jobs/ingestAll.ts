import { pool } from "../db";
import { ingestGeometry } from "./ingestGeometry";
import { ingestMeters } from "./ingestMeters";
import { ingestSigns } from "./ingestSigns";
import { rebuildRules } from "./rebuildRules";

async function main(): Promise<void> {
  console.log("[ingest:all] starting geometry...");
  await ingestGeometry();

  console.log("[ingest:all] starting meters...");
  await ingestMeters();

  console.log("[ingest:all] starting signs...");
  await ingestSigns();

  console.log("[ingest:all] rebuilding rules...");
  await rebuildRules();

  console.log("[ingest:all] complete");
}

if (require.main === module) {
  main()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[ingest:all] failed", error);
      await pool.end();
      process.exit(1);
    });
}
