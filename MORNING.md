# Ráno — co dělat

## ✅ Co se v noci stalo

15+ commitů, hlavní vylepšení po posledním screenshotu:

### Auth + multi-user
- 2 účty (`vodvarka@grevo.cz`, `gregor@grevo.cz`, oba heslo `Grevo!32462`)
- Per-user Bunny settings (každý si nastavuje vlastní Storage Zone)
- Per-user knihovna — Vodvárka nevidí Gregora a naopak
- Login obrazovka, logout v sidebaru
- Build SHA v sidebaru (vidíš, jestli máš nejnovější verzi)

### Top-tier video editor
- **Thumbnail strip** na timeline (16 frame snímků z videa)
- **Audio waveform** přes celou timeline (Web Audio decode)
- **Klávesové zkratky** — `?` v editoru zobrazí všechny:
  - Space/K play/pauza, J/L ±5s, ←→ frame step, Shift+arrow ±1s
  - I mark in, O mark out, C cut, Delete remove cut
- **Speed control** 0.5× / 1× / 1.25× / 1.5× / 2×
- **Click-to-scrub** timeline (klikni kdekoliv = playhead jump)
- **„Najít ticho"** — auto-detekce delších pauz a navržení cuts
- **Persistent panel** — trim editor vždy nad videem (nemusíš klikat „Střih")

### Recording UX
- **Full-screen preview** během nahrávání (vidíš co nahráváš na celé ploše)
- Time/status overlay nahoře, controls dole, kamera v rohu
- Self-hosted ffmpeg.wasm → MP4 konverze funguje spolehlivě (~31 MB cache po prvním spuštění)
- Lepší error messaging (žádné „undefined")

### Library
- Filter `Vše / Na Bunny / Lokální` s počty
- Sort: Nejnovější / Nejstarší / Největší / Nejdelší
- Cloud badge u nahraných videí
- Search by name

### Infrastructure
- nginx no-cache pro index.html + CDN-Cache-Control (Bunny CDN respektuje)
- Vite injects BUILD_SHA + BUILD_DATE
- Proxy v multi-tenant módu — credentials per request, nic se na serveru neukládá

## 🚨 1 manuální krok

GHCR má nejnovější image. **Bunny pořád servuje starý** — potřebujeme update container:

1. https://dash.bunny.net → tvoje Magic Containers appka
2. **app** container → **Edit** → **Update Container** (klikni Save bez změn)
3. To samé pro **records-by-grevo-proxy** (i když ten už je multi-tenant, refresh nezaškodí)
4. Počkej ~30s na rolling update

**Verifikace:**
- Otevři https://grevo-records.bunny.run/ v Chrome (`Cmd+Shift+R` hard refresh)
- V sidebaru vlevo dole uvidíš SHA — měl by být `69a333a` nebo novější
- Pokud stejný starý → ještě 1× hard refresh, případně otevři v anonymním okně

## ⚙️ Setup po deployi

1. **Login**: `vodvarka@grevo.cz` / `Grevo!32462`
2. **Settings** → vyplň znovu Bunny:
   - Storage Zone: `jan-vodvarka-apps`
   - Region: Falkenstein
   - Access Key: ten rotovaný (zadej PŘÍMO v UI)
   - Pull Zone: `https://jan-vodvarka-apps.b-cdn.net`
   - Folder: `recordings/`
   - Bunny upload: ON
   - **Otestovat** → mód `multi-tenant` ✅
   - Uložit
3. **Pošli Gregorovi**:
   - URL: https://grevo-records.bunny.run/
   - Login: `gregor@grevo.cz` / `Grevo!32462`
   - V Settings si vyplní svoje Bunny údaje sám

## 🎬 Test plán

- [ ] Login funguje
- [ ] Settings první otevření prázdné (per-user), vyplníš
- [ ] Test connection → multi-tenant ✅
- [ ] Nahraj 10–15 s s mikrofonem (vyzkoušej pauzy mezi mluvením)
- [ ] Při nahrávání vidíš full-screen preview
- [ ] Po stop: progress bar konverze → MP4
- [ ] V Preview: thumbnaily + waveform na timeline
- [ ] Stiskni `?` → zobrazí klávesové zkratky
- [ ] Zkus `Space`, `J`/`L`, `←`/`→`, `C`
- [ ] Klikni **„Najít ticho"** — automaticky navrhne cuts
- [ ] Klikni **„Uložit střih jako novou"** → vznikne nová zkrácená verze
- [ ] V Library: filter „Lokální" → vidíš obě verze (originál + trimmed)
- [ ] Klikni **„Nahrát na Bunny"** → progress → zelený panel s linkem
- [ ] Zkopíruj link, otevři v anonymním okně → MP4 se přehraje
- [ ] V Library: filter „Na Bunny" → trimmed má cloud badge

## 💡 Volitelný auto-deploy

Aby každý git push auto-aktualizoval Bunny:

1. Bunny dashboard → Account Settings → API → **Add API Key**
2. https://github.com/grevo-cz/grevo-records/settings/secrets/actions:
   - **Secret**: `BUNNYNET_API_KEY` = ten klíč
3. https://github.com/grevo-cz/grevo-records/settings/variables/actions:
   - `BUNNY_SPA_APP_ID` = APP_ID z URL Bunny dashboardu
   - `BUNNY_SPA_CONTAINER` = `app`
   - `BUNNY_PROXY_APP_ID` = stejný APP_ID
   - `BUNNY_PROXY_CONTAINER` = `records-by-grevo-proxy`

Pak `git push` = automatický rolling update v Bunny.

## 🐛 Pokud něco selže

- **„Site can't be reached"** → DNS cache (Cmd+Shift+R, nebo `sudo dscacheutil -flushcache`)
- **Login nefunguje** → musí být HTTPS (lokálně přes `localhost` taky funguje)
- **MP4 konverze fail** → otevři DevTools Network, ověř že `/ffmpeg/ffmpeg-core.wasm` se načítá (200, ne 404)
- **Upload „Síťová chyba"** → CORS — zkontroluj že `ALLOWED_ORIGINS=*` v proxy env vars
- **Bunny zobrazuje starý design** → Update Container nebyl proveden, opakuj krok 1 výše

## 📦 Repo

https://github.com/grevo-cz/grevo-records

Commit history je čistý a popsaný. Hláška `dev` v sidebaru = lokální dev build, jakýkoliv 7-znakový hex = GHA build.
