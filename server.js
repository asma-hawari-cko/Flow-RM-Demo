require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const {
  CHECKOUT_SECRET_KEY,
  CHECKOUT_PUBLIC_KEY,
  CHECKOUT_ENV = 'sandbox',
  CHECKOUT_PROCESSING_CHANNEL_ID,
  PORT = 3000,
} = process.env;

if (!CHECKOUT_SECRET_KEY || !CHECKOUT_PUBLIC_KEY) {
  console.error('Missing CHECKOUT_SECRET_KEY or CHECKOUT_PUBLIC_KEY. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

const CHECKOUT_API_BASE = CHECKOUT_ENV === 'production'
  ? 'https://api.checkout.com'
  : 'https://api.sandbox.checkout.com';

const PROMOTIONS_FILE = path.join(__dirname, 'promotions.json');

// ---- Promotions "database" --------------------------------------------------

function readPromotions() {
  try {
    const raw = fs.readFileSync(PROMOTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.promotions) ? parsed.promotions : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read promotions:', err);
    return [];
  }
}

function writePromotions(promotions) {
  fs.writeFileSync(PROMOTIONS_FILE, JSON.stringify({ promotions }, null, 2) + '\n');
}

function findPromotionByBin(cardBin) {
  if (!cardBin || cardBin.length < 4) return null;
  const promotions = readPromotions().filter((p) => p.active);
  promotions.sort((a, b) => b.bin_prefix.length - a.bin_prefix.length);
  return promotions.find((p) => {
    const minLen = Math.min(p.bin_prefix.length, cardBin.length);
    return p.bin_prefix.slice(0, minLen) === cardBin.slice(0, minLen);
  }) || null;
}

function applyPromotionToAmount(amount, promotion) {
  if (!promotion) return { finalAmount: amount, discountAmount: 0 };
  const discountAmount = Math.round((amount * promotion.discount_percent) / 100);
  return { finalAmount: amount - discountAmount, discountAmount };
}

// ---- Cart -------------------------------------------------------------------
// The demo has a single fixed cart. In production, look the total up in your DB
// by session id (or by reading GET /payment-sessions/{id} from Checkout).
const DEMO_CART_AMOUNT_MINOR = 2500;
const DEMO_CART_CURRENCY = 'AED';

// ---- App --------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({ publicKey: CHECKOUT_PUBLIC_KEY, environment: CHECKOUT_ENV });
});

// ---- Promotions API ---------------------------------------------------------

app.get('/api/promotions', (_req, res) => {
  res.json({ promotions: readPromotions() });
});

app.post('/api/promotions', (req, res) => {
  const { bin_prefix, discount_percent, label, description, active = true } = req.body || {};

  if (!bin_prefix || !/^\d{4,16}$/.test(String(bin_prefix))) {
    return res.status(400).json({ error: 'bin_prefix must be 4–16 digits.' });
  }
  if (typeof discount_percent !== 'number' || discount_percent <= 0 || discount_percent > 100) {
    return res.status(400).json({ error: 'discount_percent must be a number between 0 and 100.' });
  }

  const promotions = readPromotions();
  const promotion = {
    id: 'promo_' + crypto.randomBytes(6).toString('hex'),
    bin_prefix: String(bin_prefix),
    discount_percent,
    label: label || `${discount_percent}% off`,
    description: description || '',
    active: Boolean(active),
    created_at: new Date().toISOString(),
  };
  promotions.push(promotion);
  writePromotions(promotions);
  res.status(201).json(promotion);
});

app.get('/api/promotions/bin/:bin', (req, res) => {
  const promotion = findPromotionByBin(String(req.params.bin || '').replace(/\D/g, ''));
  res.json({ promotion });
});

// ---- Create a payment session ----------------------------------------------
// Always created at the FULL cart amount. The discount is applied later via
// POST /payment-sessions/{id}/submit, so the session never needs to be re-minted.

