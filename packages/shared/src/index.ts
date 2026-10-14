export type TransportType = "ethernet" | "dect" | "wifi";
export type DeviceRole = "beltpack" | "deskstation";
export type UserRole = "admin" | "director" | "operator" | "talent";

/**
 * Channel types — Green-GO inspired:
 *   "group"        – Partyline / Ringleitung: alle Teilnehmer sprechen gleichzeitig
 *   "direct"       – Private 1:1-Leitung zu einem anderen User
 *   "announcement" – Systemkanal: immer passiv verfügbar, nur empfangen
 *   "emergency"    – Systemkanal: immer passiv verfügbar, Priorität über alle anderen
 *   "program"      – Systemkanal: Program Audio, nur empfangen
 */
export type ChannelType = "group" | "direct" | "announcement" | "emergency" | "program";

/** Die 3 fest reservierten System-Kanal-IDs */
export const SYSTEM_CHANNEL_ANNOUNCEMENT = "__sys_announcement__";
export const SYSTEM_CHANNEL_EMERGENCY    = "__sys_emergency__";
export const SYSTEM_CHANNEL_PROGRAM      = "__sys_program__";

export interface BatteryState {
  percent: number;
  charging: boolean;
  source: "usb-c" | "battery" | "poe";
}

export interface NetworkState {
  online: boolean;
  signal?: number;
  ip?: string;
  latencyMs?: number;
}

