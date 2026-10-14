import cors from "cors";
import AdmZip from "adm-zip";
import express from "express";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { atomicWrite, bakPath, readWithBackup } from "./configStore.js";
import { zertifikatBesorgen } from "./tls.js";
import { TRANSCRIPT_FORMATS, TranscriptLog, type TranscriptFormat } from "./transcriptLog.js";
import {
	CAPTION_MAX_PER_SECOND,
	captionFeedError,
	captionMessage,
	createRateLimiter,
	defaultCaptionFeed,
	dueRules,
	fireAction,
	ruleError,
	sendCaption,
	type TranscriptHit,
} from "./automation.js";
import type {
	AudioSettings,
	BeltpackDevice,
	CallBehaviorSettings,
	Channel,
	ClientMessage,
	ClientSession,
	ConfigRef,
	ControlAction,
	CoreState,
	DectAntenna,
	EventItem,
	IntercomGroup,
	IntercomUser,
	KeywordRule,
	CaptionFeed,
	MatrixRoute,
	PluginBridgeConfig,
	PopupMode,
	ReplyMode,
	ServerMessage,
	TemporaryChannel,
	TransportType,
	UserProfile,
	UserRole,
} from "@broadcast/shared";
import {
	applyIntercomPlan,
	defaultCallBehavior,
	diffIntercomPlan,
	readIntercomPlan,
	applyAudioControl,
	SYSTEM_CHANNEL_ANNOUNCEMENT,
	SYSTEM_CHANNEL_EMERGENCY,
	SYSTEM_CHANNEL_PROGRAM,
} from "@broadcast/shared";

const PORT = Number(process.env.PORT || 4001);
/**
 * Der HTTPS-Port (#23).
 *
 * Browser geben das Mikrofon nur in einem secure context frei — HTTPS oder
 * `localhost`. Ein Beltpack auf einem Handy im WLAN ist weder das eine noch
 * das andere, solange der Server nur Klartext spricht; deshalb stand die
 * Meldung „Microphone access requires HTTPS" auf jedem Geraet ausser dem
 * Server selbst.
 *
 * `INTERCOM_TLS=0` schaltet es ab — fuer Aufbauten, die bereits hinter einem
 * eigenen Reverse-Proxy mit echtem Zertifikat stehen; dort waere ein zweiter,
 * selbst ausgestellter Dienst nur ein zweiter Weg mit anderem Vertrauen.
 */
const TLS_PORT = Number(process.env.TLS_PORT || PORT + 442);
const TLS_AKTIV = process.env.INTERCOM_TLS !== "0";
const MOCK_MODE = process.env.MOCK_DEVICES === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Datenverzeichnis (configs/, models/). Standard ist das repo-interne `data/`
// relativ zum gebauten Server. In der Electron-Desktop-App liegt es dagegen im
// beschreibbaren userData-Pfad, weil das gepackte asar read-only ist — der
// Electron-Main-Prozess setzt dazu INTERCOM_DATA_DIR. Ein Override statt eines
// festen Pfades, damit derselbe gebaute Server in beiden Welten schreibt.
const DATA_DIR = process.env.INTERCOM_DATA_DIR
	? path.resolve(process.env.INTERCOM_DATA_DIR)
	: path.resolve(__dirname, "../../../data");
const CONFIG_DIR = path.resolve(DATA_DIR, "configs");
const MODEL_DIR = path.resolve(DATA_DIR, "models");
// Gebautes Web-UI (apps/web/dist). Im Dev liefert Vite die UI aus und proxyt
// /api + /ws hierher; im Produktions-/Desktop-Betrieb gibt es kein Vite, also
// liefert der Kern die UI selbst aus — unter DERSELBEN Origin wie die API. Das
// Web-UI setzt genau das voraus: es baut alle URLs aus location.origin
// (fetch("/api/..."), WebSocket auf `${origin}/ws`), ein file://-Fenster oder
// eine fremde Origin wuerde es brechen. WEB_DIST erlaubt dem Electron-Main, auf
// den entpackten Resources-Pfad zu zeigen; sonst der Pfad relativ zum Server.
const WEB_DIST = process.env.WEB_DIST
	? path.resolve(process.env.WEB_DIST)
	: path.resolve(__dirname, "../../web/dist");
const DEFAULT_MODEL_URL = process.env.VOSK_MODEL_URL || "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip";
const require = createRequire(import.meta.url);

const defaultChannels: Record<string, Channel> = {
	ch1: { id: "ch1", name: "DIR",   color: "#c1121f", type: "group" },
	ch2: { id: "ch2", name: "CAM",   color: "#0077b6", type: "group" },
	ch3: { id: "ch3", name: "AUDIO", color: "#2a9d8f", type: "group" },
	ch4: { id: "ch4", name: "STAGE", color: "#f4a261", type: "group" },
	// Die 3 System-Kanäle — immer passiv verfügbar, können nicht entfernt werden
	[SYSTEM_CHANNEL_ANNOUNCEMENT]: { id: SYSTEM_CHANNEL_ANNOUNCEMENT, name: "Announcement", color: "#e9c46a", type: "announcement" },
	[SYSTEM_CHANNEL_EMERGENCY]:    { id: SYSTEM_CHANNEL_EMERGENCY,    name: "Emergency",    color: "#e63946", type: "emergency"    },
	[SYSTEM_CHANNEL_PROGRAM]:      { id: SYSTEM_CHANNEL_PROGRAM,      name: "Program",      color: "#457b9d", type: "program"      },
};

function sanitizeConfigName(input: string): string {
	const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, "").replace(/\s+/g, "-");
	return cleaned || "default";
}

function now(): number {
	return Date.now();
}

function defaultAudioSettings(transport: TransportType): AudioSettings {
	return {
		inputGainDb: 0,
		outputGainDb: transport === "ethernet" ? 2 : 0,
		sidetonePercent: 20,
		noiseGateDb: -45,
		limiterEnabled: true,
	};
}

function defaultPluginBridge(): PluginBridgeConfig {
	return {
		enabled: false,
		protocol: "ws",
		host: "ws://127.0.0.1:39000",
		pluginPaths: [],
		preset: "",
		bypass: true,
	};
}

function defaultUserPermissions(role: UserRole, channels: string[]) {
	const limitedTalk = channels.slice(0, 2);
	const limitedListen = channels.slice(0, 3);

	if (role === "admin") {
		return {
			talkChannelIds: channels,
			listenChannelIds: channels,
			transcriptionChannelIds: channels,
			canAllCall: true,
			canManageDevices: true,
		};
	}

	if (role === "director") {
		return {
			talkChannelIds: channels,
			listenChannelIds: channels,
			transcriptionChannelIds: channels,
			canAllCall: true,
			canManageDevices: false,
		};
	}

	if (role === "operator") {
		return {
			talkChannelIds: limitedTalk,
			listenChannelIds: limitedListen,
			transcriptionChannelIds: limitedListen,
			canAllCall: false,
			canManageDevices: false,
		};
	}

	return {
		talkChannelIds: limitedTalk,
		listenChannelIds: limitedListen,
		transcriptionChannelIds: [],
		canAllCall: false,
		canManageDevices: false,
	};
}

const REPLY_MODES: ReplyMode[] = ["ptt", "latch", "handsfree"];
const POPUP_MODES: PopupMode[] = ["off", "call", "talk", "all"];

function clampDb(value: unknown, fallback: number, min = -60, max = 0): number {
	const n = Number(value);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, n));
}

function clampSeconds(value: unknown, fallback: number, min = 0, max = 600): number {
	const n = Number(value);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Validiert/normalisiert eingehende Call-Behavior-Werte und füllt fehlende
 * Felder aus den Defaults auf (dient zugleich als Schema-Migration für
 * ältere Configs ohne `callBehavior`).
 */
function sanitizeCallBehavior(raw: unknown, base: CallBehaviorSettings = defaultCallBehavior()): CallBehaviorSettings {
	const input = (raw && typeof raw === "object" ? raw : {}) as Partial<CallBehaviorSettings>;
	return {
		replyMode: REPLY_MODES.includes(input.replyMode as ReplyMode) ? (input.replyMode as ReplyMode) : base.replyMode,
		priorityDimDb: clampDb(input.priorityDimDb, base.priorityDimDb),
		isolate: typeof input.isolate === "boolean" ? input.isolate : base.isolate,
		cueTimeoutSec: clampSeconds(input.cueTimeoutSec, base.cueTimeoutSec, 0, 60),
		popupMode: POPUP_MODES.includes(input.popupMode as PopupMode) ? (input.popupMode as PopupMode) : base.popupMode,
		alertTone: typeof input.alertTone === "boolean" ? input.alertTone : base.alertTone,
		toneLevelDb: clampDb(input.toneLevelDb, base.toneLevelDb),
		activeTimeSec: clampSeconds(input.activeTimeSec, base.activeTimeSec, 0, 600),
	};
}

function createDefaultUsers(channels: string[]): Record<string, IntercomUser> {
	const ts = now();
	return {
		"user-admin": {
			id: "user-admin",
			name: "Intercom Admin",
			role: "admin",
			color: "#0a9396",
			permissions: defaultUserPermissions("admin", channels),
			callBehavior: defaultCallBehavior(),
			assignedDeviceIds: [],
			createdAt: ts,
			updatedAt: ts,
		},
	};
}

function createInitialState(configName: string): CoreState {
	const channelIds = Object.values(defaultChannels).map((ch) => ch.id);
	return {
		activeConfig: { name: configName, updatedAt: now() },
		users: createDefaultUsers(channelIds),
		devices: {},
		antennas: {},
		channels: { ...defaultChannels },
		groups: {},
		temporaryChannels: [],
		profiles: {},
		sessions: {},
		matrixRoutes: [],
		pluginBridge: defaultPluginBridge(),
		keywordRules: [],
		captionFeed: defaultCaptionFeed(),
		revokedDeviceIds: [],
		events: [],
	};
}

interface VoskRuntime {
	vosk: any | null;
	model: any | null;
	recognizers: Map<string, any>;
	disabledReason: string;
	modelPath: string;
}

const voskRuntime: VoskRuntime = {
	vosk: null,
	model: null,
	recognizers: new Map(),
	disabledReason: "",
	modelPath: process.env.VOSK_MODEL_PATH || path.resolve(MODEL_DIR, "vosk-model-small-en-us-0.15"),
};

function freeVoskRuntime(): void {
	voskRuntime.recognizers.forEach((recognizer) => {
		if (recognizer && typeof recognizer.free === "function") {
			recognizer.free();
		}
	});
	voskRuntime.recognizers.clear();

	if (voskRuntime.model && typeof voskRuntime.model.free === "function") {
		voskRuntime.model.free();
	}

	voskRuntime.model = null;
	voskRuntime.vosk = null;
	voskRuntime.disabledReason = "";
}

async function findModelDirectory(rootDir: string): Promise<string | null> {
	if (!existsSync(rootDir)) {
		return null;
	}

	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const nested = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(rootDir, entry.name));

	for (const candidate of nested) {
		if (candidate.toLowerCase().includes("vosk-model")) {
			return candidate;
		}
	}

	return null;
}

