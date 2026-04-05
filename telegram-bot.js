/* ============================================================
   ZEBRATUR – TELEGRAM BOT MODULE
   Price alerts & tour search via Telegram

   Comenzi:
   /start          — Bun venit + instrucțiuni
   /urmareste      — Setează alertă de preț (conversație ghidată)
   /ofertele_mele  — Listează alertele tale active
   /stop           — Oprește o alertă specifică
   /help           — Ajutor
   ============================================================ */

const TelegramBot = require('node-telegram-bot-api');

// ===== COUNTRY DATA (Otpusk IDs) =====
const COUNTRIES = {
  'turcia': { id: 115, flag: '🇹🇷', transport: 'air' },
  'egipt': { id: 43, flag: '🇪🇬', transport: 'air' },
  'grecia': { id: 34, flag: '🇬🇷', transport: 'air' },
  'bulgaria': { id: 13, flag: '🇧🇬', transport: 'bus' },
  'cipru': { id: 54, flag: '🇨🇾', transport: 'air' },
  'muntenegru': { id: 135, flag: '🇲🇪', transport: 'bus' },
  'emirate': { id: 92, flag: '🇦🇪', transport: 'air' },
  'spania': { id: 49, flag: '🇪🇸', transport: 'air' },
  'italia': { id: 48, flag: '🇮🇹', transport: 'air' },
  'tunisia': { id: 114, flag: '🇹🇳', transport: 'air' },
  'tailanda': { id: 113, flag: '🇹🇭', transport: 'air' },
  'maldive': { id: 79, flag: '🇲🇻', transport: 'air' },
  'albania': { id: 10, flag: '🇦🇱', transport: 'bus' },
  'dominicana': { id: 42, flag: '🇩🇴', transport: 'air' },
  'tanzania': { id: 152, flag: '🇹🇿', transport: 'air' },
  'sri lanka': { id: 125, flag: '🇱🇰', transport: 'air' },
  'vietnam': { id: 29, flag: '🇻🇳', transport: 'air' },
};

const DEPARTURE_CITIES = {
  'chisinau': { id: 1831, label: 'Chișinău' },
  'bucuresti': { id: 1373, label: 'București' },
  'iasi': { id: 4091, label: 'Iași' },
  'cluj': { id: 4083, label: 'Cluj-Napoca' },
  'timisoara': { id: 3396, label: 'Timișoara' },
  'bacau': { id: 2858, label: 'Bacău' },
  'suceava': { id: 1727, label: 'Suceava' },
};

const FOOD_CODES = {
  'fara masa': 'ob',
  'mic dejun': 'bb',
  'demipensiune': 'hb',
  'pensiune completa': 'fb',
  'all inclusive': 'ai',
  'ultra all inclusive': 'uai',
};

const MONTHS_RO = {
  'ianuarie': '01', 'februarie': '02', 'martie': '03', 'aprilie': '04',
  'mai': '05', 'iunie': '06', 'iulie': '07', 'august': '08',
  'septembrie': '09', 'octombrie': '10', 'noiembrie': '11', 'decembrie': '12',
  'ian': '01', 'feb': '02', 'mar': '03', 'apr': '04',
  'iun': '06', 'iul': '07', 'aug': '08',
  'sept': '09', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
};

// ===== CONVERSATION STATE (in-memory) =====
// Stores ongoing conversations for /urmareste flow
const conversations = new Map();

