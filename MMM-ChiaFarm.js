/* MagicMirror Module: MMM-ChiaFarm
 * Chia farm status from chia-exporter (Prometheus) metrics.
 */
Module.register("MMM-ChiaFarm", {
	defaults: {
		url: "http://chiafarm.local:9914/metrics",
		nodeExporterUrl: "http://chiafarm.local:9100/metrics", // null to turn off host details
		drivePattern: "^/chia\\d+$", // mountpoints counted as plot drives
		expectedDrives: null,    // set to warn when fewer plot drives are mounted
		updateInterval: 60 * 1000,
		title: "Chia Farm",
		showBalance: false,      // wallet balance on a family screen is off by default
		lookupWarn: 2,           // seconds: yellow above this
		lookupBad: 5             // seconds: red above this
	},

	start () {
		this.summary = null;
		this.host = null;
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
			drivePattern: this.config.drivePattern
		});
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "CHIAFARM_DATA" || payload.id !== this.identifier) return;
		this.host = payload.host || null;
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

	fmtDuration (s) {
		if (s == null) return null;
		const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
		if (d) return `${d}d ${h}h`;
		if (h) return `${h}h ${m}m`;
		return `${m}m`;
	},

	stat (value, label, cls) {
		const s = this.el("div", "cf-stat" + (cls ? " " + cls : ""));
		s.appendChild(this.el("div", "cf-stat-value", value));
		s.appendChild(this.el("div", "cf-stat-label", label));
		return s;
	},

	// Drive problem to show in place of "Synced", or null. Unknown (no node_exporter) is not a problem.
	driveProblem () {
		const h = this.host;
		if (!h) return null;
		const missing = this.config.expectedDrives ? this.config.expectedDrives - h.driveCount : 0;
		if (missing > 0) return missing === 1 ? "Drive missing" : `${missing} drives missing`;
		if (h.readOnly.length === 1) return `${h.readOnly[0]} read-only`;
		if (h.readOnly.length > 1) return `${h.readOnly.length} drives read-only`;
		return null;
	},

	sizeLabel (s) {
		const size = this.fmtBytes(s.plotBytes);
		const h = this.host;
		if (!h) return size;
		const expected = this.config.expectedDrives;
		return expected && h.driveCount < expected
			? `${size} · ${h.driveCount} of ${expected} drives`
			: `${size} · ${h.driveCount} drives`;
	},

	getDom () {
		const w = this.el("div", "chiafarm");
		w.appendChild(this.el("div", "cf-title", this.config.title));

		if (!this.summary && !this.error) {
			w.appendChild(this.el("div", "dimmed small", "Loading…"));
			return w;
		}

		const s = this.summary || {};
		let state = "ok", stateText = "Synced";
		if (this.error) { state = "bad"; stateText = "Offline"; }
		else if (!s.synced) { state = "warn"; stateText = "Syncing"; }
		else if (!s.harvesters) { state = "warn"; stateText = "No harvester"; }
		else if (this.driveProblem()) { state = "warn"; stateText = this.driveProblem(); }
		w.classList.add("cf-" + state);
		if (this.error && this.summary) w.classList.add("cf-stale");

		const hero = this.el("div", "cf-hero");
		hero.appendChild(this.el("span", "cf-dot"));
		hero.appendChild(this.el("span", "cf-state", stateText));
		if (s.height != null) hero.appendChild(this.el("span", "cf-height", this.fmtInt(s.height)));
		w.appendChild(hero);

		if (!this.summary) return w;

		const hours = s.uptimeSec ? s.uptimeSec / 3600 : null;
		const rate = hours && s.partials != null ? `${(s.partials / hours).toFixed(1)}/hr` : "partials";

		let lookCls = "cf-good";
		if (s.lookup != null && s.lookup > this.config.lookupBad) lookCls = "cf-badtext";
		else if (s.lookup != null && s.lookup > this.config.lookupWarn) lookCls = "cf-warntext";

		const grid = this.el("div", "cf-grid");
		const short = this.host && this.config.expectedDrives && this.host.driveCount < this.config.expectedDrives;
		const plots = this.stat(this.fmtInt(s.plots), this.sizeLabel(s));
		if (short) plots.classList.add("cf-short");
		grid.appendChild(plots);
		grid.appendChild(this.stat(this.fmtInt(s.partials), rate));
		grid.appendChild(this.stat(this.fmtInt(s.points), "points"));
		grid.appendChild(this.stat(this.fmtInt(s.proofs), "proofs"));
		grid.appendChild(this.stat(this.fmtInt(s.peers), "peers"));
		grid.appendChild(this.stat(s.lookup != null ? `${s.lookup.toFixed(2)}s` : "–", "lookup", lookCls));
		w.appendChild(grid);

		const foot = [];
		if (s.version) foot.push(`v${s.version}`);
		const h = this.host;
		if (h && h.uptimeSec != null) foot.push(`up ${this.fmtDuration(h.uptimeSec)}`);
		else if (s.uptimeSec != null) foot.push(`exporter up ${this.fmtDuration(s.uptimeSec)}`);
		if (h && h.cpuTemp != null) foot.push(`${Math.round(h.cpuTemp)}°C`);
		if (h && h.osFreePct != null) foot.push(`OS drive ${Math.round(h.osFreePct)}% free`);
		if (s.netspaceMiB) foot.push(`net ${this.fmtBytes(s.netspaceMiB * 1048576)}`);
		if (this.config.showBalance && s.balanceMojo != null) foot.push(`${(s.balanceMojo / 1e12).toFixed(2)} XCH`);
		w.appendChild(this.el("div", "cf-foot", foot.join(" · ")));

		return w;
	}
});
