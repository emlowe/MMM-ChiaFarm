/* MagicMirror Module: MMM-ChiaFarm helper
 * Reads a chia-exporter /metrics endpoint and sends a summary to the front end.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");

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
	const label = (name, key) => (all(name)[0] || { labels: {} }).labels[key] || null;

	// Exporter uptime: prefer the standard process metric; otherwise estimate from
	// signage points seen since start (64 per 600 s sub-slot = 9.375 s each).
	const start = sum("process_start_time_seconds");
	const sps = sum("chia_full_node_total_signage_points");
	const uptimeSec = start ? Date.now() / 1000 - start : (sps != null ? sps * 9.375 : null);

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
		points: sum("chia_farmer_points_acknowledged_since_start"),
		difficulty: sum("chia_farmer_current_difficulty"),
		proofs: sum("chia_farmer_total_found_proofs"),
		lookup,
		netspaceMiB: sum("chia_full_node_netspace_mib"),
		walletSynced: sum("chia_wallet_synced") === 1,
		balanceMojo: sum("chia_wallet_confirmed_balance", { wallet_type: "0" }),
		version: label("chia_full_node_version", "version"),
		uptimeSec
	};
}

// Machine health from a stock node_exporter. drivePattern selects the plot drives by mountpoint.
function summarizeHost(metrics, drivePattern) {
	const rows = (name) => metrics.filter((x) => x.name === name);
	const one = (name) => (rows(name)[0] || {}).value;
	const bytes = (name, mount) => (rows(name).find((x) => x.labels.mountpoint === mount) || {}).value;

	const re = new RegExp(drivePattern);
	const broken = new Set(rows("node_filesystem_device_error").filter((x) => x.value === 1).map((x) => x.labels.mountpoint));
	const drives = new Map();
	for (const r of rows("node_filesystem_readonly")) {
		if (re.test(r.labels.mountpoint) && !broken.has(r.labels.mountpoint)) drives.set(r.labels.mountpoint, r.value === 1);
	}

	const now = one("node_time_seconds");
	const boot = one("node_boot_time_seconds");
	const pkg = rows("node_thermal_zone_temp").find((x) => x.labels.type === "x86_pkg_temp");
	const core = rows("node_hwmon_temp_celsius").filter((x) => (x.labels.chip || "").includes("coretemp")).map((x) => x.value);
	const size = bytes("node_filesystem_size_bytes", "/");
	const avail = bytes("node_filesystem_avail_bytes", "/");

	return {
		uptimeSec: now && boot ? now - boot : null,
		cpuTemp: pkg ? pkg.value : (core.length ? Math.max(...core) : null),
		osFreePct: size && avail != null ? (100 * avail) / size : null,
		driveCount: drives.size,
		readOnly: [...drives].filter(([, ro]) => ro).map(([mount]) => mount).sort()
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
	},

	async fetchMetrics (config) {
		// The two sources fail independently: node_exporter being down only removes the host details.
		const [chia, node] = await Promise.allSettled([
			getText(config.url),
			config.nodeExporterUrl ? getText(config.nodeExporterUrl) : Promise.resolve(null)
		]);

		let host = null;
		if (node.status === "rejected") {
			Log.error(`MMM-ChiaFarm: node_exporter: ${node.reason.message}`);
		} else if (node.value) {
			host = summarizeHost(parseMetrics(node.value), config.drivePattern);
		}

		if (chia.status === "rejected") {
			Log.error(`MMM-ChiaFarm: ${chia.reason.message}`);
			this.sendSocketNotification("CHIAFARM_DATA", { id: config.id, host, error: chia.reason.message });
		} else {
			this.sendSocketNotification("CHIAFARM_DATA", { id: config.id, host, summary: summarize(parseMetrics(chia.value)) });
		}
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
