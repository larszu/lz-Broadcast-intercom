// Electron-Main-Prozess der Desktop-Huelle.
//
// LZ Broadcast Intercom ist im Kern ein Server (Express + WS), gegen den sich
// Beltpacks und Telefon-Clients im LAN verbinden, plus ein Web-UI, das der
// Operator bedient. Die Desktop-App aendert daran NICHTS an der Architektur:
// dieser Main-Prozess startet denselben Kern (gebuendelt als `server.cjs`) als
// Kindprozess und oeffnet ein Fenster, das die vom Kern ausgelieferte UI unter
// http://localhost:<port> laedt. Die UI baut alle URLs aus location.origin,
// deshalb MUSS sie ueber HTTP von derselben Origin wie die API kommen — ein
// `file://`-Fenster wuerde /api und /ws ins Leere laufen lassen. Andere Geraete
// im selben Netz erreichen denselben Kern weiterhin ueber die LAN-Adresse.
import { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// userData leitet Electron aus dem productName ab. Seit der Umbenennung in
// „LZ Broadcast Intercom" zeigt es sonst auf einen leeren Ordner: Konfigurationen,
// Modelle und das Bibliotheks-Token blieben im alten zurueck. Muss vor jedem
// getPath("userData") stehen.
if (app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Broadcast Intercom"));

const PORT = Number(process.env.PORT || 4001);
const STARTUP_URL = `http://localhost:${PORT}`;
const READY_URL = `${STARTUP_URL}/api/state`;

// Pfade unterscheiden sich zwischen "unverpackt gestartet" (electron .) und
// dem gepackten Build. Im gepackten Build liegen `server.cjs` und das Web-UI
// als extraResources neben dem asar (process.resourcesPath), weil ein
// Kindprozess nicht aus dem read-only asar geforkt werden kann und das UI
// beschreibbar/lesbar auf der Platte liegen muss.
const serverEntry = app.isPackaged
	? path.join(process.resourcesPath, "server.cjs")
	: path.join(__dirname, "server.cjs");
const webDist = app.isPackaged
	? path.join(process.resourcesPath, "web")
	: path.join(__dirname, "..", "..", "web", "dist");
// Beschreibbares Datenverzeichnis. Das gepackte asar ist read-only, also
// gehoeren configs/ und models/ in den userData-Pfad des Betriebssystems.
const dataDir = path.join(app.getPath("userData"), "data");

// Token der Geraetebibliothek (devices.zumpelars.de). Liegt nur
// verschluesselt auf der Platte — `safeStorage` nimmt Schluesselbund bzw.
// DPAPI. Bietet das System keine Verschluesselung an (Linux ohne
// Schluesselring), wird NICHTS geschrieben: die Anmeldung haelt dann bis zum
// Schliessen der App. Ein Klartext-Token auf der Platte waere schlimmer als
// eine erneute Anmeldung. Nie geloggt.
const tokenFile = path.join(app.getPath("userData"), "device-library-token.bin");

// Nur das eigene Fenster darf fragen: es laedt die UI des Kerns von localhost.
const vomFenster = (e: Electron.IpcMainInvokeEvent) => {
	try {
		return new URL(e.senderFrame?.url ?? "").origin === new URL(STARTUP_URL).origin;
	} catch {
		return false;
	}
};

ipcMain.handle("device-library-token:get", (e) => {
	if (!vomFenster(e) || !existsSync(tokenFile) || !safeStorage.isEncryptionAvailable()) return null;
	try {
		return safeStorage.decryptString(readFileSync(tokenFile));
	} catch {
		return null;
	}
});
ipcMain.handle("device-library-token:set", (e, token: unknown) => {
	if (!vomFenster(e) || typeof token !== "string" || !safeStorage.isEncryptionAvailable()) return false;
	writeFileSync(tokenFile, safeStorage.encryptString(token), { mode: 0o600 });
	return true;
});
ipcMain.handle("device-library-token:clear", (e) => {
	if (vomFenster(e)) rmSync(tokenFile, { force: true });
});

let serverProc: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function startServer(): void {
	if (!existsSync(serverEntry)) {
		throw new Error(`Server-Bundle nicht gefunden: ${serverEntry} — wurde "npm run build" ausgefuehrt?`);
	}
	// utilityProcess ist Electrons empfohlener Weg, Node-Code als Kindprozess zu
	// fahren: er laeuft in einem echten Node-Kontext (nicht im Renderer) und
	// wird beim App-Ende sauber mitbeendet.
	serverProc = utilityProcess.fork(serverEntry, [], {
		stdio: "inherit",
		env: {
			...process.env,
			PORT: String(PORT),
			INTERCOM_DATA_DIR: dataDir,
			WEB_DIST: webDist,
			NODE_ENV: "production",
		},
	});
	serverProc.on("exit", (code) => {
		serverProc = null;
		// Stirbt der Kern, ist das Fenster nutzlos — die App beenden statt eine
		// leere Seite stehen zu lassen.
		if (code !== 0 && !app.isPackaged) {
			console.error(`Intercom-Kern beendet mit Code ${code}`);
		}
		if (mainWindow && !mainWindow.isDestroyed()) {
			app.quit();
		}
	});
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	// Erst warten, wenn der Kern die API bedient — sonst laedt das Fenster ins
	// Leere und der Nutzer sieht einen Verbindungsfehler statt der UI.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return;
		} catch {
			// noch nicht bereit
		}
		if (Date.now() > deadline) {
			throw new Error(`Intercom-Kern wurde unter ${url} nicht bereit (${timeoutMs} ms).`);
		}
		await new Promise((r) => setTimeout(r, 300));
	}
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		backgroundColor: "#0b0f14",
		title: "LZ Broadcast Intercom",
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});
	// Links mit target=_blank (z. B. "Open Web Client") im System-Browser oeffnen,
	// nicht in einem randlosen Electron-Fenster.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});
	mainWindow.loadURL(STARTUP_URL);
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

app.whenReady().then(async () => {
	startServer();
	try {
		await waitForServer(READY_URL, 30000);
	} catch (error) {
		console.error(error);
	}
	createWindow();

	app.on("activate", () => {
		// macOS: Klick aufs Dock-Icon ohne offene Fenster oeffnet wieder eines.
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	// Auf allen Plattformen beenden — der Kern soll nicht ohne Fenster
	// weiterlaufen (er haelt sonst den Port und laeuft im Hintergrund weiter).
	app.quit();
});

// #40: Ein Renderer lief nach dem App-Ende 16 Tage mit ~580 % CPU weiter.
// Abgaenge von Renderer und Hilfsprozessen protokollieren, damit sich so ein
// Zustand im Log wiederfindet.
app.on("render-process-gone", (_e, _wc, details) => {
	console.error(`Renderer beendet: ${details.reason} (Code ${details.exitCode})`);
});
app.on("child-process-gone", (_e, details) => {
	console.error(`Hilfsprozess ${details.type} beendet: ${details.reason} (Code ${details.exitCode})`);
});

// Lebenszeichen fuer den Waechter im Preload: bleibt die Antwort aus, ist der
// Hauptprozess weg und der Renderer beendet sich selbst.
ipcMain.handle("desktop:ping", () => true);

app.on("before-quit", () => {
	// Fenster hart beenden, statt auf einen Renderer zu warten, der in einer
	// heissen Schleife (Audio-Kette, rAF) das Ende verpassen koennte (#40).
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.destroy();
	}
	if (serverProc) {
		serverProc.kill();
		serverProc = null;
	}
});