export interface AudioSettings {
  inputGainDb: number;
  outputGainDb: number;
  sidetonePercent: number;
  noiseGateDb: number;
  limiterEnabled: boolean;
  /**
   * Der Pegel VOR dem Stummschalten, damit „wieder laut" ihn zurueckholen
   * kann. Fehlt, solange nicht stumm geschaltet ist — ein Feld, das in jedem
   * Datensatz steht und nichts bedeutet, waere Ballast.
   */
  preMuteInputGainDb?: number;
  preMuteOutputGainDb?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Lautstaerke und Stumm — eine Stelle, und ein Weg zurueck.
//
// BEFUND (Defektformen-Sweep, Form `fixture-erreicht-grenze-nicht`, gemessen
// 2026-09-08). Der Kern kannte `mute_input`, `mute_output`, `volume_up` und
// `volume_down`, und der Smoke-Test — 58 Pruefungen — beruehrt keine davon.
// Die Grenze, an der sie sich treffen, ist deshalb nie erreicht worden, und
// dort steckten zwei Fehler:
//
//   1. STUMM WAR EINE EINBAHNSTRASSE. `mute_input` setzte `inputGainDb = -60`
//      und das war alles. Ein Zurueck gab es NICHT: kein `unmute`, und fuer
//      den Eingang auch kein `volume_up`. Wer auf seiner Companion-Taste das
//      eigene Mikrofon stumm schaltet, bekommt es nur ueber die Weboberflaeche
//      und den Schieberegler zurueck — mitten in einer Sendung.
//
//   2. -60 dB HIESS ZWEIERLEI. Es ist der Stumm-Wert UND das untere Ende des
//      Lautstaerkebereichs. Wer `volume_down` oft genug drueckt, landet auf
//      exakt -60 und ist damit „stumm"; wer danach `volume_up` drueckt,
//      landet auf -57 dB — hoerbar, aber fast aus — statt dort, wo er
//      vorher war.
//
// Die Regel ist jetzt in einem Satz sagbar, und sie steht an EINER Stelle:
// Stummschalten merkt sich den Pegel, nochmal Stummschalten holt ihn zurueck,
// und jede ausdrueckliche Lautstaerkeaenderung vergisst ihn wieder — dann hat
// der Bediener uebernommen.
// ───────────────────────────────────────────────────────────────────────────

/** Unteres und oberes Ende des Ausgangspegels (dB). */
export const AUDIO_GAIN_MIN_DB = -60;
export const AUDIO_GAIN_MAX_DB = 12;
/** Schrittweite einer Companion-Taste. */
export const AUDIO_GAIN_STEP_DB = 3;

export type AudioControlAction =
  | 'mute_input'
  | 'mute_output'
  | 'unmute_input'
  | 'unmute_output'
  | 'volume_up'
  | 'volume_down';

export const AUDIO_CONTROL_ACTIONS: readonly AudioControlAction[] = [
  'mute_input', 'mute_output', 'unmute_input', 'unmute_output',
  'volume_up', 'volume_down',
] as const;

export const isAudioControlAction = (a: string): a is AudioControlAction =>
  (AUDIO_CONTROL_ACTIONS as readonly string[]).includes(a);

const klemme = (db: number): number =>
  Math.max(AUDIO_GAIN_MIN_DB, Math.min(AUDIO_GAIN_MAX_DB, db));

/**
 * Eine Lautstaerke-/Stumm-Aktion auf die Audio-Einstellungen anwenden.
 *
 * Rein: gibt neue Einstellungen zurueck, aendert nichts. `fallbackDb` ist der
 * Pegel, auf den „wieder laut" faellt, wenn nichts gemerkt wurde (der Vorgabe-
 * Pegel des Transports).
 *
 * `mute_*` ist ein UMSCHALTER: dieselbe Companion-Taste macht stumm und wieder
 * laut. Genau das erwartet jemand von einer Taste mit „Mute" darauf.
 */
export function applyAudioControl(
  audio: AudioSettings,
  action: AudioControlAction,
  fallbackDb = 0,
): AudioSettings {
  const stumm = (feld: 'input' | 'output'): AudioSettings => {
    const gain = feld === 'input' ? 'inputGainDb' : 'outputGainDb';
    const merker = feld === 'input' ? 'preMuteInputGainDb' : 'preMuteOutputGainDb';
    // Kein „schon stumm?"-Vorbehalt: `stumm` wird nur aufgerufen, wenn es
    // NICHT stumm ist — der Umschalter unten entscheidet das. Eine Zeile, die
    // nichts tut, aber aussieht, als hielte sie eine Zusicherung, ist
    // schlimmer als keine; die Gegenprobe hat sie als unerreichbar entlarvt.
    return { ...audio, [merker]: audio[gain], [gain]: AUDIO_GAIN_MIN_DB };
  };
  const laut = (feld: 'input' | 'output'): AudioSettings => {
    const gain = feld === 'input' ? 'inputGainDb' : 'outputGainDb';
    const merker = feld === 'input' ? 'preMuteInputGainDb' : 'preMuteOutputGainDb';
    const zurueck = audio[merker];
    const next = { ...audio, [gain]: klemme(typeof zurueck === 'number' ? zurueck : fallbackDb) };
    delete next[merker];
    return next;
  };
  const istStumm = (feld: 'input' | 'output') =>
    audio[feld === 'input' ? 'inputGainDb' : 'outputGainDb'] <= AUDIO_GAIN_MIN_DB;

  switch (action) {
    case 'mute_input':
      return istStumm('input') ? laut('input') : stumm('input');
    case 'mute_output':
      return istStumm('output') ? laut('output') : stumm('output');
    case 'unmute_input':
      return laut('input');
    case 'unmute_output':
      return laut('output');
    case 'volume_up':
    case 'volume_down': {
      // Eine ausdrueckliche Aenderung vergisst den Merker: ab hier bestimmt
      // der Bediener den Pegel, nicht mehr das, was vor dem Stummschalten war.
      const delta = action === 'volume_up' ? AUDIO_GAIN_STEP_DB : -AUDIO_GAIN_STEP_DB;
      const next = { ...audio, outputGainDb: klemme(audio.outputGainDb + delta) };
      delete next.preMuteOutputGainDb;
      return next;
    }
  }
}

export interface UserPermissions {
  talkChannelIds: string[];
  listenChannelIds: string[];
  transcriptionChannelIds: string[];
  canAllCall: boolean;
  canManageDevices: boolean;
}

/**
 * Wie eine Talk-Taste sich verhält (Green-GO "ReplyMode"):
 *   "ptt"       – Momentary: sprechen nur solange gedrückt/gehalten
 *   "latch"     – Rastend: einmal antippen an, erneut antippen aus
 *   "handsfree" – Dauersprechen (offenes Mikro), bis manuell beendet
 */
export type ReplyMode = "ptt" | "latch" | "handsfree";

/**
 * Wann ein eingehender Ruf/Talk automatisch als Popup angezeigt wird
 * (Green-GO "PopupMode"):
 *   "off"  – nie automatisch aufpoppen
 *   "call" – nur bei Direktrufen aufpoppen
 *   "talk" – nur bei aktivem Talk auf einem gehörten Kanal aufpoppen
 *   "all"  – bei Rufen und Talk aufpoppen
 */
export type PopupMode = "off" | "call" | "talk" | "all";

/**
 * Advanced Call Behavior — pro User konfigurierbares Ruf-/Talk-Verhalten,
 * abgeleitet aus dem Green-GO gg5 `Settings`-Block einer Station.
 * Wird im State gehalten, propagiert an alle Clients des Users und in der
 * Config persistiert.
 */
export interface CallBehaviorSettings {
  /** Talk-Tasten-Verhalten (momentary/rastend/handsfree). */
  replyMode: ReplyMode;
  /**
   * Wie stark andere Kanäle abgesenkt werden, während ein Prioritäts-/
   * Notfall-Talk aktiv ist, in dB (<= 0). Green-GO "PriorityDim".
   */
  priorityDimDb: number;
  /**
   * Isolate/Solo: nur der aktuell gewählte Kanal wird gehört, alle anderen
   * werden stummgeschaltet. Green-GO "Isolate".
   */
  isolate: boolean;
  /**
   * Wie lange eine Ruf-/Cue-Anzeige stehen bleibt, in Sekunden.
   * Green-GO "CueTimeout".
   */
  cueTimeoutSec: number;
  /** Popup-Verhalten bei eingehenden Rufen/Talk. Green-GO "PopupMode". */
  popupMode: PopupMode;
  /** Ob bei eingehendem Ruf ein Alarmton abgespielt wird. Green-GO "AlertTone". */
  alertTone: boolean;
  /** Pegel des Alarm-/Ruftons in dB (<= 0). Green-GO "ToneLevel". */
  toneLevelDb: number;
  /**
   * Automatische Freigabe eines rastenden Talks nach N Sekunden
   * (0 = nie automatisch freigeben). Green-GO "ActiveTime".
   */
  activeTimeSec: number;
}

/** Standard-Werte für Advanced Call Behavior (an Green-GO-Defaults angelehnt). */
export const defaultCallBehavior = (): CallBehaviorSettings => ({
  replyMode: "ptt",
  priorityDimDb: -6,
  isolate: false,
  cueTimeoutSec: 3,
  popupMode: "call",
  alertTone: false,
  toneLevelDb: -12,
  activeTimeSec: 0,
});

export interface IntercomUser {
  id: string;
  name: string;
  role: UserRole;
  color: string;
  permissions: UserPermissions;
  /** Advanced Call Behavior (Ruf-/Talk-Verhalten), siehe CallBehaviorSettings. */
  callBehavior: CallBehaviorSettings;
  assignedDeviceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BeltpackDevice {
  id: string;
  label: string;
  role: DeviceRole;
  transport: TransportType;
  userId?: string;
  channelIds: string[];
  talkChannelId?: string;
  listenChannelIds: string[];
  transcriptionChannelIds?: string[];
  battery: BatteryState;
  network: NetworkState;
  audio: AudioSettings;
  connectedAntennaId?: string;
  lastSeenAt: number;
}

export interface DectAntenna {
  id: string;
  label: string;
  location: string;
  online: boolean;
  connectedDeviceIds: string[];
  lastSeenAt: number;
}

export interface Channel {
  id: string;
  name: string;
  color: string;
  /** Kanaltyp — bestimmt das Routing-Verhalten */
  type: ChannelType;
  /**
   * Nur relevant wenn type="direct": ID des Ziel-Users.
   * Routing-Regel: Nur Geräte, die mit diesem User verknüpft sind, nehmen an der
   * Kommunikation teil. Falls der Empfänger den Sender nicht konfiguriert hat,
   * wird ein temporärer Kanal geöffnet (siehe TemporaryChannel).
   */
  targetUserId?: string;
  /**
   * Nur relevant wenn type="group": IDs der User in dieser Gruppe.
   * User werden NICHT der Gruppe zugeordnet — stattdessen legt jeder User
   * die Gruppe auf einem seiner Kanäle ab (groupId im Channel-Slot).
   */
  memberUserIds?: string[];
}

/**
 * Eine Gruppe (Partyline / Ringleitung).
 * User werden nicht der Gruppe zugeordnet — jeder User legt die Gruppe
 * eigenständig auf einem seiner Kanäle ab.
 */
export interface IntercomGroup {
  id: string;
  name: string;
  color: string;
  /** Welche User sind aktuell auf dieser Gruppe aktiv (dynamisch, nicht konfiguriert) */
  activeMemberUserIds: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Temporärer Kanal — wird automatisch geöffnet wenn ein User einen Direktruf
 * einleitet und der Empfänger den Sender nicht in seiner Konfiguration hat.
 * Wird nach Ende des Gesprächs wieder geschlossen.
 */
export interface TemporaryChannel {
  id: string;
  /** User der den Ruf initiiert hat */
  callerUserId: string;
  /** User der den temporären Kanal angezeigt bekommt */
  receiverUserId: string;
  /** Wann der Kanal geöffnet wurde */
  openedAt: number;
  /** Läuft noch? */
  active: boolean;
}

export interface EventItem {
  id: string;
  ts: number;
  type: "register" | "heartbeat" | "talk" | "listen" | "assign" | "matrix" | "config" | "system" | "call" | "transcript" | "bookmark";
  message: string;
}

export interface MatrixRoute {
  fromDeviceId: string;
  toDeviceId: string;
  channelId: string;
  enabled: boolean;
}

export interface ConfigRef {
  name: string;
  updatedAt: number;
}

export interface PluginBridgeConfig {
  enabled: boolean;
  protocol: "ws" | "http";
  host: string;
  pluginPaths: string[];
  preset?: string;
  bypass: boolean;
}

/**
 * Ziel-Objekt eines Kanal-Slots: Gruppe, Direktruf zu User oder Systemkanal
 */
export type ChannelSlotTarget =
  | { type: "group"; groupId: string }
  | { type: "direct"; userId: string }
  | { type: "system"; channelId: string };

/**
 * Ein Slot auf einem Beltpack / User-Profil.
 * Entspricht einem der konfigurierbaren Kanal-Slots auf dem Gerät.
 */
export interface ChannelSlot {
  /** 0-basierter Index (0 = erster Slot) */
  index: number;
  /** Was auf diesem Slot liegt — fehlt = unbelegt */
  target?: ChannelSlotTarget;
}

/**
 * User-Profil mit Kanal-Slots — entspricht einem "Preset" in Eyevinn-Terminologie.
 * Definiert welche Gruppen / Systemkanäle / Direktruf-Targets einem User zugewiesen sind.
 */
export interface UserProfile {
  id: string;
  userId: string;
  name: string;
  /** Slot-Konfiguration (typischerweise 8 Slots, 0-basiert) */
  slots: ChannelSlot[];
  /** Optionale Companion-Control-URL für dieses Profil */
  companionUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Aktive Client-Session — entspricht einer "UserSession" in Eyevinn-Terminologie.
 * Wird beim WebSocket-Connect erzeugt und beim Disconnect entfernt.
 */
export interface ClientSession {
  id: string;
  deviceId: string;
  userId?: string;
  profileId?: string;
  connectedAt: number;
  lastSeenAt: number;
  /** Aktiv sprechende / hörende Slot-Indizes */
  activeSlotIds: string[];
  isTalking: boolean;
}

/**
 * Control-Aktionen für den Companion-kompatiblen Control-Endpoint.
 * Ermöglicht externe Steuerung (StreamDeck, Companion, etc.)
 */
export type ControlAction =
  | "ptt_start"
  | "ptt_stop"
  | "mute_input"
  | "mute_output"
  // Der Weg zurueck. `mute_*` ist zwar ein Umschalter (eine Companion-Taste
  // soll beides koennen), aber ein Aufrufer, der den Zustand KENNT, soll ihn
  // nicht erraten muessen.
  | "unmute_input"
  | "unmute_output"
  | "set_selected_slot"
  | "volume_up"
  | "volume_down"
  | "direct_call_start"
  | "direct_call_end"
  | "emergency_start"
  | "emergency_stop";

/**
 * What a keyword rule does when it hears its word. Deliberately no MIDI (needs
 * a native module on every host) and no local shell command (a transcript
 * line would decide what runs on the core machine).
 */
export type KeywordAction =
  | { kind: "webhook"; url: string }
  | { kind: "osc"; host: string; port: number; address: string };

/** A word or phrase in a transcript line triggers an action. */
export interface KeywordRule {
  id: string;
  /** Matched as a whole word or phrase, case-insensitive. */
  keyword: string;
  /** Only lines from this channel; empty = every channel. */
  channelId?: string;
  enabled: boolean;
  action: KeywordAction;
}

/** Every final transcript line of the chosen channels goes out as an OSC caption. */
export interface CaptionFeed {
  enabled: boolean;
  host: string;
  port: number;
  /** Default `/lzvm/caption` (LZ Vision Mixer). */
  address: string;
  /** Empty = every channel. */
  channelIds: string[];
  /** Sends "Speaker: text" instead of the bare text. */
  includeSpeaker: boolean;
  /** Optional int argument after the text (the mixer's graphics layer). */
  layer?: number;
}

export interface CoreState {
  activeConfig: ConfigRef;
  users: Record<string, IntercomUser>;
  devices: Record<string, BeltpackDevice>;
  antennas: Record<string, DectAntenna>;
  /** Alle konfigurierten Kanäle inkl. der 3 Systemkanäle */
  channels: Record<string, Channel>;
  /** Alle konfigurierten Gruppen */
  groups: Record<string, IntercomGroup>;
  /** Aktive temporäre Kanäle (Direktrufe ohne Konfiguration beim Empfänger) */
  temporaryChannels: TemporaryChannel[];
  /** User-Profile / Presets */
  profiles: Record<string, UserProfile>;
  /** Aktive WebSocket-Client-Sessions */
  sessions: Record<string, ClientSession>;
  matrixRoutes: MatrixRoute[];
  pluginBridge: PluginBridgeConfig;
  /** Keyword rules on transcript lines (optional: older configs lack it). */
  keywordRules?: KeywordRule[];
  /** Live caption feed (optional: older configs lack it). */
  captionFeed?: CaptionFeed;
  /**
   * Browser beltpacks the admin has revoked: they may not register again
   * until restored. An operator control, not access control — the core has
   * no authentication, and a phone that forgets its id comes back as new.
   */
  revokedDeviceIds?: string[];
  /** Gerätepräsenz (online/offline) — dynamisch, nicht in Config gespeichert */
  presence?: Record<string, { online: boolean; lastSeenAt: number }>;
  events: EventItem[];
}

export type ClientMessage =
  | {
      type: "register_device";
      payload: {
        id: string;
        label: string;
        transport: TransportType;
        role?: DeviceRole;
        userId?: string;
        channelIds?: string[];
        connectedAntennaId?: string;
      };
    }
  | {
      type: "register_antenna";
      payload: {
        id: string;
        label: string;
        location: string;
      };
    }
  | {
      type: "heartbeat";
      payload: {
        id: string;
        battery?: Partial<BatteryState>;
        network?: Partial<NetworkState>;
      };
    }
  | {
      type: "set_talk";
      payload: {
        id: string;
        channelId: string;
        active: boolean;
      };
    }
  | {
      type: "set_listen";
      payload: {
        id: string;
        channelIds: string[];
      };
    }
  | {
      type: "assign_channels";
      payload: {
        id: string;
        channelIds: string[];
      };
    }
  | {
      type: "set_transcription_channels";
      payload: {
        id: string;
        channelIds: string[];
      };
    }
  | {
      type: "transcribe_audio";
      payload: {
        id: string;
        channelId: string;
        sampleRate: number;
        audio: string;
      };
    }
  | {
      type: "set_user";
      payload: {
        id: string;
        userId?: string;
      };
    }
  /** Direktruf: initiiert einen temporären Kanal beim Empfänger */
  | {
      type: "direct_call";
      payload: {
        fromDeviceId: string;
        toUserId: string;
      };
    }
  /** Direktruf beenden */
  | {
      type: "direct_call_end";
      payload: {
        tempChannelId: string;
      };
    };

export type ServerMessage =
  | { type: "state"; payload: CoreState }
  | { type: "event"; payload: EventItem }
  | {
      type: "audio_chunk";
      payload: {
        fromDeviceId: string;
        channelId: string;
        sampleRate: number;
        audio: string; // base64 Int16 PCM
      };
    }
  /** Server teilt einem Gerät mit, dass ein temporärer Direktruf-Kanal geöffnet wurde */
  | {
      type: "temp_channel_opened";
      payload: TemporaryChannel;
    }
  /** Server teilt einem Gerät mit, dass ein temporärer Direktruf-Kanal geschlossen wurde */
  | {
      type: "temp_channel_closed";
      payload: { tempChannelId: string };
    };


// ═══════════════════════════════════════════════════════════════════════════
// Den Intercom-Plan aus dem AV-Planner einlesen (B-41.2).
//
// WARUM DAS IN DIESER DATEI STEHT UND NICHT DANEBEN. Es gehoerte in ein
// eigenes Modul, und es lag auch dort -- bis gemessen wurde, was dabei
// passiert: dieses Paket wird zur LAUFZEIT als TypeScript-Quelle geladen
// (`main: src/index.ts`, Node streift die Typen ab). Ein relativer Import
// zwischen zwei Dateien des Pakets braucht dann eine Endung, die Node
// aufloest, und keine der drei Formen geht durch:
//
//   `./planImport`      Node loest im ESM-Modus keine Extensionen auf --
//                       der Kern startete in CI gar nicht.
//   `./planImport.js`   Node sucht die Datei woertlich; es gibt keine.
//   `./planImport.ts`   Node kann es, aber `apps/server` und `apps/web`
//                       pruefen die Quellen dieses Pakets mit und lehnen die
//                       Endung ab (TS5097). `allowImportingTsExtensions`
//                       verlangt `noEmit` -- und der Server emittiert.
//
// Eine Datei mehr haette also den Build-Vertrag des Pakets geaendert, fuer
// eine Kosmetik. Der Abschnitt bleibt deshalb hier, deutlich abgesetzt.
// ═══════════════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────────────
// Den Intercom-Plan aus dem AV-Planner einlesen (B-41.2).
//
// WORUM ES GEHT. Der `cable-planner` exportiert seit `cable#684` ein
// herstellerneutrales Intercom-Format (`avplan-intercom`): welche Konferenzen
// es gibt, welche Sprechstellen daran haengen, und je Zugehoerigkeit getrennt,
// ob die Stelle spricht oder nur mithoert. Gelesen hat das bisher niemand. Wer
// die Anlage geplant hat, tippte die Konferenzen hier ein zweites Mal ab —
// also genau die Doppelerfassung, gegen die das Format geschrieben wurde.
//
// WARUM DAS ZUSAMMENFUEHREN UND NICHT ERSETZEN. Der Plan kennt Rollen und
// Konferenzen. Diese Anlage kennt zusaetzlich Geraete, Antennen, Zuordnungen
// und laufende Sitzungen — nichts davon kann ein Plan wiederherstellen. Ein
// Import, der den Zustand ersetzt, wuerfe das weg. Deshalb:
//
//   * Zusammengefuehrt wird ueber den NAMEN, nicht ueber die Id aus der Datei.
//     `ch-3` bedeutet auf dieser Anlage nichts; „PGM" bedeutet etwas, weil es
//     das ist, was in der Regie gesagt wird. Ueber die Datei-Id zu gehen
//     hiesse, beim zweiten Import alles zu verdoppeln.
//   * Geloescht wird NIE. Was der Plan nicht nennt, bleibt stehen und wird im
//     Abgleich aufgezaehlt. Das ist die andere Entscheidung als beim
//     Tally-Weg (dort verschwinden ungenannte Geraete, weil der Plan dort die
//     ganze Wahrheit ist) — und sie faellt hier anders, weil dieser Server
//     Dinge besitzt, die im Plan gar nicht vorkommen koennen.
//   * Die Systemkanaele (Announcement, Emergency, Program) sind unantastbar.
//     Sie sind keine geplanten Konferenzen, sondern Eigenschaften der Anlage.
//
// WAS DIE DATEI UEBER SICH SELBST SAGT. `derivedFrom` steht im Format, weil
// eine aus Green-GO abgeleitete Datei talk UND listen gesetzt hat — dort ist
// die Zugehoerigkeit EINE Liste. Das ist keine Messung, sondern die aermere
// Quelle. Der Abgleich reicht den Satz durch, statt ihn zu schlucken: wer eine
// Sprechberechtigung in eine fremde Anlage traegt, soll wissen, woher sie
// kommt.
//
// KEINE UHR, KEIN DATEI-IO. Reine Funktionen; der Aufrufer gibt `now` herein
// und schreibt die Konfiguration. Dieselbe Aufteilung wie im Planer, und aus
// demselben Grund pruefbar.
// ───────────────────────────────────────────────────────────────────────────

export const INTERCOM_PLAN_FORMAT = "avplan-intercom";

/**
 * Die hoechste Plan-Version, die dieser Kern versteht.
 *
 * BEFUND (Defektformen-Sweep, Form `vertrag-nur-feldnamen`, gemessen
 * 2026-09-07). `parseIntercomPlan` pruefte `typeof o.version !== "number"` —
 * also den NAMEN und den TYP des Feldes — und verglich die Zahl danach mit
 * nichts. Ein Plan mit `version: 7`, geschrieben von einem Exporteur, den es
 * heute noch nicht gibt, wurde mit v1-Bedeutung gelesen: jedes Feld, dessen
 * Bedeutung sich zwischen den Versionen aendert, wird dann still falsch
 * verstanden. Und was hier falsch verstanden wird, sind SPRECHBERECHTIGUNGEN
 * an einer Anlage, an der gleich jemand arbeitet.
 *
 * Alle Schwester-Formate dieser Familie lehnen eine zu neue Version ab
 * (`camera-list`, `.avplan`, `venue-exchange`, `avplan-inventory`). Dieses
 * eine nicht.
 *
 * ANGEHOBEN AUF 2 am 2026-09-09, und zwar aus genau dem Grund, den der
 * Absatz darueber beschreibt. Version 2 traegt die TASTENBELEGUNG der
 * Sprechstellen (`PlanStation.keys`). Ein v1-Leser wuerde eine v2-Datei
 * annehmen und die Belegung stillschweigend fallen lassen — er kennt das Feld
 * nicht. Genau deshalb gehoert die Ablehnung zur Erweiterung: der Planer hebt
 * seine Version, dieser Kern hebt seine, und wer nur eine Seite aktualisiert,
 * bekommt eine ehrliche Fehlermeldung statt einer halben Uebernahme.
 */
export const INTERCOM_PLAN_VERSION = 2;

/** Ein Eintrag, den die Datei enthielt und der Kern nicht uebernehmen konnte. */
export interface PlanSkipped {
  /** Wo er stand. */
  where: "channel" | "station" | "membership" | "key";
  /** Position in der Datei, 1-basiert — damit man ihn wiederfindet. */
  index: number;
  /** Wozu er gehoerte, sofern lesbar (Sprechstellen-Name bei Zugehoerigkeiten). */
  context?: string;
  /** Warum er nicht uebernommen wurde. */
  reason: string;
}

/** Eine Konferenz aus dem Plan ("PGM", "CAM", "Ton"). */
export interface PlanChannel {
  id: string;
  name: string;
  purpose?: string;
}

/** Wie eine Sprechstelle an einer Konferenz haengt. */
export interface PlanMembership {
  channelId: string;
  talk: boolean;
  listen: boolean;
}

/**
 * Eine Taste auf der Sprechstelle: welche Konferenz liegt auf welchem Platz.
 *
 * Format-Version 2. Die Belegung ist eine REGIE-ENTSCHEIDUNG und keine Folge
 * der Zugehoerigkeit: wer auf drei Konferenzen haengt, hat nicht dadurch schon
 * eine Reihenfolge. Sie steht deshalb neben `memberships` und nicht darin.
 */
export interface PlanKey {
  /** Seite auf dem Geraet, ab 1. */
  page: number;
  /** Taste auf dieser Seite, ab 1. */
  button: number;
  /** Die Konferenz, die auf dieser Taste liegt. */
  channelId: string;
}

/** Eine Sprechstelle / Rolle aus dem Plan ("Regie", "Kamera 1"). */
export interface PlanStation {
  id: string;
  name: string;
  shortName?: string;
  memberships: PlanMembership[];
  /** Geraet im Verkabelungsplan — hier nur durchgereicht, nicht aufgeloest. */
  equipmentId?: string;
  /**
   * Die Tastenbelegung, wenn der Plan sie fuehrt (Format-Version 2).
   *
   * DREI ZUSTAENDE, NICHT ZWEI, und der Unterschied ist der Grund fuer das
   * Fragezeichen:
   *
   *   `undefined` — der Plan sagt nichts ueber die Belegung dieser Stelle.
   *   `[]`        — der Plan sagt: diese Stelle hat KEINE Taste belegt.
   *   Eintraege   — so liegt sie.
   *
   * Die ersten beiden zusammenzuwerfen hiesse, eine bewusst leergeraeumte
   * Sprechstelle wie eine ununtersuchte zu behandeln. Dieselbe Unterscheidung
   * fuehrt der Planer auf seiner Seite (`GreenGoUser.keys`), und sie muss
   * ueber die Datei ueberleben, sonst ist sie beim ersten Austausch weg.
   */
  keys?: PlanKey[];
}

export interface IntercomPlanFile {
  format: typeof INTERCOM_PLAN_FORMAT;
  version: number;
  exportedAt?: string;
  systemName: string;
  description?: string;
  channels: PlanChannel[];
  stations: PlanStation[];
  vendor?: Record<string, unknown>;
  derivedFrom?: string;
  /**
   * Was in der Datei stand und nicht uebernommen wurde.
   *
   * Vorher fielen solche Eintraege per `continue` still aus der Liste. Eine
   * Datei, deren Sprechstellen alle eine unlesbare Id haben, ergab dann eine
   * leere Liste, der Abgleich sagte „nichts zu tun", und niemand erfuhr,
   * dass die Haelfte der Datei weggeworfen wurde. Der Abgleich ist genau
   * dafuer da, zu zeigen, was passiert.
   */
  skipped: PlanSkipped[];
}

/**
 * Systemkanal? Als Funktion und nicht als Konstante am Modulkopf.
 *
 * `index.ts` reicht diese Datei nach aussen weiter, und diese Datei liest von
 * dort die drei Kennungen -- ein Kreis. Ein `new Set([...])` beim Laden faellt
 * darin in die temporale Totzone und wirft beim Start des Servers
 * („Cannot access 'SYSTEM_CHANNEL_ANNOUNCEMENT' before initialization",
 * gemessen). Zur Aufrufzeit ist alles da.
 */
const istSystemKanal = (id: string): boolean =>
  id === SYSTEM_CHANNEL_ANNOUNCEMENT ||
  id === SYSTEM_CHANNEL_EMERGENCY ||
  id === SYSTEM_CHANNEL_PROGRAM;

/**
 * Vergleichsform eines Namens.
 *
 * Klein und ohne Randabstand: „PGM ", „pgm" und „PGM" sind dieselbe Konferenz.
 * Weiter zu normalisieren (Bindestriche, Umlaute) waere geraten — zwei Kanaele,
 * die wirklich „CAM-1" und „CAM 1" heissen, sind womoeglich zwei.
 */
const key = (name: string): string => name.trim().toLowerCase();

/**
 * Eine feste Farbfolge. Bewusst deterministisch: ein zweiter Import derselben
 * Datei darf die Farben nicht durchmischen — sie sind das, woran jemand die
 * Kanaele auf dem Geraet auseinanderhaelt.
 */
const PALETTE = [
  "#c1121f", "#0077b6", "#2a9d8f", "#f4a261",
  "#8338ec", "#3a86ff", "#fb5607", "#06d6a0",
];

/**
 * Was beim Lesen einer Plan-Datei herauskommt.
 *
 * Ein Ergebnis-Typ und nicht `IntercomPlanFile | null`: der Grund, warum eine
 * Datei nicht angenommen wird, ist fuer den Nutzer die eigentliche Auskunft.
 * „Kein gueltiger Intercom-Plan" fuer eine Datei, die nur eine Version zu neu
 * ist, schickt jemanden auf die falsche Suche.
 */
export type IntercomPlanRead =
  | { ok: true; file: IntercomPlanFile }
  | { ok: false; error: string };

/** Ein gelesener Wert, der ein Intercom-Plan sein soll. */
export function readIntercomPlan(text: string): IntercomPlanRead {
  let roh: unknown;
  try {
    roh = JSON.parse(text);
  } catch {
    return { ok: false, error: "Die Datei ist kein JSON." };
  }
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) {
    return { ok: false, error: "Die Datei enthaelt kein Objekt." };
  }
  const o = roh as Record<string, unknown>;
  if (o.format !== INTERCOM_PLAN_FORMAT) {
    return {
      ok: false,
      error: `Kein Intercom-Plan: erwartet wird format "${INTERCOM_PLAN_FORMAT}".`,
    };
  }
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) {
    return { ok: false, error: "Der Plan nennt keine gueltige Version." };
  }
  // Der eigentliche Befund: hier stand nichts. Eine zu neue Datei wurde mit
  // v1-Bedeutung gelesen — und was hier falsch verstanden wird, sind
  // Sprechberechtigungen.
  if (o.version > INTERCOM_PLAN_VERSION) {
    return {
      ok: false,
      error:
        `Der Plan ist Version ${o.version}; dieser Kern versteht bis ` +
        `Version ${INTERCOM_PLAN_VERSION}. Ein neuerer Plan koennte Felder ` +
        `anders meinen, als er hier gelesen wuerde.`,
    };
  }
  if (!Array.isArray(o.channels) || !Array.isArray(o.stations)) {
    return { ok: false, error: "Der Plan hat keine Listen fuer Kanaele und Sprechstellen." };
  }

