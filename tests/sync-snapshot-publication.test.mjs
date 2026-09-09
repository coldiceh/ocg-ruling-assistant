import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

const productionScript = process.env.SYNC_PUBLICATION_SCRIPT_OVERRIDE
  || fileURLToPath(new URL("../scripts/publish-synced-snapshot.sh", import.meta.url));
const bash = process.platform === "win32"
  ? [process.env.GIT_BASH, "C:/Program Files/Git/bin/bash.exe", "D:/Git/bin/bash.exe"].find(value => value && existsSync(value))
  : "bash";

function git(directory, ...args) {
  const result = spawnSync("git", args, {
    cwd: directory, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr || result.error || ""}`);
  return result.stdout.trim();
}

async function write(directory, file, content) {
  const target = path.join(directory, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function snapshot(directory, revision) {
  const text = `${JSON.stringify({ revision })}\n`;
  for (const file of ["data/cards.json", "data/cards-lite.json", "data/snapshot-meta.json",
    "data/rag-runtime-v1/manifest.json", "data/cloud-evidence-v1/corpus-manifest.json",
    "public/data/cards-lite.json", "public/data/snapshot-meta.json"]) {
    await write(directory, file, text);
  }
  await write(directory, "data/cards.json.gz", gzipSync(text));
}

function configure(directory) {
  git(directory, "config", "user.name", "Sync publication test");
  git(directory, "config", "user.email", "sync-publication-test@example.invalid");
  git(directory, "config", "core.autocrlf", "false");
}

async function fixture(context, { generated = true } = {}) {
  assert.ok(bash, "Git Bash must be available for the production shell script");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocg-sync-publication-"));
  // Retain only these newly created fixtures for failed-run inspection. This
  // test deliberately performs no recursive deletion or checkout cleanup.
  context.diagnostic(`Local Git fixture: ${root}`);
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const working = path.join(root, "sync");
  const writer = path.join(root, "writer");
  const bin = path.join(root, "bin");
  const output = path.join(root, "github-output.txt");
  const events = path.join(root, "events.txt");
  await fs.mkdir(seed);
  await fs.mkdir(bin);
  await fs.writeFile(output, "");
  await fs.writeFile(events, "");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(seed, "init", "--initial-branch=main");
  configure(seed);
  await snapshot(seed, "base");
  await write(seed, "src/app.js", "// original source\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base snapshot");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "HEAD:refs/heads/main");
  git(root, "clone", "-c", "core.autocrlf=false", remote, working);
  git(root, "clone", "-c", "core.autocrlf=false", remote, writer);
  configure(working);
  configure(writer);
  if (generated) await snapshot(working, "generated");
  for (const command of ["pnpm", "node"]) {
    const executable = path.join(bin, command);
    await fs.writeFile(executable, `#!/usr/bin/env bash\nprintf '%s %s\\n' '${command}' "$*" >> "$PUBLICATION_TEST_EVENTS"\nif [[ "\${PUBLICATION_TEST_FAIL_VALIDATION:-}" == 1 && "$*" == *check:data* ]]; then\n  echo 'injected data compatibility failure' >&2\n  exit 23\nfi\n`);
    await fs.chmod(executable, 0o755);
  }
  const hook = path.join(working, ".git", "hooks", "pre-push");
  await fs.writeFile(hook, "#!/usr/bin/env bash\nprintf 'push\\n' >> \"$PUBLICATION_TEST_EVENTS\"\nif [[ -n \"${PUBLICATION_TEST_RACE_WRITER:-}\" ]]; then\n  git -C \"$PUBLICATION_TEST_RACE_WRITER\" push origin HEAD:refs/heads/main\nfi\n");
  await fs.chmod(hook, 0o755);
  return { root, remote, working, writer, bin, output, events };
}

async function advance(f, file = "src/upstream.js", content = "// upstream change\n", push = true) {
  await write(f.writer, file, content);
  git(f.writer, "add", file);
  git(f.writer, "commit", "-m", "advance main independently");
  const sha = git(f.writer, "rev-parse", "HEAD");
  if (push) git(f.writer, "push", "origin", "HEAD:refs/heads/main");
  return sha;
}

