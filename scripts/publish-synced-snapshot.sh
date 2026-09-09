#!/usr/bin/env bash
set -euo pipefail

checked_out_main="$(git rev-parse HEAD)"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -u -- data
git add data/*.json data/*.json.gz data/rag-runtime-v1/** data/cloud-evidence-v1/** public/data/cards-lite.json public/data/snapshot-meta.json
if git diff --cached --quiet; then
  echo "No data changes."
  echo "data_changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

git commit -m "chore(data): sync ruling snapshot"
# Preserve the original generated tree even if rebase or publication fails.
snapshot_commit="$(git rev-parse HEAD)"
echo "snapshot_commit=$snapshot_commit" >> "$GITHUB_OUTPUT"
git fetch --no-tags origin refs/heads/main
remote_main="$(git rev-parse FETCH_HEAD)"
if ! git merge-base --is-ancestor "$checked_out_main" "$remote_main"; then
  echo "main no longer descends from the synchronization base; snapshot retained" >&2
  exit 1
fi

if [ "$checked_out_main" != "$remote_main" ]; then
  # Replay only this generated snapshot. Conflicts stop without choosing either
  # side or forcing a push; no source retrieval or embeddings are repeated.
  git -c rebase.autoStash=false rebase --onto "$remote_main" "$checked_out_main"
  pnpm install --frozen-lockfile
  pnpm check:data
  pnpm check:freshness
  pnpm check
  node scripts/sync-cloud-evidence-assets.mjs --data-dir data --cloud-dir data/cloud-evidence-v1 --check-only
  node --test --test-concurrency=1 tests/rag-runtime-parity.test.mjs
  node --test --test-concurrency=1 tests/sync-ygoresources-selection.test.mjs tests/sync-ocg-rule.test.mjs tests/source-freshness.test.mjs tests/rag-data-source-file.test.mjs tests/rag-data-revision-manifest.test.mjs tests/rag-runtime-bundle.test.mjs tests/rag-runtime-deployment-safety.test.mjs tests/cloud-evidence-assets.test.mjs tests/cloud-evidence-incremental-sync.test.mjs tests/evidence-vector-index.test.mjs tests/deployment-workflows.test.mjs tests/sync-snapshot-publication.test.mjs
  git diff --exit-code
  git diff --cached --exit-code
fi

if [ "$(git rev-parse HEAD)" = "$remote_main" ]; then
  echo "Snapshot is already present on main."
  echo "data_changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
git merge-base --is-ancestor "$remote_main" HEAD
# A second concurrent update is an ordinary rejected push, never a force push.
# The failure artifact keeps the generated tree so it can be recovered.
git push origin HEAD:refs/heads/main
echo "data_changed=true" >> "$GITHUB_OUTPUT"
