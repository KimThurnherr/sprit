# sprit – Tankbuch

Kleine Web-App (PWA) zum Erfassen von Betankungen und Auswerten von Verbrauch und Kosten, mit MCP-Schnittstelle,
damit sich Betankungen auch aus einem KI-Assistenten heraus erfassen lassen (z.B. Foto vom Tankbeleg).

- Mehrere Fahrzeuge, pro Betankung: Datum, Kilometerstand, Menge, Literpreis oder Betrag, Währung, voll/teil, Tankstelle, Land, Notiz.
- Verbrauch nach der Volltank-Methode: gemessen wird nur zwischen zwei Volltankungen, Teilbetankungen dazwischen
  zählen zur Menge der nächsten Volltankung. Alles vor der ersten Volltankung ist nur Startpunkt.
  Mit «Betankung davor fehlt» wird die Messung unterbrochen und ab der nächsten Volltankung neu begonnen.
- Fremdwährungen werden zum EZB-Referenzkurs des Tankdatums (frankfurter.dev) in CHF umgerechnet. Optional lässt sich
  der tatsächlich belastete CHF-Betrag erfassen. Ist der Kursdienst nicht erreichbar, wird der Kurs stündlich nachgeholt.
- Statistik: Durchschnitt, letzter/bester/schlechtester Verbrauch, Kosten pro 100 km, Durchschnittspreis, pro Monat und Jahr, Verlaufsgrafik.
- Plausibilitätsprüfung (Kilometerstand passt nicht zum Datum, Menge grösser als Tank).
- Mandantenfähig: Jeder Benutzer sieht nur seine eigenen Fahrzeuge.

Keine externen Abhängigkeiten (Node 24: `node:http`, `node:sqlite`, `node:crypto`).

## Konfiguration

| Variable | Beispiel | Zweck |
|---|---|---|
| `PUBLIC_URL` | `https://sprit.example.com` | Öffentliche Adresse (für Login-Redirect und Cookies) |
| `ALLOWED_USERS` | `alex:alex@example.com` | Wer sich mit Google anmelden darf |
| `USER_NAMES` | `alex:Alex` | Anzeigenamen |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | OAuth-Client (Web), Redirect-URI `PUBLIC_URL/auth/callback` |
| `MCP_TOKENS` | `alex:<token>` | Bearer-Token pro Benutzer für `/mcp` (mind. 32 Zeichen). Ohne Eintrag ist die Schnittstelle gesperrt. |
| `GITHUB_REPO`, `GITHUB_REF` | `owner/sprit`, `main` | Woher der Container den Code holt |
| `BIND_ADDR`, `HOST_PORT` | `0.0.0.0`, `8080` | Port auf dem Docker-Host (hinter einem Reverse-Proxy) |
| `FX_ENABLED` | `1` | `0` schaltet die automatische Kursabfrage ab |

Die Daten liegen in einer SQLite-Datei im Volume (`/home/node/data/sprit.db`).

## Lokal testen

```sh
DEV_LOGIN=1 ALLOWED_USERS=test:test@example.com node server.js
# dann http://localhost:8080/auth/dev?u=test öffnen
```

## MCP-Schnittstelle

`POST <PUBLIC_URL>/mcp` (Streamable HTTP, JSON-Antworten, zustandslos) mit `Authorization: Bearer <token>`.
Werkzeuge: `get_overview`, `add_vehicle`, `update_vehicle`, `list_fillups`, `add_fillup`, `update_fillup`, `delete_fillup`, `get_stats`.
Begrenzt auf 120 Anfragen pro Minute und Token.

## Deployment

`docker-compose.yml` startet `node:24-alpine`, lädt den Code als Tarball aus dem Repo und startet `server.js`.
Nach einem Push genügt ein Neustart des Containers.
