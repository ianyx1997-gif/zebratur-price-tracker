/* ============================================================
   ZEBRATUR – PRICE TRACKER SERVER
   Node.js backend for tracking tour prices & sending email/telegram alerts
   Deploy on Railway, Render, or any Node.js hosting
   ============================================================ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const { initTelegramBot } = require('./telegram-bot');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CORS =====
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
    callback(null, false);
  }
}));
app.use(express.json());

// ===== DATABASE (SQLite — stored on disk, survives restarts) =====
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'pricetracker.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS watchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    tour_id TEXT NOT NULL,
    tour_name TEXT,
    tour_url TEXT,
    tour_img TEXT,
    initial_price REAL NOT NULL,
    current_price REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    geo TEXT,
    dates TEXT,
    stars INTEGER,
    food TEXT,
    search_params TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_checked DATETIME,
    last_notified DATETIME,
    active INTEGER DEFAULT 1,
    UNIQUE(email, tour_id)
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id TEXT NOT NULL,
    price REAL NOT NULL,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watcher_id INTEGER,
    old_price REAL,
    new_price REAL,
    change_pct REAL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (watcher_id) REFERENCES watchers(id)
  );
`);

// Telegram pre-registration table (stores tour data before user opens deep link)
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_pending (
    token TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add search_params column if missing
try {
  db.exec(`ALTER TABLE watchers ADD COLUMN search_params TEXT`);
  console.log('[DB] Added search_params column');
} catch(e) {
  // Column already exists
}

// Prepared statements
const insertWatcher = db.prepare(`
  INSERT OR REPLACE INTO watchers (email, tour_id, tour_name, tour_url, tour_img, initial_price, current_price, currency, geo, dates, stars, food, search_params)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getActiveWatchers = db.prepare(`SELECT * FROM watchers WHERE active = 1`);

const updateWatcherPrice = db.prepare(`
  UPDATE watchers SET current_price = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?
`);

const markNotified = db.prepare(`
  UPDATE watchers SET last_notified = CURRENT_TIMESTAMP WHERE id = ?
`);

const deactivateWatcher = db.prepare(`UPDATE watchers SET active = 0 WHERE id = ?`);

const insertPriceHistory = db.prepare(`
  INSERT INTO price_history (tour_id, price) VALUES (?, ?)
`);

const insertNotificationLog = db.prepare(`
  INSERT INTO notifications_log (watcher_id, old_price, new_price, change_pct) VALUES (?, ?, ?, ?)
`);

const getWatchersByEmail = db.prepare(`SELECT * FROM watchers WHERE email = ? AND active = 1`);

const getWatcherById = db.prepare(`SELECT * FROM watchers WHERE id = ?`);

const getPriceHistory = db.prepare(`
  SELECT * FROM price_history WHERE tour_id = ? ORDER BY checked_at DESC LIMIT 30
`);

// ===== EMAIL TRANSPORT =====
// Priority: RESEND_API_KEY (HTTP API, works on Railway) > SMTP (may be blocked)
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
let transporter = null;

if (RESEND_API_KEY) {
  console.log('[Email] Resend API configured (HTTP-based, no SMTP needed)');
} else if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: parseInt(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  console.log('[Email] SMTP transport configured: ' + process.env.SMTP_HOST);
} else {
  console.log('[Email] WARNING: No email configured. Emails will be logged only.');
}

// Send email via Resend HTTP API
async function sendViaResend(to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'ZebraTur <onboarding@resend.dev>',
      to: [to],
      subject: subject,
      html: html
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.message || JSON.stringify(data));
  }
  return data;
}

const AGENCY = {
  name: process.env.AGENCY_NAME || 'ZebraTur',
  site: process.env.AGENCY_SITE || 'https://zebratur.md',
  phone: process.env.AGENCY_PHONE || '078 326 222'
};

const THRESHOLD = parseFloat(process.env.PRICE_CHANGE_THRESHOLD) || 3;

// ===== SEND EMAIL =====
async function sendPriceAlert(watcher, oldPrice, newPrice, changePct) {
  const isDecrease = newPrice < oldPrice;
  const direction = isDecrease ? 'scazut' : 'crescut';
  const emoji = isDecrease ? '📉' : '📈';
  const color = isDecrease ? '#16a34a' : '#ef4444';
  const actionText = isDecrease
    ? 'Pretul a scazut! Rezerva acum pentru a profita de oferta.'
    : 'Pretul a crescut. Rezerva cat mai curand inainte sa creasca si mai mult.';

  const subject = `${emoji} Pretul a ${direction} cu ${Math.abs(changePct).toFixed(1)}% — ${watcher.tour_name}`;

  const unsubLink = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:' + PORT}/api/unsubscribe/${watcher.id}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:20px;">
      <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
        ${watcher.tour_img ? `<img src="${watcher.tour_img}" alt="${watcher.tour_name}" style="width:100%;height:250px;object-fit:cover;">` : ''}
        <div style="padding:24px;">
          <h2 style="margin:0 0 8px;color:#1e293b;font-size:22px;">${watcher.tour_name || 'Hotel'}</h2>
          ${watcher.geo ? `<p style="margin:0 0 16px;color:#64748b;font-size:14px;">📍 ${watcher.geo}</p>` : ''}

          <div style="background:#f1f5f9;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px;">
            <div style="font-size:14px;color:#64748b;margin-bottom:8px;">Pretul a ${direction}</div>
            <div style="display:flex;align-items:center;justify-content:center;gap:16px;">
              <span style="font-size:22px;color:#94a3b8;text-decoration:line-through;">${oldPrice} ${watcher.currency}</span>
              <span style="font-size:16px;">→</span>
              <span style="font-size:28px;font-weight:800;color:${color};">${newPrice} ${watcher.currency}</span>
            </div>
            <div style="margin-top:8px;font-size:16px;font-weight:700;color:${color};">
              ${emoji} ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%
            </div>
          </div>

          <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:20px;">${actionText}</p>

          ${watcher.tour_url ? `
          <a href="${watcher.tour_url}" style="display:block;text-align:center;background:#3b82f6;color:white;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;margin-bottom:16px;">
            Vezi oferta acum
          </a>
          ` : ''}

          <div style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:16px;">
            <table style="width:100%;font-size:13px;color:#64748b;">
              ${watcher.dates ? `<tr><td style="padding:3px 0;">📅 Date:</td><td style="padding:3px 0;text-align:right;">${watcher.dates}</td></tr>` : ''}
              ${watcher.stars ? `<tr><td style="padding:3px 0;">⭐ Stele:</td><td style="padding:3px 0;text-align:right;">${'★'.repeat(watcher.stars)}</td></tr>` : ''}
              ${watcher.food ? `<tr><td style="padding:3px 0;">🍽️ Masa:</td><td style="padding:3px 0;text-align:right;">${watcher.food}</td></tr>` : ''}
              <tr><td style="padding:3px 0;">💰 Pret initial:</td><td style="padding:3px 0;text-align:right;">${watcher.initial_price} ${watcher.currency}</td></tr>
            </table>
          </div>
        </div>

        <div style="background:#1e293b;padding:20px;text-align:center;">
          <p style="margin:0 0 4px;color:white;font-size:15px;font-weight:700;">${AGENCY.name}</p>
          <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">📞 ${AGENCY.phone}</p>
          <p style="margin:0;color:#94a3b8;font-size:13px;">🌐 <a href="${AGENCY.site}" style="color:#60a5fa;text-decoration:none;">${AGENCY.site.replace('https://', '')}</a></p>
        </div>
      </div>

      <p style="text-align:center;margin-top:16px;font-size:11px;color:#94a3b8;">
        <a href="${unsubLink}" style="color:#94a3b8;">Dezabonare de la notificari pentru acest tur</a>
      </p>
    </div>
  `;

  if (RESEND_API_KEY) {
    try {
      await sendViaResend(watcher.email, subject, html);
      console.log(`[Email] Sent via Resend to ${watcher.email}: ${subject}`);
    } catch (err) {
      console.error(`[Email] Resend failed for ${watcher.email}:`, err.message);
    }
  } else if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || `${AGENCY.name} <noreply@zebratur.md>`,
        to: watcher.email,
        subject: subject,
        html: html
      });
      console.log(`[Email] Sent via SMTP to ${watcher.email}: ${subject}`);
    } catch (err) {
      console.error(`[Email] SMTP failed for ${watcher.email}:`, err.message);
    }
  } else {
    console.log(`[Email] (no SMTP) Would send to ${watcher.email}: ${subject}`);
  }

  // Log notification
  insertNotificationLog.run(watcher.id, oldPrice, newPrice, changePct);
  markNotified.run(watcher.id);
}

// ===== FETCH PRICES VIA OTPUSK v2.5 SEARCH API =====
// This uses the SAME API as the Otpusk widget, so prices match exactly
const OTPUSK_TOKEN = process.env.OTPUSK_ACCESS_TOKEN || '3834b-187cb-0bad1-61bd5-28f3f';

// Poll the async search API until lastResult=true, then fetch ALL pages
// Returns a map of hotelId -> { price, currency, name }
async function searchPrices(searchParams) {
  const sp = searchParams;
  if (!sp || !sp.countryId || !sp.checkIn) {
    console.log('[Search] Missing search params, cannot search');
    return null;
  }

  const buildParams = (pageNum) => {
    const params = new URLSearchParams({
      to: sp.countryId,
      checkIn: sp.checkIn,
      checkTo: sp.checkTo || sp.checkIn,
      length: sp.length || '7',
      lengthTo: sp.lengthTo || '',
      people: sp.people || '2',
      transport: sp.transport || 'air',
      number: '0',
      page: String(pageNum),
      deptCity: sp.deptCity || '1831',
      lang: 'ro',
      group: '5',
      currencyLocal: sp.currencyLocal || 'eur',
      currency: '',
      access_token: OTPUSK_TOKEN
    });
    if (sp.food) params.set('food', sp.food);
    if (sp.stars) params.set('stars', sp.stars);
    if (sp.price) params.set('price', sp.price);
    if (sp.priceTo) params.set('priceTo', sp.priceTo);
    return params;
  };

  console.log(`[Search] Starting: countryId=${sp.countryId}, checkIn=${sp.checkIn}, checkTo=${sp.checkTo}, deptCity=${sp.deptCity}`);

  // Helper: extract hotels from response data
  function extractHotels(data) {
    const hotelPrices = {};
    if (data.hotels) {
      for (const pageKey of Object.keys(data.hotels)) {
        const page = data.hotels[pageKey];
        if (page && typeof page === 'object') {
          for (const hotelId of Object.keys(page)) {
            const hotel = page[hotelId];
            if (hotel && hotel.p) {
              hotelPrices[hotelId] = {
                price: parseFloat(hotel.p),
                currency: hotel.pu || 'eur',
                name: hotel.n || hotel.ohn || hotelId
              };
            }
          }
        }
      }
    }
    return hotelPrices;
  }

  // Helper: poll one page until lastResult=true
  async function pollPage(pageNum) {
    const params = buildParams(pageNum);
    const searchUrl = `https://api.otpusk.com/api/2.5/tours/search/?${params.toString()}`;
    const maxPolls = 12;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      try {
        const resp = await fetch(searchUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; ZebraTur-PriceTracker/1.0)'
          }
        });

        if (!resp.ok) {
          console.log(`[Search] Page ${pageNum}: API returned ${resp.status}, attempt ${attempt + 1}`);
          await new Promise(r => setTimeout(r, pollInterval));
          continue;
        }

        const data = await resp.json();

        if (data.lastResult) {
          const hotels = extractHotels(data);
          const totalOffers = data.total || 0;
          console.log(`[Search] Page ${pageNum} complete: ${Object.keys(hotels).length} hotels, ${totalOffers} total offers`);
          return { hotels, totalOffers };
        }

        // Not ready yet
        const progress = data.progress || {};
        const done = Object.values(progress).filter(v => v === true).length;
        const total = Object.keys(progress).length;
        if (pageNum === 1) {
          console.log(`[Search] Poll ${attempt + 1}/${maxPolls}: ${done}/${total} operators done, ${data._persent || 0}%`);
        }

        // On last poll, extract partial results
        if (attempt === maxPolls - 1 && data.hotels) {
          const hotels = extractHotels(data);
          if (Object.keys(hotels).length > 0) {
            console.log(`[Search] Page ${pageNum} timeout, partial: ${Object.keys(hotels).length} hotels`);
            return { hotels, totalOffers: data.total || 0 };
          }
        }

        await new Promise(r => setTimeout(r, pollInterval));
      } catch (err) {
        console.error(`[Search] Page ${pageNum} error on poll ${attempt + 1}:`, err.message);
        await new Promise(r => setTimeout(r, pollInterval));
      }
    }
    return { hotels: {}, totalOffers: 0 };
  }

  // Fetch page 1
  const page1 = await pollPage(1);
  const allHotels = { ...page1.hotels };
  const hotelsPerPage = 20; // Otpusk returns ~20 hotels per page
  const maxPages = parseInt(process.env.SEARCH_MAX_PAGES) || 5;

  // Calculate how many more pages to fetch
  const totalPages = Math.min(Math.ceil(page1.totalOffers / hotelsPerPage), maxPages);

  if (totalPages > 1) {
    console.log(`[Search] Fetching ${totalPages - 1} more pages (total offers: ${page1.totalOffers})`);
    for (let p = 2; p <= totalPages; p++) {
      const pageResult = await pollPage(p);
      Object.assign(allHotels, pageResult.hotels);
      // Small delay between pages
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`[Search] All pages done: ${Object.keys(allHotels).length} unique hotels total`);
  return Object.keys(allHotels).length > 0 ? allHotels : null;
}

// Fallback: use minoffer API for watchers without search params
async function fetchMinofferPrice(tourId) {
  try {
    if (!tourId || !/^\d+$/.test(tourId)) return null;
    const apiUrl = `https://api.otpusk.com/api/2.4/tours/hotel/?hotelId=${tourId}&data=minoffer&lang=ro&access_token=${OTPUSK_TOKEN}`;
    const resp = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; ZebraTur-PriceTracker/1.0)' },
      timeout: 15000
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.hotel && data.hotel.p && data.hotel.p.p) {
      return parseFloat(data.hotel.p.p);
    }
    return null;
  } catch (err) {
    console.error(`[Minoffer] Error for hotel ${tourId}:`, err.message);
    return null;
  }
}

// ===== PRICE CHECK JOB =====
async function checkAllPrices() {
  console.log('[PriceCheck] Starting price check...');
  const watchers = getActiveWatchers.all();
  console.log(`[PriceCheck] Checking ${watchers.length} active watchers`);

  let checked = 0, alerts = 0;

  // Group watchers by search params to batch API calls
  const searchGroups = {}; // key = JSON search params, value = [watchers]
  const noSearchWatchers = []; // watchers without search params (use minoffer fallback)

  for (const watcher of watchers) {
    if (watcher.search_params) {
      try {
        const sp = JSON.parse(watcher.search_params);
        // Create a group key from the search params that matter
        const key = JSON.stringify({
          countryId: sp.countryId,
          checkIn: sp.checkIn,
          checkTo: sp.checkTo,
          length: sp.length,
          lengthTo: sp.lengthTo,
          deptCity: sp.deptCity || '1831',
          people: sp.people || '2',
          food: sp.food || '',
          stars: sp.stars || '',
          transport: sp.transport || 'air'
        });
        if (!searchGroups[key]) searchGroups[key] = { params: sp, watchers: [] };
        searchGroups[key].watchers.push(watcher);
      } catch (e) {
        noSearchWatchers.push(watcher);
      }
    } else {
      noSearchWatchers.push(watcher);
    }
  }

  console.log(`[PriceCheck] ${Object.keys(searchGroups).length} search groups, ${noSearchWatchers.length} minoffer fallbacks`);

  // Process each search group (one API search per group)
  for (const groupKey of Object.keys(searchGroups)) {
    const group = searchGroups[groupKey];
    try {
      const hotelPrices = await searchPrices(group.params);
      if (!hotelPrices) {
        console.log(`[PriceCheck] Search returned no results for group`);
        continue;
      }

      for (const watcher of group.watchers) {
        try {
          const hotelData = hotelPrices[watcher.tour_id];
          if (!hotelData) {
            console.log(`[PriceCheck] Hotel ${watcher.tour_id} not in search results, skipping`);
            continue;
          }

          const newPrice = hotelData.price;
          if (!newPrice || newPrice <= 0) continue;

          checked++;
          insertPriceHistory.run(watcher.tour_id, newPrice);

          const oldPrice = watcher.current_price;
          const changePct = ((newPrice - oldPrice) / oldPrice) * 100;

          updateWatcherPrice.run(newPrice, watcher.id);

          console.log(`[PriceCheck] Hotel ${watcher.tour_id} (${watcher.tour_name}): ${oldPrice} -> ${newPrice} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)`);

          if (Math.abs(changePct) >= THRESHOLD) {
            if (watcher.last_notified) {
              const lastNotif = new Date(watcher.last_notified).getTime();
              const cooldownMs = (parseInt(process.env.NOTIFICATION_COOLDOWN_MINUTES) || 5) * 60 * 1000;
              if (lastNotif > Date.now() - cooldownMs) {
                console.log(`[PriceCheck] Skipping notification for ${watcher.email} (notified recently, cooldown ${cooldownMs/60000}min)`);
                continue;
              }
            }
            await sendPriceAlert(watcher, oldPrice, newPrice, changePct);
            alerts++;
          }
        } catch (err) {
          console.error(`[PriceCheck] Error processing watcher ${watcher.id}:`, err.message);
        }
      }

      // Small delay between search groups to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[PriceCheck] Error with search group:`, err.message);
    }
  }

  // Process watchers without search params (minoffer fallback)
  for (const watcher of noSearchWatchers) {
    try {
      const newPrice = await fetchMinofferPrice(watcher.tour_id);
      if (newPrice === null || newPrice <= 0) continue;

      checked++;
      insertPriceHistory.run(watcher.tour_id, newPrice);

      const oldPrice = watcher.current_price;
      const changePct = ((newPrice - oldPrice) / oldPrice) * 100;
      updateWatcherPrice.run(newPrice, watcher.id);

      if (Math.abs(changePct) >= THRESHOLD) {
        if (watcher.last_notified) {
          const lastNotif = new Date(watcher.last_notified).getTime();
          const cooldownMs = (parseInt(process.env.NOTIFICATION_COOLDOWN_MINUTES) || 5) * 60 * 1000;
          if (lastNotif > Date.now() - cooldownMs) continue;
        }
        await sendPriceAlert(watcher, oldPrice, newPrice, changePct);
        alerts++;
      }
    } catch (err) {
      console.error(`[PriceCheck] Minoffer error for watcher ${watcher.id}:`, err.message);
    }
  }

  console.log(`[PriceCheck] Done. Checked: ${checked}, Alerts sent: ${alerts}`);
}

// ===== TELEGRAM BOT =====
const telegramBot = initTelegramBot(db, searchPrices, AGENCY);
if (telegramBot) {
  console.log('[Telegram] Bot initialized successfully');
}

// ===== CRON SCHEDULE =====
const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 1;
const cronExpr = intervalMinutes >= 60
  ? `0 */${Math.floor(intervalMinutes / 60)} * * *`
  : `*/${intervalMinutes} * * * *`;

// Lock to prevent overlapping checks (search API can take 30-60s)
let isChecking = false;
cron.schedule(cronExpr, async () => {
  if (isChecking) {
    console.log('[Cron] Previous check still running, skipping this tick');
    return;
  }
  isChecking = true;
  try {
    await checkAllPrices();
    // Also check Telegram alerts
    if (telegramBot) {
      await telegramBot.checkTelegramAlerts();
    }
  } finally {
    isChecking = false;
  }
});
console.log(`[Cron] Price check scheduled: ${cronExpr} (every ${intervalMinutes}min)`);

// ===== API ROUTES =====

// Health check
app.get('/', (req, res) => {
  const watcherCount = db.prepare('SELECT COUNT(*) as count FROM watchers WHERE active = 1').get();
  const telegramStats = telegramBot ? {
    telegramEnabled: true,
    telegramUsers: telegramBot.stmts.getUserCount.get().count,
    telegramAlerts: telegramBot.stmts.getActiveAlertCount.get().count,
  } : { telegramEnabled: false };

  res.json({
    status: 'ok',
    service: `${AGENCY.name} Price Tracker`,
    activeWatchers: watcherCount.count,
    checkInterval: `${intervalMinutes}min`,
    threshold: `${THRESHOLD}%`,
    ...telegramStats
  });
});

// Subscribe to price tracking
app.post('/api/watch', async (req, res) => {
  try {
    const { email, tourId, tourName, tourUrl, tourImg, price, currency, geo, dates, stars, food, searchParams } = req.body;

    if (!email || !tourId || !price) {
      return res.status(400).json({ error: 'Email, tourId, and price are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const numPrice = parseFloat(price);
    if (isNaN(numPrice) || numPrice <= 0) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    // Use widget price directly as baseline — the search API returns the same prices
    // No more minoffer mismatch!
    const baselinePrice = numPrice;

    // Store search params so we can replay the same search server-side
    let searchParamsJson = null;
    if (searchParams && typeof searchParams === 'object' && searchParams.countryId) {
      searchParamsJson = JSON.stringify(searchParams);
      console.log(`[Watch] Search params captured: country=${searchParams.countryId}, checkIn=${searchParams.checkIn}, deptCity=${searchParams.deptCity}`);
    } else {
      console.log(`[Watch] WARNING: No search params provided for hotel ${tourId} — will use minoffer fallback`);
    }

    insertWatcher.run(
      email, tourId, tourName || null, tourUrl || null, tourImg || null,
      numPrice, baselinePrice, currency || 'USD',
      geo || null, dates || null, stars ? parseInt(stars) : null, food || null,
      searchParamsJson
    );

    console.log(`[Watch] ${email} now watching hotel ${tourId} at ${baselinePrice} ${currency || 'EUR'}`);

    res.json({
      success: true,
      message: `Vei primi notificari cand pretul se schimba cu mai mult de ${THRESHOLD}%`
    });
  } catch (err) {
    console.error('[Watch] Error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Telegram pre-registration — stores tour data so the bot can retrieve it via token
// This gives Telegram the same data quality as email (name, URL, image, searchParams)
app.post('/api/telegram-preregister', (req, res) => {
  try {
    const { token, tourId, tourName, tourUrl, tourImg, price, currency, geo, dates, stars, food, searchParams } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const data = JSON.stringify({ tourId, tourName, tourUrl, tourImg, price, currency, geo, dates, stars, food, searchParams });

    db.prepare('INSERT OR REPLACE INTO telegram_pending (token, data) VALUES (?, ?)').run(token, data);

    // Clean up old pending entries (older than 24h)
    db.prepare("DELETE FROM telegram_pending WHERE created_at < datetime('now', '-24 hours')").run();

    console.log(`[TG-PreReg] Token ${token} stored for hotel ${tourId} (${tourName || 'unknown'})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[TG-PreReg] Error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unsubscribe
