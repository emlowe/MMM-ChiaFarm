# MMM-ChiaFarm

MagicMirror² module that shows Chia farm status from a
[chia-exporter](https://github.com/Chia-Network/chia-exporter) `/metrics` endpoint:
sync state, height, plots and size, partials (with rate), pool points, proofs found,
full-node peers, harvester lookup time, version and exporter uptime.

No npm dependencies (uses Node's built-in `fetch`).

## Config

```js
{
  module: "MMM-ChiaFarm",
  position: "top_left",
  config: {
    url: "http://chiafarm.local:9914/metrics",
    updateInterval: 60000,
    showBalance: false,   // show wallet XCH balance in the footer
    lookupWarn: 2,        // seconds; lookup time turns yellow above this
    lookupBad: 5          // seconds; red above this
  }
}
```

Status line: **Synced** (green), **Syncing** / **No harvester** (yellow), **Offline** (red, last-known numbers dimmed).

Counters like partials and proofs reset when the exporter restarts. Exporter uptime comes
from `process_start_time_seconds` when present, otherwise it is estimated from signage
points seen since start.
