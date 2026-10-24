# garmin-sync

Mikroservis koji s Garmin Connect Personal API-ja povlači **san, HRV, dnevni wellness, treninge i
Fitness Age** u **vlastitu Postgres bazu**, računa jutarnju procjenu oporavka (🟢🟡🔴) i
**biološku dob**, šalje **Telegram** sažetak i radi **dnevni backup**.

| Container | Uloga |
|---|---|
| `db` | Postgres 16, vlastiti volume, port samo na `127.0.0.1` |
| `app` | sync daemon + biološka dob + Telegram |
| `grafana` | dashboard na http://localhost:3000 (read-only korisnik baze) |
| `backup` | `pg_dump` svaku noć u `./backups`, rotacija |

## Pokretanje (Mac, Docker Desktop)

```bash
cp .env.example .env          # GARMIN_API_KEY, POSTGRES_PASSWORD, GRAFANA_* (+ opcionalno BIRTH_DATE, TELEGRAM_*)
docker compose up -d --build
docker compose run --rm app node src/index.js backfill --from 2025-01-01   # povijest
```

Zatim http://localhost:3000.

## Naredbe

| Naredba | Što radi |
|---|---|
| `sync [--days 3]` | zadnjih N dana uključujući danas |
| `backfill --from YYYY-MM-DD [--to ...]` | povijest u komadima po 28 dana + preračun biološke dobi |
| `report [--days 14]` | tablica oporavka u terminalu |
| `bioage [--all]` | ponovno izračunaj biološku dob (npr. nakon promjene pragova) |
| `notify-test` | pošalji jutarnju Telegram poruku odmah |
| `daemon` | default u Dockeru – sync u `SYNC_TIMES` |

Pokreću se s `docker compose run --rm app node src/index.js <naredba>`.

## Što se događa svaki dan

1. U svakom `SYNC_TIMES` (default 09:30 i 21:30) povuku se zadnja 3 dana: san, HRV, wellness, aktivnosti, Fitness Age.
2. Preračuna se biološka dob za zadnjih 30 dana.
3. Nakon **prvog** termina (jutro) stiže Telegram sažetak: oporavak, HRV, puls, san, jučerašnji trening, biološka dob.
4. Upozorenja na Telegram (najviše jednom u 6 h po vrsti):
   - API ključ istekao/obrisan
   - sync završio s greškama
   - nema podataka o snu > 1 dan (sat nije sinkroniziran)
5. U 03:15 backup baze u `./backups` (čuva se 14 dana).

## Telegram

1. U Telegramu otvori **@BotFather** → `/newbot` → dobiješ token.
2. Pošalji svom botu bilo koju poruku, zatim otvori
   `https://api.telegram.org/bot<TOKEN>/getUpdates` i uzmi `chat.id`.
3. Upiši `TELEGRAM_BOT_TOKEN` i `TELEGRAM_CHAT_ID` u `.env`, `docker compose up -d app`,
   provjeri s `docker compose run --rm app node src/index.js notify-test`.

## Biološka dob

Transparentan model po uzoru na WHOOP Age – **procjena, ne medicinska mjera**. Najkorisniji je trend.

`bio_age = kronološka dob + Σ pomaka` na zadnjih **180 dana**; isti model na zadnjih **30 dana** daje
`bio_age_30d`, a razlika je **trend** (> 0 = zadnji mjesec lošiji od prosjeka).

| Metrika | Izvor | Pomak (godine) |
|---|---|---|
| Koraci/dan | wellness | < 4k +3 · < 6k +1,5 · < 8k +0,5 · < 10k 0 · < 12k −1 · više −1,5 |
| Mirovni puls | wellness | < 50 −2 · < 55 −1,5 · < 60 −1 · < 65 0 · < 70 +0,5 · < 75 +1,5 · više +3 |
| Sati sna | san | < 6 +2 · < 7 +0,5 · 7–9 0 · više +1 |
| Pravilnost sna (SD sredine sna) | san | < 30 min −0,5 · < 60 0 · < 90 +0,5 · više +1,5 |
| Intenzitet tjedno (umjerene + 2× intenzivne min) | wellness | < 75 +2 · < 150 +1 · < 300 0 · < 600 −1 · više −1,5 |
| Treninzi snage tjedno | aktivnosti | < 1 +1 · < 2 0 · ≥ 2 −1 *(tek kad se aktivnosti bilježe cijeli prozor)* |
| Garmin Fitness Age − dob | fitness age | pola razlike, max ±4 |

