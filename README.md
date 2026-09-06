# Tlak – web-aplikacija za osobno praćenje krvnog tlaka

Instalabilna progresivna web-aplikacija (PWA) za bilježenje SYS/DIA/pulsa, pregled trendova i izradu izvještaja za liječnika,
prema korisničkom zahtjevu v1.0 (6. 9. 2026.), **uz nadopunu: online pohrana u bazi dostupnoj s više uređaja uz korisnički račun.**

Primarna platforma: iPhone/Safari (dodaj na početni zaslon). Radi i na Androidu/Chromeu i na stolnim računalima. Sučelje je na hrvatskom,
datum `dd.mm.gggg.`, 24-satno vrijeme, mmHg i otkucaji/min, tamni način rada, dodirne kontrole ≥ 44 px.

## Arhitektura

```
tlak/
├─ client/   Vite + React + TypeScript PWA (IndexedDB, service worker, lokalni OCR)
├─ server/   Node 22 + Express API (ugrađeni node:sqlite, bez nativnih ovisnosti)
├─ Dockerfile, docker-compose.yml, .env.example
└─ .github/workflows/ci.yml
```

**Offline-first.** Svi zapisi žive u IndexedDB-u u pregledniku; aplikacija u cijelosti radi bez mreže nakon prvog učitavanja
(precache ~12 MB uključuje OCR modele). Poslužitelj je opcionalan: bez računa podaci ostaju samo na uređaju.

**Sinkronizacija više uređaja.** Nakon prijave (e-pošta + lozinka) svaki lokalni zapis dobiva zastavicu `dirty` i šalje se na
`POST /api/sync`; poslužitelj vraća sve promjene od zadnjeg poznatog `rev`. Sukob se rješava pravilom *zadnja izmjena pobjeđuje*
(`updatedAt`, ISO UTC). Brisanja su meka (tombstone), pa se propagiraju na sve uređaje, a zapis se može vratiti. Sinkronizacija se
pokreće pri učitavanju, povratku u prvi plan, povratku mreže, promjeni stranice (ako je prošlo > 20 s), 1,5 s nakon svake lokalne izmjene i svakih 5 min.

**Sigurnost računa.** Lozinke: scrypt (N = 2¹⁵) sa soli. Sesije: nasumični 256-bitni token, na poslužitelju samo SHA-256 sažetak,
trajanje 180 dana, po uređaju (popis i odjava pojedinog uređaja u Postavkama). Promjena lozinke odjavljuje ostale uređaje.
Ograničenje pokušaja prijave po IP-u i e-pošti. Registracija se može zatvoriti (`ALLOW_REGISTRATION=false`). Brisanje računa briše sve
podatke na poslužitelju.

**Što se nikad ne šalje na poslužitelj:** fotografije tlakomjera (OCR je u cijelosti lokalan, fotografija se nakon potvrde odbacuje) i PIN
aplikacije (samo lokalno). Mjerenja, bilješke, ciljevi, terapija i događaji šalju se **samo** ako je korisnik prijavljen, što je izričita
nadopuna zahtjeva (točke 3 i 16.2 izvornog dokumenta traže isključivo lokalnu pohranu). Promet treba ići preko HTTPS-a (reverse proxy).

## Pokretanje

Zahtjevi: Node ≥ 22.13 (koristi ugrađeni `node:sqlite`).

```bash
npm install
npm run build          # gradi PWA u client/dist (kopira Tesseract worker/WASM u client/public/tesseract)
npm start              # API + statička aplikacija na http://localhost:3000, baza u ./data/tlak.db
```

Razvoj (dva procesa, Vite proxy prosljeđuje `/api` na 3000):

```bash
npm run dev:server     # http://localhost:3000
npm run dev            # http://localhost:5173
```

Testovi i provjera tipova: `npm test`, `npm run typecheck`.

Docker: `docker compose up -d --build` (baza u volumenu `tlak-data`). Varijable okoline: vidi `.env.example`.
Ispred aplikacije postavite reverse proxy s TLS-om (Caddy/nginx/Traefik) i `TRUST_PROXY=1`.

## API (sažetak)

| Metoda | Putanja | Opis |
|---|---|---|
| GET | `/api/health` | stanje, je li registracija otvorena |
| POST | `/api/auth/register` / `login` / `logout` | račun i sesije (`Authorization: Bearer <token>`) |
| GET | `/api/auth/me` | korisnik, prijavljeni uređaji, broj zapisa |
| POST | `/api/auth/password` | promjena lozinke (odjavljuje ostale uređaje) |
| DELETE | `/api/auth/sessions/:id` | odjava drugog uređaja |
| DELETE | `/api/auth/account` | brisanje računa i svih podataka |
| POST | `/api/sync` | `{ since, changes[] }` → `{ rev, more, applied, rejected, changes[] }` |