  const skipped: PlanSkipped[] = [];
  const uebersprungen = (where: PlanSkipped["where"], index: number, reason: string, context?: string) =>
    skipped.push({ where, index: index + 1, reason, ...(context ? { context } : {}) });

  const channels: PlanChannel[] = [];
  (o.channels as unknown[]).forEach((c, i) => {
    if (!c || typeof c !== "object") {
      uebersprungen("channel", i, "kein Objekt");
      return;
    }
    const x = c as Record<string, unknown>;
    if (typeof x.id !== "string" || !x.id.trim()) {
      uebersprungen("channel", i, "ohne Kennung");
      return;
    }
    if (typeof x.name !== "string" || !x.name.trim()) {
      uebersprungen("channel", i, "ohne Namen", x.id);
      return;
    }
    channels.push({
      id: x.id,
      name: x.name.trim(),
      ...(typeof x.purpose === "string" ? { purpose: x.purpose } : {}),
    });
  });

  const stations: PlanStation[] = [];
  (o.stations as unknown[]).forEach((st, i) => {
    if (!st || typeof st !== "object") {
      uebersprungen("station", i, "kein Objekt");
      return;
    }
    const x = st as Record<string, unknown>;
    if (typeof x.id !== "string" || !x.id.trim()) {
      uebersprungen("station", i, "ohne Kennung");
      return;
    }
    if (typeof x.name !== "string" || !x.name.trim()) {
      uebersprungen("station", i, "ohne Namen", x.id);
      return;
    }
    const name = x.name.trim();
    const memberships: PlanMembership[] = [];
    if (x.memberships !== undefined && !Array.isArray(x.memberships)) {
      uebersprungen("station", i, "memberships ist keine Liste", name);
    } else if (Array.isArray(x.memberships)) {
      (x.memberships as unknown[]).forEach((m, j) => {
        if (!m || typeof m !== "object") {
          uebersprungen("membership", j, "kein Objekt", name);
          return;
        }
        const y = m as Record<string, unknown>;
        if (typeof y.channelId !== "string" || !y.channelId.trim()) {
          uebersprungen("membership", j, "ohne Kanal-Kennung", name);
          return;
        }
        // Fehlt eine der beiden Angaben, gilt sie als NICHT gesetzt. Eine
        // fehlende Sprechberechtigung zu erfinden waere der teurere Fehler:
        // wer nicht sprechen soll, soll auch nicht koennen.
        memberships.push({
          channelId: y.channelId,
          talk: y.talk === true,
          listen: y.listen === true,
        });
      });
    }
    // Format-Version 2: die Tastenbelegung. FEHLT das Feld, bleibt es
    // `undefined` — „der Plan sagt nichts dazu". Steht dort eine leere Liste,
    // bleibt sie leer: „keine Taste belegt". Beides zusammenzuwerfen hiesse,
    // eine bewusst leergeraeumte Sprechstelle wie eine ununtersuchte zu
    // behandeln.
    let keys: PlanKey[] | undefined;
    if (x.keys !== undefined && !Array.isArray(x.keys)) {
      uebersprungen("station", i, "keys ist keine Liste", name);
    } else if (Array.isArray(x.keys)) {
      keys = [];
      (x.keys as unknown[]).forEach((k, j) => {
        if (!k || typeof k !== "object") {
          uebersprungen("key", j, "kein Objekt", name);
          return;
        }
        const z = k as Record<string, unknown>;
        if (typeof z.channelId !== "string" || !z.channelId.trim()) {
          uebersprungen("key", j, "ohne Kanal-Kennung", name);
          return;
        }
        // Seite und Taste zaehlen ab 1. Eine 0 oder eine Kommazahl ist kein
        // Platz auf einem Geraet; sie zu runden hiesse, eine Taste zu
        // erfinden, auf die dann jemand drueckt.
        if (!Number.isInteger(z.page) || (z.page as number) < 1) {
          uebersprungen("key", j, "Seite ist keine ganze Zahl ab 1", name);
          return;
        }
        if (!Number.isInteger(z.button) || (z.button as number) < 1) {
          uebersprungen("key", j, "Taste ist keine ganze Zahl ab 1", name);
          return;
        }
        keys!.push({
          page: z.page as number,
          button: z.button as number,
          channelId: z.channelId,
        });
      });
    }
    stations.push({
      id: x.id,
      name,
      ...(typeof x.shortName === "string" ? { shortName: x.shortName } : {}),
      memberships,
      ...(typeof x.equipmentId === "string" ? { equipmentId: x.equipmentId } : {}),
      ...(keys !== undefined ? { keys } : {}),
    });
  });