async function installVoskModel(url = DEFAULT_MODEL_URL, force = false): Promise<{ modelPath: string; downloaded: boolean }> {
	await fs.mkdir(MODEL_DIR, { recursive: true });

	if (!force && existsSync(voskRuntime.modelPath)) {
		return { modelPath: voskRuntime.modelPath, downloaded: false };
	}

	const tmpZip = path.join(MODEL_DIR, "vosk-model.zip");
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Download failed (${response.status})`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	await fs.writeFile(tmpZip, buffer);

	const zip = new AdmZip(tmpZip);
	zip.extractAllTo(MODEL_DIR, true);
	await fs.unlink(tmpZip);

	const modelDir = await findModelDirectory(MODEL_DIR);
	if (!modelDir) {
		throw new Error("No extracted Vosk model directory found");
	}

	voskRuntime.modelPath = modelDir;
	freeVoskRuntime();
	return { modelPath: modelDir, downloaded: true };
}

function recognizerKey(deviceId: string, channelId: string): string {
	return `${deviceId}::${channelId}`;
}

function parseVoskText(result: unknown): string {
	if (!result) {
		return "";
	}

	if (typeof result === "string") {
		try {
			const parsed = JSON.parse(result) as { text?: string; partial?: string };
			return (parsed.text || parsed.partial || "").trim();
		} catch {
			return "";
		}
	}

	if (typeof result === "object") {
		const parsed = result as { text?: string; partial?: string };
		return (parsed.text || parsed.partial || "").trim();
	}

	return "";
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	return "Unknown error";
}

function getLanHosts(): string[] {
	const nets = networkInterfaces();
	const hosts = new Set<string>();

	for (const entries of Object.values(nets)) {
		for (const entry of entries || []) {
			if (!entry || entry.family !== "IPv4" || entry.internal) {
				continue;
			}
			hosts.add(entry.address);
		}
	}

	return Array.from(hosts);
}

function loadVoskIfAvailable(): boolean {
	if (voskRuntime.model || voskRuntime.disabledReason) {
		return Boolean(voskRuntime.model);
	}

	if (!existsSync(voskRuntime.modelPath)) {
		voskRuntime.disabledReason = `Vosk model not found: ${voskRuntime.modelPath}`;
		return false;
	}

	try {
		const vosk = require("vosk");
		if (typeof vosk.setLogLevel === "function") {
			vosk.setLogLevel(-1);
		}
		voskRuntime.vosk = vosk;
		voskRuntime.model = new vosk.Model(voskRuntime.modelPath);
		return true;
	} catch (error) {
		voskRuntime.disabledReason = `Vosk module not available: ${describeError(error)}`;
		return false;
	}
}

function dropRecognizer(deviceId: string, channelId: string): void {
	const key = recognizerKey(deviceId, channelId);
	const recognizer = voskRuntime.recognizers.get(key);
	if (recognizer && typeof recognizer.free === "function") {
		recognizer.free();
	}
	voskRuntime.recognizers.delete(key);
}

function ensureRecognizer(deviceId: string, channelId: string, sampleRate: number): any | null {
	if (!loadVoskIfAvailable() || !voskRuntime.vosk || !voskRuntime.model) {
		return null;
	}

	const key = recognizerKey(deviceId, channelId);
	const existing = voskRuntime.recognizers.get(key);
	if (existing) {
		return existing;
	}

	let recognizer: any;
	try {
		recognizer = new voskRuntime.vosk.Recognizer({ model: voskRuntime.model, sampleRate });
	} catch {
		recognizer = new voskRuntime.vosk.Recognizer(voskRuntime.model, sampleRate);
	}

	voskRuntime.recognizers.set(key, recognizer);
	return recognizer;
}

function hydrateState(raw: Partial<CoreState>, configName: string, updatedAt?: number): CoreState {
	const hydratedChannels = Object.keys(raw.channels || {}).length > 0 ? (raw.channels as CoreState["channels"]) : { ...defaultChannels };
	// Systemkanäle immer erzwingen — sie dürfen nie fehlen
	hydratedChannels[SYSTEM_CHANNEL_ANNOUNCEMENT] ??= defaultChannels[SYSTEM_CHANNEL_ANNOUNCEMENT];
	hydratedChannels[SYSTEM_CHANNEL_EMERGENCY]    ??= defaultChannels[SYSTEM_CHANNEL_EMERGENCY];
	hydratedChannels[SYSTEM_CHANNEL_PROGRAM]      ??= defaultChannels[SYSTEM_CHANNEL_PROGRAM];
	const channelIds = Object.keys(hydratedChannels);
	const hydrated: CoreState = {
		activeConfig: {
			name: configName,
			updatedAt: updatedAt || raw.activeConfig?.updatedAt || now(),
		},
		users: raw.users || createDefaultUsers(channelIds),
		devices: raw.devices || {},
		antennas: raw.antennas || {},
		channels: hydratedChannels,
		groups: raw.groups || {},
		temporaryChannels: [], // temporäre Kanäle werden nie persistiert
		profiles: raw.profiles || {},
		sessions: {}, // Sessions sind flüchtig, werden nie persistiert
		matrixRoutes: raw.matrixRoutes || [],
		pluginBridge: { ...defaultPluginBridge(), ...(raw.pluginBridge || {}) },
		keywordRules: Array.isArray(raw.keywordRules) ? raw.keywordRules : [],
		captionFeed: { ...defaultCaptionFeed(), ...(raw.captionFeed || {}) },
		revokedDeviceIds: Array.isArray(raw.revokedDeviceIds) ? raw.revokedDeviceIds.map(String) : [],
		events: raw.events || [],
	};

	Object.values(hydrated.devices).forEach((device) => {
		device.audio = device.audio || defaultAudioSettings(device.transport);
		device.listenChannelIds = device.listenChannelIds || ["ch1"];
		device.channelIds = device.channelIds || ["ch1"];
		device.transcriptionChannelIds = device.transcriptionChannelIds || [];
	});

	Object.values(hydrated.users).forEach((user) => {
		user.permissions = user.permissions || defaultUserPermissions(user.role, channelIds);
		user.callBehavior = sanitizeCallBehavior(user.callBehavior);
		user.assignedDeviceIds = user.assignedDeviceIds || [];
	});

	return hydrated;
}

function configFilePath(configName: string): string {
	return path.join(CONFIG_DIR, `${sanitizeConfigName(configName)}.json`);
}

async function ensureConfigDir(): Promise<void> {
	await fs.mkdir(CONFIG_DIR, { recursive: true });
}

async function listConfigs(): Promise<ConfigRef[]> {
	await ensureConfigDir();
	const files = await fs.readdir(CONFIG_DIR);
	const refs: ConfigRef[] = [];

	for (const file of files.filter((item) => item.endsWith(".json"))) {
		const stat = await fs.stat(path.join(CONFIG_DIR, file));
		refs.push({
			name: file.replace(/\.json$/, ""),
			updatedAt: stat.mtimeMs,
		});
	}

	return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

let state: CoreState = createInitialState("default");

async function saveConfig(configName?: string): Promise<void> {
	const target = sanitizeConfigName(configName || state.activeConfig.name);
	state.activeConfig = { name: target, updatedAt: now() };
	await ensureConfigDir();
	// ATOMAR, nicht direkt: ein Absturz waehrend des Schreibens hinterliess
	// vorher eine halbe Datei, und der Kern startete danach nicht mehr.
	// Siehe `configStore.ts` fuer den ganzen Befund.
	await atomicWrite(configFilePath(target), JSON.stringify(state, null, 2));
}

async function loadConfig(configName: string): Promise<CoreState> {
	const target = sanitizeConfigName(configName);
	const datei = configFilePath(target);
	const ergebnis = await readWithBackup(datei, (raw) => JSON.parse(raw) as Partial<CoreState>);
	if (ergebnis.warnung) {
		emitEvent("system", ergebnis.warnung);
	}
	// Der Zeitstempel kommt von der Datei, die WIRKLICH gelesen wurde — sonst
	// traegt der Stand das Datum einer Datei, aus der er nicht stammt.
	const stat = await fs.stat(ergebnis.source === "haupt" ? datei : bakPath(datei));
	return hydrateState(ergebnis.value, target, stat.mtimeMs);
}

const app = express();
app.use(cors());
app.use(express.json());

// Statisches Web-UI ausliefern, wenn ein Build vorliegt (Produktions-/Desktop-
// Fall). Muss VOR den /api-Routen stehen, schadet ihnen aber nicht: express
// .static ruft next() fuer jede Anfrage ohne passende Datei, /api/* faellt also
// durch zu den Handlern weiter unten. In der Dev-Umgebung existiert WEB_DIST
// nicht -> uebersprungen, dort liefert Vite die UI.
if (existsSync(WEB_DIST)) {
	app.use(express.static(WEB_DIST));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Map ws connection → registered device ID (updated on register_device)
const wsDeviceMap = new Map<import("ws").WebSocket, string>();

// Auto-Release-Timer pro Gerät (Green-GO "ActiveTime"): ein rastender/offener
// Talk wird nach `callBehavior.activeTimeSec` Sekunden automatisch beendet.
const talkAutoReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTalkAutoRelease(deviceId: string): void {
	const timer = talkAutoReleaseTimers.get(deviceId);
	if (timer) {
		clearTimeout(timer);
		talkAutoReleaseTimers.delete(deviceId);
	}
}

/**
 * Plant die automatische Talk-Freigabe für ein Gerät ein, sofern der
 * zugewiesene User ein `activeTimeSec > 0` konfiguriert hat. Läuft der Timer
 * ab und spricht das Gerät weiterhin auf demselben Kanal, wird der Talk
 * serverseitig beendet und der State neu verteilt.
 */
function scheduleTalkAutoRelease(device: BeltpackDevice, channelId: string): void {
	clearTalkAutoRelease(device.id);
	const user = ensureUser(device.userId);
	const seconds = user?.callBehavior?.activeTimeSec ?? 0;
	if (seconds <= 0) {
		return;
	}
	const timer = setTimeout(() => {
		talkAutoReleaseTimers.delete(device.id);
		const current = ensureDevice(device.id);
		if (current && current.talkChannelId === channelId) {
			current.talkChannelId = undefined;
			routeTalkEvent(current.id, undefined);
			emitEvent("system", `${current.label} talk auto-released after ${seconds}s (ActiveTime)`);
			broadcastState();
		}
	}, seconds * 1000);
	talkAutoReleaseTimers.set(device.id, timer);
}

function pushEvent(type: EventItem["type"], message: string): EventItem {
	const event: EventItem = {
		id: randomUUID(),
		ts: now(),
		type,
		message,
	};
	state.events.unshift(event);
	state.events = state.events.slice(0, 300);
	return event;
}

function emit(message: ServerMessage): void {
	const payload = JSON.stringify(message);
	wss.clients.forEach((client) => {
		if (client.readyState === 1) {
			client.send(payload);
		}
	});
}

function emitState(): void {
	emit({ type: "state", payload: state });
}

/** Alias für emit — semantisch: an alle Clients senden */
const broadcast = emit;

/** Aktuellen State an alle Clients senden */
function broadcastState(): void {
	emitState();
}

/**
 * Sendet eine Nachricht an alle WebSocket-Clients, deren Gerät dem angegebenen User zugewiesen ist.
 */
function broadcastToUser(userId: string, message: ServerMessage): void {
	const userDeviceIds = new Set(
		Object.values(state.devices)
			.filter((d) => d.userId === userId)
			.map((d) => d.id)
	);
	const payload = JSON.stringify(message);
	wsDeviceMap.forEach((deviceId, ws) => {
		if (userDeviceIds.has(deviceId) && (ws as unknown as { readyState: number }).readyState === 1) {
			(ws as unknown as { send: (data: string) => void }).send(payload);
		}
	});
}

function emitEvent(type: EventItem["type"], message: string): void {
	const event = pushEvent(type, message);
	emit({ type: "event", payload: event });
	emitState();
}

function ensureDevice(deviceId: string): BeltpackDevice | undefined {
	return state.devices[deviceId];
}

function ensureUser(userId?: string): IntercomUser | undefined {
	if (!userId) {
		return undefined;
	}
	return state.users[userId];
}

function uniqueKnownChannels(channelIds: string[]): string[] {
	const known = new Set(Object.keys(state.channels));
	const dedup = new Set<string>();
	channelIds.forEach((channelId) => {
		if (known.has(channelId)) {
			dedup.add(channelId);
		}
	});
	return Array.from(dedup);
}

function filterByPermissions(requested: string[], allowed: string[]): string[] {
	if (allowed.length === 0) {
		return [];
	}
	const allowedSet = new Set(allowed);
	return requested.filter((channelId) => allowedSet.has(channelId));
}

function assignDeviceToUser(deviceId: string, userId?: string): void {
	Object.values(state.users).forEach((user) => {
		user.assignedDeviceIds = user.assignedDeviceIds.filter((id) => id !== deviceId);
	});

	if (!userId || !state.users[userId]) {
		return;
	}

	const user = state.users[userId];
	if (!user.assignedDeviceIds.includes(deviceId)) {
		user.assignedDeviceIds.push(deviceId);
	}
	user.updatedAt = now();
}

function applyUserPermissions(device: BeltpackDevice): void {
	const user = ensureUser(device.userId);
	if (!user) {
		device.channelIds = uniqueKnownChannels(device.channelIds.length ? device.channelIds : ["ch1"]);
		device.listenChannelIds = uniqueKnownChannels(device.listenChannelIds.length ? device.listenChannelIds : device.channelIds.slice(0, 2));
		device.transcriptionChannelIds = uniqueKnownChannels(device.transcriptionChannelIds || []);
		if (device.talkChannelId && !device.channelIds.includes(device.talkChannelId)) {
			device.talkChannelId = undefined;
		}
		return;
	}

	device.channelIds = filterByPermissions(uniqueKnownChannels(device.channelIds), user.permissions.talkChannelIds);
	if (device.channelIds.length === 0) {
		device.channelIds = user.permissions.talkChannelIds.slice(0, 1);
	}

	device.listenChannelIds = filterByPermissions(uniqueKnownChannels(device.listenChannelIds), user.permissions.listenChannelIds);
	if (device.listenChannelIds.length === 0) {
		device.listenChannelIds = user.permissions.listenChannelIds.slice(0, 1);
	}

	device.transcriptionChannelIds = filterByPermissions(
		uniqueKnownChannels(device.transcriptionChannelIds || []),
		user.permissions.transcriptionChannelIds
	);

	if (device.talkChannelId && !user.permissions.talkChannelIds.includes(device.talkChannelId)) {
		device.talkChannelId = undefined;
	}
}

function ensureAntenna(antennaId: string): DectAntenna | undefined {
	return state.antennas[antennaId];
}

function matrixAllows(fromDeviceId: string, toDeviceId: string, channelId: string): boolean {
	const route = state.matrixRoutes.find(
		(item) => item.fromDeviceId === fromDeviceId && item.toDeviceId === toDeviceId && item.channelId === channelId
	);
	return route ? route.enabled : true;
}

function routeTalkEvent(deviceId: string, channelId?: string): void {
	const source = ensureDevice(deviceId);
	if (!source) {
		return;
	}

	if (!channelId) {
		emitEvent("talk", `${source.label} TALK OFF`);
		return;
	}

	const isAllCall = channelId === "all";
	const listeners = Object.values(state.devices)
		.filter(
			(device) =>
				device.id !== deviceId &&
				(isAllCall || (device.listenChannelIds.includes(channelId) && matrixAllows(deviceId, device.id, channelId)))
		)
		.map((device) => device.label)
		.join(", ");

	const channelName = isAllCall ? "ALL CALL" : (state.channels[channelId]?.name || channelId);
	emitEvent("talk", `${source.label} TALK ${channelName}${listeners ? ` -> listeners: ${listeners}` : ""}`);
}

function relayAudioChunk(senderDeviceId: string, channelId: string, sampleRate: number, audio: string): void {
	const isAllCall = channelId === "all";
	const listenerIds = new Set(
		Object.values(state.devices)
			.filter(
				(d) =>
					d.id !== senderDeviceId &&
					(isAllCall || (d.listenChannelIds.includes(channelId) && matrixAllows(senderDeviceId, d.id, channelId)))
			)
			.map((d) => d.id)
	);

	if (listenerIds.size === 0) return;

	const msg = JSON.stringify({
		type: "audio_chunk",
		payload: { fromDeviceId: senderDeviceId, channelId, sampleRate, audio },
	});

	wsDeviceMap.forEach((deviceId, ws) => {
		if (listenerIds.has(deviceId) && (ws as unknown as { readyState: number }).readyState === 1) {
			(ws as unknown as { send: (data: string) => void }).send(msg);
		}
	});
}

let voskWarningEmitted = false;
const transcriptLog = new TranscriptLog();

function runKeywordRules(hit: TranscriptHit): void {
	for (const rule of dueRules(state.keywordRules ?? [], hit)) {
		void fireAction(rule, hit).then((err) => {
			emitEvent("system", err
				? `Rule "${rule.keyword}" (${rule.action.kind}) failed: ${err}`
				: `Rule "${rule.keyword}" fired ${rule.action.kind} on [${hit.channelName}]`);
		});
	}
}

const captionAllowed = createRateLimiter(CAPTION_MAX_PER_SECOND, 1000);
let lastCaptionWarning = 0;

// No event per line: the transcript event already shows it. Only failures and
// dropped lines are reported, at most every 10 s.
function runCaptionFeed(hit: TranscriptHit): void {
	const feed = state.captionFeed;
	const msg = captionMessage(feed, hit);
	if (!feed || !msg) return;
	const warn = (text: string) => {
		if (hit.ts - lastCaptionWarning < 10_000) return;
		lastCaptionWarning = hit.ts;
		emitEvent("system", text);
	};
	if (!captionAllowed(hit.ts)) {
		warn(`Live captions: more than ${CAPTION_MAX_PER_SECOND} lines per second, lines dropped`);
		return;
	}
	void sendCaption(feed, msg).then((err) => {
		if (err) warn(`Live captions failed: ${err}`);
	});
}

function handleTranscriptionAudio(payload: Extract<ClientMessage, { type: "transcribe_audio" }>["payload"]): void {
	const device = ensureDevice(payload.id);
	if (!device) {
		console.error(`[Transcription] Device not found: ${payload.id} (known devices: ${Object.keys(state.devices).join(", ")})`);
		return;
	}

	// Relay audio to all devices currently listening on this channel (independent of Vosk)
	if (device.talkChannelId === payload.channelId || device.talkChannelId === "all") {
		relayAudioChunk(payload.id, payload.channelId, payload.sampleRate || 16000, payload.audio);
	}

	const assignedUser = ensureUser(device.userId);
	if (assignedUser && !assignedUser.permissions.transcriptionChannelIds.includes(payload.channelId)) {
		console.warn(`[Transcription] User ${assignedUser.name} is not allowed to transcribe ${payload.channelId}`);
		return;
	}

	const selected = device.transcriptionChannelIds || [];
	if (!selected.includes(payload.channelId)) {
		console.warn(`[Transcription] Channel ${payload.channelId} not in transcription list for ${device.label}. Enabled channels: ${selected.join(", ")}`);
		return;
	}

	const recognizer = ensureRecognizer(payload.id, payload.channelId, payload.sampleRate || 16000);
	if (!recognizer) {
		if (!voskWarningEmitted && voskRuntime.disabledReason) {
			voskWarningEmitted = true;
			console.warn(`[Vosk] Not available: ${voskRuntime.disabledReason}`);
			emitEvent("system", `Transcription disabled: ${voskRuntime.disabledReason}`);
		}
		return;
	}

	const pcm = Buffer.from(payload.audio, "base64");
	if (pcm.length === 0) {
		return;
	}

	try {
		const isFinal = Boolean(recognizer.acceptWaveform(pcm));
		if (!isFinal) {
			return;
		}

		const text = parseVoskText(recognizer.result());
		if (!text) {
			return;
		}

		const channelName = state.channels[payload.channelId]?.name || payload.channelId;
		transcriptLog.add({ id: randomUUID(), ts: now(), kind: "line", channelId: payload.channelId, channelName, sender: device.label, text });
		emitEvent("transcript", `[${channelName}] ${device.label}: ${text}`);
		const hit = { channelId: payload.channelId, channelName, sender: device.label, text, ts: now() };
		runKeywordRules(hit);
		runCaptionFeed(hit);
	} catch {
		emitEvent("system", `Transcription error on ${device.label}/${payload.channelId}`);
	}
}

function upsertMatrixRoute(route: MatrixRoute): void {
	const existing = state.matrixRoutes.find(
		(item) =>
			item.fromDeviceId === route.fromDeviceId &&
			item.toDeviceId === route.toDeviceId &&
			item.channelId === route.channelId
	);

	if (existing) {
		existing.enabled = route.enabled;
		return;
	}

	state.matrixRoutes.push(route);
}

function handleMessage(message: ClientMessage): void {
	switch (message.type) {
		case "register_antenna": {
			const antenna: DectAntenna = {
				id: message.payload.id,
				label: message.payload.label,
				location: message.payload.location,
				online: true,
				connectedDeviceIds: ensureAntenna(message.payload.id)?.connectedDeviceIds || [],
				lastSeenAt: now(),
			};
			state.antennas[antenna.id] = antenna;
			emitEvent("register", `Antenna ${antenna.label} registered (${antenna.location})`);
			break;
		}
		case "register_device": {
			if (state.revokedDeviceIds?.includes(message.payload.id)) {
				// The phone learns it from the broadcast state and shows why.
				emitEvent("system", `Revoked device ${message.payload.label || message.payload.id} tried to register`);
				break;
			}
			const existing = ensureDevice(message.payload.id);
			const next: BeltpackDevice = {
				id: message.payload.id,
				label: message.payload.label || existing?.label || message.payload.id,
				role: message.payload.role || existing?.role || "beltpack",
				transport: message.payload.transport,
				userId: message.payload.userId || existing?.userId,
				channelIds: message.payload.channelIds || existing?.channelIds || ["ch1"],
				talkChannelId: existing?.talkChannelId,
				listenChannelIds: existing?.listenChannelIds || ["ch1"],
				transcriptionChannelIds: existing?.transcriptionChannelIds || [],
				battery: existing?.battery || {
					percent: message.payload.transport === "ethernet" ? 100 : 85,
					charging: message.payload.transport === "ethernet",
					source: message.payload.transport === "ethernet" ? "poe" : "battery",
				},
				network: existing?.network || {
					online: true,
					signal: message.payload.transport === "dect" ? 78 : 100,
					ip: "0.0.0.0",
					latencyMs: message.payload.transport === "dect" ? 28 : 8,
				},
				audio: existing?.audio || defaultAudioSettings(message.payload.transport),
				connectedAntennaId: message.payload.connectedAntennaId || existing?.connectedAntennaId,
				lastSeenAt: now(),
			};

			applyUserPermissions(next);

			state.devices[next.id] = next;
			assignDeviceToUser(next.id, next.userId);

			if (next.connectedAntennaId && state.antennas[next.connectedAntennaId]) {
				const antenna = state.antennas[next.connectedAntennaId];
				if (!antenna.connectedDeviceIds.includes(next.id)) {
					antenna.connectedDeviceIds.push(next.id);
				}
			}

			emitEvent("register", `Device ${next.label} registered via ${next.transport}`);
			break;
		}
		case "heartbeat": {
			const device = ensureDevice(message.payload.id);
			if (!device) {
				return;
			}
			device.lastSeenAt = now();
			device.battery = { ...device.battery, ...message.payload.battery };
			device.network = { ...device.network, ...message.payload.network };
			emitEvent("heartbeat", `Heartbeat ${device.label} (${device.transport})`);
			break;
		}
		case "assign_channels": {
			const device = ensureDevice(message.payload.id);
			if (!device) {
				return;
			}

			const assignedUser = ensureUser(device.userId);
			const requested = uniqueKnownChannels(message.payload.channelIds);
			device.channelIds = assignedUser
				? filterByPermissions(requested, assignedUser.permissions.talkChannelIds)
				: requested;
			device.listenChannelIds = assignedUser
				? filterByPermissions(requested.slice(0, 2), assignedUser.permissions.listenChannelIds)
				: requested.slice(0, 2);
			emitEvent("assign", `${device.label} assigned channels: ${device.channelIds.join(", ")}`);
			break;
		}
		case "set_listen": {
			const device = ensureDevice(message.payload.id);
			if (!device) {
				return;
			}
			const assignedUser = ensureUser(device.userId);
			const requested = uniqueKnownChannels(message.payload.channelIds);
			device.listenChannelIds = assignedUser
				? filterByPermissions(requested, assignedUser.permissions.listenChannelIds)
				: requested;
			emitEvent("listen", `${device.label} listen -> ${device.listenChannelIds.join(", ") || "NONE"}`);
			break;
		}
		case "set_talk": {
			const device = ensureDevice(message.payload.id);
			if (!device) {
				return;
			}

			const assignedUser = ensureUser(device.userId);
			if (assignedUser) {
				const isAllCall = message.payload.channelId === "all";
				if (isAllCall && !assignedUser.permissions.canAllCall) {
					emitEvent("system", `All-call denied for ${assignedUser.name}`);
					return;
				}
				if (!isAllCall && !assignedUser.permissions.talkChannelIds.includes(message.payload.channelId)) {
					emitEvent("system", `Talk denied for ${assignedUser.name} on ${message.payload.channelId}`);
					return;
				}
			}
			if (message.payload.active) {
				device.talkChannelId = message.payload.channelId;
				routeTalkEvent(device.id, message.payload.channelId);
				scheduleTalkAutoRelease(device, message.payload.channelId);
			} else {
				if (device.talkChannelId === message.payload.channelId) {
					device.talkChannelId = undefined;
					routeTalkEvent(device.id, undefined);
				}
				clearTalkAutoRelease(device.id);
			}
			break;
		}
		case "set_transcription_channels": {
			const device = ensureDevice(message.payload.id);
			if (!device) {
				return;
			}

			const assignedUser = ensureUser(device.userId);
			const filtered = assignedUser
				? filterByPermissions(uniqueKnownChannels(message.payload.channelIds), assignedUser.permissions.transcriptionChannelIds)
				: uniqueKnownChannels(message.payload.channelIds);

			const previous = new Set(device.transcriptionChannelIds || []);
			device.transcriptionChannelIds = filtered;

			previous.forEach((channelId) => {
				if (!filtered.includes(channelId)) {
					dropRecognizer(device.id, channelId);
				}
			});

			emitEvent("assign", `${device.label} transcription -> ${device.transcriptionChannelIds.join(", ") || "NONE"}`);
			break;
		}
		case "transcribe_audio": {
			handleTranscriptionAudio(message.payload);
			break;
		}
		case "set_user": {
			const device = ensureDevice(message.payload.id);
			if (!device) {
				return;
			}

			if (message.payload.userId && !state.users[message.payload.userId]) {
				console.warn(`[set_user] User not found: ${message.payload.userId} for device ${device.label} – skipping assignment`);
				return;
			}

			device.userId = message.payload.userId;
			assignDeviceToUser(device.id, message.payload.userId);
			applyUserPermissions(device);
			emitEvent("assign", `${device.label} user set to ${device.userId ? state.users[device.userId].name : "none"}`);
			break;
		}
		case "direct_call": {
			const { fromDeviceId, toUserId } = message.payload;
			if (!state.users[toUserId]) {
				console.warn(`[direct_call] Unknown toUserId: ${toUserId}`);
				break;
			}
			const tempId = `tmp-${randomUUID()}`;
			const callerUserId = state.devices[fromDeviceId]?.userId || fromDeviceId;
			const tempCh: TemporaryChannel = {
				id: tempId,
				callerUserId,
				receiverUserId: toUserId,
				openedAt: now(),
				active: true,
			};
			state.temporaryChannels.push(tempCh);
			// Alle Geräte des Empfängers benachrichtigen
			broadcastToUser(toUserId, { type: "temp_channel_opened", payload: tempCh });
			emitEvent("call", `Direct call from ${callerUserId} to ${toUserId}`);
			broadcastState();
			break;
		}
		case "direct_call_end": {
			const { tempChannelId } = message.payload;
			const ch = state.temporaryChannels.find((t) => t.id === tempChannelId);
			if (ch) {
				ch.active = false;
				state.temporaryChannels = state.temporaryChannels.filter((t) => t.id !== tempChannelId);
				broadcast({ type: "temp_channel_closed", payload: { tempChannelId } });
				emitEvent("call", `Direct call ${tempChannelId} ended`);
				broadcastState();
			}
			break;
		}
		default:
			break;
	}
}

app.get("/api/state", (_req, res) => {
	res.json(state);
});

app.get("/api/users", (_req, res) => {
	res.json({ ok: true, users: Object.values(state.users) });
});

app.post("/api/users", (req, res) => {
	const id = String(req.body?.id || `user-${Math.random().toString(36).slice(2, 8)}`).trim();
	if (!id) {
		res.status(400).json({ ok: false, error: "Missing user id" });
		return;
	}
	if (state.users[id]) {
		res.status(400).json({ ok: false, error: "User already exists" });
		return;
	}

	const role = (req.body?.role || "operator") as UserRole;
	const name = String(req.body?.name || id).trim();
	const channelIds = Object.keys(state.channels);
	const permissions = {
		...defaultUserPermissions(role, channelIds),
		...(req.body?.permissions || {}),
	};

	const user: IntercomUser = {
		id,
		name,
		role,
		color: String(req.body?.color || "#2a9d8f"),
		permissions: {
			talkChannelIds: uniqueKnownChannels(permissions.talkChannelIds || []),
			listenChannelIds: uniqueKnownChannels(permissions.listenChannelIds || []),
			transcriptionChannelIds: uniqueKnownChannels(permissions.transcriptionChannelIds || []),
			canAllCall: Boolean(permissions.canAllCall),
			canManageDevices: Boolean(permissions.canManageDevices),
		},
		callBehavior: sanitizeCallBehavior(req.body?.callBehavior),
		assignedDeviceIds: [],
		createdAt: now(),
		updatedAt: now(),
	};

	state.users[id] = user;
	emitEvent("assign", `User ${user.name} created (${user.role})`);
	res.json({ ok: true, user, state });
});

app.patch("/api/users/:id", (req, res) => {
	const user = state.users[req.params.id];
	if (!user) {
		res.status(404).json({ ok: false, error: "User not found" });
		return;
	}

	if (req.body?.name) {
		user.name = String(req.body.name);
	}
	if (req.body?.color) {
		user.color = String(req.body.color);
	}
	if (req.body?.role) {
		user.role = req.body.role as UserRole;
	}

	if (req.body?.permissions) {
		const incoming = req.body.permissions;
		user.permissions = {
			...user.permissions,
			talkChannelIds: incoming.talkChannelIds ? uniqueKnownChannels(incoming.talkChannelIds) : user.permissions.talkChannelIds,
			listenChannelIds: incoming.listenChannelIds ? uniqueKnownChannels(incoming.listenChannelIds) : user.permissions.listenChannelIds,
			transcriptionChannelIds: incoming.transcriptionChannelIds ? uniqueKnownChannels(incoming.transcriptionChannelIds) : user.permissions.transcriptionChannelIds,
			canAllCall: typeof incoming.canAllCall === "boolean" ? incoming.canAllCall : user.permissions.canAllCall,
			canManageDevices: typeof incoming.canManageDevices === "boolean" ? incoming.canManageDevices : user.permissions.canManageDevices,
		};
	}

	if (req.body?.callBehavior) {
		// Bestehende Werte als Basis: partielle Updates überschreiben nur die
		// mitgeschickten Felder, der Rest bleibt erhalten.
		user.callBehavior = sanitizeCallBehavior(
			{ ...user.callBehavior, ...req.body.callBehavior },
			user.callBehavior,
		);
	}

	user.updatedAt = now();

	Object.values(state.devices).forEach((device) => {
		if (device.userId === user.id) {
			applyUserPermissions(device);
		}
	});

	emitEvent("assign", `User ${user.name} updated`);
	res.json({ ok: true, user, state });
});

app.delete("/api/users/:id", (req, res) => {
	const user = state.users[req.params.id];
	if (!user) {
		res.status(404).json({ ok: false, error: "User not found" });
		return;
	}
	if (user.role === "admin" && Object.values(state.users).filter((u) => u.role === "admin").length <= 1) {
		res.status(400).json({ ok: false, error: "At least one admin must remain" });
		return;
	}

	Object.values(state.devices).forEach((device) => {
		if (device.userId === user.id) {
			device.userId = undefined;
			applyUserPermissions(device);
		}
	});

	delete state.users[user.id];
	emitEvent("assign", `User ${user.name} removed`);
	res.json({ ok: true, state });
});

app.patch("/api/devices/:id/user", (req, res) => {
	const device = ensureDevice(req.params.id);
	if (!device) {
		res.status(404).json({ ok: false, error: "Device not found" });
		return;
	}

	const userId = req.body?.userId ? String(req.body.userId) : undefined;
	if (userId && !state.users[userId]) {
		res.status(404).json({ ok: false, error: "User not found" });
		return;
	}

	device.userId = userId;
	assignDeviceToUser(device.id, userId);
	applyUserPermissions(device);
	emitEvent("assign", `${device.label} assigned to ${userId ? state.users[userId].name : "no user"}`);
	res.json({ ok: true, state });
});

app.get("/api/transcription/status", (_req, res) => {
	const installed = existsSync(voskRuntime.modelPath);
	res.json({
		ok: true,
		installed,
		modelPath: voskRuntime.modelPath,
		moduleLoaded: Boolean(voskRuntime.model),
		disabledReason: voskRuntime.disabledReason || null,
		defaultModelUrl: DEFAULT_MODEL_URL,
	});
});

app.get("/api/transcript", (req, res) => {
	const channelId = typeof req.query.channel === "string" && req.query.channel ? req.query.channel : undefined;
	const entries = transcriptLog.list(channelId);
	const format = typeof req.query.format === "string" ? req.query.format : "";
	if (!format) {
		res.json({ ok: true, entries });
		return;
	}
	const out = TRANSCRIPT_FORMATS[format as TranscriptFormat];
	if (!out) {
		res.status(400).json({ ok: false, error: `Unknown format "${format}" (json, txt, srt)` });
		return;
	}
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	res.setHeader("Content-Type", out.type);
	res.setHeader("Content-Disposition", `attachment; filename="transcript-${stamp}.${format}"`);
	res.send(out.render(entries));
});

app.post("/api/transcript/bookmark", (req, res) => {
	const note = String(req.body?.note ?? "").trim().slice(0, 500);
	const entry = transcriptLog.add({ id: randomUUID(), ts: now(), kind: "bookmark", text: note || "Bookmark" });
	emitEvent("bookmark", entry.text);
	res.json({ ok: true, entry });
});

app.delete("/api/transcript", (_req, res) => {
	transcriptLog.clear();
	emitEvent("system", "Transcript cleared");
	res.json({ ok: true });
});

// ── Keyword rules (transcript → webhook / OSC) ───────────────────────────────
function ruleFromBody(body: any, id: string): KeywordRule {
	const a = body?.action ?? {};
	const action = a.kind === "osc"
		? { kind: "osc" as const, host: String(a.host ?? "").trim(), port: Number(a.port), address: String(a.address ?? "").trim() }
		: { kind: "webhook" as const, url: String(a.url ?? "").trim() };
	const channelId = body?.channelId ? String(body.channelId) : undefined;
	return { id, keyword: String(body?.keyword ?? "").trim(), channelId, enabled: body?.enabled !== false, action };
}

app.get("/api/automation/rules", (_req, res) => {
	res.json({ ok: true, rules: state.keywordRules ?? [] });
});

app.post("/api/automation/rules", (req, res) => {
	const rule = ruleFromBody(req.body, randomUUID());
	const err = ruleError(rule) ?? (rule.channelId && !state.channels[rule.channelId] ? "unknown channel" : null);
	if (err) {
		res.status(400).json({ ok: false, error: err });
		return;
	}
	state.keywordRules = [...(state.keywordRules ?? []), rule];
	emitEvent("config", `Keyword rule "${rule.keyword}" added`);
	res.json({ ok: true, rule });
});

app.patch("/api/automation/rules/:id", (req, res) => {
	const rules = state.keywordRules ?? [];
	const i = rules.findIndex((r) => r.id === req.params.id);
	if (i < 0) {
		res.status(404).json({ ok: false, error: "rule not found" });
		return;
	}
	const rule = ruleFromBody({ ...rules[i], ...req.body, action: req.body?.action ?? rules[i].action }, rules[i].id);
	const err = ruleError(rule) ?? (rule.channelId && !state.channels[rule.channelId] ? "unknown channel" : null);
	if (err) {
		res.status(400).json({ ok: false, error: err });
		return;
	}
	state.keywordRules = rules.map((r, j) => (j === i ? rule : r));
	emitEvent("config", `Keyword rule "${rule.keyword}" updated`);
	res.json({ ok: true, rule });
});

app.delete("/api/automation/rules/:id", (req, res) => {
	const rules = state.keywordRules ?? [];
	const rule = rules.find((r) => r.id === req.params.id);
	if (!rule) {
		res.status(404).json({ ok: false, error: "rule not found" });
		return;
	}
	state.keywordRules = rules.filter((r) => r.id !== rule.id);
	emitEvent("config", `Keyword rule "${rule.keyword}" removed`);
	res.json({ ok: true });
});

// Sends the action once with a sample line, so an operator can check the
// console or the webhook receiver before the show instead of during it.
app.post("/api/automation/rules/:id/test", async (req, res) => {
	const rule = (state.keywordRules ?? []).find((r) => r.id === req.params.id);
	if (!rule) {
		res.status(404).json({ ok: false, error: "rule not found" });
		return;
	}
	const channelName = rule.channelId ? state.channels[rule.channelId]?.name ?? rule.channelId : "*";
	const err = await fireAction(rule, { channelId: rule.channelId ?? "", channelName, sender: "Test", text: `Test: ${rule.keyword}`, ts: now() });
	res.status(err ? 502 : 200).json(err ? { ok: false, error: err } : { ok: true });
});

// ── Live caption feed (transcript → OSC caption) ─────────────────────────────
function captionFeedFromBody(body: any, current: CaptionFeed): CaptionFeed {
	const b = { ...current, ...(body ?? {}) };
	const layer = b.layer === undefined || b.layer === null || b.layer === "" ? undefined : Number(b.layer);
	return {
		enabled: b.enabled === true,
		host: String(b.host ?? "").trim(),
		port: Number(b.port),
		address: String(b.address ?? "").trim(),
		channelIds: Array.isArray(b.channelIds) ? b.channelIds.map(String) : b.channelIds,
		includeSpeaker: b.includeSpeaker === true,
		...(layer === undefined ? {} : { layer }),
	};
}

app.get("/api/automation/captions", (_req, res) => {
	res.json({ ok: true, feed: state.captionFeed ?? defaultCaptionFeed() });
});

app.patch("/api/automation/captions", (req, res) => {
	const feed = captionFeedFromBody(req.body, state.captionFeed ?? defaultCaptionFeed());
	const unknown = Array.isArray(feed.channelIds) ? feed.channelIds.find((id) => !state.channels[id]) : undefined;
	const err = captionFeedError(feed) ?? (unknown ? `unknown channel ${unknown}` : null);
	if (err) {
		res.status(400).json({ ok: false, error: err });
		return;
	}
	state.captionFeed = feed;
	emitEvent("config", `Live captions ${feed.enabled ? "on" : "off"} → ${feed.host}:${feed.port} ${feed.address}`);
	res.json({ ok: true, feed });
});

// Sends one sample caption regardless of the switch and the channel filter,
// so the graphic can be checked before the show.
app.post("/api/automation/captions/test", async (_req, res) => {
	const feed = state.captionFeed ?? defaultCaptionFeed();
	const msg = captionMessage({ ...feed, enabled: true, channelIds: [] }, { channelId: "", sender: "Test", text: "Live caption test" });
	const err = msg ? await sendCaption(feed, msg) : "nothing to send";
	res.status(err ? 502 : 200).json(err ? { ok: false, error: err } : { ok: true });
});

app.get("/api/network/hosts", (_req, res) => {
	res.json({
		ok: true,
		hosts: getLanHosts(),
		serverPort: PORT,
		// Damit die Oberflaeche sagen kann, WOHIN man wechseln muss, wenn das
		// Mikrofon gesperrt ist (#23) — statt nur, dass HTTPS noetig waere.
		tlsPort: TLS_AKTIV ? TLS_PORT : null,
	});
});

app.post("/api/transcription/model/install", async (req, res) => {
	try {
		const url = req.body?.url ? String(req.body.url) : DEFAULT_MODEL_URL;
		const force = Boolean(req.body?.force);
		const result = await installVoskModel(url, force);
		emitEvent("system", `Vosk model ready: ${result.modelPath}`);
		res.json({ ok: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown install error";
		emitEvent("system", `Vosk model install failed: ${message}`);
		res.status(500).json({ ok: false, error: message });
	}
});

app.get("/api/audio/plugin-bridge", (_req, res) => {
	res.json({ ok: true, pluginBridge: state.pluginBridge });
});

app.patch("/api/audio/plugin-bridge", (req, res) => {
	state.pluginBridge = {
		...state.pluginBridge,
		...req.body,
		pluginPaths: Array.isArray(req.body?.pluginPaths) ? req.body.pluginPaths.map((v: unknown) => String(v)) : state.pluginBridge.pluginPaths,
	};
	emitEvent("config", `Plugin bridge updated (${state.pluginBridge.enabled ? "enabled" : "disabled"})`);
	res.json({ ok: true, pluginBridge: state.pluginBridge });
});

/**
 * Ist dieser Eintrag ein Plugin? (#24)
 *
 * Der Punkt, an dem die Auswahl bisher scheiterte: ein VST3 ist auf macOS
 * und Linux KEINE Datei, sondern ein Ordner — `Reverb.vst3/Contents/...`.
 * Genauso eine Audio-Unit (`.component`). Der Dateibrowser fragte nur
 * `isDirectory()` und stieg deshalb in das Plugin HINEIN, statt es zu nehmen:
 * wer auf sein Plugin tippte, sah `Contents` und `Resources`.
 *
 * Die Endung entscheidet, nicht die Frage Datei-oder-Ordner.
 */
function istPlugin(name: string): boolean {
	return /\.(vst3|vst|dll|component|so)$/i.test(name);
}

// File-system browser for plugin path selection (server-local paths only)
app.get("/api/fs/list", (req, res) => {
	try {
		const rawPath = typeof req.query.path === "string" ? req.query.path : "";
		// Default to common VST dirs on Windows/Mac/Linux
		const defaultPath = process.platform === "win32"
			? "C:\\Program Files\\Common Files\\VST3"
			: process.platform === "darwin"
			? "/Library/Audio/Plug-Ins/VST3"
			: "/usr/lib/vst3";
		const targetPath = rawPath || defaultPath;
		// Safety: only allow absolute paths, no traversal tricks
		const resolved = path.resolve(targetPath);
		if (!existsSync(resolved)) {
			// Fall back to drive root on Windows or / elsewhere
			const fallback = process.platform === "win32" ? "C:\\" : "/";
			const entries = readdirSync(fallback, { withFileTypes: true }).map((e) => ({
				name: e.name,
				isDir: e.isDirectory(),
				isPlugin: istPlugin(e.name),
				path: path.join(fallback, e.name),
			}));
			return res.json({ ok: true, path: fallback, entries, parent: null });
		}
		const entries = readdirSync(resolved, { withFileTypes: true })
			.filter((e) => e.isDirectory() || istPlugin(e.name))
			.map((e) => ({
				name: e.name,
				isDir: e.isDirectory(),
				// Ein Plugin kann beides sein: Ordner UND Plugin. Genau das
				// stand bisher nicht in der Antwort, und die Oberflaeche musste
				// raten — sie riet auf "Ordner".
				isPlugin: istPlugin(e.name),
				path: path.join(resolved, e.name),
			}))
			// Plugins zuerst, dann Ordner, dann der Rest: wer in
			// /Library/Audio/Plug-Ins/VST3 steht, sucht ein Plugin und keinen
			// Unterordner.
			.sort((a, b) =>
				(b.isPlugin ? 1 : 0) - (a.isPlugin ? 1 : 0)
				|| (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0)
				|| a.name.localeCompare(b.name));
		const parent = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;
		res.json({ ok: true, path: resolved, entries, parent });
	} catch (err) {
		res.status(400).json({ ok: false, error: String(err) });
	}
});

app.get("/api/configs", async (_req, res) => {
	const items = await listConfigs();
	res.json({ active: state.activeConfig.name, items });
});

app.post("/api/configs/new", async (req, res) => {
	const name = sanitizeConfigName(req.body?.name || "default");
	state = createInitialState(name);
	await saveConfig(name);
	emitEvent("config", `Created new config ${name}`);
	res.json({ ok: true, state });
});

app.post("/api/configs/load", async (req, res) => {
	try {
		const name = sanitizeConfigName(req.body?.name || "default");
		state = await loadConfig(name);
		emitEvent("config", `Loaded config ${name}`);
		res.json({ ok: true, state });
	} catch {
		res.status(404).json({ ok: false, error: "Config not found" });
	}
});

app.post("/api/configs/save", async (req, res) => {
	const name = req.body?.name ? sanitizeConfigName(req.body.name) : state.activeConfig.name;
	await saveConfig(name);
	emitEvent("config", `Saved config ${name}`);
	res.json({ ok: true, state });
});

app.delete("/api/configs/:name", async (req, res) => {
	const name = sanitizeConfigName(req.params.name);
	if (name === state.activeConfig.name) {
		res.status(400).json({ ok: false, error: "Cannot delete active config" });
		return;
	}
	try {
		await fs.unlink(configFilePath(name));
		emitEvent("config", `Deleted config ${name}`);
		res.json({ ok: true });
	} catch {
		res.status(404).json({ ok: false, error: "Config not found" });
	}
});

app.post("/api/channels", (req, res) => {
	const name = String(req.body?.name || "NEW").trim();
	const color = String(req.body?.color || "#6c757d").trim();
	const nextId = req.body?.id ? String(req.body.id) : `ch${Object.keys(state.channels).length + 1}`;

	if (state.channels[nextId]) {
		res.status(400).json({ ok: false, error: "Channel id already exists" });
		return;
	}

	state.channels[nextId] = { id: nextId, name, color, type: "group" };
	Object.values(state.users).forEach((user) => {
		if (user.role === "admin" || user.role === "director") {
			if (!user.permissions.talkChannelIds.includes(nextId)) {
				user.permissions.talkChannelIds.push(nextId);
			}
			if (!user.permissions.listenChannelIds.includes(nextId)) {
				user.permissions.listenChannelIds.push(nextId);
			}
			if (!user.permissions.transcriptionChannelIds.includes(nextId)) {
				user.permissions.transcriptionChannelIds.push(nextId);
			}
			user.updatedAt = now();
		}
	});
	emitEvent("assign", `Channel ${name} (${nextId}) created`);
	res.json({ ok: true, state });
});

app.patch("/api/channels/:id", (req, res) => {
	const channel = state.channels[req.params.id];
	if (!channel) {
		res.status(404).json({ ok: false, error: "Channel not found" });
		return;
	}

	channel.name = req.body?.name ? String(req.body.name) : channel.name;
	channel.color = req.body?.color ? String(req.body.color) : channel.color;
	emitEvent("assign", `Channel ${channel.id} updated`);
	res.json({ ok: true, state });
});

app.delete("/api/channels/:id", (req, res) => {
	const channelId = req.params.id;
	if (!state.channels[channelId]) {
		res.status(404).json({ ok: false, error: "Channel not found" });
		return;
	}

	delete state.channels[channelId];
	Object.values(state.devices).forEach((device) => {
		device.channelIds = device.channelIds.filter((id) => id !== channelId);
		device.listenChannelIds = device.listenChannelIds.filter((id) => id !== channelId);
		device.transcriptionChannelIds = (device.transcriptionChannelIds || []).filter((id) => id !== channelId);
		dropRecognizer(device.id, channelId);
		if (device.talkChannelId === channelId) {
			device.talkChannelId = undefined;
		}
	});
	state.matrixRoutes = state.matrixRoutes.filter((route) => route.channelId !== channelId);
	Object.values(state.users).forEach((user) => {
		user.permissions.talkChannelIds = user.permissions.talkChannelIds.filter((id) => id !== channelId);
		user.permissions.listenChannelIds = user.permissions.listenChannelIds.filter((id) => id !== channelId);
		user.permissions.transcriptionChannelIds = user.permissions.transcriptionChannelIds.filter((id) => id !== channelId);
		user.updatedAt = now();
	});
	emitEvent("assign", `Channel ${channelId} deleted`);
	res.json({ ok: true, state });
});

// ─── Groups ──────────────────────────────────────────────────────────────────

app.get("/api/groups", (_req, res) => {
	res.json({ ok: true, groups: Object.values(state.groups) });
});

app.post("/api/groups", (req, res) => {
	const id = `grp-${randomUUID().slice(0, 8)}`;
	const name = String(req.body?.name || "New Group").trim();
	const color = String(req.body?.color || "#6c757d").trim();
	const group: IntercomGroup = {
		id,
		name,
		color,
		activeMemberUserIds: [],
		createdAt: now(),
		updatedAt: now(),
	};
	state.groups[id] = group;
	emitEvent("assign", `Group ${name} created`);
	broadcastState();
	res.status(201).json({ ok: true, group });
});

app.patch("/api/groups/:id", (req, res) => {
	const group = state.groups[req.params.id];
	if (!group) {
		res.status(404).json({ ok: false, error: "Group not found" });
		return;
	}
	if (req.body?.name) group.name = String(req.body.name);
	if (req.body?.color) group.color = String(req.body.color);
	group.updatedAt = now();
	emitEvent("assign", `Group ${group.name} updated`);
	broadcastState();
	res.json({ ok: true, group });
});

app.delete("/api/groups/:id", (req, res) => {
	const group = state.groups[req.params.id];
	if (!group) {
		res.status(404).json({ ok: false, error: "Group not found" });
		return;
	}
	delete state.groups[req.params.id];
	emitEvent("assign", `Group ${group.name} deleted`);
	broadcastState();
	res.status(204).end();
});

// ─── Profiles (User-Presets) ──────────────────────────────────────────────────

app.get("/api/profiles", (_req, res) => {
	res.json({ ok: true, profiles: Object.values(state.profiles) });
});

app.post("/api/profiles", (req, res) => {
	const id = `profile-${randomUUID().slice(0, 8)}`;
	const userId = String(req.body?.userId || "").trim();
	if (userId && !state.users[userId]) {
		res.status(404).json({ ok: false, error: "User not found" });
		return;
	}
	const profile: UserProfile = {
		id,
		userId,
		name: String(req.body?.name || "New Profile").trim(),
		slots: Array.isArray(req.body?.slots) ? req.body.slots : [],
		companionUrl: req.body?.companionUrl ? String(req.body.companionUrl) : undefined,
		createdAt: now(),
		updatedAt: now(),
	};
	state.profiles[id] = profile;
	emitEvent("config", `Profile ${profile.name} created`);
	broadcastState();
	res.status(201).json({ ok: true, profile });
});

app.patch("/api/profiles/:id", (req, res) => {
	const profile = state.profiles[req.params.id];
	if (!profile) {
		res.status(404).json({ ok: false, error: "Profile not found" });
		return;
	}
	if (req.body?.name) profile.name = String(req.body.name);
	if (req.body?.companionUrl !== undefined) profile.companionUrl = req.body.companionUrl ? String(req.body.companionUrl) : undefined;
	if (Array.isArray(req.body?.slots)) profile.slots = req.body.slots;
	profile.updatedAt = now();
	emitEvent("config", `Profile ${profile.name} updated`);
	broadcastState();
	res.json({ ok: true, profile });
});

app.delete("/api/profiles/:id", (req, res) => {
	const profile = state.profiles[req.params.id];
	if (!profile) {
		res.status(404).json({ ok: false, error: "Profile not found" });
		return;
	}
	delete state.profiles[req.params.id];
	emitEvent("config", `Profile ${profile.name} deleted`);
	broadcastState();
	res.status(204).end();
});

// ─── Sessions (read-only, managed by WS lifecycle) ────────────────────────────

app.get("/api/sessions", (_req, res) => {
	res.json({ ok: true, sessions: Object.values(state.sessions) });
});

// ─── Control Actions (Companion-kompatibel) ───────────────────────────────────

app.post("/api/control/action", (req, res) => {
	const action = req.body?.action as ControlAction | undefined;
	const deviceId = req.body?.deviceId ? String(req.body.deviceId) : undefined;
	const slotIndex = typeof req.body?.slotIndex === "number" ? req.body.slotIndex : undefined;

	if (!action) {
		res.status(400).json({ ok: false, error: "Missing action" });
		return;
	}

	const device = deviceId ? ensureDevice(deviceId) : undefined;

	switch (action) {
		case "ptt_start":
		case "ptt_stop": {
			if (!device) {
				res.status(404).json({ ok: false, error: "Device not found" });
				return;
			}
			const channelId = device.channelIds[slotIndex ?? 0];
			if (!channelId) {
				res.status(400).json({ ok: false, error: "No channel at slot index" });
				return;
			}
			if (action === "ptt_start") {
				device.talkChannelId = channelId;
				routeTalkEvent(device.id, channelId);
				scheduleTalkAutoRelease(device, channelId);
			} else {
				device.talkChannelId = undefined;
				routeTalkEvent(device.id, undefined);
				clearTalkAutoRelease(device.id);
			}
			broadcastState();
			break;
		}
		case "mute_input":
		case "mute_output":
		case "unmute_input":
		case "unmute_output":
		case "volume_up":
		case "volume_down": {
			if (!device) { res.status(404).json({ ok: false, error: "Device not found" }); return; }
			// Die Regel steht in `applyAudioControl` (@broadcast/shared), nicht
			// hier: Stummschalten merkt sich den Pegel, nochmal Stummschalten
			// holt ihn zurueck. Vorher war Stumm eine Einbahnstrasse — mitten
			// in einer Sendung nur ueber den Schieberegler in der
			// Weboberflaeche zu loesen.
			const vorgabe = defaultAudioSettings(device.transport);
			device.audio = applyAudioControl(device.audio || vorgabe, action, vorgabe.outputGainDb);
			broadcastState();
			break;
		}
		case "emergency_start":
		case "emergency_stop": {
			const active = action === "emergency_start";
			const emergencyChannel = state.channels[SYSTEM_CHANNEL_EMERGENCY];
			if (emergencyChannel) {
				emitEvent("system", `Emergency ${active ? "ACTIVATED" : "deactivated"}`);
				broadcast({ type: "state", payload: state });
			}
			broadcastState();
			break;
		}
		default:
			// Weitere Actions werden per WS weitergeleitet, z.B. direct_call_start
			broadcastState();
	}

	res.json({ ok: true, action, deviceId });
});

app.post("/api/devices", (req, res) => {
	const id = String(req.body?.id || "").trim();
	if (!id) {
		res.status(400).json({ ok: false, error: "Missing device id" });
		return;
	}
	if (state.devices[id]) {
		res.status(400).json({ ok: false, error: "Device already exists" });
		return;
	}

	const transport = (req.body?.transport || "ethernet") as TransportType;
	const requestedUserId = req.body?.userId ? String(req.body.userId) : undefined;
	const device: BeltpackDevice = {
		id,
		label: String(req.body?.label || id),
		role: (req.body?.role || "beltpack") as BeltpackDevice["role"],
		transport,
		userId: requestedUserId,
		channelIds: req.body?.channelIds || ["ch1"],
		listenChannelIds: req.body?.listenChannelIds || ["ch1"],
		transcriptionChannelIds: req.body?.transcriptionChannelIds || [],
		talkChannelId: undefined,
		battery: {
			percent: transport === "ethernet" ? 100 : 90,
			charging: transport === "ethernet",
			source: transport === "ethernet" ? "poe" : "battery",
		},
		network: { online: true, signal: transport === "dect" ? 80 : 100, ip: "0.0.0.0", latencyMs: 12 },
		audio: defaultAudioSettings(transport),
		connectedAntennaId: req.body?.connectedAntennaId,
		lastSeenAt: now(),
	};

	applyUserPermissions(device);

	state.devices[id] = device;
	assignDeviceToUser(id, device.userId);
	emitEvent("register", `Device ${device.label} added manually`);
	res.json({ ok: true, state });
});

// ─── Intercom-Plan aus dem AV-Planner (B-41.2) ────────────────────────────────
//
// Zwei Wege, und der erste ist nicht optional: `preview` sagt, was der Import
// taete, `apply` tut es. Ein Import schreibt Sprechberechtigungen in eine
// Anlage, an der gleich jemand arbeitet -- wer ihn ausloest, soll vorher lesen
// koennen, was sich bewegt. Dieselbe Aufteilung wie beim Tally-Weg der Suite,
// und aus demselben Grund.
//
// Der Koerper ist die Datei selbst (`plan`), als Objekt oder als Text. Beides,
// weil der Weg von Hand (Datei einlesen, Text schicken) und der Weg aus einem
// anderen Programm (JSON weiterreichen) sonst zwei Endpunkte braeuchten.

function leseGeplantenPlan(body: unknown): ReturnType<typeof readIntercomPlan> {
	const roh = (body as Record<string, unknown> | null)?.plan;
	if (typeof roh === "string") return readIntercomPlan(roh);
	if (roh && typeof roh === "object") return readIntercomPlan(JSON.stringify(roh));
	return { ok: false, error: PLAN_FEHLER };
}

const PLAN_FEHLER =
	"Kein gueltiger Intercom-Plan. Erwartet wird eine Datei im Format " +
	"'avplan-intercom' (Export aus dem Cable-Planner).";

// Der GRUND geht mit hinaus, statt in einem Satz fuer alles zu verschwinden.
// „Kein gueltiger Intercom-Plan" fuer eine Datei, die nur eine Version zu neu
// ist, schickt jemanden auf die falsche Suche.
app.post("/api/plan/preview", (req, res) => {
	const gelesen = leseGeplantenPlan(req.body);
	if (!gelesen.ok) {
		res.status(400).json({ ok: false, error: gelesen.error });
		return;
	}
	const plan = gelesen.file;
	res.json({ ok: true, diff: diffIntercomPlan(state, plan) });
});

app.post("/api/plan/apply", async (req, res) => {
	const gelesen = leseGeplantenPlan(req.body);
	if (!gelesen.ok) {
		res.status(400).json({ ok: false, error: gelesen.error });
		return;
	}
	const plan = gelesen.file;
	const ergebnis = applyIntercomPlan(state, plan, now());
	state = ergebnis.state;
	await saveConfig();
	emitEvent(
		"config",
		`Intercom-Plan "${plan.systemName || "ohne Namen"}" uebernommen: ` +
			`${ergebnis.diff.channels.added.length} Kanaele neu, ` +
			`${ergebnis.diff.users.added.length} Sprechstellen neu, ` +
			`${ergebnis.diff.users.updated.length} geaendert`,
	);
	broadcastState();
	res.json({ ok: true, diff: ergebnis.diff, state });
});

app.patch("/api/devices/:id", (req, res) => {
	const device = ensureDevice(req.params.id);
	if (!device) {
		res.status(404).json({ ok: false, error: "Device not found" });
		return;
	}

	device.label = req.body?.label ? String(req.body.label) : device.label;
	device.channelIds = req.body?.channelIds || device.channelIds;
	device.listenChannelIds = req.body?.listenChannelIds || device.listenChannelIds;
	device.transcriptionChannelIds = req.body?.transcriptionChannelIds || device.transcriptionChannelIds || [];
	if (typeof req.body?.userId === "string" || req.body?.userId === null) {
		device.userId = req.body?.userId || undefined;
	}
	if (req.body?.transport) {
		device.transport = req.body.transport;
	}
	applyUserPermissions(device);
	assignDeviceToUser(device.id, device.userId);
	emitEvent("assign", `Device ${device.id} updated`);
	res.json({ ok: true, state });
});

app.patch("/api/devices/:id/audio", (req, res) => {
	const device = ensureDevice(req.params.id);
	if (!device) {
		res.status(404).json({ ok: false, error: "Device not found" });
		return;
	}
	device.audio = {
		...device.audio,
		...req.body,
	};
	emitEvent("assign", `Audio settings updated for ${device.label}`);
	res.json({ ok: true, state });
});

function removeDevice(id: string): void {
	(state.devices[id].transcriptionChannelIds || []).forEach((channelId) => {
		dropRecognizer(id, channelId);
	});

	clearTalkAutoRelease(id);
	assignDeviceToUser(id, undefined);
	delete state.devices[id];
	state.matrixRoutes = state.matrixRoutes.filter((route) => route.fromDeviceId !== id && route.toDeviceId !== id);
	Object.values(state.antennas).forEach((antenna) => {
		antenna.connectedDeviceIds = antenna.connectedDeviceIds.filter((deviceId) => deviceId !== id);
	});
}

app.delete("/api/devices/:id", (req, res) => {
	const id = req.params.id;
	if (!state.devices[id]) {
		res.status(404).json({ ok: false, error: "Device not found" });
		return;
	}
	removeDevice(id);
	emitEvent("register", `Device ${id} removed`);
	res.json({ ok: true, state });
});

// Revoke a browser beltpack: removed now, refused on its next register until
// restored. Only for the device ids that come from the invite link; hardware
// beltpacks are removed, not revoked.
app.post("/api/devices/:id/revoke", (req, res) => {
	const id = req.params.id;
	if (!id.startsWith("web-")) {
		res.status(400).json({ ok: false, error: "Only browser beltpacks (web-…) can be revoked" });
		return;
	}
	const label = state.devices[id]?.label ?? id;
	if (state.devices[id]) removeDevice(id);
	state.revokedDeviceIds = [...new Set([...(state.revokedDeviceIds ?? []), id])];
	emitEvent("system", `Browser beltpack ${label} revoked`);
	res.json({ ok: true });
});

app.delete("/api/devices/:id/revoke", (req, res) => {
	const id = req.params.id;
	if (!state.revokedDeviceIds?.includes(id)) {
		res.status(404).json({ ok: false, error: "Device is not revoked" });
		return;
	}
	state.revokedDeviceIds = state.revokedDeviceIds.filter((d) => d !== id);
	emitEvent("system", `Browser beltpack ${id} restored`);
	res.json({ ok: true });
});

app.patch("/api/matrix", (req, res) => {
	const fromDeviceId = String(req.body?.fromDeviceId || "");
	const toDeviceId = String(req.body?.toDeviceId || "");
	const channelId = String(req.body?.channelId || "");
	const enabled = Boolean(req.body?.enabled);

	if (!fromDeviceId || !toDeviceId || !channelId) {
		res.status(400).json({ ok: false, error: "Missing matrix fields" });
		return;
	}

	upsertMatrixRoute({ fromDeviceId, toDeviceId, channelId, enabled });
	emitEvent("matrix", `Matrix ${fromDeviceId} -> ${toDeviceId} on ${channelId}: ${enabled ? "ON" : "OFF"}`);
	res.json({ ok: true, state });
});

wss.on("connection", (ws) => {
	const sessionId = randomUUID();
	const connectedAt = now();

	ws.send(JSON.stringify({ type: "state", payload: state } satisfies ServerMessage));

	ws.on("message", (raw) => {
		try {
			const parsed = JSON.parse(raw.toString()) as ClientMessage;
			// Track which device this connection represents and create/update session
			if (parsed.type === "register_device") {
				const deviceId = parsed.payload.id;
				wsDeviceMap.set(ws, deviceId);
				const device = state.devices[deviceId];
				const session: ClientSession = {
					id: sessionId,
					deviceId,
					userId: device?.userId,
					profileId: undefined,
					connectedAt,
					lastSeenAt: now(),
					activeSlotIds: [],
					isTalking: false,
				};
				state.sessions[sessionId] = session;
				broadcastState();
			} else if (parsed.type === "heartbeat") {
				const session = state.sessions[sessionId];
				if (session) {
					session.lastSeenAt = now();
					const device = state.devices[parsed.payload.id];
					session.userId = device?.userId;
					session.isTalking = Boolean(device?.talkChannelId);
				}
			}
			handleMessage(parsed);
		} catch {
			emitEvent("system", "Malformed WS message ignored");
		}
	});

	ws.on("close", () => {
		wsDeviceMap.delete(ws);
		delete state.sessions[sessionId];
		broadcastState();
	});
});

function startMockEnvironment(): void {
	handleMessage({
		type: "register_antenna",
		payload: { id: "ant-1", label: "DECT ANTENNA A", location: "Main Stage FOH" },
	});

	handleMessage({
		type: "register_device",
		payload: {
			id: "bp-dect-1",
			label: "BP Wireless 1",
			transport: "dect",
			channelIds: ["ch1", "ch2"],
			connectedAntennaId: "ant-1",
		},
	});

	handleMessage({
		type: "register_device",
		payload: {
			id: "bp-eth-1",
			label: "BP PoE 1",
			transport: "ethernet",
			channelIds: ["ch1", "ch3", "ch4"],
		},
	});

	handleMessage({
		type: "register_device",
		payload: {
			id: "bp-wifi-1",
			label: "BP Wifi Backup",
			transport: "wifi",
			channelIds: ["ch2", "ch4"],
		},
	});

	let tick = 0;
	setInterval(() => {
		tick += 1;
		const wirelessBattery = Math.max(20, 88 - tick);
		handleMessage({
			type: "heartbeat",
			payload: {
				id: "bp-dect-1",
				battery: {
					percent: wirelessBattery,
					charging: tick % 6 === 0,
					source: tick % 6 === 0 ? "usb-c" : "battery",
				},
				network: { online: true, signal: 65 + (tick % 20), latencyMs: 20 + (tick % 8) },
			},
		});

		handleMessage({
			type: "set_talk",
			payload: {
				id: tick % 2 === 0 ? "bp-dect-1" : "bp-eth-1",
				channelId: tick % 3 === 0 ? "ch2" : "ch1",
				active: true,
			},
		});

		if (tick % 3 === 0) {
			handleMessage({
				type: "set_talk",
				payload: {
					id: "bp-dect-1",
					channelId: "ch2",
					active: false,
				},
			});
		}
	}, 4000);
}

async function initializeState(): Promise<void> {
	await ensureConfigDir();
	const items = await listConfigs();
	if (items.length > 0) {
		try {
			state = await loadConfig(items[0].name);
		} catch (error) {
			// Weder Hauptdatei noch Sicherung lesbar. Der Kern startet
			// trotzdem: ein Intercom, das wegen einer kaputten Datei gar
			// nicht hochkommt, ist im Aufbau schlimmer als eines mit leerer
			// Konfiguration.
			//
			// Aber er SPEICHERT NICHT. Die kaputte Datei bleibt liegen, damit
			// sie jemand von Hand retten kann; ein automatisches Ueberschreiben
			// waere die zweite Haelfte desselben Datenverlusts. Geschrieben
			// wird erst wieder, wenn ein Mensch etwas aendert.
			state = createInitialState(items[0].name);
			emitEvent(
				"system",
				`Konfiguration "${items[0].name}" ist unlesbar (${describeError(error)}). ` +
					`Der Kern startet mit einer leeren Konfiguration; die Datei wurde NICHT ` +
					`ueberschrieben und kann von Hand geprueft werden.`,
			);
		}
	} else {
		state = createInitialState("default");
		await saveConfig("default");
	}

	const currentChannelIds = Object.keys(state.channels);
	if (Object.keys(state.users).length === 0) {
		state.users = createDefaultUsers(currentChannelIds);
	}

	const adminCount = Object.values(state.users).filter((user) => user.role === "admin").length;
	if (adminCount === 0) {
		const id = `user-admin-${Math.random().toString(36).slice(2, 6)}`;
		state.users[id] = {
			id,
			name: "Recovery Admin",
			role: "admin",
			color: "#0a9396",
			permissions: defaultUserPermissions("admin", currentChannelIds),
			callBehavior: defaultCallBehavior(),
			assignedDeviceIds: [],
			createdAt: now(),
			updatedAt: now(),
		};
	}

	Object.values(state.users).forEach((user) => {
		user.assignedDeviceIds = [];
		user.permissions.talkChannelIds = uniqueKnownChannels(user.permissions.talkChannelIds || []);
		user.permissions.listenChannelIds = uniqueKnownChannels(user.permissions.listenChannelIds || []);
		user.permissions.transcriptionChannelIds = uniqueKnownChannels(user.permissions.transcriptionChannelIds || []);
		user.callBehavior = sanitizeCallBehavior(user.callBehavior);
	});

	Object.values(state.devices).forEach((device) => {
		applyUserPermissions(device);
		assignDeviceToUser(device.id, device.userId);
	});

	const discovered = await findModelDirectory(MODEL_DIR);
	if (discovered && !existsSync(voskRuntime.modelPath)) {
		voskRuntime.modelPath = discovered;
	}

	if (process.env.VOSK_AUTO_DOWNLOAD === "1" && !existsSync(voskRuntime.modelPath)) {
		await installVoskModel(DEFAULT_MODEL_URL, false);
	}
}

initializeState()
	.then(async () => {
		if (MOCK_MODE && Object.keys(state.devices).length === 0) {
			startMockEnvironment();
		}
		emitEvent("system", `Intercom core running on :${PORT}${MOCK_MODE ? " (mock mode)" : ""}`);
		// Eagerly attempt to load Vosk so moduleLoaded reflects true state from the start
		loadVoskIfAvailable();
		// SPA-Fallback: eine GET-Anfrage, die weder API noch WS noch eine
		// vorhandene statische Datei ist, bekommt index.html. Muss NACH allen
		// /api-Routen registriert werden, sonst verschluckt sie diese — deshalb
		// erst hier, wenn das Modul vollstaendig ausgewertet ist. Nur aktiv, wenn
		// ein Web-Build vorliegt (Produktions-/Desktop-Fall).
		if (existsSync(WEB_DIST)) {
			app.use((req, res, next) => {
				if (req.method !== "GET" || req.path.startsWith("/api") || req.path === "/ws") {
					return next();
				}
				res.sendFile(path.join(WEB_DIST, "index.html"));
			});
		}
		// HTTPS zusaetzlich zu HTTP (#23). Der Klartext-Port bleibt: der
		// Desktop-Client laeuft ueber `localhost` und braucht kein TLS, und ein
		// Umschalten, das bestehende Aufbauten bricht, waere hier keine
		// Verbesserung.
		//
		// Beide Server bekommen denselben WebSocket-Aufsatz. Ohne das waere die
		// HTTPS-Seite eine Oberflaeche ohne Verbindung: die Seite laedt, das
		// Mikrofon geht, und kein Ton kommt an.
		let tlsHosts: string[] = [];
		let tlsNeu = false;
		if (TLS_AKTIV) {
			try {
				const tls = await zertifikatBesorgen(DATA_DIR, getLanHosts());
				tlsHosts = tls.hosts;
				tlsNeu = tls.neuErzeugt;
				const tlsServer = createTlsServer({ key: tls.key, cert: tls.cert }, app);
				wss.addListener("close", () => tlsServer.close());
				tlsServer.on("upgrade", (req, socket, head) => {
					const { url } = req;
					if (!url || !url.startsWith("/ws")) {
						socket.destroy();
						return;
					}
					wss.handleUpgrade(req, socket as never, head, (ws) => {
						wss.emit("connection", ws, req);
					});
				});
				tlsServer.listen(TLS_PORT);
			} catch (error) {
				// Kein Grund, den ganzen Kern nicht zu starten: ohne TLS laeuft
				// alles wie bisher, nur das Mikrofon bleibt auf fremden Geraeten
				// gesperrt. Das gehoert gesagt, nicht verschwiegen.
				console.error("TLS konnte nicht eingerichtet werden:", describeError(error));
				console.error("Der Kern laeuft weiter ueber HTTP — auf anderen Geraeten bleibt das Mikrofon gesperrt.");
			}
		}

		server.listen(PORT, () => {
			// DIE ADRESSE, DIE MAN WEITERSAGEN KANN.
			//
			// Hier stand nur `localhost`. Der Server bindet ohne Host-Angabe
			// alle Schnittstellen — er war also die ganze Zeit im Netz
			// erreichbar, und niemand erfuhr, unter welcher Adresse. Ein
			// Beltpack auf einem Handy im selben WLAN ist aber der
			// Normalfall dieser Anwendung und nicht die Ausnahme.
			console.log(`Intercom core on http://localhost:${PORT}`);
			// UND DIE ADRESSEN, DIE MAN WEITERSAGEN KANN.
			//
			// Hier stand nur `localhost`. Der Server bindet ohne Host-Angabe
			// alle Schnittstellen — er war also die ganze Zeit im Netz
			// erreichbar, und niemand erfuhr, unter welcher Adresse. Ein
			// Beltpack auf einem Handy im selben WLAN ist aber der Normalfall
			// dieser Anwendung, nicht die Ausnahme.
			//
			// `getLanHosts()` stand schon da und beantwortet genau diese
			// Frage; eine zweite Erkennung daneben waere die Defektform
			// `zwei-rechnungen` im Kleinen. Es werden ALLE gefundenen
			// Adressen genannt und nicht eine geraten: auf einem Rechner mit
			// Docker- oder VPN-Bruecke ist die erste oft die falsche, und wer
			// die Liste sieht, erkennt seine eigene.
			for (const host of getLanHosts()) {
				console.log(`               http://${host}:${PORT}  (im selben Netz)`);
			}

			// DIE ADRESSE, UNTER DER DAS MIKROFON GEHT.
			//
			// Sie steht bewusst UNTER der Klartext-Liste und mit einem Satz
			// dazu: wer die Adresse weitersagt, muss wissen, dass die
			// Zertifikatswarnung beim ersten Aufruf dazugehoert und kein
			// Fehler ist. Ohne diesen Satz klickt man sie weg und landet
			// wieder auf HTTP.
			if (TLS_AKTIV && tlsHosts.length > 0) {
				console.log("");
				console.log("Fuer Beltpacks auf Handy/Tablet — nur hier gibt der Browser das Mikrofon frei:");
				for (const host of getLanHosts()) {
					console.log(`               https://${host}:${TLS_PORT}`);
				}
				console.log("Beim ersten Aufruf warnt der Browser vor dem selbst ausgestellten");
				console.log("Zertifikat. Das ist erwartet: \"Erweitert\" -> \"Weiter zu ...\". Einmal je Geraet.");
				if (tlsNeu) {
					console.log(`(Zertifikat neu erzeugt in ${DATA_DIR}, gueltig fuer: ${tlsHosts.join(", ")})`);
				}
			}
		});
	})
	.catch((error) => {
		console.error("Failed to initialize state", error);
		process.exit(1);
	});