app.post('/api/payment-sessions', async (req, res) => {
  const { amount, currency, customer } = req.body || {};

  if (!customer || !customer.name || !customer.email) {
    return res.status(400).json({ error: 'Customer name and email are required.' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive integer (minor units).' });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const reference = `ORD-${Date.now()}`;

  const payload = {
    amount,
    currency: currency || 'AED',
    reference,
    billing: { address: { country: 'AE' } },
    customer: { name: customer.name, email: customer.email },
    '3ds': { enabled: true, attempt_n3d: false },
    success_url: `https://flow-rm-demo.onrender.com/success.html`,
    failure_url: `https://flow-rm-demo.onrender.com/failure.html`,
    processing_channel_id: CHECKOUT_PROCESSING_CHANNEL_ID || undefined,
  };

  try {
    const response = await fetch(`${CHECKOUT_API_BASE}/payment-sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CHECKOUT_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      console.error('Checkout API error:', response.status, data);
      return res.status(response.status).json({ error: 'Failed to create payment session.', details: data });
    }

    console.log(`[/api/payment-sessions] created ${data.id} amount=${amount} ${payload.currency}`);

    res.json({
      id: data.id,
      payment_session_secret: data.payment_session_secret,
      payment_session_token: data.payment_session_token,
    });
  } catch (err) {
    console.error('Network error:', err);
    res.status(500).json({ error: 'Unable to reach Checkout.com API.' });
  }
});

// ---- Submit a payment session ----------------------------------------------
// Called by the browser's handleSubmit callback. Forwards Flow's session_data
// (and anything else it produced) to Checkout's /submit, overriding `amount`
// based on the server-resolved promotion. The Checkout response is returned
// untouched — Flow consumes it on the client to drive 3DS.

app.post('/api/payment-sessions/:id/submit', async (req, res) => {
  const sessionId = req.params.id;
  const { submit_data, promotion_id } = req.body || {};

  if (submit_data === undefined || submit_data === null) {
    return res.status(400).json({ error: 'submit_data is required.' });
  }

  // Server-side authority: re-resolve the promotion against our DB.
  let appliedPromotion = null;
  if (promotion_id) {
    appliedPromotion = readPromotions().find((p) => p.id === promotion_id && p.active) || null;
  }
  const { finalAmount, discountAmount } = applyPromotionToAmount(DEMO_CART_AMOUNT_MINOR, appliedPromotion);

  // Flow's handleSubmit hands us either a string (the raw session_data token)
  // or an object containing session_data + extras. Normalise both.
  let baseFields;
  if (typeof submit_data === 'string') {
    baseFields = { session_data: submit_data };
  } else if (typeof submit_data === 'object') {
    baseFields = submit_data;
  } else {
    return res.status(400).json({ error: 'submit_data must be a string or object.' });
  }

  // Our overrides always win over what the client sent.
  const payload = Object.assign({}, baseFields, {
    amount: finalAmount,
    '3ds': { enabled: true, attempt_n3d: false },
  });
  if (appliedPromotion) {
    payload.metadata = Object.assign({}, baseFields.metadata, {
      promotion_id: appliedPromotion.id,
      discount_amount: discountAmount,
      original_amount: DEMO_CART_AMOUNT_MINOR,
    });
  }

  const url = `${CHECKOUT_API_BASE}/payment-sessions/${encodeURIComponent(sessionId)}/submit`;
  console.log(`[/api/payment-sessions/${sessionId}/submit] → ${url} amount=${finalAmount}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CHECKOUT_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    console.log(`[/api/payment-sessions/${sessionId}/submit] ← ${response.status}`,
      data && data.status ? data.status : (data.error_type || ''));

    if (!response.ok) {
      console.error('Submit API error body:', data);
    }

    // Per the docs: "You must provide the unmodified response to the handleSubmit
    // event in the client-side integration. Flow handles any additional required actions."
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Network error:', err);
    res.status(500).json({ error: 'Unable to reach Checkout.com API.' });
  }
});

// ---- Status lookup ----------------------------------------------------------

app.get('/api/payments/:id', async (req, res) => {
  try {
    const response = await fetch(`${CHECKOUT_API_BASE}/payments/${req.params.id}`, {
      headers: { Authorization: `Bearer ${CHECKOUT_SECRET_KEY}` },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Network error:', err);
    res.status(500).json({ error: 'Unable to reach Checkout.com API.' });
  }
});

app.listen(PORT, () => {
  console.log(`\nCheckout.com Flow sample running at http://localhost:${PORT}`);
  console.log(`Environment: ${CHECKOUT_ENV}\n`);
});