  return {
    ok: true,
    file: {
      format: INTERCOM_PLAN_FORMAT,
      version: o.version,
      ...(typeof o.exportedAt === "string" ? { exportedAt: o.exportedAt } : {}),
      systemName: typeof o.systemName === "string" ? o.systemName : "",
      ...(typeof o.description === "string" ? { description: o.description } : {}),
      channels,
      stations,
      ...(o.vendor && typeof o.vendor === "object" ? { vendor: o.vendor as Record<string, unknown> } : {}),
      ...(typeof o.derivedFrom === "string" ? { derivedFrom: o.derivedFrom } : {}),
      skipped,
    },
  };
}

/**
 * Bequeme Form fuer Aufrufer, die den Grund nicht brauchen.
 *
 * KEINE zweite Rechnung: sie ruft `readIntercomPlan` und wirft nur den Grund
 * weg. Wer den Grund anzeigen will — und der Import will das —, nimmt die
 * Form darueber.
 */
export function parseIntercomPlan(text: string): IntercomPlanFile | null {
  const r = readIntercomPlan(text);
  return r.ok ? r.file : null;
}

/** Was ein Import an einem Kanal oder einer Sprechstelle taete. */
export interface PlanChangeItem {
  name: string;
  /** Vorhandene Id, wenn er schon da ist. */
  existingId?: string;
  /** Klartext, was sich aendert — leer bei „neu" und bei „unveraendert". */
  changes: string[];
}

export interface IntercomPlanDiff {
  systemName: string;
  exportedAt?: string;
  /** Der Satz aus der Datei, woraus sie gebaut wurde. Unveraendert durchgereicht. */
  derivedFrom?: string;
  /**
   * Kanaele kennen hier nur „neu", „schon da" und „nicht im Plan" — es gibt
   * kein `updated`, weil der Plan an einem vorhandenen Kanal nichts zu aendern
   * haette: der Name ist der Schluessel, und die Farbe gehoert der Anlage. Ein
   * leeres Feld `updated` mitzufuehren, das nie etwas enthaelt, waere eine
   * Zusicherung ohne Inhalt.
   */
  channels: {
    added: PlanChangeItem[];
    unchanged: PlanChangeItem[];
    /** Auf dieser Anlage vorhanden, im Plan nicht genannt. Bleibt stehen. */
    keptOutsidePlan: PlanChangeItem[];
  };
  users: {
    added: PlanChangeItem[];
    updated: PlanChangeItem[];
    unchanged: PlanChangeItem[];
    keptOutsidePlan: PlanChangeItem[];
  };
  /**
   * Zugehoerigkeiten, deren Kanal in der Datei nicht vorkommt. Kein Fehler des
   * Servers, aber auch nichts, was still verschwinden darf.
   */
  danglingMemberships: { station: string; channelId: string }[];
  /**
   * Was in der Datei stand und gar nicht erst angekommen ist. Aus
   * `IntercomPlanFile.skipped` durchgereicht — der Abgleich ist die Stelle,
   * an der jemand hinsieht, bevor er uebernimmt.
   */
  skipped: PlanSkipped[];
  /**
   * FORMAT-VERSION 2: Tastenbelegungen, die in der Datei stehen und von
   * DIESEM Kern nicht uebernommen werden.
   *
   * Der Grund ist keine Nachlaessigkeit, sondern eine Tatsache ueber diese
   * Anlage: `IntercomUser` fuehrt keine Tastenbelegung. Es gibt hier kein
   * Feld, in das eine Seite und eine Tastennummer geschrieben werden
   * koennten. Der Plan darf sie trotzdem tragen — er beschreibt eine Anlage,
   * die er nicht kennt.
   *
   * Was daraus folgt, ist ADR-005 Regel 3, angewandt auf den Abgleich:
   * bewahren, verweigern oder MELDEN. Bewahren geht nicht (kein Feld),
   * verweigern waere unverhaeltnismaessig (der Rest der Datei ist
   * einwandfrei) — also wird es gemeldet, und zwar an der Stelle, an der
   * jemand vor dem Uebernehmen hinsieht. Stillschweigend fallen zu lassen
   * hiesse: die Regie hat die Belegung geplant, der Import sagte „fertig",
   * und im Saal liegt auf Taste 1 etwas anderes als auf dem Plan.
   *
   * Leer heisst: keine Datei-Belegung offen — entweder trug die Datei keine,
   * oder es gibt sie hier eines Tages doch.
   */
  keysNotApplied: { station: string; count: number }[];
}

const vendorColors = (
  file: IntercomPlanFile,
  feld: "groupColors" | "userColors",
): Record<string, string> => {
  const greengo = (file.vendor?.greengo ?? null) as Record<string, unknown> | null;
  const roh = greengo?.[feld];
  if (!roh || typeof roh !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    // Green-GO fuehrt Farben als Index, nicht als Hexwert. Nur echte Hexwerte
    // uebernehmen — eine Zahl als CSS-Farbe waere eine unsichtbare Kachel.
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) out[k] = v;
  }
  return out;
};

/**
 * Was der Import taete — ohne ihn zu tun.
 *
 * Der Abgleich ist kein Beiwerk. Ein Import schreibt Sprechberechtigungen in
 * eine Anlage, an der gleich jemand arbeitet; wer ihn ausloest, soll vorher
 * lesen koennen, was sich bewegt. Dieselbe Regel wie beim Tally-Weg.
 */
export function diffIntercomPlan(state: CoreState, file: IntercomPlanFile): IntercomPlanDiff {
  const planChannelByKey = new Map<string, PlanChannel>();
  for (const c of file.channels) planChannelByKey.set(key(c.name), c);

  const stateChannelByKey = new Map<string, Channel>();
  for (const c of Object.values(state.channels)) {
    if (istSystemKanal(c.id)) continue;
    stateChannelByKey.set(key(c.name), c);
  }

  // Kanal-Id in der Datei -> Kanal-Id auf dieser Anlage (oder neu).
  const zielKanalId = new Map<string, string>();
  const channels: IntercomPlanDiff["channels"] = {
    added: [], unchanged: [], keptOutsidePlan: [],
  };
  file.channels.forEach((c) => {
    const da = stateChannelByKey.get(key(c.name));
    if (da) {
      zielKanalId.set(c.id, da.id);
      // Der Name IST der Schluessel, die Farbe gehoert der Anlage: ein
      // Import, der sie ueberschreibt, aendert das Geraetebild fuer eine
      // Angabe, die der Plan gar nicht fuehrt.
      channels.unchanged.push({ name: c.name, existingId: da.id, changes: [] });
    } else {
      channels.added.push({ name: c.name, changes: [] });
    }
  });
  for (const c of stateChannelByKey.values()) {
    if (!planChannelByKey.has(key(c.name))) {
      channels.keptOutsidePlan.push({ name: c.name, existingId: c.id, changes: [] });
    }
  }

  // Fuer die Berechtigungs-Vorschau brauchen neue Kanaele schon eine Id.
  let n = Object.keys(state.channels).length;
  for (const c of file.channels) {
    if (!zielKanalId.has(c.id)) {
      n += 1;
      zielKanalId.set(c.id, `ch${n}`);
    }
  }

  const stateUserByKey = new Map<string, IntercomUser>();
  for (const u of Object.values(state.users)) stateUserByKey.set(key(u.name), u);
  const planStationByKey = new Map<string, PlanStation>();
  for (const s of file.stations) planStationByKey.set(key(s.name), s);

  const users: IntercomPlanDiff["users"] = {
    added: [], updated: [], unchanged: [], keptOutsidePlan: [],
  };
  const danglingMemberships: IntercomPlanDiff["danglingMemberships"] = [];

  for (const s of file.stations) {
    const talk: string[] = [];
    const listen: string[] = [];
    for (const m of s.memberships) {
      const ziel = zielKanalId.get(m.channelId);
      if (!ziel) {
        danglingMemberships.push({ station: s.name, channelId: m.channelId });
        continue;
      }
      if (m.talk) talk.push(ziel);
      if (m.listen) listen.push(ziel);
    }
    const da = stateUserByKey.get(key(s.name));
    if (!da) {
      users.added.push({ name: s.name, changes: [] });
      continue;
    }
    const aenderungen: string[] = [];
    const gleich = (a: string[], b: string[]) =>
      a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
    if (!gleich(da.permissions.talkChannelIds, talk)) {
      aenderungen.push(`spricht auf ${talk.length} statt ${da.permissions.talkChannelIds.length} Kanälen`);
    }
    if (!gleich(da.permissions.listenChannelIds, listen)) {
      aenderungen.push(`hört ${listen.length} statt ${da.permissions.listenChannelIds.length} Kanäle`);
    }
    if (aenderungen.length > 0) {
      users.updated.push({ name: s.name, existingId: da.id, changes: aenderungen });
    } else {
      users.unchanged.push({ name: s.name, existingId: da.id, changes: [] });
    }
  }
  for (const u of stateUserByKey.values()) {
    if (!planStationByKey.has(key(u.name))) {
      users.keptOutsidePlan.push({ name: u.name, existingId: u.id, changes: [] });
    }
  }

  return {
    systemName: file.systemName,
    ...(file.exportedAt ? { exportedAt: file.exportedAt } : {}),
    ...(file.derivedFrom ? { derivedFrom: file.derivedFrom } : {}),
    channels,
    users,
    danglingMemberships,
    skipped: file.skipped,
    // Format-Version 2. Gemeldet wird, was die Datei traegt und dieser Kern
    // nicht unterbringt — mit Anzahl, damit der Satz eine Groesse hat und
    // nicht nur ein Gefuehl. Eine leere Belegung (`keys: []`) ist KEIN
    // offener Posten: die Datei sagt dort ausdruecklich „keine Taste
    // belegt", und daran ist nichts zu uebernehmen.
    keysNotApplied: file.stations
      .filter((s) => (s.keys?.length ?? 0) > 0)
      .map((s) => ({ station: s.name, count: s.keys!.length })),
  };
}

/**
 * Den Plan in den Zustand einarbeiten.
 *
 * Liefert einen NEUEN Zustand; der uebergebene bleibt unberuehrt. Alles, was
 * der Plan nicht kennt — Geraete, Antennen, Sitzungen, Matrix, Bridge —, geht
 * unveraendert mit.
 */
export function applyIntercomPlan(
  state: CoreState,
  file: IntercomPlanFile,
  now: number,
): { state: CoreState; diff: IntercomPlanDiff } {
  const diff = diffIntercomPlan(state, file);

  const channels: Record<string, Channel> = { ...state.channels };
  const vorhandenNachName = new Map<string, Channel>();
  for (const c of Object.values(channels)) {
    if (!istSystemKanal(c.id)) vorhandenNachName.set(key(c.name), c);
  }

  const kanalFarben = vendorColors(file, "groupColors");
  const zielKanalId = new Map<string, string>();
  let n = Object.keys(channels).length;
  file.channels.forEach((c, i) => {
    const da = vorhandenNachName.get(key(c.name));
    if (da) {
      zielKanalId.set(c.id, da.id);
      return;
    }
    n += 1;
    let id = `ch${n}`;
    // Freie Id suchen, statt eine bestehende zu ueberschreiben: die Zaehlung
    // ueber die Anzahl trifft daneben, sobald jemand einen Kanal geloescht hat.
    while (channels[id]) {
      n += 1;
      id = `ch${n}`;
    }
    channels[id] = {
      id,
      name: c.name,
      color: kanalFarben[c.id] ?? PALETTE[i % PALETTE.length],
      type: "group",
    };
    zielKanalId.set(c.id, id);
  });

  const users: Record<string, IntercomUser> = { ...state.users };
  const vorhandeneNutzer = new Map<string, IntercomUser>();
  for (const u of Object.values(users)) vorhandeneNutzer.set(key(u.name), u);
  const nutzerFarben = vendorColors(file, "userColors");

  file.stations.forEach((s, i) => {
    const talk: string[] = [];
    const listen: string[] = [];
    for (const m of s.memberships) {
      const ziel = zielKanalId.get(m.channelId);
      if (!ziel) continue;
      if (m.talk) talk.push(ziel);
      if (m.listen) listen.push(ziel);
    }
    const da = vorhandeneNutzer.get(key(s.name));
    if (da) {
      users[da.id] = {
        ...da,
        permissions: {
          ...da.permissions,
          talkChannelIds: talk,
          listenChannelIds: listen,
        },
        updatedAt: now,
      };
      return;
    }
    // Neue Sprechstelle. Rolle `operator` und NICHT geraten: der Plan fuehrt
    // keine Rollen im Sinne dieser Anlage. Wer eine Regie zum `director`
    // machen will, tut das hier — eine Rechtevergabe aus einem Namen
    // abzuleiten waere die falsche Art von Hilfsbereitschaft.
    const id = `user-plan-${key(s.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `${i + 1}`}`;
    users[id] = {
      id,
      name: s.name,
      role: "operator",
      color: nutzerFarben[s.id] ?? PALETTE[(i + 3) % PALETTE.length],
      permissions: {
        talkChannelIds: talk,
        listenChannelIds: listen,
        transcriptionChannelIds: [],
        canAllCall: false,
        canManageDevices: false,
      },
      callBehavior: defaultCallBehavior(),
      assignedDeviceIds: [],
      createdAt: now,
      updatedAt: now,
    };
  });

  return { state: { ...state, channels, users }, diff };
}
