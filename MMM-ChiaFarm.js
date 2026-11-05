/* MagicMirror Module: MMM-ChiaFarm
 * Chia farm status from chia-exporter and node_exporter (Prometheus) metrics.
 */
Module.register("MMM-ChiaFarm", {
	defaults: {
		url: "http://chiafarm.local:9914/metrics",
		nodeExporterUrl: "http://chiafarm.local:9100/metrics", // null to turn off drive details
		drivePattern: "^/chia\\d+$", // mountpoints counted as plot drives
		expectedDrives: null,    // set to warn when fewer plot drives are mounted
		partialWarnMinutes: 20,  // warn after this long with no partials; 0 to turn off
		priceCoin: "chia",       // CoinGecko coin ID for the price stat; null to turn off
		updateInterval: 60 * 1000,
		title: "Chia Farm",
		lookupWarn: 2,           // seconds: yellow above this
		lookupBad: 5             // seconds: red above this
	},

	start () {
		this.summary = null;
		this.host = null;
		this.partials = null;
		this.price = null;
		this.error = null;
		this.fetch();
		setInterval(() => this.fetch(), this.config.updateInterval);
	},

	getStyles () {
		return ["MMM-ChiaFarm.css"];
	},

	fetch () {
		this.sendSocketNotification("CHIAFARM_FETCH", {
			id: this.identifier,
			url: this.config.url,
			nodeExporterUrl: this.config.nodeExporterUrl,
			drivePattern: this.config.drivePattern,
			priceCoin: this.config.priceCoin
		});
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "CHIAFARM_DATA" || payload.id !== this.identifier) return;
		this.host = payload.host || null;
		this.partials = payload.partials || null;
		this.price = payload.price || null;
		if (payload.error) {
			this.error = payload.error;
		} else {
			this.error = null;
			this.summary = payload.summary;
		}
		this.updateDom(500);
	},

	el (tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined && text !== null) e.textContent = text;
		return e;
	},

	fmtInt (n) {
		return n == null ? "–" : Math.round(n).toLocaleString();
	},

	fmtBytes (b) {
		if (b == null) return "–";
		const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
		let i = 0;
		while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
		return `${b.toFixed(b < 10 ? 2 : 1)} ${units[i]}`;
	},

	fmtQuiet (sec) {
		const m = Math.floor(sec / 60);
		return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
	},

	stat (value, label, cls) {
		const s = this.el("div", "cf-stat" + (cls ? " " + cls : ""));
		s.appendChild(this.el("div", "cf-stat-value", value));
		s.appendChild(this.el("div", "cf-stat-label", label));
		return s;
	},

	drivesShort () {
		return Boolean(this.host && this.config.expectedDrives && this.host.driveCount < this.config.expectedDrives);
	},

	// Drive problem to show in place of "Synced", or null. Unknown (no node_exporter) is not a problem.
	driveProblem () {
		const h = this.host;
		if (!h) return null;
		if (this.drivesShort()) {
			const missing = this.config.expectedDrives - h.driveCount;
			return missing === 1 ? "Drive missing" : `${missing} drives missing`;
		}
		if (h.readOnly.length === 1) return `${h.readOnly[0]} read-only`;
		if (h.readOnly.length > 1) return `${h.readOnly.length} drives read-only`;
		return null;
	},

	partialsQuiet () {
		const mins = this.config.partialWarnMinutes;
		return Boolean(mins && this.partials && this.partials.quietSec >= mins * 60);
	},

	sizeLabel (s) {
		const size = this.fmtBytes(s.plotBytes);
		const h = this.host;
		if (!h) return size;
		return this.drivesShort()
			? `${size} · ${h.driveCount} of ${this.config.expectedDrives} drives`
			: `${size} · ${h.driveCount} drives`;
	},

	priceStat () {
		const p = this.price;
		const value = `$${p.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
		if (p.change24h == null) return this.stat(value, "24h");
		const change = Math.round(p.change24h * 10) / 10;
		const label = `${change > 0 ? "+" : ""}${change.toFixed(1)}% 24h`;
		return this.stat(value, label, change > 0 ? "cf-up" : (change < 0 ? "cf-down" : null));
	},

	buildGraph () {
		const wrap = this.el("div", "cf-graph");
		const barsEl = this.el("div", "cf-bars");
		const bars = this.partials ? this.partials.bars : [];
		const top = Math.max(1, ...bars.map((n) => n || 0));
		for (const n of bars) {
			const bar = this.el("div", n == null ? "cf-bar cf-bar-empty" : "cf-bar");
			if (n != null) bar.style.height = `${(100 * n) / top}%`;
			barsEl.appendChild(bar);
		}
		wrap.appendChild(barsEl);
		const axis = this.el("div", "cf-axis");
		axis.appendChild(this.el("span", null, "3h ago"));
		axis.appendChild(this.el("span", null, "now"));
		wrap.appendChild(axis);
		return wrap;
	},

	getDom () {
		const w = this.el("div", "chiafarm");
		w.appendChild(this.el("div", "cf-title", this.config.title));

		if (!this.summary && !this.error) {
			w.appendChild(this.el("div", "dimmed small", "Loading…"));
			return w;
		}

		const s = this.summary || {};
		const quiet = this.partialsQuiet();
		let state = "ok", stateText = "Synced";
		if (this.error) { state = "bad"; stateText = "Offline"; }
		else if (!s.synced) { state = "warn"; stateText = "Syncing"; }
		else if (!s.harvesters) { state = "warn"; stateText = "No harvester"; }
		else if (this.driveProblem()) { state = "warn"; stateText = this.driveProblem(); }
		else if (quiet) { state = "warn"; stateText = `No partials ${this.fmtQuiet(this.partials.quietSec)}`; }
		w.classList.add("cf-" + state);
		if (this.error && this.summary) w.classList.add("cf-stale");
		if (quiet) w.classList.add("cf-quiet");

		const hero = this.el("div", "cf-hero");
		hero.appendChild(this.el("span", "cf-dot"));
		hero.appendChild(this.el("span", "cf-state", stateText));
		if (s.height != null) hero.appendChild(this.el("span", "cf-height", this.fmtInt(s.height)));
		w.appendChild(hero);

		if (!this.summary) return w;

		const rate = this.partials && this.partials.rate != null ? this.partials.rate.toFixed(1) : "–";
		const top = this.el("div", "cf-partials");
		const big = this.el("div", "cf-rate");
		big.appendChild(this.el("div", "cf-rate-value", rate));
		big.appendChild(this.el("div", "cf-stat-label", "partials/hr"));
		top.appendChild(big);
		top.appendChild(this.buildGraph());
		w.appendChild(top);

		let lookCls = "cf-good";
		if (s.lookup != null && s.lookup > this.config.lookupBad) lookCls = "cf-badtext";
		else if (s.lookup != null && s.lookup > this.config.lookupWarn) lookCls = "cf-warntext";

		const row = this.el("div", "cf-row");
		row.appendChild(this.stat(this.fmtInt(s.plots), this.sizeLabel(s), this.drivesShort() ? "cf-short" : null));
		row.appendChild(this.stat(this.fmtInt(s.peers), "peers"));
		row.appendChild(this.stat(s.lookup != null ? `${s.lookup.toFixed(2)}s` : "–", "lookup", lookCls));
		if (this.price) row.appendChild(this.priceStat());
		w.appendChild(row);

		return w;
	}
});
