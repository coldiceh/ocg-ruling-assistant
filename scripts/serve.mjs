import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const port = Number(process.env.PORT || process.argv[2] || 4173);
const localBackendUrl = normalizeLocalBackendUrl(process.env.LOCAL_BACKEND_URL);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = normalize(join(rootDir, pathname));

    if (!target.startsWith(rootDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    if (pathname === "/config.json" && localBackendUrl) {
      const original = await readOptionalConfig(target);
      const answerApiUrl = `${localBackendUrl}/api/answer`;
      const body = Buffer.from(JSON.stringify({
        ...original,
        answerApiUrl,
        budgetApiUrl: `${localBackendUrl}/api/budget`,
      }, null, 2));
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }

    const info = await stat(target);
    if (!info.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Yu-Gi-Oh! OCG AI Rulings: http://127.0.0.1:${port}/`);
});

function normalizeLocalBackendUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const url = new URL(text);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("LOCAL_BACKEND_URL must be a loopback HTTP URL");
  }
  return url.toString().replace(/\/+$/u, "");
}

async function readOptionalConfig(target) {
  try {
    const parsed = JSON.parse(await readFile(target, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
