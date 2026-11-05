/* MagicMirror Module: MMM-ChiaFarm helper
 * Reads chia-exporter and node_exporter metrics and sends a summary to the front end.
 */
const fs = require("fs");
const path = require("path");
const NodeHelper = require("node_helper");
const Log = require("logger");

const HISTORY_FILE = path.join(__dirname, "history.json");
const MIN_SAMPLE_GAP = 45 * 1000;      // several open pages must not add extra readings
const MAX_SAMPLE_GAP = 5 * 60 * 1000;  // readings further apart than this leave a hole, not a stall
const BUCKET = 10 * 60 * 1000;
const BUCKETS = 18;                    // three hours of ten-minute bars
const RATE_WINDOW = 60 * 60 * 1000;
const MIN_RATE_COVERAGE = 10 * 60 * 1000;
const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const PRICE_INTERVAL = 10 * 60 * 1000;
const PRICE_MAX_AGE = 60 * 60 * 1000;  // an older price is hidden rather than shown as current
const POOL_API = "https://api.foxypool.io/api/v4";
const POOL_INTERVAL = 5 * 60 * 1000;
const POOL_MAX_AGE = 60 * 60 * 1000;   // an older valid percentage is hidden

// Parse Prometheus text format into [{name, labels, value}]
function parseMetrics(text) {
	const out = [];
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/);
		if (!m) continue;
		const labels = {};
		if (m[2]) {
			for (const l of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
		}
		out.push({ name: m[1], labels, value: Number(m[3]) });
	}
	return out;
}

function summarize(metrics) {
	const all = (name, where = {}) => metrics.filter(
		(x) => x.name === name && Object.entries(where).every(([k, v]) => x.labels[k] === v)
	);
	const sum = (name, where) => {
		const rows = all(name, where);
		return rows.length ? rows.reduce((a, r) => a + r.value, 0) : null;
	};

	// Lookup time: harvester reports seconds; farmer reports microseconds.
	let lookup = sum("chia_harvester_last_lookup_time");
	if (lookup == null) {
		const f = all("chia_farmer_last_lookup_time").map((r) => r.value);
		if (f.length) lookup = Math.max(...f) / 1e6;
	}

	return {
		synced: sum("chia_full_node_node_synced") === 1,
		height: sum("chia_full_node_node_height"),
		peers: sum("chia_full_node_connection_count", { node_type: "full_node" }),
		harvesters: sum("chia_farmer_connection_count", { node_type: "harvester" }),
		plots: sum("chia_farmer_plot_count"),
		plotBytes: sum("chia_farmer_plot_filesize"),
		partials: sum("chia_farmer_submitted_partials"),
		eligiblePlots: sum("chia_farmer_total_eligible_plots"),
		netspaceMiB: sum("chia_full_node_netspace_mib"),
		launcherId: (all("chia_farmer_submitted_partials")[0] || { labels: {} }).labels.launcher_id || null,
		lookup
	};
}

// Plot drive health from a stock node_exporter. drivePattern selects drives by mountpoint.
function summarizeHost(metrics, drivePattern) {
	const rows = (name) => metrics.filter((x) => x.name === name);
	const re = new RegExp(drivePattern);
	const broken = new Set(rows("node_filesystem_device_error").filter((x) => x.value === 1).map((x) => x.labels.mountpoint));
	const drives = new Map();
	for (const r of rows("node_filesystem_readonly")) {
		if (re.test(r.labels.mountpoint) && !broken.has(r.labels.mountpoint)) drives.set(r.labels.mountpoint, r.value === 1);
	}
	return {
		driveCount: drives.size,
		readOnly: [...drives].filter(([, ro]) => ro).map(([mount]) => mount).sort()
	};
}

