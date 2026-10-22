# Status – AscendancyDotA

Live-Statusseite für die Dienste von AscendancyDotA: **https://ascendancydota.github.io/status/**

## Was die Seite zeigt

- **Binokel** – Online/Offline, offene Tische, aktive Verbindungen, Partien gesamt (aus `/health` des Spielservers)
- **TeamSpeak** – Online/Offline (UDP-Port 9987) und Nutzer online (über WebQuery/ServerQuery auf `127.0.0.1`).
  Solange der Dienst in der Exporter-Config `"enabled": false` hat, steht dort „Noch nicht eingerichtet“.
- **Oracle-Server** – CPU-Auslastung, Load, RAM, Speicher, Laufzeit seit Neustart
- **Ausgehender Traffic** – Verbrauch im laufenden Monat (vnStat) gegen die 10 TB/Monat, die Oracle kostenlos
  lässt, plus Hochrechnung aufs Monatsende. Über 70 % Hochrechnung wird gelb gewarnt, über 100 % rot.
- **Verlauf** (24 h / 7 Tage) als kleine SVG-Kurven und **Verfügbarkeit** pro Dienst (24 h, 7, 30, 90 Tage + 90-Tage-Balken).

Veröffentlicht werden nur Zahlen – keine Namen, keine IP-Adressen von Nutzern, keine Schlüssel.
Keine Cookies, keine Tracker, keine externen Schriften oder Bibliotheken.

## Wie es funktioniert

```
Oracle-Box                                     GitHub
┌──────────────────────────────┐               ┌─────────────────────────────────────┐
│ status-exporter (Bun)         │  Funnel       │ Pages (main): index.html, app.js    │
│ 127.0.0.1:8799  ──────────────┼─ /status ───▶ │   holt alle 30 s live /status.json  │
│  ├ Binokel  127.0.0.1:8787    │               │                                     │
│  ├ TeamSpeak WebQuery/UDP 9987│               │ Action „collect“ (alle 15 min)      │
│  ├ /proc, df                  │ ◀──────────── │   hängt Messpunkt an Branch `data`  │
│  └ vnstat (enp0s6)            │               │   an (90 Tage)                      │
└──────────────────────────────┘               └─────────────────────────────────────┘
```

1. **Exporter** (`exporter/exporter.ts`, ohne Abhängigkeiten) läuft als systemd-Dienst `status-exporter`
   auf `127.0.0.1:8799` und liefert auf jedem Pfad das Status-JSON (mit CORS, 5 s Cache).
   Config: `/etc/status-exporter/config.json` (Vorlage: `exporter/config.json`).
2. **Tailscale Funnel** veröffentlicht ihn zusätzlich zum Spiel unter
   `https://binokel.tail108204.ts.net/status/status.json`:
   ```
   sudo tailscale funnel --bg --set-path /status http://127.0.0.1:8799
   ```
   Die Spiel-Route `/` bleibt unverändert.
3. **GitHub Action** `.github/workflows/collect.yml` (cron `*/15`, auch manuell startbar) ruft das JSON ab
   und schreibt mit `scripts/collect.mjs` auf den Branch **`data`**:
   - `days/JJJJ-MM-TT.json` – ein kompakter Messpunkt pro Zeile
   - `summary.json` – pro Tag und Dienst [up, Messungen] → Verfügbarkeit
   - `latest.json` – letzter vollständiger Stand (Fallback, wenn der Server nicht erreichbar ist)

   Ältere Dateien als 90 Tage werden gelöscht. Weil die Daten auf einem eigenen Branch liegen, wird die
   Pages-Seite nicht alle 15 Minuten neu gebaut; die Seite lädt sie über `raw.githubusercontent.com`.
   Ist der Exporter nicht erreichbar, zählt der Messpunkt als „down“ für Server und alle Dienste.
4. **Seite** – statisches HTML/CSS/JS, hell/dunkel automatisch, Handy-tauglich. Einstellungen in `config.js`.

Hinweise: GitHub führt Cron-Jobs oft einige Minuten verspätet aus. Bei 60 Tagen ohne Aktivität im Repo
pausiert GitHub geplante Workflows – dann unter *Actions → collect → Enable workflow* wieder aktivieren.