async function run(f, extraEnv = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
  environment.PATH = `${f.bin}${path.delimiter}${process.env.PATH || process.env.Path || ""}`;
  Object.assign(environment, {
    GITHUB_OUTPUT: f.output,
    PUBLICATION_TEST_EVENTS: f.events,
    GIT_TERMINAL_PROMPT: "0",
  }, extraEnv);
  const result = spawnSync(bash, ["-e", productionScript], {
    cwd: f.working, env: environment, encoding: "utf8", windowsHide: true,
    timeout: 120000,
  });
  const outputText = await fs.readFile(f.output, "utf8");
  return { ...result, outputText, outputs: Object.fromEntries(outputText.trim().split(/\r?\n/u).filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  })), events: (await fs.readFile(f.events, "utf8")).trim().split(/\r?\n/u).filter(Boolean) };
}

function assertSnapshotRetained(f, result) {
  assert.match(result.outputs.snapshot_commit || "", /^[0-9a-f]{40}$/u, result.stdout + result.stderr);
  assert.equal(git(f.working, "show", `${result.outputs.snapshot_commit}:data/cards.json`), '{"revision":"generated"}');
  assert.equal(git(f.working, "show", `${result.outputs.snapshot_commit}:public/data/cards-lite.json`), '{"revision":"generated"}');
}

test("publishes the generated snapshot on advanced main without losing either change", async context => {
  const f = await fixture(context);
  const upstream = await advance(f);
  const result = await run(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.outputs.data_changed, "true");
  assertSnapshotRetained(f, result);
  const published = git(f.remote, "rev-parse", "refs/heads/main");
  assert.equal(git(f.remote, "show", `${published}:data/cards.json`), '{"revision":"generated"}');
  assert.equal(git(f.remote, "show", `${published}:src/upstream.js`), "// upstream change");
  git(f.remote, "merge-base", "--is-ancestor", upstream, published);
  const pushedAt = result.events.indexOf("push");
  assert.ok(pushedAt > 0, `Expected validation before push: ${result.events.join(" | ")}`);
  const validations = result.events.slice(0, pushedAt).join("\n");
  for (const command of ["install --frozen-lockfile", "check:data", "check:freshness", "--check-only",
    "tests/rag-runtime-parity.test.mjs", "tests/deployment-workflows.test.mjs"]) {
    assert.ok(validations.includes(command), `Missing compatibility check: ${command}\n${validations}`);
  }
  assert.equal(result.events.filter(event => event === "push").length, 1);
});

test("a data conflict stops publication and retains the original generated commit", async context => {
  const f = await fixture(context);
  const upstream = await advance(f, "data/cards.json", '{"revision":"upstream-conflict"}\n');
  const result = await run(f);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /CONFLICT[^\n]*data\/cards\.json/u);
  assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), upstream);
  assert.notEqual(result.outputs.data_changed, "true");
  assertSnapshotRetained(f, result);
  assert.equal(result.events.includes("push"), false);
});

test("failed post-rebase data validation stops before any push", async context => {
  const f = await fixture(context);
  const upstream = await advance(f);
  const result = await run(f, { PUBLICATION_TEST_FAIL_VALIDATION: "1" });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), upstream);
  assert.match(result.stderr, /injected data compatibility failure/u);
  assert.notEqual(result.outputs.data_changed, "true");
  assertSnapshotRetained(f, result);
  assert.equal(result.events.includes("push"), false);
});

test("main advancing again during push is preserved without force or automatic retry", async context => {
  const f = await fixture(context);
  await advance(f);
  const latest = await advance(f, "src/later.js", "// change during push\n", false);
  const result = await run(f, { PUBLICATION_TEST_RACE_WRITER: f.writer });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), latest);
  assert.equal(git(f.remote, "show", "refs/heads/main:data/cards.json"), '{"revision":"base"}');
  assert.notEqual(result.outputs.data_changed, "true");
  assertSnapshotRetained(f, result);
  assert.equal(result.events.filter(event => event === "push").length, 1);
});

test("an unchanged snapshot reports false without publishing", async context => {
  const f = await fixture(context, { generated: false });
  const before = git(f.remote, "rev-parse", "refs/heads/main");
  const result = await run(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.outputs.data_changed, "false");
  assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), before);
  assert.equal(result.events.includes("push"), false);
});