// Turn counter readings [{t, v}] into recent activity. The counter restarts from zero with
// the exporter, and time with no readings counts as unknown rather than as no partials.
function partialStats(samples, now) {
	const spans = [];
	for (let i = 1; i < samples.length; i++) {
		const a = samples[i - 1], b = samples[i];
		if (b.t - a.t > MAX_SAMPLE_GAP) continue;
		spans.push({ start: a.t, end: b.t, delta: b.v >= a.v ? b.v - a.v : b.v });
	}

	const recent = spans.filter((s) => s.end > now - RATE_WINDOW);
	const covered = recent.reduce((n, s) => n + s.end - s.start, 0);
	const count = recent.reduce((n, s) => n + s.delta, 0);

	const bars = new Array(BUCKETS).fill(null);
	for (const s of spans) {
		const i = BUCKETS - 1 - Math.floor((now - s.end) / BUCKET);
		if (i >= 0 && i < BUCKETS) bars[i] = (bars[i] || 0) + s.delta;
	}

	let quiet = 0;
	for (let i = spans.length - 1; i >= 0 && spans[i].delta === 0; i--) quiet += spans[i].end - spans[i].start;

	return {
		rate: covered >= MIN_RATE_COVERAGE ? (count * RATE_WINDOW) / covered : null,
		quietSec: quiet / 1000,
		bars
	};
}

function addSample(samples, t, v, e = null) {
	if (v == null) return samples;
	const last = samples[samples.length - 1];
	if (last && t - last.t < MIN_SAMPLE_GAP) return samples;
	const cutoff = t - BUCKET * (BUCKETS + 1);
	return samples.filter((s) => s.t >= cutoff).concat({ t, v, e });
}

function parsePrice(text, coin) {
	const entry = JSON.parse(text)[coin];
	if (!entry || !Number.isFinite(entry.usd)) throw new Error(`no price for ${coin}`);
	return { usd: entry.usd, change24h: Number.isFinite(entry.usd_24h_change) ? entry.usd_24h_change : null };
}

// Blocks since the last win times this farm's share of the network, as the pool's own
// page calculates it. Unknown until there's a win since the account last joined the pool.
function currentEffort(pool, height, netspaceMiB) {
	if (!pool.lastWinHeight || !pool.ecGiB || !height || !netspaceMiB) return null;
	return (100 * Math.max(0, height - pool.lastWinHeight) * pool.ecGiB * 1024) / netspaceMiB;
}

// Time the eligible plot count has been standing still. No plots passing the filter means
// the farm isn't receiving signage points or isn't checking its plots. Null when unknown.
function notFarmingSeconds(samples) {
	let quiet = 0;
	let known = false;
	for (let i = samples.length - 1; i > 0; i--) {
		const a = samples[i - 1], b = samples[i];
		if (b.t - a.t > MAX_SAMPLE_GAP) continue;
		if (a.e == null || b.e == null) break;
		known = true;
		const delta = b.e >= a.e ? b.e - a.e : b.e;
		if (delta > 0) break;
		quiet += b.t - a.t;
	}
	return known ? quiet / 1000 : null;
}

// Foxy-Pool account details and 24 hours of history, reduced to what the panel shows.
function parsePool(account, history, wins) {
	const total = (key) => history.reduce((n, row) => n + (row[key] || 0), 0);
	const valid = total("shares");
	const all = valid + total("staleShares") + total("invalidShares");
	const accepted = Date.parse(account.lastAcceptedPartialAt);
	const lastWin = wins.reduce((latest, win) => (!latest || win.height > latest.height ? win : latest), null);
	const beforeRejoin = lastWin && account.rejoinedAt && Date.parse(lastWin.createdAt) < Date.parse(account.rejoinedAt);
	return {
		validPct: all > 0 ? (100 * valid) / all : null,
		lastAccepted: Number.isFinite(accepted) ? accepted : null,
		lastWinHeight: lastWin && !beforeRejoin ? lastWin.height : null,
		ecGiB: Number.isFinite(account.ec) ? account.ec : null
	};
}

