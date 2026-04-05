/* ============================================================
   ZEBRA TOUR – PRICE WATCHER (Frontend)
   Adds "Urmareste pretul" button in wishlist & on tour results
   Sends data to backend API for price tracking & email/telegram alerts
   ============================================================ */
(function() {
  'use strict';

  // ===== CONFIG — change this to your Railway backend URL =====
  var PW_API_URL = 'https://web-production-a7362.up.railway.app';
  var PW_WISHLIST_KEY = 'zebra_wishlist';
  var PW_EMAIL_KEY = 'pw_user_email'; // remember email in localStorage
  var PW_TELEGRAM_BOT = 'zebrapricebot'; // Telegram bot username (without @)

  // ===== TOAST =====
  function pwToast(msg) {
    var existing = document.getElementById('pwToast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.id = 'pwToast';
    t.className = 'pw-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.classList.add('pw-toast-show'); }, 10);
    setTimeout(function() {
      t.classList.remove('pw-toast-show');
      setTimeout(function() { t.remove(); }, 300);
    }, 2500);
  }

  // ===== CLOSE MODAL =====
  function closePwModal() {
    var overlay = document.getElementById('pwModalOverlay');
    if (overlay) {
      overlay.classList.remove('pw-modal-open');
      setTimeout(function() { overlay.remove(); }, 300);
    }
  }

  // ===== GET SAVED EMAIL =====
  function getSavedEmail() {
    try { return localStorage.getItem(PW_EMAIL_KEY) || ''; } catch(e) { return ''; }
  }
  function saveEmail(email) {
    try { localStorage.setItem(PW_EMAIL_KEY, email); } catch(e) {}
  }

  // ===== EXTRACT SEARCH PARAMS FROM OTPUSK WIDGET =====
  // Catches the last API search URL to know: country, dates, people, food, stars etc.
  // This data is sent both to our backend AND encoded in the Telegram deep link
  function extractSearchParams() {
    try {
      var entries = performance.getEntriesByType('resource');
      var searchEntries = entries.filter(function(e) {
        return e.name.indexOf('tours/search') > -1 && e.name.indexOf('api.otpusk.com') > -1;
      });

      if (searchEntries.length === 0) return null;

      var lastSearch = searchEntries[searchEntries.length - 1];
      var url = new URL(lastSearch.name);
      var params = {};

      var keys = ['to', 'checkIn', 'checkTo', 'length', 'lengthTo', 'people', 'food',
                  'transport', 'stars', 'deptCity', 'currencyLocal', 'rating', 'price', 'priceTo', 'services'];
      keys.forEach(function(k) {
        var v = url.searchParams.get(k);
        if (v !== null && v !== '') params[k] = v;
      });

      return {
        countryId: params.to || null,
        checkIn: params.checkIn || null,
        checkTo: params.checkTo || params.checkIn || null,
        length: params.length || '7',
        lengthTo: params.lengthTo || '',
        people: params.people || '2',
        food: params.food || '',
        transport: params.transport || 'air',
        stars: params.stars || '',
        deptCity: params.deptCity || '1831',
        currencyLocal: params.currencyLocal || 'eur',
        price: params.price || '',
        priceTo: params.priceTo || ''
      };
    } catch(e) {
      console.log('[PriceWatcher] Could not extract search params:', e.message);
      return null;
    }
  }

  // ===== BUILD TELEGRAM DEEP LINK PAYLOAD =====
  // Encodes tour + search data into a string for t.me/bot?start=PAYLOAD
  // Format: countryId_deptCity_checkInYYYYMMDD_nights_people_stars_food_price_transport_hotelId
  // The Telegram bot parses this on /start and creates a price alert automatically
  function encodeTelegramPayload(tour, searchParams) {
    var parts = [];
    if (searchParams && searchParams.countryId) {
      parts.push(searchParams.countryId);                           // 0: country ID
      parts.push(searchParams.deptCity || '1831');                  // 1: departure city ID
      parts.push((searchParams.checkIn || '').replace(/-/g, ''));   // 2: checkIn YYYYMMDD
      parts.push(searchParams.length || '7');                       // 3: nights
      parts.push(searchParams.people || '2');                       // 4: people (Otpusk format: "20405" = 2 adults + kids 4,5)
      parts.push(searchParams.stars || '0');                        // 5: stars (0 = any)
      parts.push((searchParams.food || 'any').replace(/,/g, '-'));   // 6: food code (ai-uai, hb, bb — comma replaced with dash for Telegram)
      parts.push(tour.price ? Math.round(tour.price) : '0');       // 7: current price
      parts.push(searchParams.transport || 'air');                  // 8: transport type
      parts.push(tour.id || '0');                                    // 9: hotel/tour ID (for specific hotel tracking)
    } else {
      // Fallback when search params not available
      parts.push('0');   // 0: country
      parts.push('1831');
      parts.push('0');
      parts.push('7');
      parts.push('2');
      parts.push('0');
      parts.push('any');
      parts.push(tour.price ? Math.round(tour.price) : '0');
      parts.push('air');
      parts.push(tour.id || '0');                                    // 9: hotel/tour ID
    }
    return parts.join('_');
  }

  // ===== EXTRACT TOUR DATA FROM RESULT CARD (Otpusk widget) =====
  function extractTourFromCard(card) {
    var tour = {};

    // Hotel name — Otpusk uses .new_r-item-hotel
    var nameEl = card.querySelector('.new_r-item-hotel');
    if (nameEl) tour.name = nameEl.textContent.trim();

    // Price — Otpusk uses .new_price-value
    var priceEl = card.querySelector('.new_price-value');
    if (priceEl) {
      var priceText = priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.');
      tour.price = parseFloat(priceText);
    }

    // Currency from price description
    var priceDesc = card.querySelector('.new_price-desc');
    if (priceDesc) {
      var descText = priceDesc.textContent.trim();
      if (descText.indexOf('€') > -1 || descText.indexOf('eur') > -1) tour.currency = 'EUR';
      else if (descText.indexOf('$') > -1 || descText.indexOf('usd') > -1) tour.currency = 'USD';
    }
    // Also check the price value itself for currency symbol
    if (!tour.currency && priceEl) {
      var pvt = priceEl.textContent;
      if (pvt.indexOf('€') > -1) tour.currency = 'EUR';
      else if (pvt.indexOf('$') > -1) tour.currency = 'USD';
    }

    // Geo — Otpusk uses .new_r-item-geo
    var geoEl = card.querySelector('.new_r-item-geo');
    if (geoEl) {
      var geoText = geoEl.textContent.trim().replace('Arată pe hartă', '').trim();
      tour.geo = geoText;
    }

    // Food — Otpusk uses .new_r-item-food
    var foodEl = card.querySelector('.new_r-item-food');
    if (foodEl) tour.food = foodEl.textContent.trim();

    // Image
    var imgEl = card.querySelector('.new_r-item-img img, img');
    if (imgEl) tour.img = imgEl.src || imgEl.getAttribute('data-src') || '';

    // Tour link — find the main link in the card
    var linkEl = card.querySelector('a[href]');
    if (linkEl) tour.link = linkEl.href;

    // Tour/Hotel ID — from the parent wrapper data-id attribute
    var wrapper = card.closest('.new_r-item-wrap[data-id]') || card.closest('[data-id]');
    if (wrapper) {
      tour.id = wrapper.getAttribute('data-id');
    }

    // Fallback: extract from link (hid parameter or path)
    if (!tour.id && tour.link) {
      var hidMatch = tour.link.match(/hid=(\d+)/);
      if (hidMatch) tour.id = hidMatch[1];
      else {
        var pathMatch = tour.link.match(/\/(\d+)/);
        if (pathMatch) tour.id = pathMatch[1];
      }
    }

    // Fallback ID from name
    if (!tour.id && tour.name) {
      tour.id = tour.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    }

    // Stars — from wrapper or card
    var starsEl = card.querySelector('.new_r-item-stars, [class*="stars"]');
    if (starsEl) {
      var starsText = starsEl.textContent.trim();
      var starsNum = parseInt(starsText);
      if (starsNum >= 1 && starsNum <= 5) tour.stars = starsNum;
    }

    // Dates — try to find from .new_r-item-col or table
    var cols = card.querySelectorAll('.new_r-item-col');
    cols.forEach(function(col) {
      var text = col.textContent.trim();
      if (/\d+\s*(iun|iul|aug|mai|sept|oct|nov|dec|ian|feb|mar|apr)/i.test(text) && !tour.dates) {
        tour.dates = text.replace(/\s+/g, ' ').substring(0, 50);
      }
    });

    return tour;
  }

  // ===== OPEN WATCH MODAL =====
  function openWatchModal(tour) {
    closePwModal();

    if (!tour || !tour.price) {
      pwToast('Nu s-a putut determina pretul turului');
      return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'pwModalOverlay';
    overlay.className = 'pw-modal-overlay';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closePwModal(); });

    var modal = document.createElement('div');
    modal.className = 'pw-modal';

    // Header
    var header = document.createElement('div');
    header.className = 'pw-modal-header';
    header.innerHTML = '<span class="pw-modal-title">\uD83D\uDD14 Urmareste pretul</span>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'pw-modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', closePwModal);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body
    var body = document.createElement('div');
    body.className = 'pw-modal-body';

    // Tour info
    var tourInfo = document.createElement('div');
    tourInfo.className = 'pw-tour-info';
    var html = '<div class="pw-tour-name">' + (tour.name || 'Hotel') + '</div>';
    html += '<div class="pw-tour-price">' + (tour.price || '') + (tour.currency ? ' ' + tour.currency : '') + '</div>';
    if (tour.geo) html += '<div class="pw-tour-detail">\uD83D\uDCCD ' + tour.geo + '</div>';
    if (tour.dates) html += '<div class="pw-tour-detail">\uD83D\uDCC5 ' + tour.dates + '</div>';
    tourInfo.innerHTML = html;
    body.appendChild(tourInfo);

    // ===== TELEGRAM BUTTON (first — most visible) =====
    // Encodes tour data (country, dates, people, price etc.) into a deep link
    // When user opens this link in Telegram, the bot auto-creates a price alert
    var searchParams = extractSearchParams();
    var tgPayload = encodeTelegramPayload(tour, searchParams);
    var tgLink = 'https://t.me/' + PW_TELEGRAM_BOT + '?start=' + tgPayload;

    var tgBtn = document.createElement('a');
    tgBtn.href = tgLink;
    tgBtn.target = '_blank';
    tgBtn.className = 'pw-telegram-btn';
    tgBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg> Urmareste pe Telegram';
    tgBtn.addEventListener('click', function() {
      setTimeout(closePwModal, 500);
    });
    body.appendChild(tgBtn);

    // ===== SEPARATOR =====
    var separator = document.createElement('div');
    separator.className = 'pw-separator';
    separator.innerHTML = '<span>sau prin email</span>';
    body.appendChild(separator);

    // ===== EMAIL INPUT =====
    var inputGroup = document.createElement('div');
    inputGroup.className = 'pw-input-group';
    var label = document.createElement('label');
    label.className = 'pw-input-label';
    label.textContent = 'Email-ul tau:';
    label.setAttribute('for', 'pwEmailInput');
    inputGroup.appendChild(label);
    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.id = 'pwEmailInput';
    emailInput.className = 'pw-email-input';
    emailInput.placeholder = 'exemplu@email.com';
    emailInput.value = getSavedEmail();
    inputGroup.appendChild(emailInput);
    body.appendChild(inputGroup);

    // Submit button
    var submitBtn = document.createElement('button');
    submitBtn.className = 'pw-submit-btn';
    submitBtn.textContent = '\uD83D\uDD14 Activeaza urmarirea pretului';
    submitBtn.addEventListener('click', function() {
      var email = emailInput.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        pwToast('Introdu un email valid');
        emailInput.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '\u23F3 Se trimite...';
      saveEmail(email);

      // Capture search params from the widget's last search
      var searchParams = extractSearchParams();

      // Send to API — includes searchParams so backend can replay the same search
      var payload = {
        email: email,
        tourId: tour.id || tour.name || 'unknown',
        tourName: tour.name || null,
        tourUrl: tour.link || null,
        tourImg: tour.img || null,
        price: tour.price,
        currency: tour.currency || 'EUR',
        geo: tour.geo || null,
        dates: tour.dates || null,
        stars: tour.stars || null,
        food: tour.food || null,
        searchParams: searchParams
      };

      fetch(PW_API_URL + '/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success) {
          body.innerHTML = '';
          var success = document.createElement('div');
          success.className = 'pw-success-msg';
          success.innerHTML = '<div class="pw-success-icon">\u2705</div>' +
            '<div class="pw-success-text">Urmarirea pretului activata!</div>' +
            '<div class="pw-success-sub">Vei primi o notificare pe <strong>' + email + '</strong> cand pretul se schimba cu mai mult de 3%.</div>';
          body.appendChild(success);
          setTimeout(closePwModal, 3000);
        } else {
          submitBtn.disabled = false;
          submitBtn.textContent = '\uD83D\uDD14 Activeaza urmarirea pretului';
          pwToast(data.error || 'Eroare. Incearca din nou.');
        }
      })
      .catch(function() {
        submitBtn.disabled = false;
        submitBtn.textContent = '\uD83D\uDD14 Activeaza urmarirea pretului';
        pwToast('Eroare de conexiune. Incearca din nou.');
      });
    });
    body.appendChild(submitBtn);

    // Hint
    var hint = document.createElement('div');
    hint.className = 'pw-hint';
    hint.textContent = 'Verificam pretul la fiecare ora. Te poti dezabona oricand din email.';
    body.appendChild(hint);

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(function() { overlay.classList.add('pw-modal-open'); }, 10);

    // Focus email input if empty
    if (!emailInput.value) {
      setTimeout(function() { emailInput.focus(); }, 400);
    }
  }

  // ===== BELL ICON SVG =====
  var bellSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/></svg>';

  // ===== ADD WATCH BUTTON TO WISHLIST ITEMS =====
  function addWatchButtonsToWishlist() {
    var panel = document.getElementById('zebraWishlistPanel');
    if (!panel) return;
    var items = panel.querySelectorAll('.zebra-wishlist-item');
    items.forEach(function(item) {
      if (item.querySelector('.pw-watch-btn')) return;

      var tour = {};
      try {
        var wishlist = JSON.parse(localStorage.getItem(PW_WISHLIST_KEY)) || [];
        var idx = Array.prototype.indexOf.call(item.parentElement.children, item);
        if (wishlist[idx]) tour = wishlist[idx];
      } catch(e) {}

      if (!tour.price) return;

      var btn = document.createElement('button');
      btn.className = 'pw-watch-btn';
      btn.innerHTML = bellSvg + ' Urmareste pretul';
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        openWatchModal(tour);
      });

      var priceEl = item.querySelector('.zebra-wishlist-price, [class*="price"]');
      if (priceEl) {
        priceEl.parentNode.insertBefore(btn, priceEl.nextSibling);
      } else {
        item.appendChild(btn);
      }
    });
  }

  // ===== ADD WATCH BUTTON TO TOUR RESULT CARDS =====
  function addWatchButtonsToResults() {
    var cards = document.querySelectorAll('.new_r-item');
    cards.forEach(function(card) {
      if (card.querySelector('.pw-result-watch-btn')) return;

      var tour = extractTourFromCard(card);
      if (!tour.price) return;

      var btn = document.createElement('button');
      btn.className = 'pw-result-watch-btn';
      btn.innerHTML = bellSvg + ' Urmareste pretul';
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        openWatchModal(tour);
      });

      var priceBlock = card.querySelector('.new_r-item-price');
      if (priceBlock) {
        priceBlock.parentNode.insertBefore(btn, priceBlock.nextSibling);
      } else {
        var heartBtn = card.querySelector('.zebra-heart-btn');
        if (heartBtn) {
          heartBtn.parentNode.insertBefore(btn, heartBtn.nextSibling);
        } else {
          card.appendChild(btn);
        }
      }
    });
  }

  // ===== WATCH FOR DOM CHANGES =====
  function watchForChanges() {
    var observer = new MutationObserver(function() {
      var panel = document.getElementById('zebraWishlistPanel');
      if (panel && panel.classList.contains('open')) {
        setTimeout(addWatchButtonsToWishlist, 200);
      }
      setTimeout(addWatchButtonsToResults, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // ===== INIT =====
  function initPriceWatcher() {
    watchForChanges();
    setTimeout(addWatchButtonsToWishlist, 2000);
    setTimeout(addWatchButtonsToResults, 2000);
    setTimeout(addWatchButtonsToWishlist, 5000);
    setTimeout(addWatchButtonsToResults, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPriceWatcher);
  } else {
    initPriceWatcher();
  }
})();
