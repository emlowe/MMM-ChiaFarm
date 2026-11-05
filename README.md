# MMM-ChiaFarm

MagicMirror² module that shows Chia farm status from a
[chia-exporter](https://github.com/Chia-Network/chia-exporter) `/metrics` endpoint: sync state,
height, recent partials rate with a three-hour graph, plots and size, full-node peers,
harvester lookup time and the coin price with its 24-hour change. With a stock [node_exporter](https://github.com/prometheus/node_exporter)
on the farm it also shows the plot drive count and warns about drive problems.

No npm dependencies (uses Node's built-in `fetch`).

## Config

```js
{
  module: "MMM-ChiaFarm",
  position: "top_left",
  config: {
    url: "http://chiafarm.local:9914/metrics",
    nodeExporterUrl: "http://chiafarm.local:9100/metrics", // null to turn off drive details
    drivePattern: "^/chia\\d+$", // mountpoints counted as plot drives
    expectedDrives: 10,     // warn when fewer plot drives are mounted (off by default)
    partialWarnMinutes: 20, // warn after this long with no partials; 0 to turn off
    priceCoin: "chia",      // CoinGecko coin ID for the price stat; null to turn off
    foxyPool: "chia",       // Foxy-Pool pool ID for pool-side partial data (off by default)
    validWarnPercent: 100,  // valid percentage turns yellow below this
    updateInterval: 60000,
    lookupWarn: 2,          // seconds; lookup time turns yellow above this
    lookupBad: 5            // seconds; red above this
  }
}
```

Status line: **Synced** (green), **Syncing** / **No harvester** / **Drive missing** / **read-only** /
**No partials** (yellow), **Offline** (red, last-known numbers dimmed).
A problem with node_exporter only removes the drive details: it never shows as Offline or as a drive warning.

## Price

The price comes from CoinGecko's public API, with no key, and refreshes every ten minutes.
If it can't be fetched, the last price stays for up to an hour and then the stat disappears.
A price problem never changes the farm status.

## Foxy-Pool

With `foxyPool` set, the module looks up your account on Foxy-Pool's public API, using the launcher ID
that chia-exporter reports. No key is needed. It refreshes every five minutes and adds two things:

- The valid share percentage over the last 24 hours, shown under the graph.
- The no-partials warning uses the time the pool last accepted a partial, rather than the local count.

If the pool can't be reached, the warning goes back to the local count, and the percentage disappears
after an hour. A pool problem never changes the farm status in any other way.

## Partials rate and graph

The exporter's counter only totals partials since it started, so the helper records it each update
and saves the readings in `history.json`. The rate covers the last hour and appears after ten minutes
of readings. The graph fills in over three hours. Time with no readings shows as a flat grey line, and
doesn't count toward the no-partials warning. Exporter restarts don't appear as a stall.
