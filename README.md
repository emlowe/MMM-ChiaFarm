# MMM-ChiaFarm

MagicMirror² module that shows Chia farm status from a
[chia-exporter](https://github.com/Chia-Network/chia-exporter) `/metrics` endpoint:
sync state, height, plots and size, partials (with rate), pool points, proofs found,
full-node peers, harvester lookup time and version. With a stock
[node_exporter](https://github.com/prometheus/node_exporter) on the farm it also shows the plot
drive count, machine uptime, CPU temperature and OS drive free space, and warns about drive problems.

No npm dependencies (uses Node's built-in `fetch`).

## Config

```js
{
  module: "MMM-ChiaFarm",
  position: "top_left",
  config: {
    url: "http://chiafarm.local:9914/metrics",
    nodeExporterUrl: "http://chiafarm.local:9100/metrics", // null to turn off host details
    drivePattern: "^/chia\\d+$", // mountpoints counted as plot drives
    expectedDrives: 10,   // warn when fewer plot drives are mounted (off by default)
    updateInterval: 60000,
    showBalance: false,   // show wallet XCH balance in the footer
    lookupWarn: 2,        // seconds; lookup time turns yellow above this
    lookupBad: 5          // seconds; red above this
  }
}
```

Status line: **Synced** (green), **Syncing** / **No harvester** (yellow), **Drive missing** / **read-only** (yellow), **Offline** (red, last-known numbers dimmed).
A problem with node_exporter only removes the host details: it never shows as Offline or as a drive warning.

Counters like partials and proofs reset when the exporter restarts. Exporter uptime comes
from `process_start_time_seconds` when present, otherwise it is estimated from signage
points seen since start.