// ===== INIT BOT =====
function initTelegramBot(db, searchPricesFn, AGENCY) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set — bot disabled');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log('[Telegram] Bot started with polling');

  // ===== DB SETUP =====
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      username TEXT,
      first_name TEXT,
      country_id INTEGER NOT NULL,
      country_name TEXT,
      dept_city_id INTEGER DEFAULT 1831,
      dept_city_name TEXT DEFAULT 'Chișinău',
      check_in TEXT,
      check_to TEXT,
      nights INTEGER DEFAULT 7,
      adults INTEGER DEFAULT 2,
      children_ages TEXT,
      stars INTEGER,
      food TEXT,
      max_price REAL,
      currency TEXT DEFAULT 'eur',
      transport TEXT DEFAULT 'air',
      last_best_price REAL,
      last_best_hotel TEXT,
      last_checked DATETIME,
      last_notified DATETIME,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telegram_users (
      chat_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      alerts_count INTEGER DEFAULT 0
    );
  `);

  // Migration: add columns for specific hotel tracking (like email watchers table)
  try { db.exec(`ALTER TABLE telegram_alerts ADD COLUMN tour_id TEXT`); console.log('[Telegram DB] Added tour_id column'); } catch(e) { /* exists */ }
  try { db.exec(`ALTER TABLE telegram_alerts ADD COLUMN tour_name TEXT`); console.log('[Telegram DB] Added tour_name column'); } catch(e) { /* exists */ }
  try { db.exec(`ALTER TABLE telegram_alerts ADD COLUMN tour_url TEXT`); console.log('[Telegram DB] Added tour_url column'); } catch(e) { /* exists */ }
  try { db.exec(`ALTER TABLE telegram_alerts ADD COLUMN tour_img TEXT`); console.log('[Telegram DB] Added tour_img column'); } catch(e) { /* exists */ }
  try { db.exec(`ALTER TABLE telegram_alerts ADD COLUMN search_params TEXT`); console.log('[Telegram DB] Added search_params column'); } catch(e) { /* exists */ }

  // Prepared statements
  const stmts = {
    upsertUser: db.prepare(`
      INSERT INTO telegram_users (chat_id, username, first_name, last_name, last_active)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        last_active = CURRENT_TIMESTAMP
    `),
    insertAlert: db.prepare(`
      INSERT INTO telegram_alerts (chat_id, username, first_name, country_id, country_name, dept_city_id, dept_city_name,
        check_in, check_to, nights, adults, children_ages, stars, food, max_price, currency, transport,
        tour_id, tour_name, tour_url, tour_img, search_params)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getActiveAlerts: db.prepare(`SELECT * FROM telegram_alerts WHERE active = 1`),
    getAlertsByChat: db.prepare(`SELECT * FROM telegram_alerts WHERE chat_id = ? AND active = 1`),
    deactivateAlert: db.prepare(`UPDATE telegram_alerts SET active = 0 WHERE id = ? AND chat_id = ?`),
    updateAlertPrice: db.prepare(`
      UPDATE telegram_alerts SET last_best_price = ?, last_best_hotel = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?
    `),
    markAlertNotified: db.prepare(`UPDATE telegram_alerts SET last_notified = CURRENT_TIMESTAMP WHERE id = ?`),
    setInitialPrice: db.prepare(`UPDATE telegram_alerts SET last_best_price = ?, last_best_hotel = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?`),
    getLastInsertId: db.prepare(`SELECT last_insert_rowid() as id`),
    updateAlertTourName: db.prepare(`UPDATE telegram_alerts SET tour_name = ? WHERE id = ?`),
    getUserCount: db.prepare(`SELECT COUNT(*) as count FROM telegram_users`),
    getActiveAlertCount: db.prepare(`SELECT COUNT(*) as count FROM telegram_alerts WHERE active = 1`),
  };

  // ===== HELPER: Track user =====
  function trackUser(msg) {
    const { chat, from } = msg;
    stmts.upsertUser.run(chat.id, from?.username || null, from?.first_name || null, from?.last_name || null);
  }

  // ===== HELPER: Parse date from Romanian text =====
  function parseDate(text) {
    text = text.toLowerCase().trim();

    // Format: "17 septembrie" or "17 sept" or "17.09"
    const monthNameMatch = text.match(/(\d{1,2})\s+(ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie|ian|feb|mar|apr|iun|iul|aug|sept?|oct|nov|dec)/i);
    if (monthNameMatch) {
      const day = monthNameMatch[1].padStart(2, '0');
      const monthKey = monthNameMatch[2].toLowerCase();
      const month = MONTHS_RO[monthKey];
      if (month) {
        const year = new Date().getMonth() + 1 > parseInt(month) ? new Date().getFullYear() + 1 : new Date().getFullYear();
        return `${year}-${month}-${day}`;
      }
    }

    // Format: "17.08" or "17/08"
    const numMatch = text.match(/(\d{1,2})[.\/](\d{1,2})/);
    if (numMatch) {
      const day = numMatch[1].padStart(2, '0');
      const month = numMatch[2].padStart(2, '0');
      const year = new Date().getMonth() + 1 > parseInt(month) ? new Date().getFullYear() + 1 : new Date().getFullYear();
      return `${year}-${month}-${day}`;
    }

    // Format: "2026-08-17"
    const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return isoMatch[0];

    return null;
  }

  // ===== HELPER: Build ZebraTur link =====
  function buildZebraturLink(alert) {
    const checkIn = alert.check_in;
    const checkTo = alert.check_to || addDays(checkIn, 14);
    const childAges = alert.children_ages || '';

    let link = `https://zebratur.md/test#!i=${alert.country_id}`;
    link += `&c=${checkIn}&v=${checkTo}`;
    link += `&l=${alert.nights || 7}`;
    link += `&p=${alert.adults || 2}`;
    link += `&tc=${childAges}`;
    link += `&g=1`;
    link += `&d=${alert.dept_city_id || 1831}`;
    link += `&o=${alert.food || ''}`;
    link += `&st=${alert.stars || ''}`;
    link += `&pf=100&pt=${alert.max_price || 20000}`;
    link += `&rt=0,10&th=&e=`;
    link += `&r=${alert.transport || 'air'}`;
    link += `&ex=1&cu=${alert.currency || 'eur'}`;
    link += `&page=form`;
    return link;
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }

  // ===== HELPER: Create alert from pre-registered token data =====
  // This is the NEW flow — frontend pre-registers all tour data, bot just looks it up
  function handleTokenPayload(msg, name, token) {
    const row = db.prepare('SELECT data FROM telegram_pending WHERE token = ?').get(token);
    if (!row) {
      bot.sendMessage(msg.chat.id,
        '❌ Link-ul a expirat sau nu a fost găsit.\nÎncearcă din nou de pe site: ' + AGENCY.site,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Delete the pending entry (one-time use)
    db.prepare('DELETE FROM telegram_pending WHERE token = ?').run(token);

    const d = JSON.parse(row.data);
    const sp = d.searchParams || {};

    // Extract search params (same data the email flow gets)
    const countryId = parseInt(sp.countryId) || 0;
    const deptCityId = parseInt(sp.deptCity) || 1831;
    const checkIn = sp.checkIn || null;
    const nights = parseInt(sp.length) || 7;
    const people = sp.people || '2';
    const stars = sp.stars ? parseInt(sp.stars) : null;
    const food = sp.food || null;
    const transport = sp.transport || 'air';
    const maxPrice = d.price ? Math.round(parseFloat(d.price)) : null;

    // Find country/city names
    const country = Object.entries(COUNTRIES).find(([, v]) => v.id === countryId);
    const countryName = country ? country[0].charAt(0).toUpperCase() + country[0].slice(1) : 'Destinație';
    const flag = country ? country[1].flag : '🏖️';
    const dept = Object.entries(DEPARTURE_CITIES).find(([, v]) => v.id === deptCityId);
    const deptName = dept ? dept[1].label : 'Chișinău';

    // Parse adults/children
    const adults = parseInt(people.toString()[0]) || 2;
    let childrenAges = null;
    if (people.length > 1) {
      const agesStr = people.toString().slice(1);
      const ages = [];
      for (let i = 0; i < agesStr.length; i += 2) {
        ages.push(parseInt(agesStr.substring(i, i + 2)));
      }
      if (ages.length > 0) childrenAges = ages.join(',');
    }

    const checkTo = checkIn ? addDays(checkIn, 14) : null;

    try {
      const result = stmts.insertAlert.run(
        msg.chat.id, msg.from?.username || null, name,
        countryId, countryName,
        deptCityId, deptName,
        checkIn, checkTo,
        nights, adults, childrenAges,
        stars, food,
        maxPrice, 'eur', transport,
        d.tourId || null,           // tour_id — specific hotel ID
        d.tourName || null,         // tour_name — hotel name from website
        d.tourUrl || null,          // tour_url — direct link to hotel
        d.tourImg || null,          // tour_img — hotel image
        sp ? JSON.stringify(sp) : null  // search_params — for API replay
      );

      // Set initial price so the first check doesn't trigger a false alert
      // (same as email: we already know the price from the website)
      if (maxPrice && result.lastInsertRowid) {
        stmts.setInitialPrice.run(maxPrice, d.tourName || d.tourId || 'unknown', result.lastInsertRowid);
      }

      // Build link: use tour URL if specific hotel, otherwise destination search
      const link = d.tourUrl || buildZebraturLink({
        country_id: countryId, dept_city_id: deptCityId,
        check_in: checkIn, check_to: checkTo,
        nights, adults, children_ages: childrenAges,
        stars, food, max_price: maxPrice, currency: 'eur', transport
      });

      let summary = `✅ *Alertă setată de pe site!*\n\n`;
      if (d.tourName) {
        summary += `🏨 *${d.tourName}*\n`;
      }
      summary += `${flag} *${countryName}*`;
      if (d.geo) summary += ` — ${d.geo}`;
      summary += `\n`;
      summary += `✈️ Din ${deptName}\n`;
      summary += `📅 ${checkIn || '—'} | 🌙 ${nights} nopți\n`;
      summary += `👥 ${adults} adulți${childrenAges ? ' + copii ' + childrenAges + ' ani' : ''}\n`;
      if (stars) summary += `⭐ ${stars} stele\n`;
      if (food) summary += `🍽️ ${food.toUpperCase()}\n`;
      if (maxPrice) summary += `💰 Preț curent: ~${maxPrice} EUR\n`;
      summary += `\n📬 Vei primi notificare când prețul ${d.tourName ? 'acestui hotel' : ''} se schimbă!\n`;
      summary += `\n🔗 [Vezi oferta pe ZebraTur](${link})\n`;
      summary += `\nFolosește /ofertele\\_mele pentru a vedea alertele tale.`;

      bot.sendMessage(msg.chat.id, summary, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      console.log(`[Telegram] Token alert created: hotel ${d.tourId} (${d.tourName}) for chat ${msg.chat.id}`);
    } catch (err) {
      console.error('[Telegram] Token alert error:', err.message);
      bot.sendMessage(msg.chat.id, '❌ Eroare la salvarea alertei. Încearcă din nou.');
    }
  }

  // ===== HELPER: Create alert from old-format deep link (backward compat) =====
  function handleOldPayload(msg, name, payload) {
    const parts = payload.split('_');
    if (parts.length < 7) return false;

    const countryId = parseInt(parts[0]);
    const deptCityId = parseInt(parts[1]) || 1831;
    const checkInRaw = parts[2];
    const nights = parseInt(parts[3]) || 7;
    const people = parts[4] || '2';
    const stars = parts[5] !== '0' ? parseInt(parts[5]) : null;
    const food = parts[6] !== 'any' ? parts[6].replace(/-/g, ',') : null;
    const maxPrice = parts[7] ? parseInt(parts[7]) : null;
    const transport = parts[8] || 'air';
    const tourId = parts[9] && parts[9] !== '0' ? parts[9] : null;

    let checkIn = null;
    if (checkInRaw && checkInRaw.length === 8) {
      checkIn = checkInRaw.substring(0, 4) + '-' + checkInRaw.substring(4, 6) + '-' + checkInRaw.substring(6, 8);
    }

    const country = Object.entries(COUNTRIES).find(([, v]) => v.id === countryId);
    const countryName = country ? country[0].charAt(0).toUpperCase() + country[0].slice(1) : 'Destinație';
    const flag = country ? country[1].flag : '🏖️';
    const dept = Object.entries(DEPARTURE_CITIES).find(([, v]) => v.id === deptCityId);
    const deptName = dept ? dept[1].label : 'Chișinău';

    const adults = parseInt(people.toString()[0]) || 2;
    let childrenAges = null;
    if (people.length > 1) {
      const agesStr = people.toString().slice(1);
      const ages = [];
      for (let i = 0; i < agesStr.length; i += 2) {
        ages.push(parseInt(agesStr.substring(i, i + 2)));
      }
      if (ages.length > 0) childrenAges = ages.join(',');
    }

    if (!countryId || !checkIn) return false;

    try {
      stmts.insertAlert.run(
        msg.chat.id, msg.from?.username || null, name,
        countryId, countryName,
        deptCityId, deptName,
        checkIn, addDays(checkIn, 14),
        nights, adults, childrenAges,
        stars, food,
        maxPrice, 'eur', transport,
        tourId, null, null, null, null // tour_id, tour_name, tour_url, tour_img, search_params
      );

      const link = buildZebraturLink({
        country_id: countryId, dept_city_id: deptCityId,
        check_in: checkIn, check_to: addDays(checkIn, 14),
        nights, adults, children_ages: childrenAges,
        stars, food, max_price: maxPrice, currency: 'eur', transport
      });

      let summary = `✅ *Alertă setată de pe site!*\n\n`;
      summary += `${flag} *${countryName}*\n`;
      summary += `✈️ Din ${deptName}\n`;
      summary += `📅 ${checkIn} | 🌙 ${nights} nopți\n`;
      summary += `👥 ${adults} adulți${childrenAges ? ' + copii ' + childrenAges + ' ani' : ''}\n`;
      if (stars) summary += `⭐ ${stars} stele\n`;
      if (food) summary += `🍽️ ${food.toUpperCase()}\n`;
      if (maxPrice) summary += `💰 Preț curent: ~${maxPrice} EUR\n`;
      summary += `\n📬 Vei primi notificare când prețul scade!\n`;
      summary += `\n🔗 [Vezi oferte pe ZebraTur](${link})\n`;
      summary += `\nFolosește /ofertele\\_mele pentru a vedea alertele tale.`;

      bot.sendMessage(msg.chat.id, summary, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      return true;
    } catch (err) {
      console.error('[Telegram] Old deep link alert error:', err.message);
      return false;
    }
  }

  // ===== /start COMMAND (with optional deep link payload) =====
  bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    trackUser(msg);
    const name = msg.from?.first_name || 'Salut';
    const payload = match[1];

    if (payload) {
      // NEW FORMAT: token-based (starts with "tg" prefix)
      if (payload.startsWith('tg') && !payload.includes('_')) {
        handleTokenPayload(msg, name, payload);
        return;
      }

      // OLD FORMAT: underscore-separated params (backward compatible)
      if (payload.includes('_')) {
        if (handleOldPayload(msg, name, payload)) return;
      }
    }

    // Normal /start (no payload)
    bot.sendMessage(msg.chat.id,
      `👋 Bun venit, *${name}*!\n\n` +
      `Sunt botul *${AGENCY.name}* — te ajut să urmărești prețurile la tururi și primești notificări când prețul scade.\n\n` +
      `📋 *Ce pot face:*\n` +
      `🔔 /urmareste — Setează o alertă de preț\n` +
      `📋 /ofertele\\_mele — Vezi alertele tale active\n` +
      `🛑 /stop — Oprește o alertă\n` +
      `❓ /help — Ajutor\n\n` +
      `📞 *Contact agenție:* ${AGENCY.phone}\n` +
      `🌐 ${AGENCY.site}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ===== /help COMMAND =====
  bot.onText(/\/help/, (msg) => {
    trackUser(msg);
    bot.sendMessage(msg.chat.id,
      `❓ *Cum funcționează:*\n\n` +
      `1️⃣ Trimiți /urmareste și îmi spui unde vrei să mergi\n` +
      `2️⃣ Setezi datele, numărul de persoane, bugetul\n` +
      `3️⃣ Verific prețurile periodic (la fiecare oră)\n` +
      `4️⃣ Când găsesc o ofertă bună, primești notificare aici!\n\n` +
      `💡 *Sfaturi:*\n` +
      `• Poți avea mai multe alerte active simultan\n` +
      `• Prețurile se verifică automat, nu trebuie să faci nimic\n` +
      `• Folosește /stop pentru a opri o alertă\n\n` +
      `📞 Pentru rezervări, contactează-ne: ${AGENCY.phone}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ===== /urmareste COMMAND — Start conversation flow =====
  bot.onText(/\/urmareste/, (msg) => {
    trackUser(msg);
    const chatId = msg.chat.id;

    // Initialize conversation state
    conversations.set(chatId, {
      step: 'country',
      data: {
        chat_id: chatId,
        username: msg.from?.username,
        first_name: msg.from?.first_name,
      }
    });

    // Show country keyboard
    const countryButtons = Object.entries(COUNTRIES).map(([name, info]) => {
      return [{ text: `${info.flag} ${name.charAt(0).toUpperCase() + name.slice(1)}`, callback_data: `country_${name}` }];
    });

    // Split into rows of 2
    const keyboard = [];
    for (let i = 0; i < countryButtons.length; i += 2) {
      const row = [countryButtons[i][0]];
      if (countryButtons[i + 1]) row.push(countryButtons[i + 1][0]);
      keyboard.push(row);
    }

    bot.sendMessage(chatId,
      '🌍 *Unde vrei să mergi?*\nAlege destinația:',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }
    );
  });

  // ===== /ofertele_mele COMMAND =====
  bot.onText(/\/ofertele_mele/, (msg) => {
    trackUser(msg);
    const alerts = stmts.getAlertsByChat.all(msg.chat.id);

    if (alerts.length === 0) {
      bot.sendMessage(msg.chat.id,
        '📭 Nu ai nicio alertă activă.\n\nFolosește /urmareste pentru a seta una!',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let text = `📋 *Alertele tale active (${alerts.length}):*\n\n`;
    alerts.forEach((a, i) => {
      const country = Object.entries(COUNTRIES).find(([, v]) => v.id === a.country_id);
      const flag = country ? country[1].flag : '🏖️';
      if (a.tour_id) {
        text += `${i + 1}. 🏨 *${a.tour_name || 'Hotel #' + a.tour_id}*\n`;
        text += `   ${flag} ${a.country_name || 'Destinație'}\n`;
      } else {
        text += `${i + 1}. ${flag} *${a.country_name || 'Destinație'}*\n`;
      }
      text += `   📅 ${a.check_in} | 🌙 ${a.nights} nopți\n`;
      text += `   👥 ${a.adults} adulți${a.children_ages ? ' + copii ' + a.children_ages : ''}\n`;
      if (a.max_price) text += `   💰 Max: ${a.max_price} ${a.currency}\n`;
      if (a.last_best_price) text += `   📊 ${a.tour_id ? 'Preț actual' : 'Cel mai bun preț'}: *${a.last_best_price} ${a.currency}*\n`;
      if (a.tour_url) text += `   🔗 [Vezi hotelul](${a.tour_url})\n`;
      text += `   🆔 ID: ${a.id}\n\n`;
    });
    text += `Pentru a opri o alertă: /stop`;

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });

  // ===== /stop COMMAND =====
  bot.onText(/\/stop(?:\s+(\d+))?/, (msg, match) => {
    trackUser(msg);
    const chatId = msg.chat.id;
    const alertId = match[1] ? parseInt(match[1]) : null;

    if (alertId) {
      const result = stmts.deactivateAlert.run(alertId, chatId);
      if (result.changes > 0) {
        bot.sendMessage(chatId, `✅ Alerta #${alertId} a fost oprită.`);
      } else {
        bot.sendMessage(chatId, `❌ Nu am găsit alerta #${alertId} în lista ta.`);
      }
      return;
    }

    // Show alerts to choose from
    const alerts = stmts.getAlertsByChat.all(chatId);
    if (alerts.length === 0) {
      bot.sendMessage(chatId, '📭 Nu ai nicio alertă activă.');
      return;
    }

    const keyboard = alerts.map(a => [{
      text: `❌ #${a.id} — ${a.country_name || 'Destinație'} (${a.check_in})`,
      callback_data: `stop_${a.id}`
    }]);

    bot.sendMessage(chatId, '🛑 *Care alertă vrei să o oprești?*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });

  // ===== CALLBACK QUERY HANDLER (inline buttons) =====
  bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    // Country selection
    if (data.startsWith('country_')) {
      const countryName = data.replace('country_', '');
      const country = COUNTRIES[countryName];
      if (!country) return;

      const conv = conversations.get(chatId);
      if (!conv || conv.step !== 'country') return;

      conv.data.country_id = country.id;
      conv.data.country_name = countryName.charAt(0).toUpperCase() + countryName.slice(1);
      conv.data.transport = country.transport;
      conv.step = 'departure';

      // Show departure cities
      const deptButtons = Object.entries(DEPARTURE_CITIES).map(([key, city]) => [{
        text: `✈️ ${city.label}`,
        callback_data: `dept_${key}`
      }]);

      const keyboard = [];
      for (let i = 0; i < deptButtons.length; i += 2) {
        const row = [deptButtons[i][0]];
        if (deptButtons[i + 1]) row.push(deptButtons[i + 1][0]);
        keyboard.push(row);
      }

      bot.sendMessage(chatId,
        `${country.flag} *${conv.data.country_name}* — de unde pleci?`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
      );
    }

    // Departure city selection
    if (data.startsWith('dept_')) {
      const cityKey = data.replace('dept_', '');
      const city = DEPARTURE_CITIES[cityKey];
      if (!city) return;

      const conv = conversations.get(chatId);
      if (!conv || conv.step !== 'departure') return;

      conv.data.dept_city_id = city.id;
      conv.data.dept_city_name = city.label;
      conv.step = 'date';

      bot.sendMessage(chatId,
        `📅 *Când vrei să pleci?*\n\nScrie data (ex: \`2 august\`, \`15 sept\`, \`17.08\`):`,
        { parse_mode: 'Markdown' }
      );
    }

    // Food selection
    if (data.startsWith('food_')) {
      const foodCode = data.replace('food_', '');
      const conv = conversations.get(chatId);
      if (!conv || conv.step !== 'food') return;

      conv.data.food = foodCode === 'any' ? '' : foodCode;
      conv.step = 'stars';

      const starsKeyboard = [
        [
          { text: '⭐⭐⭐ 3★', callback_data: 'stars_3' },
          { text: '⭐⭐⭐⭐ 4★', callback_data: 'stars_4' },
          { text: '⭐⭐⭐⭐⭐ 5★', callback_data: 'stars_5' },
        ],
        [{ text: '🏨 Orice categorie', callback_data: 'stars_any' }]
      ];

      bot.sendMessage(chatId, '⭐ *Câte stele?*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: starsKeyboard }
      });
    }

    // Stars selection
    if (data.startsWith('stars_')) {
      const stars = data.replace('stars_', '');
      const conv = conversations.get(chatId);
      if (!conv || conv.step !== 'stars') return;

      conv.data.stars = stars === 'any' ? null : parseInt(stars);
      conv.step = 'budget';

      bot.sendMessage(chatId,
        '💰 *Care e bugetul maxim per persoană?*\n\nScrie suma în EUR (ex: `1000`, `1500`, `2000`).\nSau scrie `orice` fără limită:',
        { parse_mode: 'Markdown' }
      );
    }

    // Stop alert
    if (data.startsWith('stop_')) {
      const alertId = parseInt(data.replace('stop_', ''));
      const result = stmts.deactivateAlert.run(alertId, chatId);
      if (result.changes > 0) {
        bot.editMessageText(`✅ Alerta #${alertId} a fost oprită.`, {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      }
    }
  });

  // ===== TEXT MESSAGE HANDLER (conversation flow) =====
  bot.on('message', (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // Skip commands
    const chatId = msg.chat.id;
    const conv = conversations.get(chatId);
    if (!conv) return;

    const text = msg.text?.trim();
    if (!text) return;

    // STEP: Date
    if (conv.step === 'date') {
      const date = parseDate(text);
      if (!date) {
        bot.sendMessage(chatId, '❌ Nu am înțeles data. Scrie ca `2 august` sau `17.08`:',
          { parse_mode: 'Markdown' });
        return;
      }
      conv.data.check_in = date;
      conv.data.check_to = addDays(date, 14); // Search window: 2 weeks from date
      conv.step = 'nights';

      const nightsKeyboard = [
        [
          { text: '4 nopți', callback_data: 'nights_4' },
          { text: '5 nopți', callback_data: 'nights_5' },
          { text: '7 nopți', callback_data: 'nights_7' },
        ],
        [
          { text: '10 nopți', callback_data: 'nights_10' },
          { text: '14 nopți', callback_data: 'nights_14' },
        ]
      ];

      bot.sendMessage(chatId, `📅 Check-in: *${date}*\n\n🌙 *Câte nopți?*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: nightsKeyboard }
      });
    }

    // STEP: People (text input)
    else if (conv.step === 'people') {
      // Parse "2 adulti 3 copii 4 5 6" or "2+3(4,5,6)" etc.
      const adultsMatch = text.match(/(\d)\s*(adult|pers|oameni)/i);
      const childMatch = text.match(/(\d)\s*copi/i);
      const agesMatch = text.match(/(\d+)/g);

      if (adultsMatch) {
        conv.data.adults = parseInt(adultsMatch[1]);
      } else if (agesMatch) {
        conv.data.adults = parseInt(agesMatch[0]);
      }

      if (childMatch && agesMatch && agesMatch.length > 2) {
        // First number is adults, second is child count, rest are ages
        conv.data.children_ages = agesMatch.slice(2).join(',');
      } else if (text.toLowerCase().includes('copii') || text.toLowerCase().includes('copil')) {
        // Try to find ages after "copii"
        const afterChildren = text.toLowerCase().split(/copi[il]+/)[1];
        if (afterChildren) {
          const ages = afterChildren.match(/\d+/g);
          if (ages) conv.data.children_ages = ages.join(',');
        }
      }

      if (!conv.data.adults) conv.data.adults = 2;
      conv.step = 'food';

      const foodKeyboard = [
        [
          { text: '🍽️ All Inclusive', callback_data: 'food_ai' },
          { text: '🥇 Ultra AI', callback_data: 'food_uai' },
        ],
        [
          { text: '🍳 Mic dejun', callback_data: 'food_bb' },
          { text: '🍽️ Demipensiune', callback_data: 'food_hb' },
        ],
        [{ text: '🔄 Orice tip de masă', callback_data: 'food_any' }]
      ];

      let peopleText = `👥 ${conv.data.adults} adulți`;
      if (conv.data.children_ages) peopleText += ` + copii (${conv.data.children_ages} ani)`;

      bot.sendMessage(chatId, `${peopleText}\n\n🍽️ *Ce tip de masă preferi?*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: foodKeyboard }
      });
    }

    // STEP: Budget
    else if (conv.step === 'budget') {
      if (text.toLowerCase() === 'orice' || text.toLowerCase() === 'fara limita') {
        conv.data.max_price = null;
      } else {
        const price = parseInt(text.replace(/[^\d]/g, ''));
        if (!price || price < 50) {
          bot.sendMessage(chatId, '❌ Scrie un preț valid (ex: `1000`):',
            { parse_mode: 'Markdown' });
          return;
        }
        conv.data.max_price = price;
      }
      conv.data.currency = 'eur';

      // ===== SAVE ALERT =====
      try {
        const d = conv.data;
        stmts.insertAlert.run(
          d.chat_id, d.username || null, d.first_name || null,
          d.country_id, d.country_name,
          d.dept_city_id || 1831, d.dept_city_name || 'Chișinău',
          d.check_in, d.check_to || null,
          d.nights || 7, d.adults || 2, d.children_ages || null,
          d.stars || null, d.food || null,
          d.max_price || null, d.currency || 'eur', d.transport || 'air',
          null, null, null, null, null // tour_id, tour_name, tour_url, tour_img, search_params — /urmareste tracks whole destination
        );

        const link = buildZebraturLink(d);

        const country = Object.entries(COUNTRIES).find(([, v]) => v.id === d.country_id);
        const flag = country ? country[1].flag : '🏖️';

        let summary = `✅ *Alertă setată!*\n\n`;
        summary += `${flag} *${d.country_name}*\n`;
        summary += `✈️ Din ${d.dept_city_name}\n`;
        summary += `📅 ${d.check_in} | 🌙 ${d.nights} nopți\n`;
        summary += `👥 ${d.adults} adulți${d.children_ages ? ' + copii ' + d.children_ages + ' ani' : ''}\n`;
        if (d.stars) summary += `⭐ ${d.stars} stele\n`;
        if (d.food) summary += `🍽️ ${d.food.toUpperCase()}\n`;
        if (d.max_price) summary += `💰 Max: ${d.max_price} EUR\n`;
        summary += `\n🔗 [Vezi oferte pe ZebraTur](${link})\n\n`;
        summary += `📬 Vei primi notificare când găsesc oferte bune!\n`;
        summary += `Poți seta mai multe alerte cu /urmareste`;

        bot.sendMessage(chatId, summary, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });

        conversations.delete(chatId);
      } catch (err) {
        console.error('[Telegram] Error saving alert:', err.message);
        bot.sendMessage(chatId, '❌ Eroare la salvarea alertei. Încearcă din nou cu /urmareste');
        conversations.delete(chatId);
      }
    }
  });

  // Handle nights callback (inline buttons)
  bot.on('callback_query', (query) => {
    if (!query.data.startsWith('nights_')) return;
    const chatId = query.message.chat.id;
    const conv = conversations.get(chatId);
    if (!conv || conv.step !== 'nights') return;

    bot.answerCallbackQuery(query.id);
    conv.data.nights = parseInt(query.data.replace('nights_', ''));
    conv.step = 'people';

    bot.sendMessage(chatId,
      `🌙 *${conv.data.nights} nopți*\n\n` +
      `👥 *Câte persoane?*\nScrie, de exemplu:\n` +
      `• \`2 adulti\`\n` +
      `• \`2 adulti 2 copii 4 5\` (vârstele copiilor)\n` +
      `• Sau doar un număr: \`2\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ===== SEND TELEGRAM PRICE ALERT =====
  async function sendTelegramPriceAlert(alert, bestPrice, bestHotel, allOffers) {
    const country = Object.entries(COUNTRIES).find(([, v]) => v.id === alert.country_id);
    const flag = country ? country[1].flag : '🏖️';
    const link = buildZebraturLink(alert);

    let text = `🔔 *Alertă preț — ${flag} ${alert.country_name}!*\n\n`;

    if (alert.last_best_price && bestPrice < alert.last_best_price) {
      const savings = alert.last_best_price - bestPrice;
      text += `📉 Prețul a scăzut cu *${savings.toFixed(0)} EUR*!\n\n`;
    }

    // Show top 3 offers
    const top = allOffers.slice(0, 3);
    top.forEach((offer, i) => {
      const medal = ['🥇', '🥈', '🥉'][i];
      text += `${medal} *${offer.name}*\n`;
      text += `   💰 ${offer.price} ${alert.currency.toUpperCase()}/pers\n`;
      if (offer.stars) text += `   ⭐ ${offer.stars} stele\n`;
      text += `\n`;
    });

    text += `📅 ${alert.check_in} | 🌙 ${alert.nights} nopți | 👥 ${alert.adults} pers\n\n`;
    text += `🔗 [Vezi toate ofertele pe ZebraTur](${link})\n`;
    text += `📞 Rezervări: ${AGENCY.phone}`;

    try {
      await bot.sendMessage(alert.chat_id, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '🔗 Vezi oferte', url: link }
          ]]
        }
      });
      stmts.markAlertNotified.run(alert.id);
      console.log(`[Telegram] Alert sent to ${alert.chat_id} for ${alert.country_name}`);
    } catch (err) {
      console.error(`[Telegram] Failed to send to ${alert.chat_id}:`, err.message);
      // If bot was blocked by user, deactivate their alerts
      if (err.response?.statusCode === 403) {
        console.log(`[Telegram] User ${alert.chat_id} blocked the bot, deactivating alerts`);
        db.prepare('UPDATE telegram_alerts SET active = 0 WHERE chat_id = ?').run(alert.chat_id);
      }
    }
  }

  // ===== SEND SPECIFIC HOTEL PRICE ALERT =====
  // Used when alert has tour_id (from website deep link) — tracks ONE hotel
  // Uses tour_url (specific hotel link) just like email notifications do
  async function sendTelegramHotelAlert(alert, oldPrice, newPrice, changePct, hotelData) {
    const country = Object.entries(COUNTRIES).find(([, v]) => v.id === alert.country_id);
    const flag = country ? country[1].flag : '🏖️';
    // Use the specific hotel URL if available (stored from pre-registration, like email)
    // Fall back to destination search link only if tour_url is missing
    const link = alert.tour_url || buildZebraturLink(alert);
    const hotelName = alert.tour_name || hotelData.name || `Hotel #${alert.tour_id}`;

    const isDecrease = newPrice < oldPrice;
    const arrow = isDecrease ? '📉' : '📈';
    const direction = isDecrease ? 'scăzut' : 'crescut';

    let text = `🔔 *Alertă preț hotel!*\n\n`;
    text += `🏨 *${hotelName}*\n`;
    text += `${flag} ${alert.country_name}\n\n`;

    if (oldPrice) {
      text += `${arrow} Prețul a *${direction}*:\n`;
      text += `   ~${oldPrice.toFixed(0)}~ → *${newPrice.toFixed(0)} ${(alert.currency || 'eur').toUpperCase()}*/pers\n`;
      text += `   ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%\n\n`;
    } else {
      text += `💰 Preț actual: *${newPrice.toFixed(0)} ${(alert.currency || 'eur').toUpperCase()}*/pers\n\n`;
    }

    text += `📅 ${alert.check_in} | 🌙 ${alert.nights} nopți | 👥 ${alert.adults} pers\n`;
    if (alert.food) text += `🍽️ ${alert.food.toUpperCase()}\n`;
    text += `\n📞 Rezervări: ${AGENCY.phone}`;

    try {
      await bot.sendMessage(alert.chat_id, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '🔗 Vezi oferta', url: link }
          ]]
        }
      });
      stmts.markAlertNotified.run(alert.id);
      console.log(`[Telegram] Hotel alert sent to ${alert.chat_id} for hotel ${alert.tour_id} (${hotelName})`);
    } catch (err) {
      console.error(`[Telegram] Failed to send hotel alert to ${alert.chat_id}:`, err.message);
      if (err.response?.statusCode === 403) {
        console.log(`[Telegram] User ${alert.chat_id} blocked the bot, deactivating alerts`);
        db.prepare('UPDATE telegram_alerts SET active = 0 WHERE chat_id = ?').run(alert.chat_id);
      }
    }
  }

  // ===== CHECK PRICES FOR TELEGRAM ALERTS =====
  // Two paths: alerts WITH search_params use them directly (like email — exact same API call)
  //            alerts WITHOUT search_params reconstruct from columns (legacy/urmareste)
  async function checkTelegramAlerts() {
    const alerts = stmts.getActiveAlerts.all();
    if (alerts.length === 0) return;

    console.log(`[Telegram] Checking ${alerts.length} active alerts...`);

    // Split alerts into two groups: those with stored search_params and those without
    const withSearchParams = [];   // from website (pre-registration) — use exact params like email
    const withoutSearchParams = []; // from /urmareste command — reconstruct from columns

    for (const alert of alerts) {
      if (alert.search_params) {
        withSearchParams.push(alert);
      } else {
        withoutSearchParams.push(alert);
      }
    }

    // ===== PATH 1: Alerts with stored search_params (SAME logic as email checkAllPrices) =====
    if (withSearchParams.length > 0) {
      // Group by search params to batch API calls — EXACTLY like email does
      const searchGroups = {};
      for (const alert of withSearchParams) {
        try {
          const sp = JSON.parse(alert.search_params);
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
          if (!searchGroups[key]) searchGroups[key] = { params: sp, alerts: [] };
          searchGroups[key].alerts.push(alert);
        } catch (e) {
          // Bad JSON — fall back to column-based
          withoutSearchParams.push(alert);
        }
      }

      console.log(`[Telegram] ${Object.keys(searchGroups).length} search groups (with stored params), ${withoutSearchParams.length} legacy alerts`);

      for (const group of Object.values(searchGroups)) {
        try {
          // Use stored search params directly — same API call as email
          const hotelPrices = await searchPricesFn(group.params);
          if (!hotelPrices) continue;

          const sortedHotels = Object.entries(hotelPrices)
            .map(([id, data]) => ({ id, ...data }))
            .sort((a, b) => a.price - b.price);

          if (sortedHotels.length === 0) continue;

          for (const alert of group.alerts) {
            await processAlertWithResults(alert, hotelPrices, sortedHotels);
          }

          await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
          console.error('[Telegram] Search group error (stored params):', err.message);
        }
      }
    }

    // ===== PATH 2: Alerts without search_params (legacy — reconstruct from columns) =====
    if (withoutSearchParams.length > 0) {
      const groups = {};
      for (const alert of withoutSearchParams) {
        const key = JSON.stringify({
          countryId: alert.country_id,
          checkIn: alert.check_in,
          checkTo: alert.check_to,
          length: String(alert.nights || 7),
          deptCity: String(alert.dept_city_id || 1831),
          people: buildPeopleParam(alert.adults, alert.children_ages),
          food: alert.food || '',
          stars: alert.stars ? String(alert.stars) : '',
          transport: alert.transport || 'air',
        });
        if (!groups[key]) groups[key] = { params: JSON.parse(key), alerts: [] };
        groups[key].alerts.push(alert);
      }

      for (const group of Object.values(groups)) {
        try {
          const sp = {
            countryId: group.params.countryId,
            checkIn: group.params.checkIn,
            checkTo: group.params.checkTo || group.params.checkIn,
            length: group.params.length,
            people: group.params.people,
            food: group.params.food,
            stars: group.params.stars,
            transport: group.params.transport,
            deptCity: group.params.deptCity,
            currencyLocal: 'eur',
          };

          const hotelPrices = await searchPricesFn(sp);
          if (!hotelPrices) continue;

          const sortedHotels = Object.entries(hotelPrices)
            .map(([id, data]) => ({ id, ...data }))
            .sort((a, b) => a.price - b.price);

          if (sortedHotels.length === 0) continue;

          for (const alert of group.alerts) {
            await processAlertWithResults(alert, hotelPrices, sortedHotels);
          }

          await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
          console.error('[Telegram] Search group error (legacy):', err.message);
        }
      }
    }
  }

  // ===== PROCESS SINGLE ALERT WITH SEARCH RESULTS =====
  // Shared logic for both paths (stored params and legacy)
  async function processAlertWithResults(alert, hotelPrices, sortedHotels) {
    const tourIdStr = alert.tour_id ? String(alert.tour_id) : null;

    // === SPECIFIC HOTEL TRACKING (when tour_id exists — from website deep link) ===
    if (tourIdStr) {
      // Try both string and number keys — Otpusk API can return either
      const hotelData = hotelPrices[tourIdStr] || hotelPrices[parseInt(tourIdStr)];
      if (!hotelData) {
        console.log(`[Telegram] Hotel ${tourIdStr} not found in search results for alert #${alert.id} (available: ${Object.keys(hotelPrices).slice(0, 5).join(', ')}...)`);
        return;
      }

      const newPrice = hotelData.price;
      if (!newPrice || newPrice <= 0) return;

      // Save hotel name on first discovery
      if (!alert.tour_name && hotelData.name) {
        stmts.updateAlertTourName.run(hotelData.name, alert.id);
        alert.tour_name = hotelData.name;
      }

      const oldPrice = alert.last_best_price;
      stmts.updateAlertPrice.run(newPrice, hotelData.name || tourIdStr, alert.id);

      // Calculate change %
      const changePct = oldPrice ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;

      // No previous price — just record, don't alert
      if (!oldPrice) {
        console.log(`[Telegram] Hotel ${tourIdStr}: first price recorded ${newPrice} EUR`);
        return;
      }

      // Price didn't change enough — skip
      if (Math.abs(changePct) < 3) return;

      // Cooldown disabled for testing — every 3%+ change sends alert immediately
      // TODO: re-enable for production (e.g. 4 * 60 * 60 * 1000 = 4 hours)
      // if (alert.last_notified) {
      //   const lastNotif = new Date(alert.last_notified).getTime();
      //   const cooldown = 4 * 60 * 60 * 1000;
      //   if (Date.now() - lastNotif < cooldown) return;
      // }

      console.log(`[Telegram] Hotel ${tourIdStr} (${alert.tour_name}): ${oldPrice} → ${newPrice} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%) — sending alert`);
      await sendTelegramHotelAlert(alert, oldPrice, newPrice, changePct, hotelData);
      return;
    }

    // === DESTINATION TRACKING (no tour_id — from /urmareste command) ===
    let relevantOffers = sortedHotels;
    if (alert.max_price) {
      relevantOffers = sortedHotels.filter(h => h.price <= alert.max_price);
    }
    if (relevantOffers.length === 0) return;

    const bestOffer = relevantOffers[0];
    const bestPrice = bestOffer.price;

    stmts.updateAlertPrice.run(bestPrice, bestOffer.name || bestOffer.id, alert.id);

    // Notify if: first check, or price dropped significantly
    const shouldNotify =
      !alert.last_best_price ||
      (bestPrice < alert.last_best_price * 0.97) ||
      (!alert.last_notified);

    // Cooldown: don't notify more than once per 6 hours
    if (alert.last_notified) {
      const lastNotif = new Date(alert.last_notified).getTime();
      const cooldown = 6 * 60 * 60 * 1000;
      if (Date.now() - lastNotif < cooldown) return;
    }

    if (shouldNotify) {
      await sendTelegramPriceAlert(alert, bestPrice, bestOffer.name, relevantOffers.slice(0, 5));
    }
  }

  // Helper: build people param for Otpusk API (2 adults + kids 4,5 = "20405")
  function buildPeopleParam(adults, childrenAges) {
    let people = String(adults || 2);
    if (childrenAges) {
      const ages = childrenAges.split(',').map(a => a.trim()).filter(Boolean);
      ages.forEach(age => {
        people += String(parseInt(age)).padStart(2, '0');
      });
    }
    return people;
  }

  // ===== RETURN BOT INTERFACE =====
  return {
    bot,
    checkTelegramAlerts,
    stmts,
    sendTelegramPriceAlert,
    sendTelegramHotelAlert,
  };
}

module.exports = { initTelegramBot };
