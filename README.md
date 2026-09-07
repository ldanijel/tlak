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

Kolekcije: `measurements`, `targets`, `devices`, `medications`, `events`, `settings`, `ocrModels`. Zapis se pohranjuje kao JSON (`data`) uz
`updated_at`, `deleted`, `rev`. Podatkovni model mjerenja slijedi točku 17 zahtjeva (id, measuredAt, timezone, systolic, diastolic, pulse,
source, period, sessionId, armLocation, bodyPosition, medicationTiming, deviceId, symptoms, tags, notes, includedInAverage, ocrConfidence,
createdAt, updatedAt) i ostaje mapljiv na HealthKit/Health Connect.

## Verzija 1.1

- **Fotografija:** okvir za zaslon tlakomjera mijenja veličinu ručicama na sva četiri kuta i sva četiri ruba te se pomiče povlačenjem;
  dvije žute horizontale (SYS | DIA | PULS) pomiču se neovisno. OCR više ne pogađa raspored po položaju, nego svaku od tri zone čita
  zasebno (više varijanta predobrade, oba modela, bira se najpouzdanije očitanje).
- **Kategorije tlaka (ESC, kućno mjerenje):** nepovišeni SYS < 120 i DIA < 70; povišeni SYS 120–134 ili DIA 70–84; visoki SYS ≥ 135 ili
  DIA ≥ 85. Kategoriju određuje lošija od dviju vrijednosti (118/71 je „povišeni”). Prikaz zeleno/žuto/crveno uvijek uz tekst i simbol
  (● ▲ ■). Pragovi su podesivi u Postavkama; raspodjela po kategorijama prikazuje se na Početnoj, u Analizi i u izvještaju; Povijest
  ima filtar po kategoriji. Osobni ciljni raspon ostaje kao dodatna, neobvezna oznaka.

## Verzija 1.2

- **Četiri kategorije:** nepovišeni / povišeni / visoki / **vrlo visoki** (≥ 180/120, podesivo). Kategorija „vrlo visoki” ujedno je
  sigurnosni prag: pri unosu traži potvrdu, savjetuje ponovljeno mjerenje i provjeru simptoma (112). Zasebni „sigurnosni pragovi” za
  gornje vrijednosti više ne postoje; ostaju upozorenja za niske vrijednosti i puls.
- **Pamćenje rasporeda zaslona po tlakomjeru:** u tijeku fotografije bira se tlakomjer (ili se novi dodaje na licu mjesta); pri potvrdi
  se pamte okvir (kao udjeli fotografije) i položaj horizontala, pa se pri idućoj fotografiji istog tlakomjera automatski postavljaju.
- **Učenje OCR-a po tlakomjeru** (`client/src/ocr/learn.ts`): svaka potvrda očitanja s fotografije uči aplikaciju kako izgledaju
  znamenke tog tlakomjera. Iz binarizirane zone (SYS, DIA, puls) izdvajaju se pojedinačne znamenke projekcijom po stupcima, svaka se
  normalizira u bitmapu 16×24 i sprema pod potvrđenom znamenkom (najviše 40 uzoraka po znamenki, najnoviji se zadržavaju). Kod idućeg
  čitanja znamenke se uspoređuju s naučenim predlošcima (najbliži susjed, Hammingova udaljenost); model je aktivan nakon ≥ 6
  potvrđenih znamenki, a pojedina znamenka vrijedi tek s ≥ 2 uzorka. Rezultat se spaja s Tesseractom: slaganje daje pouzdanost ≥ 90 %,
  neslaganje spušta pouzdanost na ≤ 60 % i traži ručnu provjeru; nikad se ne popunjava nepouzdana vrijednost. Uz to se broji koja
  kombinacija modela i predobrade daje točne rezultate za taj tlakomjer i ona dobiva prednost. Naučeno se sinkronizira s računom
  (kolekcija `ocrModels`, vezana uz `deviceId`), a briše se gumbom „Zaboravi OCR” na stranici Tlakomjeri. Fotografije se i dalje ne
  čuvaju, samo male bitmape znamenki.
  U E2E testu na sintetičkoj slici treća potvrđena fotografija daje 100 % pouzdanost na sva tri polja.

## Verzija 1.3

- **Docker slika iz GitHuba:** `.github/workflows/docker.yml` gradi i objavljuje `ghcr.io/ldanijel/tlak` (amd64 + arm64) pri svakom pushu
  na `main` i za oznake `v*`. Deploy je tada `docker run -p 3000:3000 -v tlak-data:/data ghcr.io/ldanijel/tlak:latest` ili `fly deploy`
  s priloženim `fly.toml`.
