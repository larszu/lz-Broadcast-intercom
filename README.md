# LZ Broadcast Intercom

LZ Broadcast Intercom is a self-hosted, browser-based production intercom system for live events and broadcast productions. Inspired by the architecture of [Green-GO](https://green-go.eu) wireless intercoms and the open-source [Eyevinn Open Intercom](https://github.com/Eyevinn/intercom-manager) project.

> ⚠️ **Currently under development.**

---

## The web page

Every push to the default branch builds this repo's page from
`.github/workflows/pages.yml` and publishes it:

**https://larszu.github.io/lz-Broadcast-intercom/**

The workflow **asks the Pages API before it configures anything.** With no
Pages site it still builds — that is a real check — and skips only the
publishing step, with a warning and the one missing step in the run summary.
A run that must stay red for a click nobody made teaches people to ignore red.

Measured 2026-09-09: **built, not published.** The build runs and passes; the
`deploy` job is skipped because this repo has no Pages site yet. That switch is
the one thing no workflow can flip (`GITHUB_TOKEN` may not create a site):
Settings → Pages → Source → **GitHub Actions**. After that the next push
publishes by itself — nothing in this repo needs changing.

---
## Features

- **Group channels (Partylines)** — multi-party talk groups, each user can hold up to 8 configurable slots
- **System channels** — three always-present channels: Announcement, Emergency, Program
- **Direct calls** — temporary 1:1 channels that auto-open when a user initiates a call, no pre-configuration on the receiver side
- **User Profiles / Presets** — per-user slot configuration (which groups/direct targets/system channels appear on each slot)
- **Role-based permissions** — `admin`, `director`, `operator`, `talent` roles gate talk/listen/transcription and management rights
- **Device Manager** — hardware beltpacks (Ethernet/DECT/WiFi) with full config; browser beltpacks via invite link, which the admin can **revoke** (removed and refused until restored; the phone says so and reconnects by itself once restored). Revoking is an operator control, not access control — the core has no sign-in
- **Companion / Stream Deck control** — REST control endpoint plus a ready-to-use [Bitfocus Companion module](companion-module/) (`companion-module/`)
- **Audio transcription** — optional Vosk speech-to-text per channel; the transcript view filters by channel and text, pins channels to the front (per browser) and counts unread lines of channels filtered out, takes operator **bookmarks** ("cue 34 late") in the same timeline, and exports the show's transcript as **TXT, SRT or JSON** (`GET /api/transcript?format=txt|srt|json[&channel=<id>]`, bookmark via `POST /api/transcript/bookmark`). The server keeps the last 5,000 lines and bookmarks until *Clear transcript*
- **Keyword rules** (Setup → Automation) — a word or phrase in a transcript line sends an **OSC** message (UDP; address, then text, channel, speaker, keyword as strings) or a **webhook** (POST JSON), optionally only for one channel; whole words only, at most once per second per rule, a *Test* button sends a sample line. Stored in the show config; REST under `/api/automation/rules`
- **Live captions** (Setup → Automation) — every transcript line of all or chosen channels goes out immediately as one **OSC** message, by default `/lzvm/caption s:text` to [LZ Vision Mixer](https://github.com/larszu/lz-vision-mixer) (`127.0.0.1:4210`), which shows it in its captions graphic; optionally as "Speaker: text" and with a layer number as a second `i` argument; at most 10 lines per second, a *Test* button sends a sample caption. Stored in the show config; REST `GET`/`PATCH /api/automation/captions`, `POST /api/automation/captions/test`
- **Plugin Bridge** — optional VST/audio plugin integration via WebSocket
- **Device library** — sign in to [devices.zumpelars.de](https://devices.zumpelars.de) (Setup → Settings & Logs), sync shared intercom device types as a read-only source; own device types are uploaded automatically (new or changed ones, at start and after each edit) and **Sync now** uploads, then fetches. The synced copy keeps working without the server: it changes only on a successful answer (offline, timeouts, errors and sign-out leave it as is), every server address keeps its own copy, and a freshly set-up empty server never wipes it; the `intercom` facet format is documented in [docs/device-library.md](docs/device-library.md)
- **Device types** — own and library types under Setup → Device types; *Add device* takes role and transports from the picked type
- **Intercom plan import** — reads the vendor-neutral `avplan-intercom` file the AV Planner Suite exports: conferences, stations, and talk/listen kept apart. Merged by name, never deleting ([details](docs/plan-import.md))

---

## Screenshots

### Operator UI — Monitor
Live view of every beltpack: transport (ETH/DECT/WiFi), assigned user and channel, and who is currently talking (highlighted red).

![Monitor view](docs/screenshots/02-monitor.png)

### Setup — Channels & Routing
Manage group and system channels and the point-to-point talk **routing matrix** between devices.

![Channels & routing](docs/screenshots/03-channels.png)

### Setup — Devices & Users
Hardware and browser beltpacks on the left; users, roles and per-channel talk/listen/transcription permissions on the right. A QR code / invite link turns any phone or tablet into a browser beltpack.

![Devices & users](docs/screenshots/04-devices.png)

### Setup — Audio & Plugin Bridge
Per-device audio settings and the optional VST/audio plugin bridge configuration.

![Audio settings](docs/screenshots/05-audio.png)

### Browser beltpack (phone / tablet)
Open the client link on any device to turn it into an independent beltpack — pick a name and user (left), then push-to-talk with per-channel listen and live talk indicators (right).

Over HTTPS (port 4443) the beltpack can be **installed on the home screen** (web app manifest, starts straight into the beltpack) and opens even while the core is unreachable — it shows *offline* and reconnects by itself; channel lists and audio are never cached. While the beltpack is open, the screen stays on (Screen Wake Lock, where the browser offers it).

<p>
  <img src="docs/screenshots/07-phone-client.png" alt="Browser beltpack onboarding" width="32%">
  &nbsp;&nbsp;
  <img src="docs/screenshots/08-phone-beltpack.png" alt="Browser beltpack push-to-talk" width="32%">
</p>

### Start screen
Create a new show configuration or open a saved one.

![Start screen](docs/screenshots/01-start.png)

> Screens are captured from the running app with seeded demo data (`docs/screenshots/`).

---

## Documentation

- [**`docs/README.md`**](docs/README.md) — index of everything: architecture
  draft, feature backlog, the Companion module reference, plus a quick
  reference and the data-flow diagram.

`npm run docs:reachable` fails the build if a document under `docs/` is not
reachable by links from an entry page. All three were orphaned until
2026-09-04 — including `docs/README.md` itself, which was already a good index
that nobody linked.

---

## Architecture

```
Broadcast-intercom/
├── apps/
│   ├── server/            Node.js + Express + WebSocket core (port 4001)
│   └── web/               React + Vite 6 operator UI (dev port 5200)
├── packages/
│   └── shared/            Common TypeScript types (shared between server & web)
├── companion-module/      Bitfocus Companion module for Stream Deck control
├── scripts/
│   └── smoke-test.mjs     Headless REST + WebSocket functional test
└── data/
    ├── configs/           Saved show configurations (JSON)
    └── models/            Vosk speech model (optional)
```

**Tech stack:**
- Runtime: Node 20 (via [fnm](https://github.com/Schniz/fnm); `.node-version` pins 20)
- Server: Express 4, `ws` WebSocket library, `tsx` for TypeScript execution
- Frontend: React 19, Vite 6, CSS-only styling (no CSS framework)
- HTTPS: the core serves the same UI over TLS on port 4443 with a certificate it
  generates itself on first start — browsers only unlock the microphone in a
  secure context, so beltpacks on phones need this. [mkcert](https://github.com/FiloSottile/mkcert)
  stays optional and only removes the one-time certificate warning.

---

## Getting Started

### Prerequisites

```powershell
winget install Schniz.fnm
fnm install 20
fnm use 20
# Optional — only needed for HTTPS / microphone access on a LAN:
winget install FiloSottile.mkcert
mkcert -install
```

> On macOS/Linux use your package manager (`brew install fnm mkcert`, etc.). Node 20+ is required; the project runs on Node 22 as well.

### Installation

```bash
git clone https://github.com/larszu/lz-Broadcast-intercom.git
cd lz-Broadcast-intercom
npm install
```

**Optional — mkcert certificates.** The core already serves HTTPS on its own (see
[Microphone on other devices](#microphone-on-other-devices)); mkcert only removes
the one-time browser warning on devices where you install its local CA:

```bash
cd apps/web
mkdir certs
mkcert -cert-file certs/localhost+4.pem -key-file certs/localhost+4-key.pem localhost 127.0.0.1 ::1 YOUR_LAN_IP
cd ../..
```

Without certificates the web dev server automatically serves plain HTTP — everything still works for local development.

### Running

```bash
./dev.sh               # Linux / macOS — server + web UI with simulated beltpacks
./dev.sh --no-mock     # …without the simulation (real devices on the network)
./dev.sh --server      # server only (headless, for Companion / tests)

.\dev.ps1              # Windows — same three, via -NoMock / plain
```

Or the npm scripts directly:

```bash
npm run dev            # server (:4001) + web UI (:5200)
npm run dev:mock       # same, with simulated beltpacks generating live traffic
npm run dev:server     # server only (useful for headless testing / Companion)
```

Open **http://localhost:5200** (or `https://` if you generated certificates).

### Microphone on other devices

On the machine running the core, `http://localhost:4001` is enough — browsers
treat `localhost` as a secure context. **On every other device it is not.** A
beltpack on a phone reaches the core at `http://192.168.x.y:4001`, and there the
browser refuses the microphone outright:

> Microphone access requires HTTPS.

That is not a setting anyone can turn off. The core therefore serves the same UI
a second time over TLS:

```
https://192.168.x.y:4443
```

The address is printed at startup next to the plain-HTTP ones. The certificate is
generated on first start, covers every LAN address of the machine, and is stored
next to the configurations. Since nobody signed it, the browser warns once per
device — *Advanced → Proceed*. That is expected and is the price for a
microphone that works at all.

A certificate from Let's Encrypt is not an option here: issuance requires a
publicly resolvable name, and an intercom rack in an OB van has no internet.
Installing the mkcert CA on the devices (above) removes the warning; it does not
change anything else.

`INTERCOM_TLS=0` disables the TLS listener — for setups that already sit behind
their own reverse proxy with a real certificate, where a second self-signed
service would just be a second path with different trust. `TLS_PORT` moves the
port.

**No hardware needed.** `dev:mock` spawns simulated beltpacks that generate
live traffic; the whole intercom — channels, calls, audio control, the plan
contract — can be exercised on a laptop. `dev.sh` uses it by default and
checks the Node version *before* starting, so a too-old Node fails with a
sentence about the version instead of a syntax error somewhere inside the
bundler.

**Other devices on the same network.** The server binds every interface, and
on startup it now prints the addresses you can actually hand out:

```
Intercom core on http://localhost:4001
               http://192.168.1.42:4001  (im selben Netz)
```

Before, only `localhost` was printed — the server was reachable from the LAN
the whole time and nobody was told under which address. All detected
addresses are listed rather than one being guessed: on a machine with a
Docker or VPN bridge the first one is often the wrong one, and whoever reads
the list recognises their own. The web UI (`:5200`) already serves on every
interface via Vite's `host: true`.

For microphone access from another device the browser needs HTTPS — that is
what the optional mkcert step above is for.

---

## Desktop app (Windows / macOS)

[`apps/desktop/`](apps/desktop/) is an Electron shell that packages the intercom
core **and** the web UI into a double-clickable desktop app. The Electron main
process starts the same core server (bundled to a single `server.cjs`) as a
child process and opens a window on the UI it serves; other devices on the LAN
still reach that same core over the network, exactly as before. The desktop app
changes packaging only — not the client/server architecture.

Build it locally:

```bash
npm run build                      # core: shared → server → web
npm run build -w @broadcast/desktop # bundles main.cjs + server.cjs
npm run dist  -w @broadcast/desktop # electron-builder → installers in apps/desktop/release/
```

Releases are built in CI: pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds on
`windows-latest` and `macos-latest` and attaches the `.exe` (Windows), `.dmg` +
`.zip` (macOS universal) and the `electron-updater` manifests
(`latest.yml` / `latest-mac.yml`) to the GitHub Release. Installers are named
`LZ Broadcast Intercom-<version>-<arch>.<ext>`. macOS is ad-hoc signed
(no paid certificate), so first launch needs right-click → **Open**; Windows is
unsigned (SmartScreen shows "unknown publisher").

The desktop window gets a preload (`dist/preload.cjs`) with one bridge: the
device library token, encrypted by the main process with Electron
`safeStorage`. See [docs/device-library.md](docs/device-library.md).

Configs and Vosk models are stored in the OS user-data directory when running as
the packaged app (the app bundle itself is read-only); the core reads
`INTERCOM_DATA_DIR` to find them. That directory is pinned to the folder
`Broadcast Intercom`, not the product name (e.g.
`~/Library/Application Support/Broadcast Intercom`, `%APPDATA%\Broadcast Intercom`).

The header shows the Lars Zumpe Medienproduktion signet (hidden below 640 px);
**Setup → Settings & Logs → About** shows the logo, app name and version. Brand
files live in `apps/web/src/assets/brand/`, app icons in `apps/desktop/build/`
and `apps/web/public/`.

## Testing (headless)

The core can be fully exercised without a browser. Start the server, then run the smoke test:

```bash
npm run dev:server          # terminal 1
npm run test:smoke          # terminal 2  (override target with BASE=http://host:port)
```

`scripts/smoke-test.mjs` verifies the REST CRUD surface, the Companion control
endpoint (PTT / mute / volume / emergency, including error paths), config
persistence, and the WebSocket lifecycle (device registration, talk events,
direct-call temporary channels).

The device library connection is checked without a server or browser:

```bash
npm run lang:check          # every UI text comes from i18n.tsx: no German and no untranslated English outside t
npm run library:check       # facet round trip, no project data, sync, offline contract (copy per server, reset, empty server, sign-out), upload + change detection, token handling
```

The Companion module has its own end-to-end test that drives the real module
logic against a running core — see [`companion-module/`](companion-module/).

To confirm everything compiles:

```bash
npm run build               # builds shared → server → web
```

---

## Bitfocus Companion module

[`companion-module/`](companion-module/) is a full [Bitfocus Companion](https://bitfocus.io/companion)
connection module that turns a Stream Deck into an intercom control surface:

- **Actions** — push-to-talk (slot or named channel), mute/unmute, volume, emergency, direct call start/end, load config
- **Feedbacks** — device talking, muted, offline, battery low, emergency active, core connected
- **Variables** — connection state, active config, device/user/channel counts, and per-device talk/battery/online values
- **Presets** — ready-to-drop PTT, mute, volume, emergency and status buttons

It keeps a live WebSocket to the core for instant feedback and sends commands to
`POST /api/control/action`. See the [module README](companion-module/README.md)
for install, build and test instructions.

---

## Green-GO Inspired Concepts

| Concept | This System |
|---|---|
| Group (Partyline) | `IntercomGroup` + `Channel` with `type: "group"` |
| Direct Call | `TemporaryChannel` — auto-created, no receiver pre-config needed |
| User Config | `UserProfile` with `ChannelSlot[]` (up to 8 slots per user) |
| System Channels | `__sys_announcement__`, `__sys_emergency__`, `__sys_program__` — always present |
| Channel Slot | `ChannelSlot` — each slot points to a group, direct target, or system channel |

Each slot in a `UserProfile` can be one of:
- `{ type: "group", groupId }` — talk/listen to a group
- `{ type: "direct", userId }` — dedicated button for direct call to a user
- `{ type: "system", channelId }` — always-on system channel

---

## Eyevinn-Inspired Concepts

| Eyevinn Term | This System |
|---|---|
| Production | Config / Show configuration |
| Line | Channel / Group |
| Preset | `UserProfile` |
| Session/Participant | `ClientSession` |
| Companion Actions | `ControlAction` via `POST /api/control/action` |

---

## API Reference

### WebSocket (`ws://localhost:4001/ws`)

On connect the server immediately sends a full `state` message; thereafter it
pushes `state` / `event` messages on every change.

**Client → Server:**

| Type | Payload |
|---|---|
| `register_device` | `{ id, label, transport, role?, userId?, channelIds?, connectedAntennaId? }` |
| `register_antenna` | `{ id, label, location }` |
| `heartbeat` | `{ id, battery?, network? }` |
| `assign_channels` | `{ id, channelIds }` |
| `set_talk` | `{ id, channelId, active }` |
| `set_listen` | `{ id, channelIds }` |
| `set_transcription_channels` | `{ id, channelIds }` |
| `set_user` | `{ id, userId? }` |
| `direct_call` | `{ fromDeviceId, toUserId }` |
| `direct_call_end` | `{ tempChannelId }` |
| `transcribe_audio` | `{ id, channelId, sampleRate, audio }` |

**Server → Client:**

| Type | Payload |
|---|---|
| `state` | Full `CoreState` |
| `event` | `EventItem` |
| `audio_chunk` | `{ fromDeviceId, channelId, sampleRate, audio }` |
| `temp_channel_opened` | `TemporaryChannel` |
| `temp_channel_closed` | `{ tempChannelId }` |

### REST endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/state` | Full state |
| GET/POST | `/api/users` | List / create users |
| PATCH/DELETE | `/api/users/:id` | Update / delete user |
| POST | `/api/channels` | Create channel |
| PATCH/DELETE | `/api/channels/:id` | Update / delete channel |
| GET/POST | `/api/groups` | List / create groups |
| PATCH/DELETE | `/api/groups/:id` | Update / delete group |
| GET/POST | `/api/profiles` | List / create profiles |
| PATCH/DELETE | `/api/profiles/:id` | Update / delete profile |
| POST | `/api/devices` | Add device |
| PATCH/DELETE | `/api/devices/:id` | Update / delete device |
| PATCH | `/api/devices/:id/audio` | Update device audio settings |
| PATCH | `/api/devices/:id/user` | Assign device to user |
| GET | `/api/sessions` | Active WebSocket sessions |
| POST | `/api/control/action` | Companion control action |
| PATCH | `/api/matrix` | Set a matrix route (from → to on channel) |
| GET/PATCH | `/api/audio/plugin-bridge` | Plugin bridge config |
| GET | `/api/transcription/status` | Vosk model / module status |
| POST | `/api/transcription/model/install` | Download & install a Vosk model |
| GET | `/api/configs` | List saved configs + active |
| POST | `/api/configs/new` \| `/load` \| `/save` | Create / load / save a config |
| DELETE | `/api/configs/:name` | Delete a saved config |
| GET | `/api/network/hosts` | LAN IP addresses + server port |
| GET | `/api/fs/list?path=` | Server-side file browser (plugin paths) |
| POST | `/api/plan/preview` | Compare an `avplan-intercom` plan against this system — changes nothing ([details](docs/plan-import.md)) |
| POST | `/api/plan/apply` | Apply that plan: merge conferences and stations by name, never delete |

**`ControlAction` values (`POST /api/control/action`):**
`ptt_start`, `ptt_stop`, `mute_input`, `mute_output`, `set_selected_slot`, `volume_up`, `volume_down`, `direct_call_start`, `direct_call_end`, `emergency_start`, `emergency_stop`

Request body: `{ action, deviceId?, slotIndex? }`. Actions that target a device
(`ptt_*`, `mute_*`, `volume_*`) require a valid `deviceId`; `ptt_*` uses
`slotIndex` to pick the channel from the device's assigned channels.

---

## Environment variables (server)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4001` | Core HTTP/WebSocket port |
| `MOCK_DEVICES` | – | Set to `1` to spawn simulated beltpacks (`npm run dev:mock`) |
| `INTERCOM_DATA_DIR` | `data/` next to the built server | Base dir for `configs/` + `models/`; the desktop app points this at the OS user-data dir |
| `WEB_DIST` | `apps/web/dist` next to the built server | When present, the core serves the built web UI from here (same origin as the API); unset in dev, where Vite serves it |
| `VOSK_MODEL_PATH` | `data/models/vosk-model-small-en-us-0.15` | Path to an unpacked Vosk model |
| `VOSK_MODEL_URL` | small en-us model | Model download URL |
| `VOSK_AUTO_DOWNLOAD` | – | Set to `1` to download the model on first start |

---

## License

Proprietär — © 2026 Lars Zumpe, alle Rechte vorbehalten. Nutzung der veröffentlichten Builds ist kostenlos; Weiterverbreitung und abgeleitete Werke sind es nicht. Siehe [LICENSE](LICENSE).
