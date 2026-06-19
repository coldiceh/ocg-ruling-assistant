import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDataHealth } from "../backend/dataHealth.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const health = await checkDataHealth(join(rootDir, "data"));

console.log(JSON.stringify(health, null, 2));
if (!health.usable) process.exitCode = 1;