- **Položaj znamenki po tlakomjeru:** uz predloške, model pamti prosječan položaj i visinu znamenki u svakoj zoni. Pri čitanju se prije
  spajanja rezultata provjerava odstupanje (visina ± 35 %, pomak po visini > 22 %, vodoravni pomak > 25 %) i korisnik dobiva upozorenje
  „okvir ili horizontala vjerojatno su pomaknuti” s uputom što pomaknuti.
- **Otpornost na ikone na zaslonu** (Beurer BM38 ima ikonu ruke uz DIA i srce uz puls): znamenke su na LCD-u poravnate udesno, pa se
  uzimaju najdesniji glifovi usklađene visine; treći (lijevi) glif prihvaća se kao znamenka samo ako pouzdano sliči naučenoj znamenki ili
  je uzak (znamenka „1”). Isto pravilo vrijedi i pri učenju.
- **Ispitni alat za stvarne fotografije:** `node --experimental-strip-types client/scripts/ocr-eval.mjs <mapa>` čita JPEG/PNG datoteke
  nazvane `SYS-DIA-PULS.jpg` (ime je istina) uz `layout.json` s okvirom i horizontalama, pokreće isti cjevovod kao aplikacija (bez
  preglednika) i ispisuje točnost Tesseracta, naučenog modela (leave-one-out) i kombinacije. Mapa `client/test/fixtures/real/` je u
  `.gitignore` jer su fotografije osobni podaci.

## Verzija 1.4

- Puls je neobvezan (prazno polje, `pulse: null`; prosjeci i graf ga preskaču, CSV ga izvozi prazno i uvozi prazno).
- Unos u jednoj boji; pri prikazu SYS i DIA obojeni svaki svojom ESC kategorijom (zeleno / žuto / crveno / tamnocrveno),
  puls neutralno. Na grafu točke nose boju kategorije, linije su neutralne.
- Razdoblja D / T / M / 3M / 6M / G (dan, 7, 30, 90, 180, 365 dana) kao kratki izbornik na Početnoj, u Analizi i Izvještaju.
- Povijest: „Izbriši više…” sa SVE / SVE OD: / SVE DO: / RASPON OD–DO, s brojem pogođenih i gumbom „Vrati”.
- Postavke: „Tvornički reset” ovog uređaja (potvrda riječju RESET); podaci na računu ostaju.
- Stranica `/upute` za ukućane, s dijeljenjem linka iz Postavki.
- Naučeni OCR model vidljivo na računu: stranica Tlakomjeri uz svaki model prikazuje „☁ spremljeno na račun” / „⏳ čeka
  sinkronizaciju” / „📱 samo na ovom uređaju”; stranica Račun broji naučene OCR modele na poslužitelju. Nakon uspješnog slanja
  promjena sinkronizacija odmah osvježava lokalno stanje (`store.unsynced`). Odabir tlakomjera dostupan je i na ekranu potvrde
  (kad je zaslon pronađen automatski, bez ručnog izreza).

## Verzija 1.5

- Automatski izrez više se ne prihvaća slijepo: nakon automatskog pronalaženja zaslona (i nakon zapamćenog rasporeda) očitanje
  vrijedi samo ako su SYS i DIA pročitani s pouzdanošću ≥ 55 %, bez upozorenja o pomaknutom okviru i uz SYS > DIA. Inače se
  pokušava idući izvor (auto → zapamćeni raspored → ručni izrez), a ekran izreza objašnjava zašto je otvoren.
- Učenje samo iz pouzdanih izreza: ručno postavljen okvir ili automatski izrez u kojem je OCR pogodio bar SYS ili DIA. Iz
  nepouzdanog izreza uče se samo zone koje je OCR pogodio, raspored se ne pamti, a korisnik dobiva poruku da se iz te fotografije
  nije učilo. Time pogrešan automatski izrez ne kvari naučeni model.
- EXIF datum fotografije koristi se i kad je zaslon pronađen automatski (prije samo pri ručnom izrezu).
- Postavke → O aplikaciji prikazuje stvarnu verziju iz `package.json` (`__APP_VERSION__`), vrijeme izgradnje i verziju
  poslužitelja (`/api/health` vraća `version`), uz gumb „Provjeri ažuriranje”. Nova verzija se i dalje preuzima sama
  (autoUpdate), a provjera se ponavlja svakih sat vremena i pri svakom povratku u aplikaciju.