Kronološka dob: `BIRTH_DATE` iz `.env` → inače iz Garmin profila → inače iz Fitness Age.
Pragovi su u `src/bioage.js` (`MODEL`) – nakon izmjene pokreni `bioage --all`.

## Baza

Shema `garmin` (`sql/schema.sql`, primjenjuje se automatski i sigurno nadograđuje postojeću bazu):

| Tablica / view | Izvor |
|---|---|
| `sleep_daily` | `/sleep-service/sleep/dailySleepSummariesByDate` |
| `hrv_daily` | `/hrv-service/hrv/daily/{start}/{end}` |
| `wellness_daily` | `/usersummary-service/v2/dailysummaries` |
| `activities` | `/activitylist-service/activities/search/activities` (paginirano) |
| `fitness_age` | `/fitnessage-service/fitnessage/v2/{date}` (dnevno; u backfillu tjedno) |
| `bio_age_daily` | izračun (`src/bioage.js`) |
| `sync_log` | svaki sync: raspon, broj redaka, greške |
| `raw_payload` | sirovi odgovori za san/HRV/wellness |
| **`recovery_daily`** (view) | jutarnja procjena: HRV vs Garmin baseline, RHR vs 28d, san, jučerašnji trening |

```bash
psql "postgres://garmin:<lozinka>@127.0.0.1:5434/garmin" -c "select * from garmin.recovery_daily order by 1 desc limit 7"
```

## Dashboard (Grafana)

http://localhost:3000 – bez logina za gledanje; `admin` / `GRAFANA_ADMIN_PASSWORD` za uređivanje.
Grafana se spaja kao **`garmin_reader`** (read-only rola koju `app` kreira pri pokretanju).

Dashboard se **generira kodom**: `grafana/gen-dashboard.js` → `npm run dashboard` →
`grafana/dashboards/oporavak.json`. CI provjerava da su JSON i generator usklađeni.

## Backup i vraćanje

```bash
docker compose run --rm backup --once                      # ručni backup odmah
docker compose exec -T db pg_restore -U garmin -d garmin --clean --if-exists < backups/garmin-<datum>.dump
```

Za offsite kopiju povremeno prebaci `./backups` na šifrirani vanjski disk.

## CI/CD (GitHub Actions)

- **`build.yml`** – na push na `main`: `npm test` → provjera dashboarda → Docker image `linux/amd64`
  na `ghcr.io/<owner>/garmin-sync:latest` i `:<sha>`.
- **`deploy.yml`** – ručno (Actions → deploy → Run workflow): kopira compose/Grafanu/backup skriptu
  na server preko SSH-a, `docker compose pull` + `up -d`.

Secreti u repou: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.
Na serveru jednom ručno: `mkdir ~/garmin-sync` i u njega `.env` (secreti nikad ne idu kroz git).
Ako je port 3000 na serveru zauzet, u serverskom `.env` postavi drugi `GRAFANA_PORT`.
Grafani na serveru pristupaj preko WireGuarda ili SSH tunela (`ssh -L 3000:127.0.0.1:3000 mordor`).

> **Pazi:** pokreni daemon samo na jednom mjestu (Mac *ili* server) – inače oba troše isti API ključ
> i oba šalju Telegram poruke.

## Napomene

- **Token**: API ključ se mijenja za JWT (~24 h), obnavlja se sat prije isteka.
- **Training readiness** ne postoji u Personal API-ju; procjena oporavka je vlastita.
- Struktura Fitness Age odgovora nije javno dokumentirana – čita se defenzivno, cijeli odgovor je u `fitness_age.payload`.
