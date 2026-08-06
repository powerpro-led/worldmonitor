// Clear Nitric's local dashboard request history before starting a service.
//
// The dashboard rewrites .nitric/history-<type>.json in full on every API request,
// synchronously, before the response is flushed (pkg/dashboard/history.go). The file
// is uncapped, so per-request latency grows at roughly 15ms per MB of history. Left
// alone it reached 343MB in the sibling platform/backend repo, costing ~4.8s on every
// request — this is a straight port of that repo's scripts/clean-nitric-history.mjs,
// same fix, same root cause (worldmonitor's Nitric project root is also the repo root,
// so the relative ../.nitric path below resolves the same way).
//
// Truncate to zero rather than deleting: the CLI treats a 0-byte file as "no records",
// but a missing file — or one holding partial JSON — makes it log.Fatal and take down
// `nitric start`. Truncation never leaves a partial-content window.
//
// Usage: run alongside `nitric start` in a separate terminal (or `&`-backgrounded):
//   node scripts/clean-nitric-history.mjs &
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const historyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.nitric');
const INTERVAL_MS = 5 * 60 * 1000;

function clean() {
  let entries;
  try {
    entries = fs.readdirSync(historyDir);
  } catch {
    return; // nitric hasn't started yet, or history dir was removed
  }

  for (const entry of entries) {
    if (!entry.startsWith('history-') || !entry.endsWith('.json')) continue;
    try {
      fs.truncateSync(path.join(historyDir, entry), 0);
    } catch {
      // locked or vanished; not worth failing the dev server over
    }
  }
}

clean();
setInterval(clean, INTERVAL_MS);