- Auto-detekcija u dva prolaza (`autodetect.ts`): ako na cijeloj fotografiji nema tri reda znamenki, velike šuplje
  komponente (okvir LCD-a) obrađuju se iznutra, s vlastitim pragom i relativnim (Weberovim) kontrastom
  (`preprocessGray({ relative: true })`), jer na cijeloj fotografiji prag određuju najtamniji dijelovi (crijevo, sjene),
  a sivi LCD sa znamenkama u sjeni ispadne razlomljen. Okvir s rubom smije prijeći granice unutrašnjosti; obrezuje se
  na kraju, s preračunom horizontala.
- Auto-detekcija, drugi krug ispravaka (dijagnostika 111/90/63): tanke visoke šipke (traka u boji uz zaslon) nisu
  sjeme reda, jer bi spojile redove DIA i puls; dio znamenke ide u red s najvećim okomitim preklapanjem, a ne u prvi
  koji sadrži njegovo središte; ćelija znamenke spaja dijelove samo ako se okomito (gotovo) dodiruju (srce ispod „9”
  ostaje ikona); redovi pročitani na različitim binarizacijama spajaju se po znamenkama (jedna nađe lijevu „1”, druga
  srednju). Kad ništa nije pročitano, a okvir zaslona postoji, on je početni okvir za ručni izrez umjesto zadanog
  okvira na sredini fotografije.
- Auto-detekcija, treći krug (dijagnostika 134/86/87): unutrašnjost okvira zaslona obrađuje se i produženo prema dolje
  za 30 % visine okvira (donji rub LCD-a često je zasebna komponenta, pa okvir ne obuhvaća red pulsa); bez reda pulsa
  okvir ide 1,5 visine DIA-e ispod DIA-e; debela „8” ima udio tinte do ~0,8, pa se ćelija odbacuje kao puna mrlja tek
  iznad 0,85. Glavni cjevovod: znamenke koje dodiruju gornji ili donji rub zone smatraju se odrezanima i ne popunjavaju
  polje ispod 70 % pouzdanosti (prije je odrezana „87” pročitana kao „97”).
- Auto-detekcija, četvrti krug (dijagnostika 124/90/65, dnevno svjetlo): okvir se obrađuje u tri varijante s istim
  ishodištem (unutrašnjost bez ruba, produženo dolje, cijeli prošireni izrez – kad „okvir” nije rub zaslona nego sam
  blok znamenki), svaka i relativnim i apsolutnim kontrastom (relativni na svijetlom LCD-u gubi slabije desne
  segmente); preširoka ćelija dijeli se na najpraznijem stupcu nedilatirane tinte („1” i „2” spojene dilatacijom).
- Trajni testni primjeri: `client/test/fixtures/real/SYS-DIA-PULS.jpg` (fotografije BM38 umanjene na 800 px) i test
  `client/test/autodetect.test.ts`, koji za svaku traži tri reda i točne vrijednosti bez ručnog izreza.
- Ekran potvrde: polje se samo popunjava samo pri pouzdanosti ≥ 70 %; slabije očitanje nudi se kao gumb
  „OCR predlaže N (x %) – prihvati”, pa se kriva vrijednost ne može potvrditi nehotice.
- Dijagnostika: umanjena fotografija 1200 px (bilo 800) i `layout.trace` – što je auto-detekcija našla (redovi, okvir)
  i za svaki OCR pokušaj (auto / zapamćeni raspored / ručno) očitanja i je li prošao provjeru pouzdanosti.
- Odrezanost i vodoravno: zadnja znamenka koja dodiruje desni rub zone (zapamćeni raspored preuzak za novi kadar)
  označava očitanje nepouzdanim. Prag samostalnog popunjavanja polja: 70 %, a 60 % kad je naučeni model aktivan.
- Auto-detekcija, peti krug (dijagnostika 132/88/81 i udaljena 141/95/61): granice veličine znamenke u prolazu po
  okviru vežu se uz visinu cijele fotografije, a ne uz visinu izreza (u niskom izrezu SYS/DIA znamenke su ispadale
  kao „prevelike”); unutrašnjost okvira produžuje se prema dolje za 60 % visine. Vrijednosti koje je auto-detekcija
  sama dekodirala ulaze kao prijedlog (60 %) gdje glavni cjevovod ne pročita polje, umjesto slanja na ručni izrez.
  Šesti trajni primjer: `132-88-81.jpg`.
