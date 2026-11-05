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

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
	},

	async fetchMetrics (config) {
		try {
			const res = await fetch(config.url, { signal: AbortSignal.timeout(10000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const summary = summarize(parseMetrics(await res.text()));
			this.sendSocketNotification("CHIAFARM_DATA", { id: config.id, summary });
		} catch (err) {
			Log.error(`MMM-ChiaFarm: ${err.message}`);
			this.sendSocketNotification("CHIAFARM_DATA", { id: config.id, error: err.message });
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