Kolekcije: `measurements`, `targets`, `devices`, `medications`, `events`, `settings`. Zapis se pohranjuje kao JSON (`data`) uz
`updated_at`, `deleted`, `rev`. Podatkovni model mjerenja slijedi točku 17 zahtjeva (id, measuredAt, timezone, systolic, diastolic, pulse,
source, period, sessionId, armLocation, bodyPosition, medicationTiming, deviceId, symptoms, tags, notes, includedInAverage, ocrConfidence,
createdAt, updatedAt) i ostaje mapljiv na HealthKit/Health Connect.

## Pokrivenost zahtjeva

Faza 1 (MVP) – implementirano: instalabilna PWA; lokalna pohrana; ručni unos (numerička tipkovnica, SYS→DIA→puls→Spremi, prijedlog
jutro/večer, poništavanje nakon spremanja); fotografiranje (`capture="environment"`) i izbor fotografije (HEIC/JPEG/PNG, izrezivanje,
rotacija, EXIF datum iz JPEG-a uz jasan prikaz); lokalni OCR s predobradom (siva skala, median, kontrast, inverzija, Otsu) i obveznom
ručnom potvrdom (niska pouzdanost i vrijednosti izvan raspona nikad se ne popunjavaju automatski); validacija (cijeli brojevi, SYS > DIA s
prijedlogom zamjene, tehnički raspon uz potvrdu, isti trenutak, duplikat u 15 min); sigurnosne poruke s uputom i 112 (pragovi odvojeni
od osobnog cilja, konfigurabilni); uređivanje, dupliciranje, brisanje s potvrdom i vraćanjem; povijest s filtrima; grafovi SYS/DIA (ciljna
zona po razdobljima važenja, prekid linije kod nedostajućih dana, oznake događaja, opcionalni 7-dnevni pomični prosjek, tooltip) i odvojeni
graf pulsa; jutarnji/večernji prosjeci; osobni ciljni raspon s poviješću i datumom početka, zasebne granice za jutro/večer; sesije
(prozor 10 min, prosjek, raspon, uključi/isključi s vidljivim razlogom); izvedeni pokazatelji označeni kao izračun; izvještaj za liječnika
(ispis/PDF preko sustavskog dijaloga na iPhoneu, CSV `;` s BOM-om, JSON kopija) i dijeljenje putem Web Share API-ja; uvoz JSON-a
(pregled broja zapisa i razdoblja, spajanje ili zamjena) i CSV-a prema predlošku (pregled, detekcija duplikata); šifrirana kopija
(AES-GCM, PBKDF2); podsjetnik na kopiju; PIN zaključavanje s automatskim zaključavanjem; potpuni rad bez mreže.

Faza 2 – uključeno: sesije mjerenja, evidencija terapije i promjena doze, važni događaji na grafu, kontrolna lista prije mjerenja (isključiva).

Nije uključeno (poznata ograničenja):
- podsjetnici (Web Push zahtijeva poslužiteljski VAPID kanal i dopuštenja; planirano za iduću verziju),
- Face ID/Touch ID (WebAuthn) – dostupan je PIN,
- korekcija perspektive fotografije (korisnik izrezuje zaslon ručno, s vodičem SYS/DIA/PULS),
- Apple Health XML uvoz, Bluetooth, izvorni HealthKit/Health Connect moduli (faza 3),
- E2E šifriranje podataka na poslužitelju (podaci su vezani uz račun i zaštićeni prijavom i TLS-om, ali administrator poslužitelja ih tehnički može pročitati).

**OCR napomena.** Koriste se dva lokalna modela: `letsgodigital` (sedmerosegmentne znamenke, legacy engine) i `eng` (oznake SYS/DIA/PUL).
Na sintetičkom testu model ispravno čita ravno snimljene znamenke; pouzdanost na stvarnim fotografijama (odsjaj, kut, model
tlakomjera) treba provjeriti na testnom skupu od ≥ 50 fotografija prema točki 20 zahtjeva i po potrebi kalibrirati predobradu.

## Prihvatni kriteriji – kako provjeriti

- ručni unos ≤ 15 s: `Novo` → tri broja → Spremi (fokus i tipkovnica automatski),
- grafovi i CSV daju iste prosjeke: test `client/test/lib.test.ts` (`dailyAverages` vs. uvezeni CSV),
- JSON kopija vraća sve bez gubitka: Postavke → Sigurnosna kopija → Zamijeni,
- dva uređaja: prijava istim računom na drugom uređaju; promjene i brisanja stižu unutar nekoliko sekundi (E2E scenarij je izveden Playwrightom).