- Savjet o udaljenosti: kad je automatski pronađeni zaslon uži od trećine širine kadra, ekran potvrde (i ručni izrez)
  pokazuje poruku s postotkom i uputom da se pri sljedećem snimanju približi; pri dobrom kadru poruke nema.
- Inverzija polariteta samo kad je uz nisku srednju svjetlinu i svijetli rep histograma jači od tamnog: tamni LCD u
  sjeni (BM38, zona pulsa) s još tamnijim znamenkama više se ne invertira (prije je to zonu pulsa pretvaralo u mrlje).
- Nakon rezanja svijetlog ruba (`trimDisplay`) horizontale se preračunaju na novu visinu.
- Segmentacija: dijeljenje preširokog glifa na najpraznijem stupcu ponavlja se (tri kose znamenke spojene u jedan niz),
  a već odvojeni komad dijeli se dalje samo ako mu je omjer širine i visine > 0,8.
- Tesseractov pogodak s pouzdanošću < 25 % ne popunjava polje.
- Dijagnostika OCR-a (verzija 2) uključuje umanjenu cijelu fotografiju, podrijetlo izreza, međurezultate automatskog
  pronalaženja i potpune bitmape naučenih znamenki.

## Pozivni kod i preporučeni hosting (Fly.io)

- `INVITE_CODE` (varijabla okoline ili `fly secrets set INVITE_CODE=…`): kad je postavljen, registracija traži pozivni kod, pa račun
  mogu otvoriti samo osobe kojima ga date (do 10 ukućana, svatko sa svojim podacima). `/api/health` vraća `inviteRequired`.
- Korak-po-korak upute za netehničara: **`docs/UPUTE-Fly.io.docx`**. Put A ne traži nikakvu instalaciju: objavu obavlja GitHub Action
  `.github/workflows/fly-deploy.yml` (Actions → „Objavi na Fly.io” → Run workflow) uz tajne `FLY_API_TOKEN` i `INVITE_CODE` te
  varijablu `FLY_APP_NAME`; pri pushu na `main` objavljuje se automatski. Put B koristi `flyctl` lokalno.

## Pristup s iPhonea i pokretanje na Windowsu

**Windows (PowerShell):** instalirajte Node.js 22 LTS (installer s nodejs.org, uključite „Add to PATH”), zatim:

```powershell
git clone https://github.com/ldanijel/tlak.git
cd tlak
npm install
npm run build
npm start
```

Otvorite `http://localhost:3000`. Baza je u `data\tlak.db`. Pri prvom pokretanju Windows Defender pita za dopuštenje mreže;
dopustite privatne mreže ako želite pristup s telefona. Poslužitelj radi dok je PowerShell prozor otvoren; za trajni rad koristite
`docker compose up -d` (Docker Desktop) ili Windows Service (npr. NSSM).

**iPhone – probni pristup u kućnoj mreži:** iPhone i računalo na istom Wi-Fiju; na računalu `ipconfig` (Windows) ili
`ipconfig getifaddr en0` (Mac) daje IP, npr. `192.168.1.20`. U Safariju otvorite `http://192.168.1.20:3000`. Unos, fotografiranje i
sinkronizacija rade. Ograničenja preko običnog HTTP-a: nema instalacije kao PWA s offline radom i preglednik može odbiti dijeljenje
datoteka. Za ozbiljno korištenje potreban je HTTPS.

**iPhone – trajni pristup (HTTPS), tri načina:**

1. *VPS + Docker + Caddy (preporučeno):* na VPS-u s domenom `docker compose up -d --build`, a ispred Caddy s `reverse_proxy localhost:3000`
   (automatski Let's Encrypt certifikat). Postavite `TRUST_PROXY=1`. Na iPhoneu otvorite `https://vasa-domena` → Dijeli → „Dodaj na
   početni zaslon”. Nakon registracije postavite `ALLOW_REGISTRATION=false`.
2. *Vlastito računalo + tunel:* Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) daje javni HTTPS URL bez otvaranja
   portova. Računalo mora biti upaljeno kad želite sinkronizirati; lokalni unos na telefonu radi i bez toga.
3. *Tailscale:* privatna mreža između telefona i računala; `tailscale serve 3000` daje HTTPS adresu unutar vaše mreže.

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
