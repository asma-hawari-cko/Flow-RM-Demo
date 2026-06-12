(function () {
  'use strict';

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('error');
  const nameInput = document.getElementById('name');
  const emailInput = document.getElementById('email');

  // If the user is already signed in, skip straight to checkout.
  try {
    const existing = JSON.parse(sessionStorage.getItem('cko_user') || 'null');
    if (existing && existing.name && existing.email) {
      window.location.replace('/checkout.html');
      return;
    }
  } catch (_) { /* ignore parse errors */ }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add('is-visible');
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.remove('is-visible');
  }

  function isValidEmail(value) {
    // Pragmatic email check — the API will do the authoritative validation.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearError();

    const name = nameInput.value.trim();
    const email = emailInput.value.trim();

    if (name.length < 2) {
      showError('Please enter your full name.');
      nameInput.focus();
      return;
    }
    if (!isValidEmail(email)) {
      showError('Please enter a valid email address.');
      emailInput.focus();
      return;
    }

    sessionStorage.setItem('cko_user', JSON.stringify({ name, email }));
    window.location.assign('/checkout.html');
  });
})();
