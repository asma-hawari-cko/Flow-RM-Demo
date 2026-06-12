(function () {
  'use strict';

  // Hard-coded demo order. In a real shop these would come from your cart.
  const ORDER = {
    amount: 2500,        // 25.00 AED in minor units (fils).
    currency: 'AED',
    reference: 'ORD-' + Date.now(),
  };

  // Dummy "saved cards". In a real integration these would come from
  // /sources or /instruments on the Checkout.com API, keyed by the logged-in user.
  const SAVED_CARDS = [
    {
      id: 'src_demo_visa_4242',
      brand: 'visa',
      last4: '4242',
      bin: '42424242',           // 8-digit BIN — matches the 20% promo.
      exp_month: 12,
      exp_year: 27,
      holder: 'A. Lovelace',
    },
    {
      id: 'src_demo_mc_4444',
      brand: 'mastercard',
      last4: '4444',
      bin: '55555555',
      exp_month: 6,
      exp_year: 28,
      holder: 'A. Lovelace',
    },
  ];

  // ---- DOM refs -----------------------------------------------------------

  const errorEl = document.getElementById('error');
  const noticeEl = document.getElementById('notice');
  const userLabel = document.getElementById('user-label');
  const summaryRef = document.getElementById('summary-ref');
  const summarySubtotal = document.getElementById('summary-subtotal');
  const summaryDiscountRow = document.getElementById('summary-discount-row');
  const summaryDiscountLabel = document.getElementById('summary-discount-label');
  const summaryDiscount = document.getElementById('summary-discount');
  const summaryTotal = document.getElementById('summary-total');
  const promoBanner = document.getElementById('promo-banner');
  const promoBannerLabel = document.getElementById('promo-banner-label');
  const promoBannerDesc = document.getElementById('promo-banner-desc');
  const payButton = document.getElementById('pay-button');
  const payButtonLabel = document.getElementById('pay-button-label');
  const paymentForm = document.getElementById('payment-form');
  const flowSection = document.getElementById('flow-section');
  const flowContainer = document.getElementById('flow-container');
  const savedCardsEl = document.getElementById('saved-cards');

  // ---- Live state ---------------------------------------------------------

  let config = null;
  let user = null;
  let checkoutInstance = null;
  let flow = null;
  let paymentSessionId = null;        // ID of the active Flow session
  let appliedPromotion = null;
  let lastLookedUpBin = null;
  let isSubmitting = false;
  let selectedMethod = 'new';

  // ---- Helpers ------------------------------------------------------------

  function formatAmount(minor, currency) {
    return (minor / 100).toFixed(2) + ' ' + currency;
  }
  function computeDisplayedTotal() {
    if (!appliedPromotion) return ORDER.amount;
    const discount = Math.round((ORDER.amount * appliedPromotion.discount_percent) / 100);
    return ORDER.amount - discount;
  }
  function findSavedCard(id) {
    return SAVED_CARDS.find((c) => c.id === id) || null;
  }

  function showError(msg)  { errorEl.textContent = msg; errorEl.classList.add('is-visible'); }
  function clearError()    { errorEl.textContent = ''; errorEl.classList.remove('is-visible'); }
  function showNotice(msg) { noticeEl.textContent = msg; noticeEl.classList.add('is-visible'); }
  function clearNotice()   { noticeEl.textContent = ''; noticeEl.classList.remove('is-visible'); }

  function renderSummary() {
    const card = selectedMethod === 'new' ? null : findSavedCard(selectedMethod);
    const total = computeDisplayedTotal();

    summaryRef.textContent = ORDER.reference;
    summarySubtotal.textContent = formatAmount(ORDER.amount, ORDER.currency);

    if (appliedPromotion) {
      const discount = Math.round((ORDER.amount * appliedPromotion.discount_percent) / 100);
      summaryDiscountRow.hidden = false;
      summaryDiscountLabel.textContent = `Discount (${appliedPromotion.discount_percent}% — ${appliedPromotion.label})`;
      summaryDiscount.textContent = '−' + formatAmount(discount, ORDER.currency);
    } else {
      summaryDiscountRow.hidden = true;
    }
    summaryTotal.textContent = formatAmount(total, ORDER.currency);

    if (card) {
      payButtonLabel.textContent = `Pay ${formatAmount(total, ORDER.currency)} with •••• ${card.last4}`;
    } else {
      payButtonLabel.textContent = 'Pay ' + formatAmount(total, ORDER.currency);
    }
  }

  function showPromoBanner(p) {
    promoBanner.hidden = false;
    promoBannerLabel.textContent = `${p.discount_percent}% off — ${p.label}`;
    promoBannerDesc.textContent = p.description || '';
  }
  function hidePromoBanner() { promoBanner.hidden = true; }

  function requireUser() {
    try {
      const u = JSON.parse(sessionStorage.getItem('cko_user') || 'null');
      if (u && u.name && u.email) return u;
    } catch (_) { /* fall through */ }
    window.location.replace('/');
    return null;
  }

  // ---- Saved cards UI -----------------------------------------------------

  function brandLogoMarkup(brand) {
    if (brand === 'visa') return '<span class="brand-pill brand-pill--visa">VISA</span>';
    if (brand === 'mastercard') {
      return '<span class="brand-pill brand-pill--mc">' +
        '<span class="brand-pill__dot brand-pill__dot--red"></span>' +
        '<span class="brand-pill__dot brand-pill__dot--yellow"></span>' +
        '</span>';
    }
    return '<span class="brand-pill">CARD</span>';
  }

  function renderSavedCards() {
    const rows = SAVED_CARDS.map((c) => {
      const selected = selectedMethod === c.id;
      return `
        <label class="saved-card${selected ? ' is-selected' : ''}">
          <input type="radio" name="payment-method" value="${c.id}" ${selected ? 'checked' : ''} />
          <span class="saved-card__brand">${brandLogoMarkup(c.brand)}</span>
          <span class="saved-card__details">
            <span class="saved-card__number">•••• •••• •••• ${c.last4}</span>
            <span class="saved-card__meta">Expires ${String(c.exp_month).padStart(2,'0')}/${c.exp_year} · ${c.holder}</span>
          </span>
          <span class="saved-card__radio" aria-hidden="true"></span>
        </label>`;
    }).join('');

    const newRow = `
      <label class="saved-card saved-card--new${selectedMethod === 'new' ? ' is-selected' : ''}">
        <input type="radio" name="payment-method" value="new" ${selectedMethod === 'new' ? 'checked' : ''} />
        <span class="saved-card__brand"><span class="brand-pill brand-pill--new">+</span></span>
        <span class="saved-card__details">
          <span class="saved-card__number">Use a new card</span>
          <span class="saved-card__meta">Enter card details below</span>
        </span>
        <span class="saved-card__radio" aria-hidden="true"></span>
      </label>`;

    savedCardsEl.innerHTML = rows + newRow;

    savedCardsEl.querySelectorAll('input[name="payment-method"]').forEach((input) => {
      input.addEventListener('change', () => onMethodChange(input.value));
    });
  }

  function onMethodChange(value) {
    if (selectedMethod === value) return;
    selectedMethod = value;
    flowSection.hidden = selectedMethod !== 'new';

    if (selectedMethod === 'new') {
      appliedPromotion = null;
      hidePromoBanner();
      lastLookedUpBin = null;
    } else {
      const card = findSavedCard(selectedMethod);
      if (card && card.bin) lookupPromotionForBin(card.bin);
    }

    savedCardsEl.querySelectorAll('.saved-card').forEach((row) => {
      const input = row.querySelector('input[name="payment-method"]');
      row.classList.toggle('is-selected', input && input.value === selectedMethod);
    });

    clearError();
    clearNotice();
    renderSummary();
  }

  // ---- API calls ----------------------------------------------------------

  async function createPaymentSession() {
    const res = await fetch('/api/payment-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: ORDER.amount,
        currency: ORDER.currency,
        customer: { name: user.name, email: user.email },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || 'Could not create payment session.');
    return data;
  }

  async function lookupPromotionForBin(bin) {
    if (!bin) return;
    const cacheKey = selectedMethod + ':' + bin;
    if (cacheKey === lastLookedUpBin) return;
    lastLookedUpBin = cacheKey;
    try {
      const res = await fetch('/api/promotions/bin/' + encodeURIComponent(bin));
      if (!res.ok) return;
      const data = await res.json();
      const newPromo = data.promotion || null;
      const same = (appliedPromotion && newPromo && appliedPromotion.id === newPromo.id)
                || (!appliedPromotion && !newPromo);
      if (same) return;

      appliedPromotion = newPromo;
      if (newPromo) showPromoBanner(newPromo); else hidePromoBanner();
      renderSummary();
    } catch (err) {
      console.warn('BIN lookup failed:', err);
    }
  }

  // Server proxies Checkout's `/payment-sessions/{id}/submit`. The Checkout
  // response is returned to us unmodified and we hand it straight back to Flow.
  async function performPaymentSubmission(submitData) {
    const res = await fetch('/api/payment-sessions/' + encodeURIComponent(paymentSessionId) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submit_data: submitData,
        promotion_id: appliedPromotion ? appliedPromotion.id : null,
      }),
    });
    return res.json();
  }

  // ---- Flow mount ---------------------------------------------------------

  async function mountFlow(paymentSession) {
    paymentSessionId = paymentSession.id;

    checkoutInstance = await window.CheckoutWebComponents({
      publicKey: config.publicKey,
      environment: config.environment,
      locale: 'en-GB',
      paymentSession,
      onPaymentCompleted: function (_component, response) {
        const id = response && response.id ? response.id : '';
        window.location.assign('/success.html?cko-payment-id=' + encodeURIComponent(id));
      },
      onError: function (_component, error) {
        console.error('Flow error:', error);
        isSubmitting = false;
        payButton.disabled = false;
        renderSummary();
        showError((error && error.message) || 'Payment could not be completed.');
      },
    });

    flow = checkoutInstance.create('flow', {
      // Custom button lives in the page — hide Flow's built-in CTA.
      showPayButton: false,

      // Per Checkout.com docs: `handleSubmit` lets us submit a *modified* session.
      // Flow calls this with the tokenized submission data; we forward it to our
      // server, which calls /payment-sessions/{id}/submit with the discounted amount,
      // and we return the response unchanged so Flow can drive 3DS.
      handleSubmit: async function (_self, submitData) {
        try {
          const submitResponse = await performPaymentSubmission(submitData);
          return submitResponse;
        } catch (err) {
          console.error('handleSubmit error:', err);
          throw err;
        }
      },

      onCardBinChanged: function (_self, payload) {
        if (selectedMethod !== 'new') return;
        let bin = null;
        if (payload && typeof payload === 'object') bin = payload.bin || payload.cardBin || null;
        else if (typeof payload === 'string') bin = payload;
        if (bin) lookupPromotionForBin(String(bin).replace(/\D/g, ''));
      },
    });

    flow.mount(flowContainer);
  }

  // ---- Submit -------------------------------------------------------------

  function paySavedCard() {
    const card = findSavedCard(selectedMethod);
    if (!card) return;
    isSubmitting = true;
    payButton.disabled = true;
    payButtonLabel.textContent = 'Charging •••• ' + card.last4 + '…';
    clearNotice();

    // Dummy saved-card flow. In a real integration this would POST to a server
    // endpoint that calls /payments with { source: { type: 'id', id: 'src_…' } }
    // and handles 3DS.
    setTimeout(() => {
      const fakeId = 'pay_demo_' + Math.random().toString(36).slice(2, 10);
      window.location.assign('/success.html?cko-payment-id=' + encodeURIComponent(fakeId) + '&demo=saved');
    }, 700);
  }

  async function payNewCard() {
    isSubmitting = true;
    payButton.disabled = true;
    payButtonLabel.textContent = 'Processing…';
    clearNotice();
    try {
      // Triggers Flow's internal validation + tokenization, which calls our
      // `handleSubmit` with the tokenized submitData. From there 3DS is handled
      // by Flow based on the response we return from handleSubmit.
      await flow.submit();
    } catch (err) {
      console.error('Flow submit error:', err);
      isSubmitting = false;
      payButton.disabled = false;
      renderSummary();
      showError((err && err.message) || 'Payment could not be completed.');
    }
  }

  function handlePay(event) {
    event.preventDefault();
    if (isSubmitting) return;
    clearError();

    if (selectedMethod === 'new') payNewCard();
    else paySavedCard();
  }

  // ---- Boot ---------------------------------------------------------------

  document.getElementById('sign-out').addEventListener('click', function (event) {
    event.preventDefault();
    sessionStorage.removeItem('cko_user');
    window.location.assign('/');
  });

  user = requireUser();
  if (!user) return;

  userLabel.textContent = `${user.name} (${user.email})`;
  renderSavedCards();
  renderSummary();
  paymentForm.addEventListener('submit', handlePay);

  (async function init() {
    try {
      const configRes = await fetch('/api/config');
      if (!configRes.ok) throw new Error('Could not load configuration.');
      config = await configRes.json();

      const session = await createPaymentSession();
      await mountFlow(session);
    } catch (err) {
      console.error(err);
      flowContainer.innerHTML = '';
      showError(err.message || 'Could not initialize the payment form.');
    }
  })();
})();
