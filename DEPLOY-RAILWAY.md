# Deploy Price Tracker pe Railway

## 1. Pregatire

Ai nevoie de:
- Cont GitHub (deja ai)
- Cont Railway (railway.app) — gratuit cu $5/luna credit
- Cont email SMTP (Gmail, SendGrid, sau Mailgun)

## 2. Creeaza repo GitHub

1. Creeaza un repo nou pe GitHub (ex: `zebratur-price-tracker`)
2. Pune in repo fisierele din folderul `price-tracker/`:
   - `server.js`
   - `package.json`
   - `Procfile`
   - `.env.example` (pentru referinta)
3. **NU pune** `.env` in repo (contine parole!)

## 3. Deploy pe Railway

1. Du-te la https://railway.app si logheaza-te cu GitHub
2. Click **"New Project"** > **"Deploy from GitHub repo"**
3. Alege repo-ul `zebratur-price-tracker`
4. Railway va face automat build si deploy

## 4. Configureaza variabilele de mediu

In Railway dashboard > proiectul tau > **Variables**, adauga:

```
PORT=3000
ALLOWED_ORIGINS=https://zebratur.md,https://www.zebratur.md,https://export.otpusk.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=email-ul-tau@gmail.com
SMTP_PASS=parola-aplicatie-gmail
EMAIL_FROM=ZebraTur <noreply@zebratur.md>
PRICE_CHANGE_THRESHOLD=3
CHECK_INTERVAL_HOURS=1
AGENCY_NAME=ZebraTur
AGENCY_SITE=https://zebratur.md
AGENCY_PHONE=078 326 222
```

### Pentru Gmail SMTP:
1. Du-te la https://myaccount.google.com/apppasswords
2. Creeaza o "App Password" pentru "Mail"
3. Foloseste acea parola ca `SMTP_PASS` (nu parola contului!)

## 5. Obtine URL-ul public

In Railway dashboard > proiectul tau > **Settings** > **Networking**:
- Click **"Generate Domain"**
- Vei primi un URL ca: `https://zebratur-price-tracker-production.up.railway.app`

## 6. Actualizeaza frontend-ul

In fisierul `price-watcher.js`, schimba linia:

```javascript
var PW_API_URL = 'https://YOUR-APP.up.railway.app';
```

cu URL-ul tau real de la Railway:

```javascript
var PW_API_URL = 'https://zebratur-price-tracker-production.up.railway.app';
```

## 7. Adauga frontend-ul pe site

In HTML-ul site-ului, adauga:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/USER/REPO@COMMIT/price-watcher.css">
<script src="https://cdn.jsdelivr.net/gh/USER/REPO@COMMIT/price-watcher.js"></script>
```

## 8. Testeaza

1. Deschide site-ul
2. Cauta un tur si salveaza-l in wishlist
3. Apasa "Urmareste pretul"
4. Introdu email-ul
5. Verifica ca primesti email de confirmare

API-ul raspunde la:
- `GET /` — status server
- `POST /api/watch` — subscrie la urmarire pret
- `GET /api/my-watches?email=...` — vezi tururile urmarite
- `POST /api/check-now` — ruleaza verificarea manual (pentru teste)

## 9. Verificare pret (IMPORTANT)

Functia `fetchCurrentPrice()` din `server.js` trebuie adaptata la API-ul Otpusk.
In forma actuala, incearca:
1. API Otpusk direct (daca tour_id e numeric)
2. Scraping de pe pagina turului

Daca preturile nu se actualizeaza, va trebui sa adaptezi aceasta functie
la modul in care Otpusk returneaza datele de pret.
