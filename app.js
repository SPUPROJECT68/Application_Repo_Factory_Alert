(() => {
	'use strict';

	const $ = (selector, root = document) => root.querySelector(selector);
	const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

	const STORAGE_KEYS = {
		thresholds: 'forgeops-thresholds',
		theme: 'forgeops-theme',
		iotConfig: 'forgeops-iot-config',
		devices: 'forgeops-real-devices',
		users: 'forgeops-users'
	};

	const defaultThresholds = {
		pm25Warning: 35,
		pm25Danger: 75,
		pm10Warning: 50,
		pm10Danger: 100,
		tempWarning: 30,
		tempDanger: 35,
		humidityLow: 40,
		humidityHigh: 70,
		humidityDangerLow: 30,
		humidityDangerHigh: 80,
		anomalyWarning: 0.60,
		anomalyDanger: 0.80
	};

	const defaultIotConfig = {
		tbHost: 'https://thingsboard.cloud',
		tbJwtToken: '',
		tbPublicDashboardUrl: '',
		tbPollIntervalMs: 5000,
		tbUseWebSocket: false,
		eiProjectName: 'Uefa_ProjectSPU',
		eiAutoAlert: true
	};

	const defaultUsers = [
		{ id: 'u-admin', name: 'Admin User', username: 'admin', password: 'admin123', role: 'Admin', status: 'ACTIVE' },
		{ id: 'u-operator', name: 'Line Operator', username: 'operator', password: 'operator123', role: 'Operator', status: 'ACTIVE' }
	];

	const readStorage = (key, fallback) => {
		try {
			const saved = localStorage.getItem(key);
			return saved ? JSON.parse(saved) : structuredClone(fallback);
		} catch {
			return structuredClone(fallback);
		}
	};

	const savedUsers = readStorage(STORAGE_KEYS.users, defaultUsers);
	const initialUsers = Array.isArray(savedUsers) && savedUsers.length > 0 ? savedUsers : structuredClone(defaultUsers);
	localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(initialUsers));

	const state = {
		route: 'dashboard',
		role: 'Admin',
		user: 'Admin User',
		username: 'admin',
		users: initialUsers,
		thresholds: { ...defaultThresholds, ...readStorage(STORAGE_KEYS.thresholds, {}) },
		iotConfig: { ...defaultIotConfig, ...readStorage(STORAGE_KEYS.iotConfig, {}) },
		theme: localStorage.getItem(STORAGE_KEYS.theme) || 'light',
		activeMachine: null,
		hasTelemetry: false,
		sensorHistory: { pm25: [], pm10: [], temperature: [], humidity: [], anomalyScore: [] },
		sensors: { pm25: null, pm10: null, temperature: null, humidity: null },
		edgeAi: {
			nodeId: '--',
			machineId: '--',
			status: 'offline',
			label: 'No Signal',
			anomalyScore: null,
			confidence: null,
			inferenceMs: null
		},
		tbConnection: {
			status: 'idle',
			lastSync: null,
			errorMsg: ''
		},
		alerts: [],
		activeSensorAlerts: new Map(),
		alertFilter: 'all',
		machineFilter: 'all',
		sensorFilter: 'all',
		alertDateFilter: '',
		chartMetric: 'env',
		reportRange: 'today',
		reportStartDate: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
		reportEndDate: new Date().toISOString().slice(0, 10),
		reportLogs: [],
		reportLoading: false,
		sensorUpdatedAt: null,
		machines: readStorage(STORAGE_KEYS.devices, [])
	};

	const sensorMeta = {
		pm25: { name: 'PM2.5', unit: 'µg/m³', icon: 'radio' },
		pm10: { name: 'PM10', unit: 'µg/m³', icon: 'radio' },
		temperature: { name: 'Temperature', unit: '°C', icon: 'cpu' },
		humidity: { name: 'Humidity', unit: '%', icon: 'radio' }
	};

	let tbSocket = null;

	function esc(value) {
		return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
	}

	function icon(name) {
		return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
	}

	function formatTime(timestamp) {
		if (!timestamp) return 'Waiting...';
		return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
	}

	function formatDateTime(timestamp) {
		if (!timestamp) return '--';
		return new Intl.DateTimeFormat('en-GB', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).format(timestamp);
	}

	function relativeTime(timestamp) {
		if (!timestamp) return 'No data yet';
		const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
		return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
	}

	function isNum(v) {
		return typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v);
	}

	function severityFor(key, value) {
		if (!isNum(value)) return 'offline';
		const t = state.thresholds;
		if (key === 'pm25') return value > t.pm25Danger ? 'danger' : value > t.pm25Warning ? 'warning' : 'normal';
		if (key === 'pm10') return value > t.pm10Danger ? 'danger' : value > t.pm10Warning ? 'warning' : 'normal';
		if (key === 'temperature') return value >= t.tempDanger ? 'danger' : value > t.tempWarning ? 'warning' : 'normal';
		if (key === 'humidity') return value < t.humidityDangerLow || value > t.humidityDangerHigh ? 'danger' : value < t.humidityLow || value > t.humidityHigh ? 'warning' : 'normal';
		if (key === 'anomaly') return value >= t.anomalyDanger ? 'danger' : value >= t.anomalyWarning ? 'warning' : 'normal';
		return 'normal';
	}

	function severityLabel(severity) {
		if (severity === 'offline') return 'STANDBY';
		return severity === 'normal' ? 'NORMAL' : severity.toUpperCase();
	}

	function machineSeverity(machine) {
		if (!machine.connected) return 'offline';
		if (machine.status === 'ERROR' || (isNum(machine.anomalyScore) && machine.anomalyScore >= state.thresholds.anomalyDanger)) return 'danger';
		if (machine.status === 'OFFLINE') return 'offline';
		if (machine.status === 'WARNING' || (isNum(machine.anomalyScore) && machine.anomalyScore >= state.thresholds.anomalyWarning)) return 'warning';
		return 'normal';
	}

	function currentSeverity() {
		if (!state.hasTelemetry) return 'normal';
		const order = { offline: 0, normal: 0, warning: 1, danger: 2 };
		const sensorSeverity = Object.keys(state.sensors).map(key => severityFor(key, state.sensors[key]));
		const aiSev = severityFor('anomaly', state.edgeAi.anomalyScore);
		const machineDanger = state.machines.some(m => m.connected && m.status === 'ERROR');
		if (machineDanger || sensorSeverity.includes('danger') || aiSev === 'danger' || state.edgeAi.status === 'danger') return 'danger';
		if (sensorSeverity.includes('warning') || aiSev === 'warning' || state.edgeAi.status === 'warning') return 'warning';
		return sensorSeverity.reduce((worst, item) => order[item] > order[worst] ? item : worst, 'normal');
	}

	function overallSummary(severity) {
		if (state.machines.length === 0) {
			return {
				title: 'NO DEVICES LINKED · Waiting for ThingsBoard setup',
				copy: 'Go to ESP32 & IoT Hub to add your real ThingsBoard Device ID (UUID) and JWT Token.'
			};
		}
		if (!state.hasTelemetry) {
			return {
				title: 'STANDBY · Waiting for live telemetry from ThingsBoard',
				copy: `${state.machines.length} device(s) registered. Waiting for incoming sensor & Edge Impulse packets.`
			};
		}
		if (severity === 'danger') {
			return {
				title: 'DANGER · Immediate attention required',
				copy: 'Critical sensor reading or Edge Impulse AI anomaly detected on live hardware.'
			};
		}
		if (severity === 'warning') {
			return {
				title: 'WARNING · Attention required',
				copy: 'One or more live readings or AI anomaly scores exceeded warning thresholds.'
			};
		}
		return {
			title: 'NORMAL · System safe',
			copy: 'All connected ESP32 sensors and Edge Impulse AI classifiers report normal conditions.'
		};
	}

	function statusPill(label, severity = 'normal') {
		const cls = severity === 'normal' ? '' : severity === 'warning' ? 'warning' : severity === 'danger' ? 'danger' : severity === 'ai' ? 'ai' : 'offline';
		return `<span class="status-pill ${cls}">${esc(label)}</span>`;
	}

	function sensorStats(key) {
		if (!state.sensorHistory[key].length) {
			return `<div class="sensor-stats"><span>MIN <b>--</b></span><span>AVG <b>--</b></span><span>MAX <b>--</b></span></div>`;
		}
		const values = state.sensorHistory[key].map(sample => sample.value);
		const min = Math.min(...values), max = Math.max(...values), average = values.reduce((sum, value) => sum + value, 0) / values.length;
		const format = value => key === 'temperature' ? value.toFixed(1) : Math.round(value);
		return `<div class="sensor-stats"><span>MIN <b>${format(min)}${sensorMeta[key].unit}</b></span><span>AVG <b>${format(average)}${sensorMeta[key].unit}</b></span><span>MAX <b>${format(max)}${sensorMeta[key].unit}</b></span></div>`;
	}

	function addAlert({ severity, type, message, source }) {
		const alert = { id: `a-${Date.now()}-${Math.floor(Math.random() * 1000)}`, severity, type, message, source, timestamp: Date.now(), acknowledged: false };
		state.alerts.unshift(alert);
		state.alerts = state.alerts.slice(0, 100);
		renderNotificationPanel();
		updateAlertCounts();
		showToast(message, severity);
		return alert;
	}

	function ingestDeviceTelemetry(device, data, latestTs = Date.now()) {
		if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return;

		state.hasTelemetry = true;
		device.connected = true;
		device.lastSeen = latestTs;

		if (isNum(data.pm25)) state.sensors.pm25 = data.pm25;
		if (isNum(data.pm10)) state.sensors.pm10 = data.pm10;
		if (isNum(data.temperature)) {
			state.sensors.temperature = data.temperature;
			device.temperature = data.temperature;
		}
		if (isNum(data.machine_temp)) device.temperature = data.machine_temp;
		if (isNum(data.humidity)) state.sensors.humidity = data.humidity;
		if (isNum(data.vibration)) device.vibration = data.vibration;
		if (isNum(data.power)) device.powerConsumption = data.power;

		state.edgeAi.nodeId = data.device_id || device.name;
		state.edgeAi.machineId = data.machine_id || device.id;

		if (isNum(data.anomaly_score)) {
			const score = Math.max(0, Math.min(1, data.anomaly_score));
			state.edgeAi.anomalyScore = score;
			device.anomalyScore = score;
		}
		if (isNum(data.ai_confidence)) {
			state.edgeAi.confidence = Math.max(0, Math.min(1, data.ai_confidence));
		}
		if (isNum(data.inference_ms)) {
			state.edgeAi.inferenceMs = data.inference_ms;
		}
		if (typeof data.ai_label === 'string' && data.ai_label.trim()) {
			state.edgeAi.label = data.ai_label.trim();
			device.aiLabel = state.edgeAi.label;
		} else if (state.edgeAi.label === 'No Signal') {
			state.edgeAi.label = 'Normal Operation';
			device.aiLabel = 'Normal Operation';
		}

		if (typeof data.ai_status === 'string') {
			const norm = data.ai_status.toLowerCase();
			state.edgeAi.status = (norm === 'danger' || norm === 'anomaly' || norm === 'critical') ? 'danger'
				: (norm === 'warning' || norm === 'warn') ? 'warning'
				: severityFor('anomaly', state.edgeAi.anomalyScore);
		} else {
			state.edgeAi.status = severityFor('anomaly', state.edgeAi.anomalyScore);
		}

		device.status = state.edgeAi.status === 'danger' ? 'ERROR' : state.edgeAi.status === 'warning' ? 'WARNING' : 'ONLINE';
		localStorage.setItem(STORAGE_KEYS.devices, JSON.stringify(state.machines));

		const ts = latestTs || Date.now();
		if (isNum(state.sensors.pm25)) state.sensorHistory.pm25.push({ value: state.sensors.pm25, timestamp: ts });
		if (isNum(state.sensors.pm10)) state.sensorHistory.pm10.push({ value: state.sensors.pm10, timestamp: ts });
		if (isNum(state.sensors.temperature)) state.sensorHistory.temperature.push({ value: state.sensors.temperature, timestamp: ts });
		if (isNum(state.sensors.humidity)) state.sensorHistory.humidity.push({ value: state.sensors.humidity, timestamp: ts });
		if (isNum(state.edgeAi.anomalyScore)) state.sensorHistory.anomalyScore.push({ value: state.edgeAi.anomalyScore, timestamp: ts });

		Object.values(state.sensorHistory).forEach(arr => {
			if (arr.length > 500) arr.shift();
		});

		evaluateSensors();
	}

	function evaluateSensors() {
		if (!state.hasTelemetry) {
			updateConnectionIndicators();
			updateAlertCounts();
			return;
		}

		Object.entries(state.sensors).forEach(([key, value]) => {
			if (!isNum(value)) return;
			const severity = severityFor(key, value);
			const previous = state.activeSensorAlerts.get(key) || 'normal';
			if (severity !== previous && severity !== 'normal') {
				const meta = sensorMeta[key];
				const unitValue = key === 'temperature' ? value.toFixed(1) : Math.round(value);
				const isDanger = severity === 'danger';
				addAlert({
					severity,
					type: meta.name,
					message: `${isDanger ? 'Critical' : 'High'} ${meta.name} detected · ${unitValue} ${meta.unit}`,
					source: state.edgeAi.nodeId
				});
				if (isDanger && 'Notification' in window && Notification.permission === 'granted') {
					new Notification('Factory Alert · Critical', { body: `${meta.name} ${unitValue} ${meta.unit} · immediate attention required` });
				}
			} else if (severity === 'normal' && previous !== 'normal') {
				addAlert({
					severity: 'info',
					type: sensorMeta[key].name,
					message: `${sensorMeta[key].name} returned to normal range`,
					source: state.edgeAi.nodeId
				});
			}
			if (severity === 'normal') state.activeSensorAlerts.delete(key);
			else state.activeSensorAlerts.set(key, severity);
		});

		if (state.iotConfig.eiAutoAlert && state.edgeAi.status !== 'offline') {
			const aiSev = state.edgeAi.status;
			const prevAiSev = state.activeSensorAlerts.get('edgeAi') || 'normal';
			if (aiSev !== prevAiSev && aiSev !== 'normal') {
				const scoreTxt = isNum(state.edgeAi.anomalyScore) ? ` · Score ${state.edgeAi.anomalyScore.toFixed(2)}` : '';
				addAlert({
					severity: aiSev,
					type: 'Edge Impulse AI',
					message: `AI Anomaly (${state.edgeAi.label})${scoreTxt}`,
					source: state.edgeAi.nodeId
				});
			} else if (aiSev === 'normal' && prevAiSev !== 'normal') {
				addAlert({
					severity: 'info',
					type: 'Edge Impulse AI',
					message: `Edge AI classifier returned to Normal`,
					source: state.edgeAi.nodeId
				});
			}
			if (aiSev === 'normal') state.activeSensorAlerts.delete('edgeAi');
			else state.activeSensorAlerts.set('edgeAi', aiSev);
		}

		state.sensorUpdatedAt = Date.now();
		updateConnectionIndicators();
		updateAlertCounts();
		if (['dashboard', 'sensors', 'alerts', 'machines'].includes(state.route)) {
			renderPage();
		}
	}

	function updateConnectionIndicators() {
		const topText = $('#topbar-mode-text');
		const topLabel = $('#topbar-conn-label');
		const topDot = $('#topbar-live-dot');
		const sideTitle = $('#sidebar-conn-title');
		const sideSub = $('#sidebar-conn-sub');
		const sideBadge = $('#sidebar-conn-badge');
		const sideDot = $('#sidebar-conn-dot');
		const sideMachineCount = $('#sidebar-machine-count');
		const footerLabel = $('#footer-mode-label');

		if (sideMachineCount) sideMachineCount.textContent = String(state.machines.length);
		if (!topText) return;

		const devCount = state.machines.length;
		const ok = state.tbConnection.status === 'connected';
		const err = state.tbConnection.status === 'error';

		topText.textContent = 'THINGSBOARD';
		topLabel.textContent = devCount === 0 ? 'No Devices' : ok ? `Live (${devCount})` : err ? 'Auth / API Error' : 'Awaiting Data';
		topDot.className = `live-dot ${err ? 'error' : !ok ? 'offline' : ''}`;
		sideTitle.textContent = 'ThingsBoard IoT';
		sideSub.textContent = devCount === 0 ? 'No Devices Linked' : `${devCount} device(s) configured`;
		sideBadge.textContent = ok ? 'LIVE' : err ? 'ERR' : 'WAIT';
		sideDot.className = `connection-dot ${err ? 'error' : !ok ? 'offline' : ''}`;
		footerLabel.textContent = `MODE: THINGSBOARD LIVE (${state.iotConfig.tbHost})`;
	}

	async function pushThresholdsToThingsBoard(silent = false) {
		const cfg = state.iotConfig;
		if (!cfg.tbHost || !cfg.tbJwtToken || state.machines.length === 0) {
			if (!silent) {
				showToast('Saved locally. Link a ThingsBoard device & JWT token in IoT Hub to sync with ESP32.', 'warning');
			}
			return false;
		}

		const host = cfg.tbHost.replace(/\/+$/, '');
		const payload = {
			pm25Warning: Number(state.thresholds.pm25Warning),
			pm25Danger: Number(state.thresholds.pm25Danger),
			pm10Warning: Number(state.thresholds.pm10Warning),
			pm10Danger: Number(state.thresholds.pm10Danger),
			tempWarning: Number(state.thresholds.tempWarning),
			tempDanger: Number(state.thresholds.tempDanger),
			humidityLow: Number(state.thresholds.humidityLow),
			humidityHigh: Number(state.thresholds.humidityHigh),
			humidityDangerLow: Number(state.thresholds.humidityDangerLow),
			humidityDangerHigh: Number(state.thresholds.humidityDangerHigh),
			anomalyWarning: Number(state.thresholds.anomalyWarning),
			anomalyDanger: Number(state.thresholds.anomalyDanger)
		};

		let successCount = 0;
		let lastError = '';

		for (const dev of state.machines) {
			if (!dev.tbDeviceId) continue;
			const devUuid = encodeURIComponent(dev.tbDeviceId.trim());
			const attrUrl = `${host}/api/plugins/telemetry/DEVICE/${devUuid}/attributes/SHARED_SCOPE`;
			const rpcUrl = `${host}/api/plugins/rpc/oneway/${devUuid}`;
			const headers = {
				'Content-Type': 'application/json',
				'X-Authorization': `Bearer ${cfg.tbJwtToken.trim()}`
			};

			try {
				const res = await fetch(attrUrl, {
					method: 'POST',
					headers,
					body: JSON.stringify(payload)
				});
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}

				fetch(rpcUrl, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						method: 'syncThresholds',
						params: payload
					})
				}).catch(() => {});

				successCount++;
			} catch (err) {
				lastError = err.message;
			}
		}

		if (successCount > 0) {
			if (!silent) {
				showToast(`Thresholds pushed to ESP32 (${successCount} device) — LEDs & Buzzer updated immediately.`);
			}
			return true;
		} else if (lastError && !silent) {
			showToast(`Saved locally, but ThingsBoard sync failed (${lastError}). Check JWT Token.`, 'warning');
		}
		return false;
	}

	async function fetchThingsBoardTelemetry() {
		const cfg = state.iotConfig;
		if (state.machines.length === 0) {
			state.tbConnection.status = 'idle';
			state.tbConnection.errorMsg = '';
			updateConnectionIndicators();
			return;
		}
		if (!cfg.tbHost || !cfg.tbJwtToken) {
			state.tbConnection.status = 'idle';
			state.tbConnection.errorMsg = 'Enter ThingsBoard Host URL and JWT Token in ESP32 & IoT Hub.';
			updateConnectionIndicators();
			return;
		}

		const host = cfg.tbHost.replace(/\/+$/, '');
		const keys = 'pm25,pm10,temperature,humidity,vibration,power,ai_status,ai_label,anomaly_score,ai_confidence,inference_ms,device_id,machine_id';
		let anySuccess = false;
		let lastError = '';

		for (const dev of state.machines) {
			if (!dev.tbDeviceId) continue;
			const url = `${host}/api/plugins/telemetry/DEVICE/${encodeURIComponent(dev.tbDeviceId)}/values/timeseries?keys=${keys}`;
			try {
				const res = await fetch(url, {
					headers: {
						'Content-Type': 'application/json',
						'X-Authorization': `Bearer ${cfg.tbJwtToken.trim()}`
					}
				});
				if (!res.ok) {
					throw new Error(`HTTP ${res.status} (${res.statusText || 'Check Device UUID / JWT Token'})`);
				}
				const raw = await res.json();
				const packet = {};
				let latestTs = 0;
				Object.entries(raw).forEach(([k, arr]) => {
					if (Array.isArray(arr) && arr.length > 0) {
						if (arr[0].ts && arr[0].ts > latestTs) latestTs = arr[0].ts;
						const val = arr[0].value;
						const num = Number(val);
						packet[k] = Number.isNaN(num) || val === '' ? val : num;
					}
				});
				anySuccess = true;
				if (Object.keys(packet).length > 0) {
					ingestDeviceTelemetry(dev, packet, latestTs || Date.now());
				}
			} catch (err) {
				lastError = err.message;
			}
		}

		if (anySuccess) {
			state.tbConnection.status = 'connected';
			state.tbConnection.lastSync = Date.now();
			state.tbConnection.errorMsg = '';
		} else if (lastError) {
			state.tbConnection.status = 'error';
			state.tbConnection.errorMsg = lastError;
		}
		updateConnectionIndicators();
	}

	// ดึงประวัติล็อกย้อนหลังทั้งหมดจาก ThingsBoard Cloud ตามช่วงวันที่ในหน้า Reports
	async function fetchThingsBoardHistory(notify = false) {
		const cfg = state.iotConfig;
		if (!cfg.tbHost || !cfg.tbJwtToken || state.machines.length === 0) {
			state.reportLogs = [];
			if (notify) showToast('Configure ThingsBoard JWT Token and Device ID in IoT Hub first.', 'warning');
			if (state.route === 'reports') renderPage();
			return;
		}

		const now = Date.now();
		let startTs = now - 86400000;
		let endTs = now;

		if (state.reportRange === 'today') {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			startTs = d.getTime();
		} else if (state.reportRange === '7d') {
			startTs = now - 7 * 86400000;
		} else if (state.reportRange === '30d') {
			startTs = now - 30 * 86400000;
		} else if (state.reportRange === 'custom') {
			const s = new Date(`${state.reportStartDate}T00:00:00`).getTime();
			const e = new Date(`${state.reportEndDate}T23:59:59.999`).getTime();
			if (!Number.isNaN(s)) startTs = s;
			if (!Number.isNaN(e)) endTs = e;
		}

		state.reportLoading = true;
		if (state.route === 'reports') renderPage();

		const host = cfg.tbHost.replace(/\/+$/, '');
		const keys = 'pm25,pm10,temperature,humidity,ai_status,anomaly_score';
		const mergedMap = new Map();

		for (const dev of state.machines) {
			if (!dev.tbDeviceId) continue;
			const url = `${host}/api/plugins/telemetry/DEVICE/${encodeURIComponent(dev.tbDeviceId.trim())}/values/timeseries?keys=${keys}&startTs=${startTs}&endTs=${endTs}&limit=5000&agg=NONE`;
			try {
				const res = await fetch(url, {
					headers: {
						'Content-Type': 'application/json',
						'X-Authorization': `Bearer ${cfg.tbJwtToken.trim()}`
					}
				});
				if (!res.ok) continue;
				const raw = await res.json();

				Object.entries(raw).forEach(([key, arr]) => {
					if (!Array.isArray(arr)) return;
					arr.forEach(pt => {
						const bucketTs = Math.round(Number(pt.ts) / 1000) * 1000;
						if (!mergedMap.has(bucketTs)) {
							mergedMap.set(bucketTs, {
								ts: Number(pt.ts),
								device: dev.name,
								pm25: null,
								pm10: null,
								temperature: null,
								humidity: null,
								ai_status: '',
								anomaly_score: null
							});
						}
						const row = mergedMap.get(bucketTs);
						if (key === 'ai_status') {
							row.ai_status = String(pt.value ?? '');
						} else {
							const num = Number(pt.value);
							if (isNum(num)) row[key] = num;
						}
					});
				});
			} catch {}
		}

		const rows = [...mergedMap.values()]
			.filter(r => isNum(r.pm25) && isNum(r.pm10) && isNum(r.temperature) && isNum(r.humidity))
			.sort((a, b) => a.ts - b.ts);

		state.reportLogs = rows;
		state.reportLoading = false;

		if (notify) {
			showToast(rows.length ? `Loaded ${rows.length} historical log records.` : 'No historical records found in this date range.', rows.length ? 'normal' : 'warning');
		}
		if (state.route === 'reports') renderPage();
	}

	function connectThingsBoardWebSocket() {
		if (tbSocket) {
			try { tbSocket.close(); } catch {}
			tbSocket = null;
		}
		const cfg = state.iotConfig;
		if (!cfg.tbUseWebSocket || !cfg.tbHost || !cfg.tbJwtToken || state.machines.length === 0) return;

		const wsHost = cfg.tbHost.replace(/^http/i, 'ws').replace(/\/+$/, '');
		const wsUrl = `${wsHost}/api/ws/plugins/telemetry?token=${encodeURIComponent(cfg.tbJwtToken.trim())}`;

		try {
			tbSocket = new WebSocket(wsUrl);
			tbSocket.onopen = () => {
				const tsSubCmds = state.machines
					.filter(d => d.tbDeviceId)
					.map((d, idx) => ({
						entityType: 'DEVICE',
						entityId: d.tbDeviceId.trim(),
						scope: 'LATEST_TELEMETRY',
						cmdId: idx + 1
					}));
				if (tsSubCmds.length === 0) return;
				tbSocket.send(JSON.stringify({ tsSubCmds, historyCmds: [], attrSubCmds: [] }));
				state.tbConnection.status = 'connected';
				state.tbConnection.errorMsg = '';
				updateConnectionIndicators();
				showToast('ThingsBoard WebSocket connected.');
			};
			tbSocket.onmessage = event => {
				try {
					const msg = JSON.parse(event.data);
					if (msg.data && typeof msg.subscriptionId === 'number') {
						const dev = state.machines[msg.subscriptionId - 1];
						if (!dev) return;
						const packet = {};
						let latestTs = 0;
						Object.entries(msg.data).forEach(([k, arr]) => {
							if (Array.isArray(arr) && arr.length > 0) {
								if (arr[0][0] && arr[0][0] > latestTs) latestTs = arr[0][0];
								const val = arr[0][1];
								const num = Number(val);
								packet[k] = Number.isNaN(num) || val === '' ? val : num;
							}
						});
						state.tbConnection.lastSync = Date.now();
						if (Object.keys(packet).length > 0) {
							ingestDeviceTelemetry(dev, packet, latestTs || Date.now());
						}
					}
				} catch {}
			};
			tbSocket.onerror = () => {
				state.tbConnection.status = 'error';
				state.tbConnection.errorMsg = 'WebSocket connection failed (check CORS/SSL/Token).';
				updateConnectionIndicators();
			};
		} catch (err) {
			state.tbConnection.status = 'error';
			state.tbConnection.errorMsg = err.message;
		}
	}

	function sensorCard(key) {
		const meta = sensorMeta[key];
		const value = state.sensors[key];
		const hasVal = isNum(value);
		const severity = severityFor(key, value);
		const shownValue = !hasVal ? '--' : (key === 'temperature' ? value.toFixed(1) : Math.round(value));
		return `<article class="sensor-card ${severity === 'normal' || severity === 'offline' ? '' : severity}"><div class="sensor-head"><div class="sensor-title"><span class="sensor-icon">${icon(meta.icon)}</span>${esc(meta.name)}</div>${statusPill(severityLabel(severity), severity)}</div><div class="sensor-value">${shownValue}<small>${esc(meta.unit)}</small></div>${sensorStats(key)}<div class="sensor-footer"><span>${hasVal ? `Updated ${relativeTime(state.sensorUpdatedAt)}` : 'No telemetry'}</span><span class="signal-bars ${!hasVal ? 'offline' : severity === 'normal' ? '' : severity}"><i></i><i></i><i></i></span></div></article>`;
	}

	function edgeAiCard() {
		const ai = state.edgeAi;
		const hasScore = isNum(ai.anomalyScore);
		const sev = hasScore ? ai.status : 'offline';
		const scorePct = hasScore ? Math.round(ai.anomalyScore * 100) : 0;
		const pillLabel = !hasScore ? 'STANDBY' : (sev === 'normal' ? 'NORMAL' : sev.toUpperCase());
		const pillSev = !hasScore ? 'offline' : (sev === 'normal' ? 'ai' : sev);
		return `<article class="sensor-card ${sev === 'normal' ? 'ai-highlight' : sev === 'offline' ? '' : sev}">
			<div class="sensor-head">
				<div class="sensor-title"><span class="sensor-icon">${icon('brain')}</span>Edge Impulse AI</div>
				${statusPill(pillLabel, pillSev)}
			</div>
			<div class="sensor-value">${hasScore ? ai.anomalyScore.toFixed(2) : '--'}<small>anomaly score</small></div>
			<div class="ai-meter"><div class="ai-meter-fill ${sev === 'offline' ? '' : sev}" style="width:${scorePct}%"></div></div>
			<div class="sensor-stats">
				<span>CLASS <b>${esc(ai.label)}</b></span>
				<span>CONF <b>${isNum(ai.confidence) ? `${Math.round(ai.confidence * 100)}%` : '--'}</b></span>
			</div>
			<div class="sensor-footer">
				<span>Node: ${esc(ai.nodeId)}</span>
				<span>${isNum(ai.inferenceMs) ? `${ai.inferenceMs} ms` : 'Edge TinyML'}</span>
			</div>
		</article>`;
	}

	function machineCard(machine) {
		const severity = machineSeverity(machine);
		const statusText = machine.connected ? machine.status : 'AWAITING DATA';
		const tempText = isNum(machine.temperature) ? `${machine.temperature.toFixed(1)}°C` : '--°C';
		const aiText = isNum(machine.anomalyScore) ? `AI ${machine.anomalyScore.toFixed(2)}` : 'AI --';
		const powerText = isNum(machine.powerConsumption) ? `${machine.powerConsumption.toFixed(1)} kW` : '↗';
		return `<button class="machine-card ${machine.connected ? 'edge-node' : ''}" data-machine="${esc(machine.id)}">
			<div class="machine-card-head"><strong>${esc(machine.name)}</strong>${statusPill(statusText, severity)}</div>
			<p>${esc(machine.area)} · UUID: ${esc(machine.tbDeviceId.slice(0, 8))}…</p>
			<div class="machine-card-foot">
				<span>${tempText} · ${aiText}</span>
				<span>${powerText}</span>
			</div>
		</button>`;
	}

	function safetyRows() {
		const pm25Sev = severityFor('pm25', state.sensors.pm25);
		const pm10Sev = severityFor('pm10', state.sensors.pm10);
		const airSev = (pm25Sev === 'danger' || pm10Sev === 'danger') ? 'danger'
			: (pm25Sev === 'warning' || pm10Sev === 'warning') ? 'warning'
			: (pm25Sev === 'normal' || pm10Sev === 'normal') ? 'normal' : 'offline';

		const tempSev = severityFor('temperature', state.sensors.temperature);
		const humSev = severityFor('humidity', state.sensors.humidity);
		const aiSev = isNum(state.edgeAi.anomalyScore) ? state.edgeAi.status : 'offline';

		const bridgeSev = state.machines.length === 0 ? 'offline'
			: state.tbConnection.status === 'connected' ? 'normal'
			: state.tbConnection.status === 'error' ? 'danger' : 'offline';
		const bridgeText = state.machines.length === 0 ? 'NO DEVICES'
			: state.tbConnection.status === 'connected' ? 'CONNECTED'
			: state.tbConnection.status === 'error' ? 'ERROR' : 'WAITING';

		const checks = [
			['Air quality (PM2.5/10)', airSev, airSev === 'offline' ? 'STANDBY' : airSev === 'normal' ? 'SAFE' : severityLabel(airSev)],
			['Temperature', tempSev, tempSev === 'offline' ? 'STANDBY' : tempSev === 'normal' ? 'SAFE' : severityLabel(tempSev)],
			['Humidity', humSev, humSev === 'offline' ? 'STANDBY' : humSev === 'normal' ? 'SAFE' : severityLabel(humSev)],
			['Edge Impulse AI', aiSev, aiSev === 'offline' ? 'STANDBY' : aiSev === 'normal' ? 'SAFE' : severityLabel(aiSev)],
			['ThingsBoard Live API', bridgeSev, bridgeText]
		];
		return checks.map(([label, severity, badge]) => `<div class="safety-row"><span>${icon(label.includes('Edge Impulse') ? 'brain' : label.includes('ThingsBoard') ? 'link' : 'shield')}${esc(label)}</span>${statusPill(badge, severity)}</div>`).join('');
	}

	function makeRealChart(metricMode = 'env') {
		const width = 700, height = 190, left = 44, top = 12, plotW = 638, plotH = 133;
		let primaryArr = [], secondaryArr = [], minScale = 0, maxScale = 100;

		if (metricMode === 'ai') {
			primaryArr = state.sensorHistory.anomalyScore.slice(-24).map(d => d.value * 100);
			secondaryArr = state.sensorHistory.temperature.slice(-24).map(d => ((d.value - 20) / 25) * 100);
			minScale = 0; maxScale = 100;
		} else if (metricMode === 'air') {
			primaryArr = state.sensorHistory.pm25.slice(-24).map(d => d.value);
			secondaryArr = state.sensorHistory.pm10.slice(-24).map(d => d.value);
			minScale = 0; maxScale = 130;
		} else {
			primaryArr = state.sensorHistory.pm25.slice(-24).map(d => d.value);
			secondaryArr = state.sensorHistory.temperature.slice(-24).map(d => d.value * 2);
			minScale = 0; maxScale = 100;
		}

		const grid = [0, 1, 2, 3].map(index => {
			const y = top + (index * plotH) / 3;
			const tickVal = Math.round(maxScale - (index * (maxScale - minScale)) / 3);
			return `<line class="chart-gridline" x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}"/><text class="chart-label" x="${left - 8}" y="${y + 3}" text-anchor="end">${tickVal}</text>`;
		}).join('');

		if (primaryArr.length === 0) {
			return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Live sensor history chart">
				${grid}
				<text class="chart-label" x="${left + plotW / 2}" y="${top + plotH / 2}" text-anchor="middle" style="font-size:11px">No live data yet. Add a real ThingsBoard device in ESP32 &amp; IoT Hub.</text>
			</svg>`;
		}

		if (primaryArr.length === 1) {
			primaryArr = [primaryArr[0], primaryArr[0]];
			secondaryArr = [secondaryArr[0] ?? 0, secondaryArr[0] ?? 0];
		}

		const normalize = val => Math.max(4, Math.min(96, ((val - minScale) / (maxScale - minScale)) * 100));
		const toPoints = values => values.map((v, idx) => {
			const x = left + (idx * plotW) / Math.max(1, values.length - 1);
			const y = top + plotH - (normalize(v) / 100) * plotH;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		}).join(' ');

		const line = toPoints(primaryArr);
		const line2 = toPoints(secondaryArr);
		const lastNorm = normalize(primaryArr[primaryArr.length - 1]);
		const lastY = top + plotH - (lastNorm / 100) * plotH;
		const area = `${left},${top + plotH} ${line} ${left + plotW},${top + plotH}`;

		const labels = ['Oldest', '-18 samples', '-12 samples', '-6 samples', 'Latest'].map((label, index) => `<text class="chart-label" x="${left + (index * plotW) / 4}" y="${top + plotH + 22}" text-anchor="middle">${label}</text>`).join('');

		return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Live sensor history chart">
			<defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#719b49" stop-opacity=".18"/><stop offset="1" stop-color="#719b49" stop-opacity="0"/></linearGradient></defs>
			${grid}
			<polygon class="chart-area" points="${area}"/>
			<polyline class="chart-line" points="${line}"/>
			<polyline class="chart-line secondary" points="${line2}"/>
			<circle class="chart-point" cx="${left + plotW}" cy="${lastY.toFixed(1)}" r="3.8"/>
			${labels}
		</svg>`;
	}

	function recentAlertRows(limit = 5) {
		if (!state.alerts.length) return '<div class="empty-state">No alerts recorded.</div>';
		return state.alerts.slice(0, limit).map(alert => `<div class="alert-row ${esc(alert.severity)}"><i></i><div><strong>${esc(alert.message)}</strong><small>${esc(alert.source)} · ${esc(alert.type)}</small>${alert.severity === 'danger' ? `<div class="alert-action"><button class="text-button" data-route="alerts">View details →</button></div>` : ''}</div><time>${relativeTime(alert.timestamp)}</time></div>`).join('');
	}

	function dashboardPage() {
		const severity = currentSeverity();
		const summary = overallSummary(severity);
		const onlineCount = state.machines.filter(m => m.connected).length;
		const aiSev = isNum(state.edgeAi.anomalyScore) ? state.edgeAi.status : 'offline';
		const hasPublicTb = Boolean(state.iotConfig.tbPublicDashboardUrl && state.iotConfig.tbPublicDashboardUrl.trim());

		return `<div class="page-heading">
				<div><p class="eyebrow">PLANT 01 · ESP32 + EDGE IMPULSE + THINGSBOARD</p><h1>Factory Monitoring</h1><p>Live hardware telemetry and Edge Impulse anomaly detection.</p></div>
				<div class="heading-actions">
					<span class="timestamp">${icon('clock')} ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(Date.now())}</span>
					<button class="button button-primary" data-route="integrations">${icon('link')} Add Real Device</button>
					<button class="button button-secondary" data-action="refresh">↻ <span>Sync Now</span></button>
				</div>
			</div>
			<section class="status-banner ${severity}" role="status">
				<div class="status-symbol">${icon(severity === 'normal' ? 'shield' : 'bell')}</div>
				<div><strong>${summary.title}</strong><p>${summary.copy}</p></div>
				<div class="status-meta"><b>THINGSBOARD LIVE</b><span>${state.sensorUpdatedAt ? `Updated ${formatTime(state.sensorUpdatedAt)}` : 'Awaiting live data'}</span></div>
			</section>

			<div class="section-label">Plant &amp; Edge AI Overview <span>Live telemetry stream</span></div>
			<section class="metric-grid" aria-label="Plant summary">
				<article class="metric-card">
					<div class="metric-top">Connected devices ${icon('cpu')}</div>
					<div class="metric-value">${state.machines.length}<small>registered</small></div>
					<div class="metric-foot"><span>${onlineCount} online</span><strong>${state.machines.length === 0 ? 'NONE' : 'ACTIVE'}</strong></div>
				</article>
				<article class="metric-card ${severityFor('pm25', state.sensors.pm25)}">
					<div class="metric-top">Air quality ${icon('radio')}</div>
					<div class="metric-value">${isNum(state.sensors.pm25) ? Math.round(state.sensors.pm25) : '--'}<small>µg/m³ PM2.5</small></div>
					<div class="metric-foot"><span>PM10 ${isNum(state.sensors.pm10) ? `${Math.round(state.sensors.pm10)} µg/m³` : '--'}</span><strong>${severityLabel(severityFor('pm25', state.sensors.pm25))}</strong></div>
				</article>
				<article class="metric-card ${severityFor('temperature', state.sensors.temperature)}">
					<div class="metric-top">Temperature ${icon('cpu')}</div>
					<div class="metric-value">${isNum(state.sensors.temperature) ? state.sensors.temperature.toFixed(1) : '--'}<small>°C</small></div>
					<div class="metric-foot"><span>Limit ≤ ${state.thresholds.tempWarning}°C</span><strong>${severityLabel(severityFor('temperature', state.sensors.temperature))}</strong></div>
				</article>
				<article class="metric-card ${severityFor('humidity', state.sensors.humidity)}">
					<div class="metric-top">Humidity ${icon('radio')}</div>
					<div class="metric-value">${isNum(state.sensors.humidity) ? Math.round(state.sensors.humidity) : '--'}<small>% RH</small></div>
					<div class="metric-foot"><span>Target ${state.thresholds.humidityLow}–${state.thresholds.humidityHigh}%</span><strong>${severityLabel(severityFor('humidity', state.sensors.humidity))}</strong></div>
				</article>
				<article class="metric-card ${aiSev === 'normal' ? 'ai-card' : aiSev === 'offline' ? '' : aiSev}">
					<div class="metric-top">Edge Impulse AI ${icon('brain')}</div>
					<div class="metric-value">${isNum(state.edgeAi.anomalyScore) ? state.edgeAi.anomalyScore.toFixed(2) : '--'}<small>score</small></div>
					<div class="metric-foot"><span>${esc(state.edgeAi.label)}</span><strong>${severityLabel(aiSev)}</strong></div>
				</article>
			</section>

			<div class="overview-grid">
				<section class="panel">
					<div class="panel-header"><div><h2>Connected ESP32 Devices</h2><p>${state.machines.length} real device(s) linked via ThingsBoard</p></div><button class="text-button" data-route="integrations">+ Add device →</button></div>
					${state.machines.length
						? `<div class="machine-grid">${state.machines.slice(0, 8).map(machineCard).join('')}</div>`
						: `<div class="empty-state">No devices linked yet. Go to <b>ESP32 &amp; IoT Hub</b> to register your ThingsBoard Device ID.</div>`}
				</section>
				<section class="panel">
					<div class="panel-header"><div><h2>Safety &amp; AI checks</h2><p>Automated plant threshold guard</p></div>${statusPill(!state.hasTelemetry ? 'STANDBY' : severity === 'normal' ? 'SAFE' : severityLabel(severity), !state.hasTelemetry ? 'offline' : severity)}</div>
					<div class="safety-list">${safetyRows()}</div>
				</section>
			</div>

			<div class="section-label">Environmental sensors &amp; Edge AI classifier <span>${state.sensorUpdatedAt ? `Updated ${formatTime(state.sensorUpdatedAt)}` : 'Awaiting connection'}</span></div>
			<section class="sensor-grid">
				${Object.keys(sensorMeta).map(sensorCard).join('')}
				${edgeAiCard()}
			</section>

			<div class="chart-alert-grid">
				<section class="panel chart-panel">
					<div class="panel-header">
						<div><h2>Live telemetry history</h2><p>Real-time buffer from ThingsBoard API / WebSocket</p></div>
						<div class="chart-header-tools">
							<select class="select-control" data-action="chart-metric">
								<option value="env" ${state.chartMetric === 'env' ? 'selected' : ''}>PM2.5 &amp; Temp (×2)</option>
								<option value="air" ${state.chartMetric === 'air' ? 'selected' : ''}>PM2.5 &amp; PM10</option>
								<option value="ai" ${state.chartMetric === 'ai' ? 'selected' : ''}>Edge AI Anomaly (%)</option>
							</select>
						</div>
					</div>
					<div class="chart-legend">
						${state.chartMetric === 'ai'
							? '<span><i class="legend-mark"></i>AI Anomaly Score (%)</span><span><i class="legend-mark temp"></i>Normalized Temp</span>'
							: state.chartMetric === 'air'
							? '<span><i class="legend-mark"></i>PM2.5 (µg/m³)</span><span><i class="legend-mark temp"></i>PM10 (µg/m³)</span>'
							: '<span><i class="legend-mark"></i>PM2.5 (µg/m³)</span><span><i class="legend-mark temp"></i>Temperature (×2 °C)</span>'}
					</div>
					${makeRealChart(state.chartMetric)}
				</section>
				<section class="panel">
					<div class="panel-header"><div><h2>Recent alerts</h2><p>Latest sensor &amp; Edge AI events</p></div><button class="text-button" data-route="alerts">All alerts →</button></div>
					<div class="alerts-panel-list">${recentAlertRows(4)}</div>
				</section>
			</div>

			${hasPublicTb ? `
			<div class="section-label">ThingsBoard Embedded Dashboard <span>Live Public Dashboard Iframe</span></div>
			<section class="panel">
				<div class="panel-header"><div><h2>ThingsBoard Cloud / Server View</h2><p>${esc(state.iotConfig.tbPublicDashboardUrl)}</p></div><button class="text-button" data-route="integrations">Configure URL →</button></div>
				<div class="tb-iframe-wrap"><iframe src="${esc(state.iotConfig.tbPublicDashboardUrl)}" title="ThingsBoard Public Dashboard" loading="lazy"></iframe></div>
			</section>` : ''}`;
	}

	function machinesPage() {
		const onlineCount = state.machines.filter(m => m.connected).length;
		const errorCount = state.machines.filter(m => m.status === 'ERROR').length;
		if (state.activeMachine) return machineDetailPage(state.machines.find(item => item.id === state.activeMachine) || state.machines[0]);
		return `<div class="page-heading"><div><p class="eyebrow">HARDWARE &amp; PRODUCTION LINES</p><h1>Devices &amp; Lines</h1><p>Real ESP32 / ThingsBoard devices linked to this dashboard.</p></div><div class="heading-actions"><button class="button button-primary" data-route="integrations">+ Add ThingsBoard Device</button><button class="button button-secondary" data-action="export-machines">${icon('download')} Export CSV</button></div></div>
			<section class="detail-grid">
				<div class="detail-stat"><small>Registered devices</small><strong>${state.machines.length}</strong><span>ThingsBoard UUIDs</span></div>
				<div class="detail-stat"><small>Receiving data</small><strong>${onlineCount}</strong><span>live telemetry</span></div>
				<div class="detail-stat"><small>Awaiting data</small><strong>${state.machines.length - onlineCount}</strong><span>no packets yet</span></div>
				<div class="detail-stat"><small>Critical / Error</small><strong>${errorCount}</strong><span>attention required</span></div>
			</section>
			<section class="panel">
				<div class="panel-header"><div><h2>Registered device fleet</h2><p>Select a device to inspect live telemetry or remove it</p></div><span class="timestamp"><span class="live-dot ${onlineCount > 0 ? '' : 'offline'}"></span> ${onlineCount > 0 ? 'Live' : 'Standby'}</span></div>
				${state.machines.length
					? `<div class="machine-grid">${state.machines.map(machineCard).join('')}</div>`
					: `<div class="empty-state">No devices registered. Click <b>+ Add ThingsBoard Device</b> to connect your ESP32 hardware.</div>`}
			</section>`;
	}

	function machineDetailPage(machine) {
		if (!machine) { state.activeMachine = null; return machinesPage(); }
		return `<div class="page-heading"><div><button class="text-button" data-action="back-machines">← All devices</button><p class="eyebrow" style="margin-top:12px">${esc(machine.area)} · ThingsBoard UUID: ${esc(machine.tbDeviceId)}</p><h1>${esc(machine.name)}</h1><p>Live hardware telemetry and Edge Impulse AI diagnostics.</p></div><div class="heading-actions">${statusPill(machine.connected ? machine.status : 'AWAITING DATA', machineSeverity(machine))}<button class="button button-danger" data-remove-device="${esc(machine.id)}">Remove Device</button></div></div>
			<section class="detail-grid">
				<div class="detail-stat"><small>Last packet</small><strong>${machine.lastSeen ? formatTime(machine.lastSeen) : '--'}</strong><span>${relativeTime(machine.lastSeen)}</span></div>
				<div class="detail-stat"><small>Temperature</small><strong>${isNum(machine.temperature) ? `${machine.temperature.toFixed(1)}°C` : '--'}</strong><span>sensor reading</span></div>
				<div class="detail-stat"><small>Vibration</small><strong>${isNum(machine.vibration) ? `${machine.vibration.toFixed(2)} mm/s` : '--'}</strong><span>accelerometer</span></div>
				<div class="detail-stat"><small>Edge AI Anomaly</small><strong>${isNum(machine.anomalyScore) ? machine.anomalyScore.toFixed(2) : '--'}</strong><span>${esc(machine.aiLabel || 'Awaiting data')}</span></div>
			</section>
			<div class="overview-grid">
				<section class="panel chart-panel"><div class="panel-header"><div><h2>Live AI &amp; temperature trend</h2><p>Real-time telemetry buffer</p></div></div><div class="chart-legend"><span><i class="legend-mark"></i>AI Anomaly (%)</span><span><i class="legend-mark temp"></i>Temperature</span></div>${makeRealChart('ai')}</section>
				<section class="panel"><div class="panel-header"><div><h2>ThingsBoard Binding</h2><p>Device metadata</p></div></div><div class="safety-list"><div class="safety-row"><span>Device Name</span><strong>${esc(machine.name)}</strong></div><div class="safety-row"><span>Area / Zone</span><strong>${esc(machine.area)}</strong></div><div class="safety-row"><span>ThingsBoard Device ID</span><strong>${esc(machine.tbDeviceId)}</strong></div><div class="safety-row"><span>AI Classification</span><strong>${esc(machine.aiLabel || 'No Signal')}</strong></div></div></section>
			</div>`;
	}

	function sensorsPage() {
		return `<div class="page-heading"><div><p class="eyebrow">ENVIRONMENTAL &amp; EDGE AI MONITORING</p><h1>Sensors &amp; Edge Impulse</h1><p>Real-time readings from ESP32 sensors and on-device TinyML anomaly classifier.</p></div><div class="heading-actions"><button class="button button-secondary" data-route="integrations">${icon('link')} ThingsBoard Config</button><span class="timestamp"><span class="live-dot ${state.hasTelemetry ? '' : 'offline'}"></span> ${state.sensorUpdatedAt ? `Updated ${formatTime(state.sensorUpdatedAt)}` : 'Awaiting telemetry'}</span></div></div>
			<section class="sensor-grid">${Object.keys(sensorMeta).map(sensorCard).join('')}${edgeAiCard()}</section>
			<div class="chart-alert-grid">
				<section class="panel chart-panel"><div class="panel-header"><div><h2>Edge AI Anomaly History</h2><p>Real-time anomaly score (%) vs temperature</p></div></div><div class="chart-legend"><span><i class="legend-mark"></i>Anomaly Score (%)</span><span><i class="legend-mark temp"></i>Normalized Temp</span></div>${makeRealChart('ai')}</section>
				<section class="panel"><div class="panel-header"><div><h2>Active Thresholds</h2><p>Configured trigger limits</p></div><button class="text-button" data-route="settings">Edit →</button></div><div class="safety-list"><div class="safety-row"><span>PM2.5 warning / danger</span><strong>${state.thresholds.pm25Warning} / ${state.thresholds.pm25Danger} µg/m³</strong></div><div class="safety-row"><span>PM10 warning / danger</span><strong>${state.thresholds.pm10Warning} / ${state.thresholds.pm10Danger} µg/m³</strong></div><div class="safety-row"><span>Temperature alert</span><strong>&gt; ${state.thresholds.tempWarning}°C (Danger ≥ ${state.thresholds.tempDanger}°C)</strong></div><div class="safety-row"><span>Humidity target</span><strong>${state.thresholds.humidityLow}–${state.thresholds.humidityHigh}% (Danger &lt;${state.thresholds.humidityDangerLow}% / &gt;${state.thresholds.humidityDangerHigh}%)</strong></div><div class="safety-row"><span>Edge AI Anomaly score</span><strong>Warn ≥ ${state.thresholds.anomalyWarning} · Danger ≥ ${state.thresholds.anomalyDanger}</strong></div></div></section>
			</div>`;
	}

	function alertsPage() {
		const filtered = state.alerts.filter(alert => (state.alertFilter === 'all' || alert.severity === state.alertFilter) && (state.machineFilter === 'all' || alert.source === state.machineFilter) && (state.sensorFilter === 'all' || alert.type === state.sensorFilter) && (!state.alertDateFilter || new Date(alert.timestamp).toLocaleDateString('en-CA') === state.alertDateFilter));
		return `<div class="page-heading"><div><p class="eyebrow">EVENT CENTER</p><h1>Alerts</h1><p>Review, filter, and acknowledge real sensor and Edge Impulse AI events.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="export-alerts">${icon('download')} Export CSV</button></div></div>
			<section class="detail-grid"><div class="detail-stat"><small>Unacknowledged</small><strong>${state.alerts.filter(alert => !alert.acknowledged).length}</strong><span>events needing review</span></div><div class="detail-stat"><small>Critical</small><strong>${state.alerts.filter(alert => alert.severity === 'danger').length}</strong><span>immediate attention</span></div><div class="detail-stat"><small>Warnings</small><strong>${state.alerts.filter(alert => alert.severity === 'warning').length}</strong><span>out of normal range</span></div><div class="detail-stat"><small>Last event</small><strong>${state.alerts.length ? relativeTime(state.alerts[0].timestamp) : '—'}</strong><span>plant activity</span></div></section>
			<section class="panel"><div class="filter-bar"><div class="severity-filter">${['all', 'danger', 'warning', 'info'].map(value => `<button class="filter-chip ${state.alertFilter === value ? 'active' : ''}" data-filter="${value}">${value === 'all' ? 'All' : value === 'danger' ? 'Critical' : value[0].toUpperCase() + value.slice(1)}</button>`).join('')}</div><span class="filter-spacer"></span><select class="select-control" data-filter-select="machine"><option value="all">All sources</option>${[...new Set(state.alerts.map(alert => alert.source))].map(source => `<option ${state.machineFilter === source ? 'selected' : ''} value="${esc(source)}">${esc(source)}</option>`).join('')}</select><select class="select-control" data-filter-select="sensor"><option value="all">All event types</option>${[...new Set(state.alerts.map(alert => alert.type))].map(type => `<option ${state.sensorFilter === type ? 'selected' : ''} value="${esc(type)}">${esc(type)}</option>`).join('')}</select></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Severity</th><th>Event</th><th>Source / area</th><th>Time</th><th>Status</th><th>Action</th></tr></thead><tbody>${filtered.length ? filtered.map(alert => `<tr><td data-label="Severity">${statusPill(alert.severity.toUpperCase(), alert.severity === 'info' ? 'normal' : alert.severity)}</td><td data-label="Event"><strong>${esc(alert.message)}</strong></td><td data-label="Source / area">${esc(alert.source)} · ${esc(alert.type)}</td><td data-label="Time">${formatTime(alert.timestamp)}<br><small>${relativeTime(alert.timestamp)}</small></td><td data-label="Status">${alert.acknowledged ? statusPill('ACKNOWLEDGED', 'offline') : statusPill('OPEN', alert.severity === 'info' ? 'normal' : alert.severity)}</td><td data-label="Action">${alert.acknowledged ? '—' : `<button class="text-button" data-ack="${esc(alert.id)}">Acknowledge</button>`}</td></tr>`).join('') : '<tr><td colspan="6"><div class="empty-state">No alerts recorded yet.</div></td></tr>'}</tbody></table></div></section>`;
	}

	function getExportableLogs() {
		if (state.reportLogs.length > 0) return state.reportLogs;
		const len = Math.min(
			state.sensorHistory.pm25.length,
			state.sensorHistory.pm10.length,
			state.sensorHistory.temperature.length,
			state.sensorHistory.humidity.length
		);
		const fallback = [];
		for (let i = 0; i < len; i++) {
			fallback.push({
				ts: state.sensorHistory.pm25[i].timestamp,
				device: state.edgeAi.nodeId || 'ESP32-NODE-01',
				pm25: state.sensorHistory.pm25[i].value,
				pm10: state.sensorHistory.pm10[i].value,
				temperature: state.sensorHistory.temperature[i].value,
				humidity: state.sensorHistory.humidity[i].value,
				ai_status: state.edgeAi.status || 'normal',
				anomaly_score: state.sensorHistory.anomalyScore[i]?.value ?? null
			});
		}
		return fallback;
	}

	function reportsPage() {
		const labels = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom range' };
		const rangeLabel = state.reportRange === 'custom' ? `${state.reportStartDate} – ${state.reportEndDate}` : labels[state.reportRange];
		const logs = getExportableLogs();

		const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
		const pm25Avg = avg(logs.map(r => r.pm25));
		const tempAvg = avg(logs.map(r => r.temperature));
		const humAvg = avg(logs.map(r => r.humidity));

		return `<div class="page-heading">
				<div><p class="eyebrow">PRODUCTION INTELLIGENCE &amp; DATASET EXPORT</p><h1>Reports &amp; Historical Logs</h1><p>Fetch historical sensor logs from ThingsBoard and export directly for Excel or Edge Impulse.</p></div>
				<div class="heading-actions">
					<select class="select-control" data-action="report-range">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${state.reportRange === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
					<button class="button button-secondary" data-action="refresh-history">↻ Fetch Logs</button>
					<button class="button button-primary" data-action="export-ei-csv">${icon('download')} Export Edge Impulse CSV</button>
					<button class="button button-secondary" data-action="export-report">${icon('download')} Export Full CSV</button>
					<button class="button button-secondary" data-action="pdf-report">Print / PDF</button>
				</div>
			</div>
			<section class="detail-grid">
				<div class="detail-stat"><small>Historical Records</small><strong>${state.reportLoading ? '...' : logs.length}</strong><span>${state.reportLogs.length > 0 ? 'fetched from ThingsBoard' : 'session buffer'}</span></div>
				<div class="detail-stat"><small>Avg PM2.5 (${rangeLabel})</small><strong>${isNum(pm25Avg) ? `${pm25Avg.toFixed(1)} <span>µg/m³</span>` : '--'}</strong><span>${isNum(state.sensors.pm25) ? `Live: ${Math.round(state.sensors.pm25)} µg/m³` : 'no live data'}</span></div>
				<div class="detail-stat"><small>Avg Temperature</small><strong>${isNum(tempAvg) ? `${tempAvg.toFixed(1)} <span>°C</span>` : '--'}</strong><span>${isNum(humAvg) ? `Avg Humidity: ${humAvg.toFixed(1)}%` : '--'}</span></div>
				<div class="detail-stat"><small>Alert events</small><strong>${state.alerts.length}</strong><span>recorded events</span></div>
			</section>

			<div class="section-label">Historical Telemetry Logs (${rangeLabel}) <span>Ready for direct Edge Impulse Studio upload (UTF-8, no BOM)</span></div>
			<section class="panel">
				<div class="panel-header">
					<div><h2>Logged Sensor Samples (${logs.length} rows)</h2><p>Showing latest 25 rows preview · Click "Export Edge Impulse CSV" to download all ${logs.length} rows</p></div>
					<span class="timestamp">${icon('clock')} ${rangeLabel}</span>
				</div>
				<div class="table-wrap">
					<table class="data-table">
						<thead>
							<tr>
								<th>Date &amp; Time</th>
								<th>Device</th>
								<th>PM2.5 (µg/m³)</th>
								<th>PM10 (µg/m³)</th>
								<th>Temp (°C)</th>
								<th>Humidity (%)</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							${state.reportLoading
								? `<tr><td colspan="7"><div class="empty-state">Fetching historical logs from ThingsBoard Cloud...</div></td></tr>`
								: logs.length
								? [...logs].reverse().slice(0, 25).map(row => {
									const sev = row.ai_status === 'danger' ? 'danger' : row.ai_status === 'warning' ? 'warning' : 'normal';
									return `<tr>
										<td>${esc(formatDateTime(row.ts))}</td>
										<td><strong>${esc(row.device)}</strong></td>
										<td>${row.pm25.toFixed(1)}</td>
										<td>${row.pm10.toFixed(1)}</td>
										<td>${row.temperature.toFixed(1)}</td>
										<td>${row.humidity.toFixed(1)}</td>
										<td>${statusPill((row.ai_status || 'NORMAL').toUpperCase(), sev)}</td>
									</tr>`;
								}).join('')
								: `<tr><td colspan="7"><div class="empty-state">No historical logs found for this period. Make sure your ThingsBoard JWT Token and Device UUID are set in <b>ESP32 &amp; IoT Hub</b>.</div></td></tr>`}
						</tbody>
					</table>
				</div>
			</section>

			<section class="panel chart-panel"><div class="panel-header"><div><h2>Live Telemetry Trend</h2><p>Recent buffer · updated ${formatTime(state.sensorUpdatedAt)}</p></div></div><div class="chart-legend"><span><i class="legend-mark"></i>PM2.5</span><span><i class="legend-mark temp"></i>Temperature (×2)</span></div>${makeRealChart('env')}</section>`;
	}

	function generateEsp32CodeSnippet() {
		const cfg = state.iotConfig;
		const hostClean = (cfg.tbHost || 'https://thingsboard.cloud').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
		const firstDev = state.machines[0]?.name || 'ESP32-NODE-01';
		return `/*
 * Factory Edge AI Firmware (ESP32 + Edge Impulse + ThingsBoard)
 * Target Server: ${hostClean}
 */
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "YOUR_FACTORY_WIFI_SSID";
const char* WIFI_PASS = "YOUR_FACTORY_WIFI_PASSWORD";
const char* TB_SERVER = "${hostClean}";
const int   TB_PORT   = 1883;
const char* TB_TOKEN  = "YOUR_THINGSBOARD_DEVICE_ACCESS_TOKEN";

WiFiClient espClient;
PubSubClient mqtt(espClient);

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); }
  mqtt.setServer(TB_SERVER, TB_PORT);
}

void loop() {
  if (!mqtt.connected()) {
    if (!mqtt.connect("${firstDev}", TB_TOKEN, NULL)) { delay(2000); return; }
  }
  mqtt.loop();
  delay(3000);
}`;
	}

	function integrationsPage() {
		const cfg = state.iotConfig;
		return `<div class="page-heading">
				<div><p class="eyebrow">THINGSBOARD &amp; EDGE IMPULSE</p><h1>ESP32 &amp; IoT Hub</h1><p>Configure your ThingsBoard server credentials and register real ESP32 devices.</p></div>
				<div class="heading-actions">
					<button class="button button-secondary" data-action="download-ino">${icon('download')} Download ESP32 Code (.ino)</button>
					<button class="button button-primary" data-action="save-iot-config">Save &amp; Sync Now</button>
				</div>
			</div>

			<div class="settings-grid">
				<div>
					<section class="panel settings-section">
						<div class="panel-header"><div><h2>1. ThingsBoard API Connection</h2><p>Required to fetch live &amp; historical telemetry and push LED thresholds</p></div>${statusPill(state.tbConnection.status.toUpperCase(), state.tbConnection.status === 'connected' ? 'normal' : state.tbConnection.status === 'error' ? 'danger' : 'offline')}</div>
						<div class="settings-body">
							<div class="field"><label for="iot-tb-host">ThingsBoard Host URL</label><input id="iot-tb-host" value="${esc(cfg.tbHost)}" placeholder="https://thingsboard.cloud"></div>
							<div class="field"><label for="iot-tb-poll">REST Poll Interval (ms)</label><input id="iot-tb-poll" type="number" min="1000" step="500" value="${cfg.tbPollIntervalMs}"></div>
							<div class="field full"><label for="iot-tb-token">User JWT Token (Bearer token from ThingsBoard)</label><input id="iot-tb-token" type="password" value="${esc(cfg.tbJwtToken)}" placeholder="Paste JWT token from ThingsBoard /api/auth/login"></div>
							<div class="field full"><label for="iot-tb-iframe">ThingsBoard Public Dashboard URL (Optional Iframe Embed)</label><input id="iot-tb-iframe" value="${esc(cfg.tbPublicDashboardUrl)}" placeholder="https://thingsboard.cloud/dashboard/public/YOUR_DASHBOARD_ID"></div>
							<div class="field"><label class="check-label"><input id="iot-tb-ws" type="checkbox" ${cfg.tbUseWebSocket ? 'checked' : ''}> Use Live WebSocket Stream</label></div>
							<div class="field"><label class="check-label"><input id="iot-ei-alert" type="checkbox" ${cfg.eiAutoAlert ? 'checked' : ''}> Auto-alert on Edge AI Anomaly</label></div>
							${state.tbConnection.errorMsg ? `<div class="field full"><p class="form-error">${esc(state.tbConnection.errorMsg)}</p></div>` : ''}
						</div>
						<div class="table-actions">
							<button type="button" class="button button-primary" data-action="save-iot-config">Save &amp; Connect</button>
						</div>
					</section>

					<section class="panel settings-section">
						<div class="panel-header"><div><h2>2. Register Real ESP32 / ThingsBoard Devices</h2><p>Only devices added here will appear on your dashboard</p></div></div>
						<div class="settings-body">
							<div class="field"><label for="new-dev-name">Device / Machine Name</label><input id="new-dev-name" placeholder="e.g. ESP32-NODE-01"></div>
							<div class="field"><label for="new-dev-area">Production Line / Area</label><input id="new-dev-area" placeholder="e.g. Production Line A"></div>
							<div class="field full"><label for="new-dev-tb-id">ThingsBoard Device ID (UUID)</label><input id="new-dev-tb-id" placeholder="e.g. 784f394c-42b6-11ed-b878-0242ac120002"></div>
						</div>
						<div class="table-actions">
							<button type="button" class="button button-accent" data-action="add-device">+ Register Device</button>
						</div>
						<div class="table-wrap">
							<table class="data-table">
								<thead><tr><th>Name</th><th>Area</th><th>ThingsBoard UUID</th><th>Status</th><th>Action</th></tr></thead>
								<tbody>
									${state.machines.length ? state.machines.map(dev => `<tr>
										<td><strong>${esc(dev.name)}</strong></td>
										<td>${esc(dev.area)}</td>
										<td><code>${esc(dev.tbDeviceId)}</code></td>
										<td>${statusPill(dev.connected ? dev.status : 'AWAITING DATA', machineSeverity(dev))}</td>
										<td><button type="button" class="text-button danger-text" data-remove-device="${esc(dev.id)}">Remove</button></td>
									</tr>`).join('') : `<tr><td colspan="5"><div class="empty-state">No real devices registered yet.</div></td></tr>`}
								</tbody>
							</table>
						</div>
					</section>
				</div>

				<div>
					<section class="panel settings-section">
						<div class="panel-header"><div><h2>ESP32 Arduino C++ Firmware</h2><p>Template for Edge Impulse + ThingsBoard MQTT</p></div><button type="button" class="text-button" data-action="copy-ino">Copy code</button></div>
						<pre class="code-preview" id="esp32-code-block">${esc(generateEsp32CodeSnippet())}</pre>
					</section>
				</div>
			</div>`;
	}

	function usersPage() {
		if (state.role !== 'Admin') return `<div class="page-heading"><div><p class="eyebrow">ACCESS CONTROL</p><h1>Users</h1></div></div><section class="panel"><div class="empty-state">Administrator permission is required to manage users.</div></section>`;
		return `<div class="page-heading">
				<div><p class="eyebrow">ACCESS CONTROL</p><h1>Users</h1><p>Add, remove, and manage role-based accounts for Factory Alert.</p></div>
			</div>
			<div class="settings-grid">
				<div>
					<section class="panel settings-section">
						<div class="panel-header">
							<div><h2>Plant users</h2><p>${state.users.length} active account(s) registered</p></div>
						</div>
						<div class="table-wrap">
							<table class="data-table">
								<thead><tr><th>Name</th><th>Username</th><th>Password</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
								<tbody>
									${state.users.map(u => `<tr>
										<td data-label="Name"><strong>${esc(u.name)}</strong></td>
										<td data-label="Username">${esc(u.username)}</td>
										<td data-label="Password"><code>${esc(u.password)}</code></td>
										<td data-label="Role">${esc(u.role === 'Admin' ? 'Administrator' : 'Operator')}</td>
										<td data-label="Status">${statusPill(u.status || 'ACTIVE')}</td>
										<td data-label="Action">${u.username === state.username
											? '<span style="color:var(--muted);font-size:9px;font-weight:700">CURRENT SESSION</span>'
											: `<button type="button" class="text-button danger-text" data-delete-user="${esc(u.id)}">Delete</button>`}</td>
									</tr>`).join('')}
								</tbody>
							</table>
						</div>
					</section>
				</div>

				<div>
					<section class="panel settings-section">
						<div class="panel-header"><div><h2>Add new user</h2><p>Create a new Administrator or Operator account</p></div></div>
						<form id="add-user-form" class="settings-body">
							<div class="field full"><label for="new-user-name">Full Name</label><input id="new-user-name" placeholder="e.g. Somchai Engineer" required></div>
							<div class="field"><label for="new-user-username">Username</label><input id="new-user-username" placeholder="e.g. somchai" autocomplete="off" required></div>
							<div class="field"><label for="new-user-password">Password</label><input id="new-user-password" type="text" placeholder="Min. 4 characters" minlength="4" autocomplete="off" required></div>
							<div class="field full"><label for="new-user-role">Role / Permission</label>
								<select id="new-user-role">
									<option value="Operator">Operator (Monitoring &amp; Alerts only)</option>
									<option value="Admin">Administrator (Full Access)</option>
								</select>
							</div>
							<div class="field full"><button type="submit" class="button button-primary">+ Add User</button></div>
						</form>
					</section>
				</div>
			</div>`;
	}

	function settingsPage() {
		if (state.role !== 'Admin') return `<div class="page-heading"><div><p class="eyebrow">SYSTEM CONFIGURATION</p><h1>Settings</h1></div></div><section class="panel"><div class="empty-state">Administrator permission is required to change system settings.</div></section>`;
		return `<div class="page-heading"><div><p class="eyebrow">SYSTEM CONFIGURATION</p><h1>Settings</h1><p>Manage sensor &amp; Edge AI alert thresholds (auto-syncs to ThingsBoard &amp; ESP32 LEDs).</p></div><div class="heading-actions"><button class="button button-secondary" data-route="integrations">${icon('link')} ESP32 &amp; ThingsBoard Setup</button><button class="button button-primary" data-action="save-settings">Save all changes</button></div></div>
			<div class="settings-grid"><div>
			<section class="panel settings-section">
				<div class="panel-header"><div><h2>Sensor &amp; Edge AI thresholds</h2><p>Syncs directly to ThingsBoard &amp; ESP32-S3 immediately</p></div>
				<div style="display:flex;gap:5px"><button type="button" class="filter-chip" data-preset-thresh="standard">Standard</button><button type="button" class="filter-chip" data-preset-thresh="strict">Cleanroom</button></div></div>
				<form id="threshold-form" class="settings-body">
					<div class="field"><label for="pm25-warning">PM2.5 warning (µg/m³)</label><input id="pm25-warning" type="number" step="0.1" min="0" value="${state.thresholds.pm25Warning}" required></div>
					<div class="field"><label for="pm25-danger">PM2.5 danger (µg/m³)</label><input id="pm25-danger" type="number" step="0.1" min="1" value="${state.thresholds.pm25Danger}" required></div>
					<div class="field"><label for="pm10-warning">PM10 warning (µg/m³)</label><input id="pm10-warning" type="number" step="0.1" min="0" value="${state.thresholds.pm10Warning}" required></div>
					<div class="field"><label for="pm10-danger">PM10 danger (µg/m³)</label><input id="pm10-danger" type="number" step="0.1" min="1" value="${state.thresholds.pm10Danger}" required></div>
					<div class="field"><label for="temp-warning">Temperature warning (°C)</label><input id="temp-warning" type="number" step="0.1" min="1" value="${state.thresholds.tempWarning}" required></div>
					<div class="field"><label for="temp-danger">Temperature danger (°C)</label><input id="temp-danger" type="number" step="0.1" min="2" value="${state.thresholds.tempDanger}" required></div>
					<div class="field"><label for="humidity-low">Humidity warning low (%)</label><input id="humidity-low" type="number" step="0.1" min="0" max="100" value="${state.thresholds.humidityLow}" required></div>
					<div class="field"><label for="humidity-high">Humidity warning high (%)</label><input id="humidity-high" type="number" step="0.1" min="0" max="100" value="${state.thresholds.humidityHigh}" required></div>
					<div class="field"><label for="humidity-danger-low">Humidity danger low (%)</label><input id="humidity-danger-low" type="number" step="0.1" min="0" max="100" value="${state.thresholds.humidityDangerLow}" required></div>
					<div class="field"><label for="humidity-danger-high">Humidity danger high (%)</label><input id="humidity-danger-high" type="number" step="0.1" min="0" max="100" value="${state.thresholds.humidityDangerHigh}" required></div>
					<div class="field"><label for="anomaly-warning">Edge AI Anomaly warning (0–1)</label><input id="anomaly-warning" type="number" step="0.05" min="0.05" max="0.95" value="${state.thresholds.anomalyWarning}" required></div>
					<div class="field"><label for="anomaly-danger">Edge AI Anomaly danger (0–1)</label><input id="anomaly-danger" type="number" step="0.05" min="0.1" max="1" value="${state.thresholds.anomalyDanger}" required></div>
					<div class="field full"><button type="submit" class="button button-primary">Apply &amp; Sync Thresholds to ESP32</button></div>
				</form>
			</section>
			</div>
			<div><section class="panel settings-section"><div class="panel-header"><div><h2>Notifications</h2><p>Choose how operators are notified</p></div></div><div style="padding:4px 15px"><div class="toggle-row">Enable alert notifications <input class="toggle" type="checkbox" checked></div><div class="toggle-row">Browser notifications <input id="browser-notifications" class="toggle" type="checkbox"></div></div></section>
			<section class="panel settings-section"><div class="panel-header"><div><h2>Appearance</h2><p>Personal display preferences</p></div></div><div style="padding:4px 15px"><div class="toggle-row">Dark mode <input id="dark-mode-toggle" class="toggle" type="checkbox" ${state.theme === 'dark' ? 'checked' : ''}></div></div></section></div></div>`;
	}

	const pageTitles = {
		dashboard: 'Dashboard',
		machines: 'Devices & Lines',
		sensors: 'Sensors & Edge AI',
		alerts: 'Alerts',
		reports: 'Reports',
		integrations: 'ESP32 & IoT Hub',
		users: 'Users',
		settings: 'Settings'
	};

	function renderPage() {
		const templates = {
			dashboard: dashboardPage,
			machines: machinesPage,
			sensors: sensorsPage,
			alerts: alertsPage,
			reports: reportsPage,
			integrations: integrationsPage,
			users: usersPage,
			settings: settingsPage
		};
		$('#page-content').innerHTML = (templates[state.route] || dashboardPage)();
		if (state.route === 'alerts') {
			const dateFilter = document.createElement('input');
			dateFilter.className = 'select-control';
			dateFilter.type = 'date';
			dateFilter.setAttribute('aria-label', 'Filter alerts by date');
			dateFilter.dataset.filterSelect = 'date';
			dateFilter.value = state.alertDateFilter;
			$('.filter-bar').append(dateFilter);
		}
		if (state.route === 'reports' && state.reportRange === 'custom') {
			const actions = $('.heading-actions');
			[['Start date', 'start', state.reportStartDate], ['End date', 'end', state.reportEndDate]].forEach(([label, key, value]) => {
				const input = document.createElement('input');
				input.className = 'select-control';
				input.type = 'date';
				input.setAttribute('aria-label', label);
				input.dataset.reportDate = key;
				input.value = value;
				actions.append(input);
			});
		}
		$('#breadcrumb-page').textContent = state.route === 'machines' && state.activeMachine ? 'Device detail' : pageTitles[state.route] || 'Dashboard';
		$$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.route === state.route));
		document.title = `${pageTitles[state.route] || 'Dashboard'} | Factory Alert`;
		updateConnectionIndicators();
	}

	function renderNotificationPanel() {
		const unread = state.alerts.filter(alert => !alert.acknowledged);
		$('#notification-count').textContent = unread.length > 9 ? '9+' : String(unread.length);
		$('#notification-count').classList.toggle('is-hidden', unread.length === 0);
		$('#notification-list').innerHTML = state.alerts.slice(0, 5).map(alert => `<div class="notification-item ${esc(alert.severity)}"><i></i><div><strong>${esc(alert.message)}</strong><small>${esc(alert.source)}</small></div><time>${relativeTime(alert.timestamp)}</time></div>`).join('') || '<div class="empty-state">You are all caught up.</div>';
	}

	function updateAlertCounts() {
		$('#sidebar-alert-count').textContent = state.alerts.filter(alert => !alert.acknowledged).length;
		renderNotificationPanel();
	}

	function showToast(message, severity = 'normal') {
		const toast = document.createElement('div');
		toast.className = `toast ${severity === 'normal' ? '' : severity}`;
		toast.textContent = message;
		$('#toast-region').append(toast);
		window.setTimeout(() => toast.remove(), 4200);
	}

	function navigate(route) {
		if (!pageTitles[route]) return;
		if ((route === 'settings' || route === 'users') && state.role !== 'Admin') {
			showToast('Administrator permission required.', 'warning');
			return;
		}
		state.route = route;
		state.activeMachine = null;
		$('#sidebar').classList.remove('mobile-open');
		$$('.dropdown-menu').forEach(menu => menu.classList.remove('is-open'));
		renderPage();
		if (route === 'reports') {
			fetchThingsBoardHistory(false);
		}
		$('#page-content').focus({ preventScroll: true });
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	function saveThresholds(form, shouldRender = true) {
		if (!form.reportValidity()) return false;
		const fields = {
			pm25Warning: 'pm25-warning',
			pm25Danger: 'pm25-danger',
			pm10Warning: 'pm10-warning',
			pm10Danger: 'pm10-danger',
			tempWarning: 'temp-warning',
			tempDanger: 'temp-danger',
			humidityLow: 'humidity-low',
			humidityHigh: 'humidity-high',
			humidityDangerLow: 'humidity-danger-low',
			humidityDangerHigh: 'humidity-danger-high',
			anomalyWarning: 'anomaly-warning',
			anomalyDanger: 'anomaly-danger'
		};
		const next = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, Number($(`#${id}`).value)]));
		if (
			next.pm25Warning >= next.pm25Danger ||
			next.pm10Warning >= next.pm10Danger ||
			next.tempWarning >= next.tempDanger ||
			next.humidityDangerLow >= next.humidityLow ||
			next.humidityLow >= next.humidityHigh ||
			next.humidityHigh >= next.humidityDangerHigh ||
			next.anomalyWarning >= next.anomalyDanger
		) {
			showToast('Warning thresholds must be inside Danger thresholds.', 'danger');
			return false;
		}
		Object.assign(state.thresholds, next);
		localStorage.setItem(STORAGE_KEYS.thresholds, JSON.stringify(state.thresholds));
		pushThresholdsToThingsBoard(false);
		evaluateSensors();
		if (shouldRender) renderPage();
		return true;
	}

	function saveIotConfiguration() {
		const hostEl = $('#iot-tb-host');
		if (hostEl) {
			state.iotConfig.tbHost = hostEl.value.trim() || 'https://thingsboard.cloud';
			state.iotConfig.tbJwtToken = $('#iot-tb-token').value.trim();
			state.iotConfig.tbPublicDashboardUrl = $('#iot-tb-iframe').value.trim();
			state.iotConfig.tbPollIntervalMs = Math.max(1000, Number($('#iot-tb-poll').value) || 5000);
			state.iotConfig.tbUseWebSocket = $('#iot-tb-ws').checked;
			state.iotConfig.eiAutoAlert = $('#iot-ei-alert').checked;
		}
		localStorage.setItem(STORAGE_KEYS.iotConfig, JSON.stringify(state.iotConfig));
		updateConnectionIndicators();
		fetchThingsBoardTelemetry();
		connectThingsBoardWebSocket();
		pushThresholdsToThingsBoard(true);
		showToast('ThingsBoard configuration saved & thresholds synced.');
		renderPage();
	}

	function exportCsv(filename, rows) {
		const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
		link.download = filename;
		link.click();
		URL.revokeObjectURL(link.href);
		showToast(`${filename} exported.`);
	}

	// ส่งออกไฟล์ CSV สำหรับอัปโหลดเข้า Edge Impulse Studio โดยตรง (ไม่มี BOM และไม่มีเครื่องหมายคำพูด ")
	function exportEdgeImpulseCsv() {
		const logs = getExportableLogs();
		if (!logs.length) {
			showToast('No sensor log records available to export yet.', 'warning');
			return;
		}
		const lines = ['pm25,pm10,temperature,humidity'];
		logs.forEach(r => {
			lines.push(`${r.pm25.toFixed(1)},${r.pm10.toFixed(1)},${r.temperature.toFixed(1)},${r.humidity.toFixed(1)}`);
		});
		const csv = lines.join('\n');
		const dateTag = new Date().toISOString().slice(0, 10);
		const filename = `edge-impulse-data-${dateTag}.csv`;
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
		link.download = filename;
		link.click();
		URL.revokeObjectURL(link.href);
		showToast(`Exported ${logs.length} samples to ${filename} (Edge Impulse ready).`);
	}

	function exportHistoricalReportCsv() {
		const logs = getExportableLogs();
		if (!logs.length) {
			showToast('No historical logs available to export yet.', 'warning');
			return;
		}
		const dateTag = new Date().toISOString().slice(0, 10);
		exportCsv(`factory-historical-report-${dateTag}.csv`, [
			['Timestamp_MS', 'Date_Time', 'Device', 'PM2.5_ugm3', 'PM10_ugm3', 'Temperature_C', 'Humidity_Pct', 'Status', 'Anomaly_Score'],
			...logs.map(r => [
				r.ts,
				formatDateTime(r.ts),
				r.device,
				r.pm25.toFixed(1),
				r.pm10.toFixed(1),
				r.temperature.toFixed(1),
				r.humidity.toFixed(1),
				r.ai_status || 'normal',
				isNum(r.anomaly_score) ? r.anomaly_score.toFixed(2) : ''
			])
		]);
	}

	function downloadTextFile(filename, content) {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
		link.download = filename;
		link.click();
		URL.revokeObjectURL(link.href);
		showToast(`${filename} downloaded.`);
	}

	function exportAlerts() {
		exportCsv('factory-alert-history.csv', [['Severity', 'Event', 'Source', 'Type', 'Time', 'Acknowledged'], ...state.alerts.map(alert => [alert.severity, alert.message, alert.source, alert.type, new Date(alert.timestamp).toISOString(), alert.acknowledged ? 'Yes' : 'No'])]);
	}

	function exportMachines() {
		exportCsv('factory-devices.csv', [['Name', 'Area', 'ThingsBoard UUID', 'Connected', 'Status', 'Temperature', 'Vibration', 'AI Label', 'Anomaly Score'], ...state.machines.map(m => [m.name, m.area, m.tbDeviceId, m.connected ? 'Yes' : 'No', m.status, m.temperature ?? '', m.vibration ?? '', m.aiLabel ?? '', m.anomalyScore ?? ''])]);
	}

	function initialsFromName(name) {
		const parts = String(name || 'U').trim().split(/\s+/);
		if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
		return String(name || 'US').slice(0, 2).toUpperCase();
	}

	function completeLogin(account) {
		state.role = account.role;
		state.user = account.name;
		state.username = account.username;
		if ($('.check-label input').checked) localStorage.setItem('forgeops-remembered-user', account.username);
		else localStorage.removeItem('forgeops-remembered-user');
		sessionStorage.setItem('forgeops-session', JSON.stringify({ username: account.username, role: account.role, name: account.name, at: Date.now() }));
		$('#top-user-name').innerHTML = `${esc(account.name)}<small>${esc(account.role === 'Admin' ? 'Administrator' : 'Operator')}</small>`;
		$('#top-user-avatar').textContent = initialsFromName(account.name);
		$('#application').classList.remove('is-hidden');
		$('#login-screen').classList.add('is-hidden');
		$$('.admin-only').forEach(item => item.classList.toggle('is-hidden', account.role !== 'Admin'));
		document.body.classList.toggle('theme-dark', state.theme === 'dark');
		renderPage();
		renderNotificationPanel();
		fetchThingsBoardTelemetry();
		connectThingsBoardWebSocket();
	}

	$('#login-form').addEventListener('submit', event => {
		event.preventDefault();
		const submit = $('#login-submit');
		const username = $('#username').value.trim().toLowerCase();
		const password = $('#password').value;
		const error = $('#login-error');
		error.textContent = '';
		submit.disabled = true;
		submit.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span> Authenticating…';
		window.setTimeout(() => {
			const account = state.users.find(u => u.username.toLowerCase() === username && u.password === password);
			if (!account) {
				error.textContent = 'Username or password is incorrect.';
				submit.disabled = false;
				submit.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
				return;
			}
			submit.disabled = false;
			submit.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
			completeLogin(account);
		}, 200);
	});

	$('#password-toggle').addEventListener('click', () => {
		const input = $('#password');
		const visible = input.type === 'password';
		input.type = visible ? 'text' : 'password';
		$('#password-toggle').textContent = visible ? 'Hide' : 'Show';
	});
	$('#forgot-password').addEventListener('click', () => showToast('Contact your system administrator to reset credentials.', 'warning'));
	$('#logout-button').addEventListener('click', () => {
		sessionStorage.removeItem('forgeops-session');
		if (tbSocket) { try { tbSocket.close(); } catch {} tbSocket = null; }
		$('#application').classList.add('is-hidden');
		$('#login-screen').classList.remove('is-hidden');
		state.route = 'dashboard';
		showToast('You have signed out.');
	});
	$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));
	$('#notification-button').addEventListener('click', event => { event.stopPropagation(); $('#notification-panel').classList.toggle('is-hidden'); });
	$('#mark-read').addEventListener('click', () => { state.alerts.forEach(alert => { alert.acknowledged = true; }); renderNotificationPanel(); updateAlertCounts(); showToast('Notifications marked as read.'); });

	document.addEventListener('click', event => {
		const quickLogin = event.target.closest('[data-quick-login]');
		if (quickLogin) {
			const targetRole = quickLogin.dataset.quickLogin;
			const account = state.users.find(u => u.role === targetRole) || defaultUsers.find(u => u.role === targetRole);
			if (account) completeLogin(account);
			return;
		}
		const routeButton = event.target.closest('[data-route]');
		if (routeButton) { navigate(routeButton.dataset.route); return; }
		const dropdownButton = event.target.closest('[data-dropdown]');
		if (dropdownButton) {
			const menu = $(`[data-menu="${dropdownButton.dataset.dropdown}"]`);
			const wasOpen = menu.classList.contains('is-open');
			$$('.dropdown-menu').forEach(item => item.classList.remove('is-open'));
			menu.classList.toggle('is-open', !wasOpen);
			return;
		}
		if (!event.target.closest('.dropdown-wrap')) $$('.dropdown-menu').forEach(item => item.classList.remove('is-open'));
		const machine = event.target.closest('[data-machine]');
		if (machine) { state.activeMachine = machine.dataset.machine; state.route = 'machines'; renderPage(); return; }
		const removeDev = event.target.closest('[data-remove-device]');
		if (removeDev) {
			const devId = removeDev.dataset.removeDevice;
			state.machines = state.machines.filter(m => m.id !== devId);
			localStorage.setItem(STORAGE_KEYS.devices, JSON.stringify(state.machines));
			if (state.activeMachine === devId) state.activeMachine = null;
			if (state.machines.length === 0) {
				state.hasTelemetry = false;
				state.sensors = { pm25: null, pm10: null, temperature: null, humidity: null };
				state.edgeAi = { nodeId: '--', machineId: '--', status: 'offline', label: 'No Signal', anomalyScore: null, confidence: null, inferenceMs: null };
				state.sensorUpdatedAt = null;
			}
			updateConnectionIndicators();
			renderPage();
			showToast('Device removed.');
			return;
		}
		const deleteUserBtn = event.target.closest('[data-delete-user]');
		if (deleteUserBtn) {
			if (state.role !== 'Admin') return;
			const userId = deleteUserBtn.dataset.deleteUser;
			const target = state.users.find(u => u.id === userId);
			if (!target) return;
			if (target.username === state.username) {
				showToast('You cannot delete your currently logged-in account.', 'warning');
				return;
			}
			if (target.role === 'Admin' && state.users.filter(u => u.role === 'Admin').length <= 1) {
				showToast('Cannot delete the last remaining Administrator.', 'danger');
				return;
			}
			if (window.confirm(`Delete user "${target.name}" (${target.username})?`)) {
				state.users = state.users.filter(u => u.id !== userId);
				localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(state.users));
				renderPage();
				showToast(`User "${target.name}" deleted.`);
			}
			return;
		}
		const filter = event.target.closest('[data-filter]');
		if (filter) { state.alertFilter = filter.dataset.filter; renderPage(); return; }
		const acknowledge = event.target.closest('[data-ack]');
		if (acknowledge) {
			const alert = state.alerts.find(item => item.id === acknowledge.dataset.ack);
			if (alert) alert.acknowledged = true;
			renderPage();
			updateAlertCounts();
			showToast('Alert acknowledged.');
			return;
		}
		const presetThresh = event.target.closest('[data-preset-thresh]');
		if (presetThresh) {
			const kind = presetThresh.dataset.presetThresh;
			const p = kind === 'strict'
				? { pm25Warning: 15, pm25Danger: 35, pm10Warning: 25, pm10Danger: 50, tempWarning: 25, tempDanger: 28, humidityLow: 45, humidityHigh: 60, humidityDangerLow: 35, humidityDangerHigh: 70, anomalyWarning: 0.45, anomalyDanger: 0.70 }
				: defaultThresholds;
			Object.assign(state.thresholds, p);
			localStorage.setItem(STORAGE_KEYS.thresholds, JSON.stringify(state.thresholds));
			pushThresholdsToThingsBoard(false);
			evaluateSensors();
			renderPage();
			return;
		}

		const action = event.target.closest('[data-action]');
		if (action) {
			const name = action.dataset.action;
			if (name === 'refresh') {
				if (state.machines.length === 0) {
					showToast('No devices registered yet. Add a device in ESP32 & IoT Hub.', 'warning');
				} else {
					fetchThingsBoardTelemetry();
					showToast('Syncing live telemetry from ThingsBoard...');
				}
			}
			if (name === 'refresh-history') fetchThingsBoardHistory(true);
			if (name === 'export-ei-csv') exportEdgeImpulseCsv();
			if (name === 'export-report') exportHistoricalReportCsv();
			if (name === 'back-machines') { state.activeMachine = null; renderPage(); }
			if (name === 'export-alerts') exportAlerts();
			if (name === 'export-machines') exportMachines();
			if (name === 'pdf-report') window.print();
			if (name === 'save-settings') { const form = $('#threshold-form'); if (saveThresholds(form, false)) { renderPage(); } }
			if (name === 'save-iot-config') saveIotConfiguration();
			if (name === 'add-device') {
				const nameVal = $('#new-dev-name').value.trim();
				const areaVal = $('#new-dev-area').value.trim() || 'Production Line A';
				const uuidVal = $('#new-dev-tb-id').value.trim();
				if (!nameVal || !uuidVal) {
					showToast('Please enter both Device Name and ThingsBoard Device UUID.', 'danger');
					return;
				}
				state.machines.push({
					id: `DEV-${Date.now()}`,
					name: nameVal,
					area: areaVal,
					tbDeviceId: uuidVal,
					connected: false,
					status: 'AWAITING DATA',
					temperature: null,
					vibration: null,
					powerConsumption: null,
					aiLabel: 'No Signal',
					anomalyScore: null,
					lastSeen: null
				});
				localStorage.setItem(STORAGE_KEYS.devices, JSON.stringify(state.machines));
				updateConnectionIndicators();
				fetchThingsBoardTelemetry();
				connectThingsBoardWebSocket();
				pushThresholdsToThingsBoard(true);
				renderPage();
				showToast(`Registered real device: ${nameVal}`);
			}
			if (name === 'copy-ino') {
				navigator.clipboard?.writeText(generateEsp32CodeSnippet());
				showToast('ESP32 Arduino C++ sketch copied to clipboard.');
			}
			if (name === 'download-ino') {
				downloadTextFile('esp32_factory_edge_ai.ino', generateEsp32CodeSnippet());
			}
		}
	});

	document.addEventListener('change', event => {
		const filter = event.target.closest('[data-filter-select]');
		if (filter) {
			if (filter.dataset.filterSelect === 'machine') state.machineFilter = filter.value;
			if (filter.dataset.filterSelect === 'sensor') state.sensorFilter = filter.value;
			if (filter.dataset.filterSelect === 'date') state.alertDateFilter = filter.value;
			renderPage();
		}
		if (event.target.matches('[data-action="chart-metric"]')) {
			state.chartMetric = event.target.value;
			renderPage();
		}
		if (event.target.matches('[data-action="report-range"]')) {
			state.reportRange = event.target.value;
			fetchThingsBoardHistory(false);
		}
		if (event.target.matches('[data-report-date]')) {
			state[event.target.dataset.reportDate === 'start' ? 'reportStartDate' : 'reportEndDate'] = event.target.value;
			fetchThingsBoardHistory(false);
		}
		if (event.target.id === 'dark-mode-toggle') {
			state.theme = event.target.checked ? 'dark' : 'light';
			localStorage.setItem(STORAGE_KEYS.theme, state.theme);
			document.body.classList.toggle('theme-dark', event.target.checked);
		}
		if (event.target.id === 'browser-notifications' && event.target.checked && 'Notification' in window) {
			Notification.requestPermission().then(permission => {
				if (permission !== 'granted') {
					event.target.checked = false;
					showToast('Browser notifications were not enabled.', 'warning');
				}
			});
		}
	});

	document.addEventListener('submit', event => {
		if (event.target.id === 'threshold-form') {
			event.preventDefault();
			saveThresholds(event.target);
		}
		if (event.target.id === 'add-user-form') {
			event.preventDefault();
			if (state.role !== 'Admin') return;
			const fullName = $('#new-user-name').value.trim();
			const username = $('#new-user-username').value.trim().toLowerCase();
			const password = $('#new-user-password').value;
			const role = $('#new-user-role').value === 'Admin' ? 'Admin' : 'Operator';

			if (!fullName || !username || !password) {
				showToast('Please fill in all user fields.', 'danger');
				return;
			}
			if (state.users.some(u => u.username.toLowerCase() === username)) {
				showToast(`Username "${username}" already exists.`, 'warning');
				return;
			}
			state.users.push({
				id: `u-${Date.now()}`,
				name: fullName,
				username,
				password,
				role,
				status: 'ACTIVE'
			});
			localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(state.users));
			renderPage();
			showToast(`User "${fullName}" (${role}) added.`);
		}
	});

	document.addEventListener('keydown', event => {
		refreshSessionActivity();
		if (event.key === 'Escape') {
			$('#sidebar').classList.remove('mobile-open');
			$('#notification-panel').classList.add('is-hidden');
			$$('.dropdown-menu').forEach(menu => menu.classList.remove('is-open'));
		}
	});

	function refreshSessionActivity() {
		const saved = sessionStorage.getItem('forgeops-session');
		if (!saved) return;
		try {
			const session = JSON.parse(saved);
			session.at = Date.now();
			sessionStorage.setItem('forgeops-session', JSON.stringify(session));
		} catch {
			sessionStorage.removeItem('forgeops-session');
		}
	}
	document.addEventListener('pointerdown', refreshSessionActivity);

	document.body.classList.toggle('theme-dark', state.theme === 'dark');
	const rememberedUser = localStorage.getItem('forgeops-remembered-user');
	if (rememberedUser) $('#username').value = rememberedUser;
	$('.check-label input').addEventListener('change', event => {
		if (!event.target.checked) localStorage.removeItem('forgeops-remembered-user');
	});
	renderNotificationPanel();

	const existingSession = sessionStorage.getItem('forgeops-session');
	if (existingSession) {
		try {
			const parsed = JSON.parse(existingSession);
			if (Date.now() - parsed.at < 30 * 60 * 1000) {
				const acc = state.users.find(u => u.username === parsed.username) || state.users.find(u => u.role === parsed.role) || defaultUsers[0];
				completeLogin(acc);
			}
		} catch {}
	}

	window.setInterval(() => {
		const session = sessionStorage.getItem('forgeops-session');
		if (!session) return;
		try {
			const parsed = JSON.parse(session);
			if (Date.now() - parsed.at > 30 * 60 * 1000) {
				$('#logout-button').click();
				showToast('Session expired. Please sign in again.', 'warning');
			}
		} catch {
			sessionStorage.removeItem('forgeops-session');
		}
	}, 60000);

	window.setInterval(() => {
		if (!sessionStorage.getItem('forgeops-session')) return;
		if (!state.iotConfig.tbUseWebSocket && state.machines.length > 0) {
			fetchThingsBoardTelemetry();
		}
	}, Math.max(1500, state.iotConfig.tbPollIntervalMs || 5000));
})();