app.get('/api/unsubscribe/:id', (req, res) => {
  try {
    const watcher = getWatcherById.get(parseInt(req.params.id));
    if (watcher) {
      deactivateWatcher.run(watcher.id);
      res.send(`
        <html><body style="font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f8fafc;">
          <div style="text-align:center;background:white;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
            <h2 style="color:#1e293b;">Dezabonat cu succes</h2>
            <p style="color:#64748b;">Nu vei mai primi notificari pentru <strong>${watcher.tour_name || 'acest tur'}</strong>.</p>
            <a href="${AGENCY.site}" style="color:#3b82f6;text-decoration:none;">Inapoi la ${AGENCY.name}</a>
          </div>
        </body></html>
      `);
    } else {
      res.status(404).send('Watcher not found');
    }
  } catch (err) {
    res.status(500).send('Error');
  }
});

// Get my watches (by email)
app.get('/api/my-watches', (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const watches = getWatchersByEmail.all(email);
    res.json(watches.map(w => ({
      id: w.id,
      tourId: w.tour_id,
      tourName: w.tour_name,
      initialPrice: w.initial_price,
      currentPrice: w.current_price,
      currency: w.currency,
      changePct: ((w.current_price - w.initial_price) / w.initial_price * 100).toFixed(1),
      createdAt: w.created_at,
      lastChecked: w.last_checked
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Check if a tour is being watched by an email
app.get('/api/is-watching', (req, res) => {
  try {
    const { email, tourId } = req.query;
    if (!email || !tourId) return res.json({ watching: false });
    const watcher = db.prepare('SELECT id FROM watchers WHERE email = ? AND tour_id = ? AND active = 1').get(email, tourId);
    res.json({ watching: !!watcher });
  } catch (err) {
    res.json({ watching: false });
  }
});

// Unwatch a specific tour
app.post('/api/unwatch', (req, res) => {
  try {
    const { email, tourId } = req.body;
    if (!email || !tourId) return res.status(400).json({ error: 'Email and tourId required' });
    const watcher = db.prepare('SELECT id FROM watchers WHERE email = ? AND tour_id = ? AND active = 1').get(email, tourId);
    if (watcher) {
      deactivateWatcher.run(watcher.id);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Not watching this tour' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Price history for a tour
app.get('/api/price-history/:tourId', (req, res) => {
  try {
    const history = getPriceHistory.all(req.params.tourId);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual trigger (for testing)
app.post('/api/check-now', async (req, res) => {
  try {
    await checkAllPrices();
    if (telegramBot) {
      await telegramBot.checkTelegramAlerts();
    }
    res.json({ success: true, message: 'Price check completed (email + telegram)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Telegram stats
app.get('/api/telegram-stats', (req, res) => {
  if (!telegramBot) return res.json({ enabled: false });
  try {
    const users = telegramBot.stmts.getUserCount.get();
    const alerts = telegramBot.stmts.getActiveAlertCount.get();
    res.json({
      enabled: true,
      users: users.count,
      activeAlerts: alerts.count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`[Server] ${AGENCY.name} Price Tracker running on port ${PORT}`);
  console.log(`[Server] Threshold: ${THRESHOLD}% | Interval: ${intervalMinutes}min`);
});