async function getText(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.samples = this.loadSamples();
	},

	loadSamples () {
		try {
			const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
			return saved.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v));
		} catch (err) {
			if (err.code !== "ENOENT") Log.error(`MMM-ChiaFarm: could not read history: ${err.message}`);
			return [];
		}
	},

	saveSamples () {
		try {
			fs.writeFileSync(`${HISTORY_FILE}.tmp`, JSON.stringify(this.samples));
			fs.renameSync(`${HISTORY_FILE}.tmp`, HISTORY_FILE);
		} catch (err) {
			Log.error(`MMM-ChiaFarm: could not save history: ${err.message}`);
		}
	},

	// Refreshes on its own slower schedule, however many pages are open. A failure only
	// ever hides the price: it never affects the farm status.
	async refreshPrice (coin, now) {
		if (this.priceAttempt && now - this.priceAttempt < PRICE_INTERVAL) return;
		this.priceAttempt = now;
		try {
			const url = `${PRICE_URL}?ids=${encodeURIComponent(coin)}&vs_currencies=usd&include_24hr_change=true`;
			this.price = { ...parsePrice(await getText(url), coin), time: now };
		} catch (err) {
			Log.error(`MMM-ChiaFarm: price: ${err.message}`);
		}
	},

	// Same rules as the price: its own slower schedule, and a failure never affects the
	// farm status. After a failed attempt the last accepted time can't be trusted, so
	// the no-partials warning goes back to the local count.
	async refreshPool (poolId, launcherId, now) {
		if (this.poolAttempt && now - this.poolAttempt < POOL_INTERVAL) return;
		this.poolAttempt = now;
		try {
			const base = `${POOL_API}/${encodeURIComponent(poolId)}/account/${encodeURIComponent(launcherId.replace(/^0x/, ""))}`;
			const [account, history, wins] = await Promise.all([
				getText(base),
				getText(`${base}/historical?duration=1d`),
				getText(`${base}/won-blocks`)
			]);
			this.pool = { ...parsePool(JSON.parse(account), JSON.parse(history), JSON.parse(wins)), time: now };
		} catch (err) {
			Log.error(`MMM-ChiaFarm: pool: ${err.message}`);
			if (this.pool) this.pool.lastAccepted = null;
		}
	},

	currentPool (now, summary) {
		if (!this.pool || now - this.pool.time > POOL_MAX_AGE) return null;
		const { validPct, lastAccepted } = this.pool;
		return {
			validPct,
			quietSec: lastAccepted == null ? null : Math.max(0, now - lastAccepted) / 1000,
			effortPct: summary ? currentEffort(this.pool, summary.height, summary.netspaceMiB) : null
		};
	},

	currentPrice (now) {
		return this.price && now - this.price.time <= PRICE_MAX_AGE ? this.price : null;
	},

	async fetchMetrics (config) {
		// The two sources fail independently: node_exporter being down only removes the drive details.
		const [chia, node] = await Promise.allSettled([
			getText(config.url),
			config.nodeExporterUrl ? getText(config.nodeExporterUrl) : Promise.resolve(null),
			config.priceCoin ? this.refreshPrice(config.priceCoin, Date.now()) : Promise.resolve()
		]);

		let host = null;
		if (node.status === "rejected") {
			Log.error(`MMM-ChiaFarm: node_exporter: ${node.reason.message}`);
		} else if (node.value) {
			host = summarizeHost(parseMetrics(node.value), config.drivePattern);
		}

		const payload = { id: config.id, host, price: config.priceCoin ? this.currentPrice(Date.now()) : null };
		if (chia.status === "rejected") {
			Log.error(`MMM-ChiaFarm: ${chia.reason.message}`);
			payload.error = chia.reason.message;
		} else {
			const { launcherId, ...summary } = summarize(parseMetrics(chia.value));
			payload.summary = summary;
			const before = this.samples;
			this.samples = addSample(before, Date.now(), summary.partials, summary.eligiblePlots);
			if (this.samples !== before) this.saveSamples();
			if (config.foxyPool && launcherId) await this.refreshPool(config.foxyPool, launcherId, Date.now());
		}
		const now = Date.now();
		payload.pool = config.foxyPool ? this.currentPool(now, payload.summary) : null;
		payload.partials = partialStats(this.samples, now);
		payload.notFarmingSec = notFarmingSeconds(this.samples);
		this.sendSocketNotification("CHIAFARM_DATA", payload);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CHIAFARM_FETCH" && payload && payload.url) {
			this.fetchMetrics(payload);
		}
	}
});

// Exported for local testing
module.exports.parseMetrics = parseMetrics;
module.exports.summarize = summarize;
module.exports.summarizeHost = summarizeHost;
module.exports.partialStats = partialStats;
module.exports.addSample = addSample;
module.exports.parsePrice = parsePrice;
module.exports.parsePool = parsePool;
module.exports.currentEffort = currentEffort;
module.exports.notFarmingSeconds = notFarmingSeconds;