## Exporter installieren / aktualisieren

Vom Windows-Rechner (git-bash) im Repo-Ordner:

```
scp -i ~/.ssh/oracle_binokel -r exporter ubuntu@89.168.70.227:/tmp/status-exporter
ssh -i ~/.ssh/oracle_binokel ubuntu@89.168.70.227 'bash /tmp/status-exporter/install.sh'
```

`install.sh` installiert vnStat falls nötig, kopiert nach `/opt/status-exporter`, startet den Dienst neu
und lässt eine schon vorhandene `/etc/status-exporter/config.json` in Ruhe (`install.sh --config` überschreibt sie).
Config-Änderungen ohne Neustart übernehmen: `sudo systemctl reload status-exporter`.

## TeamSpeak (an/aus)

Der TeamSpeak-6-Server aus [oracle-teamspeak](https://github.com/AscendancyDotA/oracle-teamspeak) ist
eingebunden. Ein-/Ausschalten ist eine Zeile in `/etc/status-exporter/config.json` beim Dienst `teamspeak`:

```
"enabled": true,      // false = Karte „Noch nicht eingerichtet“
```

danach `sudo systemctl reload status-exporter`. „Nutzer online“ kommt per WebQuery `clientlist`
(nur Einträge mit `client_type` 0, Query-Verbindungen zählen nicht) mit dem **nur-lesenden** Key.
Der Key bleibt auf dem Server und wird nie veröffentlicht:

```
sudo install -m 640 -o root -g ubuntu /etc/teamspeak6/webquery-read.key /etc/status-exporter/ts-apikey
```

Alternativ klassische ServerQuery: `"query": "serverquery"`, `"serverqueryPort": 10011` und
`"serverqueryCredFile"` mit Benutzer in Zeile 1 und Passwort in Zeile 2. Ohne Query zeigt die Karte nur
Online/Offline anhand des UDP-Ports.

## Neuen Dienst hinzufügen (z. B. Stream-Relay)

Nur die Exporter-Config erweitern – die Seite und die Action übernehmen neue Dienste automatisch.
Eintrag in `services` (und in `exporter/config.json` im Repo, damit die Vorlage aktuell bleibt):

```json
{
  "id": "relay", "name": "Stream-Relay", "desc": "Restream zu Twitch/YouTube",
  "type": "http", "url": "http://127.0.0.1:8890/health", "unit": "stream-relay.service",
  "metrics": [ { "key": "streams", "path": "streams", "label": "Aktive Streams", "spark": true } ]
}
```

Typen:

| `type`      | Prüfung                                                                 |
|-------------|-------------------------------------------------------------------------|
| `http`      | GET auf `url`, online bei 2xx (und nicht `"ok": false`); Zahlen aus dem JSON per `metrics[].path` (Punkt-Pfad) |
| `systemd`   | `systemctl is-active <unit>`                                            |
| `teamspeak` | UDP-Port lauscht + optional WebQuery/ServerQuery für Nutzerzahl         |

Optional: `"unit"` (zusätzliche systemd-Prüfung → „Eingeschränkt“), `"enabled": false` (Karte „Noch nicht
eingerichtet“), `"hidden": true` (gar nicht veröffentlichen), `"link"`/`"linkLabel"`.
Metriken mit `"spark": true` bekommen eine Verlaufskurve.

## Kosten / Oracle-Abrechnung (optional, später)

Standardmäßig zeigt die Seite nur den Verbrauch gegen das kostenlose Kontingent (eigene Messung mit vnStat).
Echte Abrechnungsdaten (Pay-as-you-go) gäbe es über die **OCI Usage API** (`/20200107/usage`), dafür bräuchte
der Exporter einen OCI-API-Schlüssel eines Nutzers mit Leserechten auf *usage-reports*. Das ist bewusst noch
nicht eingebaut – bei Bedarf als zusätzlicher Wert `host.billing` im Exporter ergänzen.

## Lokal testen

```
python -m http.server 8000   # dann http://localhost:8000/
```
