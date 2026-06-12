# Checkout.com Flow — Custom Button + BIN Discounts

A minimal end-to-end integration of **Checkout.com Flow** (the Web Components SDK) with:

- a **custom Pay button** (Flow's built-in button is hidden with `showPayButton: false`),
- a live **BIN-based discount** engine (when the card BIN matches a promotion, the order summary, total, and Pay button update in real time),
- a **promotions database** (JSON-file backed; CRUD via REST),
- **3D Secure** enabled on every card payment.

Frontend is plain HTML / CSS / vanilla JS. Backend is a small Node.js (Express) server.

## Flow at runtime

This integration follows the [Dynamically adjust the payment amount](https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-your-website/extend-your-flow-integration/dynamically-adjust-the-payment-amount) pattern: the session is created **once** at the full amount, and the actual charged amount is overridden at submission time via `POST /payment-sessions/{id}/submit` — no re-mounting, no card re-entry.

1. **Login** (`/`) — user enters name + email; saved to `sessionStorage`.
2. **Checkout** (`/checkout.html`)
   - On load, the browser calls `POST /api/payment-sessions` (full amount) and mounts Flow with `showPayButton: false` and a `handleSubmit` callback.
   - As the user types their card, Flow's `onCardBinChanged` fires. The browser calls `GET /api/promotions/bin/:bin`. If a promotion matches, the discount row, total, banner, and Pay button label update instantly. The Flow session is left untouched.
3. **Pay** — clicking the custom button calls `flow.submit()`. Flow validates + tokenizes the card internally, then invokes the `handleSubmit(self, submitData)` callback we registered.
4. **Submission** — `handleSubmit` POSTs `{ submit_data, promotion_id }` to `POST /api/payment-sessions/:id/submit`. The server re-resolves the promotion, builds the `/submit` payload by merging `submit_data` with an `amount` override + `3ds.enabled: true`, and calls `POST {api}/payment-sessions/{id}/submit`. The Checkout response is returned **untouched** to the browser, which returns it from `handleSubmit`. Flow then handles 3DS itself (inline challenge, redirect, or no-op).
5. **Result** — `onPaymentCompleted` redirects to `/success.html`; redirect-based 3DS / APMs land on `success_url` / `failure_url`. Both pages confirm the final status via `GET /api/payments/:id`.

## Project layout

```
.
├── server.js                          # Express backend
├── promotions.json                    # Promotions "database"
├── package.json
├── .env.example
└── public/
    ├── index.html / login.js          # Login (name + email)
    ├── checkout.html / checkout.js    # Flow + custom Pay button + BIN discount
    ├── success.html
    ├── failure.html
    └── styles.css
```

## Setup

```bash
npm install
cp .env.example .env        # then fill in your sandbox keys
npm start                   # http://localhost:3000
```

`.env`:

```
CHECKOUT_SECRET_KEY=sk_sbox_...
CHECKOUT_PUBLIC_KEY=pk_sbox_...
CHECKOUT_ENV=sandbox
# Optional — needed if your account has multiple processing channels:
# CHECKOUT_PROCESSING_CHANNEL_ID=pc_...
```

## Key integration points

### 1. Custom Pay button + handleSubmit

`public/checkout.js`:

```js
flow = checkout.create('flow', {
  showPayButton: false,
  onCardBinChanged: (_self, payload) => lookupPromotionForBin(payload.bin),
  handleSubmit: async (_self, submitData) => {
    // Flow has already tokenized the card. Hand the data to the server,
    // which calls /payment-sessions/{id}/submit with the discounted amount,
    // then return the unmodified response so Flow can drive 3DS.
    const res = await fetch('/api/payment-sessions/' + sessionId + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submit_data: submitData, promotion_id }),
    });
    return res.json();
  },
});

flow.mount(flowContainer);

// On the merchant's own button click:
await flow.submit();   // Triggers tokenization → handleSubmit → 3DS handling
```

`showPayButton: false` removes Flow's built-in CTA so the merchant's button drives submission. `handleSubmit` is what unlocks the "dynamically adjust the amount" pattern — without it, Flow would charge the original session amount.

### 2. BIN-based discount

```js
window.CheckoutWebComponents({
  publicKey, environment, paymentSession,
  onCardBinChanged: (_component, payload) => {
    const bin = payload?.bin;
    fetch('/api/promotions/bin/' + bin)
      .then(r => r.json())
      .then(({ promotion }) => updateUiWith(promotion));
  },
  ...
});
```

The UI updates immediately. The discount is **never** baked into the session — it's applied when the server calls `/payment-sessions/{id}/submit` with the overridden `amount`. The server is the only authority on the discount: the client just sends `promotion_id`, and the server re-resolves it before forwarding to Checkout.

### 3. 3D Secure

Every payment session is created with:

```js
"3ds": { "enabled": true, "attempt_n3d": false }
```

`attempt_n3d: false` blocks the silent fallback to non-3DS if the issuer doesn't support it.

## Promotions

The database is `promotions.json`. Seed entry:

```json
{
  "id": "promo_visa_demo_42424242",
  "bin_prefix": "42424242",
  "discount_percent": 20,
  "label": "Visa demo card",
  "description": "20% off the whole cart when paying with cards starting 42424242.",
  "active": true
}
```

### Schema

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Server uses this to re-apply the discount when minting the discounted session. |
| `bin_prefix` | string (4–16 digits) | Matched against the card BIN; longest prefix wins. |
| `discount_percent` | number (0–100) | Percent off the subtotal. |
| `label` | string | Shown on the cart line. |
| `description` | string | Sub-text in the green banner. |
| `active` | boolean | Disable without deleting. |

### Add a new promotion

Either edit `promotions.json` and refresh, or:

```bash
curl -X POST http://localhost:3000/api/promotions \
  -H 'Content-Type: application/json' \
  -d '{"bin_prefix":"555555","discount_percent":10,"label":"Mastercard test"}'
```

### List / look up

```bash
curl http://localhost:3000/api/promotions
curl http://localhost:3000/api/promotions/bin/42424242
```

## Test cards (sandbox)

| Card | Behaviour |
| --- | --- |
| `4242 4242 4242 4242` | Succeeds + **triggers the 20% promo** |
| `4543 4740 0224 9996` | 3DS frictionless — approved |
| `4012 0010 3714 1112` | 3DS challenge → OTP `1234` |
| `4000 0000 0000 0119` | Declined |

Any future expiry, any CVV. Full list: <https://www.checkout.com/docs/developer-resources/testing/test-cards>.

## Production checklist

1. Live keys, `CHECKOUT_ENV=production`.
2. Serve over HTTPS — required by Flow and 3DS redirects.
3. Replace the JSON file with a real DB (Postgres, etc.) — fine for a demo, not for concurrent writes.
4. Authenticate `POST /api/promotions` (currently open for demo simplicity).
5. Replace `sessionStorage` for the logged-in user with a real session.
6. Verify final payment status server-side (`GET /payments/:id` or webhooks) before fulfilling.

## References

- Flow & Web Components: <https://www.checkout.com/docs/payments/accept-payments/use-flow-to-accept-payments>
- Payment Sessions API: <https://api-reference.checkout.com/#tag/Payment-Sessions>
- 3D Secure: <https://www.checkout.com/docs/payments/add-features/authenticate-payments-with-3d-secure>
# Flow-RM-Demo
