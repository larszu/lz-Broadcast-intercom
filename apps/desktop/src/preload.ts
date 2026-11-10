// Preload der Desktop-Huelle. Reicht dem Fenster genau eine Faehigkeit
// hinueber: das Token der Geraetebibliothek lesen, schreiben, loeschen. Das
// Token selbst verschluesselt der Main-Prozess mit `safeStorage`; das Fenster
// sieht nie mehr als den Klartext, den es ohnehin gerade braucht.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("intercomDesktop", {
	deviceLibraryToken: {
		get: (): Promise<string | null> => ipcRenderer.invoke("device-library-token:get"),
		set: (token: string): Promise<boolean> => ipcRenderer.invoke("device-library-token:set", token),
		clear: (): Promise<void> => ipcRenderer.invoke("device-library-token:clear"),
	},
});

// Waechter (#40): Ein Renderer, dessen Hauptprozess verschwunden ist (Absturz,
// kill -9), soll sich nicht tagelang weiterdrehen. Alle 5 s ein Ping an den
// Hauptprozess; bleiben drei Antworten in Folge aus, beendet sich der Renderer
// selbst. `process.crash()` steht auch im Sandbox-Preload zur Verfuegung.
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 4000;
const MAX_MISSED = 3;
let missed = 0;
setInterval(() => {
	const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), PING_TIMEOUT_MS));
	Promise.race([ipcRenderer.invoke("desktop:ping").then(() => true, () => false), timeout]).then((ok) => {
		missed = ok ? 0 : missed + 1;
		if (missed >= MAX_MISSED) process.crash();
	});
}, PING_INTERVAL_MS);
