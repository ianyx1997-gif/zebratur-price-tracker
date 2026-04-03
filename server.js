/* ============================================================
   ZEBRATUR – PRICE TRACKER SERVER
   Node.js backend for tracking tour prices & sending email alerts
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

// Prepared statements
const insertWatcher = db.prepare(`
  INSERT OR REPLACE INTO watchers (email, tour_id, tour_name, tour_url, tour_img, initial_price, current_price, currency, geo, dates, stars, food)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
let transporter = null;
if (process.env.SMTP_HOST) {
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
  console.log('[Email] WARNING: No SMTP configured. Emails will be logged only.');
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

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || `${AGENCY.name} <noreply@zebratur.md>`,
        to: watcher.email,
        subject: subject,
        html: html
      });
      console.log(`[Email] Sent to ${watcher.email}: ${subject}`);
    } catch (err) {
      console.error(`[Email] Failed to send to ${watcher.email}:`, err.message);
    }
  } else {
    console.log(`[Email] (no SMTP) Would send to ${watcher.email}: ${subject}`);
  }

  // Log notification
  insertNotificationLog.run(watcher.id, oldPrice, newPrice, changePct);
  markNotified.run(watcher.id);
}

// ===== FETCH CURRENT PRICE FOR A TOUR =====
// This function tries to get the current price from the tour URL.
// Adapt based on how Otpusk provides pricing data.
async function fetchCurrentPrice(tourUrl, tourId) {
  try {
    // Method 1: Try Otpusk API if tour_id looks like an otpusk ID
    if (tourId && /^\d+$/.test(tourId)) {
      const apiUrl = `https://export.otpusk.com/api/tour?id=${tourId}&format=json`;
      const resp = await fetch(apiUrl, {
        headers: { 'User-Agent': 'ZebraTur-PriceTracker/1.0' },
        timeout: 15000
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.price) {
          return parseFloat(data.price);
        }
      }
    }

    // Method 2: Scrape the tour page for price data
    if (tourUrl) {
      const resp = await fetch(tourUrl, {
        headers: { 'User-Agent': 'ZebraTur-PriceTracker/1.0' },
        timeout: 15000
      });
      if (resp.ok) {
        const html = await resp.text();
        // Look for price patterns in the HTML
        // Pattern: "price":123 or data-price="123" or class="price">$123
        const patterns = [
          /"price"\s*:\s*(\d+(?:\.\d+)?)/,
          /data-price="(\d+(?:\.\d+)?)"/,
          /price[^>]*>[\s$€]*(\d[\d\s,.]*)/i
        ];
        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match) {
            const price = parseFloat(match[1].replace(/[\s,]/g, ''));
            if (price > 0) return price;
          }
        }
      }
    }

    return null;
  } catch (err) {
    console.error(`[PriceCheck] Error fetching price for tour ${tourId}:`, err.message);
    return null;
  }
}

// ===== PRICE CHECK JOB =====
async function checkAllPrices() {
  console.log('[PriceCheck] Starting hourly price check...');
  const watchers = getActiveWatchers.all();
  console.log(`[PriceCheck] Checking ${watchers.length} active watchers`);

  let checked = 0, alerts = 0;

  for (const watcher of watchers) {
    try {
      const newPrice = await fetchCurrentPrice(watcher.tour_url, watcher.tour_id);

      if (newPrice === null || newPrice <= 0) {
        console.log(`[PriceCheck] Could not get price for tour ${watcher.tour_id}, skipping`);
        continue;
      }

      checked++;

      // Record price history
      insertPriceHistory.run(watcher.tour_id, newPrice);

      const oldPrice = watcher.current_price;
      const changePct = ((newPrice - oldPrice) / oldPrice) * 100;

      // Update current price in DB
      updateWatcherPrice.run(newPrice, watcher.id);

      // Check if change exceeds threshold
      if (Math.abs(changePct) >= THRESHOLD) {
        // Don't notify if we already notified in the last 12 hours
        if (watcher.last_notified) {
          const lastNotif = new Date(watcher.last_notified).getTime();
          const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
          if (lastNotif > twelveHoursAgo) {
            console.log(`[PriceCheck] Skipping notification for ${watcher.email} (already notified recently)`);
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

  console.log(`[PriceCheck] Done. Checked: ${checked}, Alerts sent: ${alerts}`);
}

// ===== CRON SCHEDULE =====
const intervalHours = parseInt(process.env.CHECK_INTERVAL_HOURS) || 1;
const cronExpr = `0 */${intervalHours} * * *`; // Every N hours at minute 0
cron.schedule(cronExpr, () => {
  checkAllPrices();
});
console.log(`[Cron] Price check scheduled: ${cronExpr} (every ${intervalHours}h)`);

// ===== API ROUTES =====

// Health check
app.get('/', (req, res) => {
  const watcherCount = db.prepare('SELECT COUNT(*) as count FROM watchers WHERE active = 1').get();
  res.json({
    status: 'ok',
    service: `${AGENCY.name} Price Tracker`,
    activeWatchers: watcherCount.count,
    checkInterval: `${intervalHours}h`,
    threshold: `${THRESHOLD}%`
  });
});

// Subscribe to price tracking
app.post('/api/watch', (req, res) => {
  try {
    const { email, tourId, tourName, tourUrl, tourImg, price, currency, geo, dates, stars, food } = req.body;

    if (!email || !tourId || !price) {
      return res.status(400).json({ error: 'Email, tourId, and price are required' });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const numPrice = parseFloat(price);
    if (isNaN(numPrice) || numPrice <= 0) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    insertWatcher.run(
      email, tourId, tourName || null, tourUrl || null, tourImg || null,
      numPrice, numPrice, currency || 'USD',
      geo || null, dates || null, stars ? parseInt(stars) : null, food || null
    );

    console.log(`[Watch] ${email} now watching tour ${tourId} at ${numPrice} ${currency || 'USD'}`);

    res.json({
      success: true,
      message: `Vei primi notificari cand pretul se schimba cu mai mult de ${THRESHOLD}%`
    });
  } catch (err) {
    console.error('[Watch] Error:', err.message);
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
    res.json({ success: true, message: 'Price check completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`[Server] ${AGENCY.name} Price Tracker running on port ${PORT}`);
  console.log(`[Server] Threshold: ${THRESHOLD}% | Interval: ${intervalHours}h`);
});
