/**
 * Login and registration views (web mode).
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getSession, requiresAuth, isSignedIn, signIn, signUp } from '../core/store.js';
import { field, toast, describeError } from '../core/ui.js';
import { navigate } from '../core/router.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeNext(route) {
  const next = route && route.query ? route.query.next : '';
  if (typeof next === 'string' && next.charAt(0) === '#' && next.length > 1) return next;
  if (typeof next === 'string' && next.charAt(0) === '/' && next.charAt(1) !== '/') return '#' + next;
  return '#/';
}

export async function mount(container, route) {
  const isRegister = route && route.name === 'register';
  const nextPath = safeNext(route);
  const session = getSession();
  let disposed = false;
  let busy = false;
  let errorMessage = '';

  if (!requiresAuth()) {
    clear(container);
    container.appendChild(h('div', { class: 'auth-layout' },
      h('div', { class: 'card auth-card' },
        h('div', { class: 'auth-head' },
          h('p', { class: 'eyebrow' }, t('app.name')),
          h('h2', { class: 'auth-title' }, t('auth.desktopNoAuth')),
          h('p', { class: 'auth-subtitle' }, t('auth.desktopNoAuthDesc'))
        ),
        h('div', { class: 'stack-12' },
          h('a', { class: 'btn btn--primary', href: '#/' }, icon('arrowLeft', 15), t('auth.backHome')),
          h('a', { class: 'btn btn--ghost', href: '#/settings' }, icon('settings', 15), t('nav.settings'))
        )
      )
    ));
    return function cleanup() {};
  }

  if (isSignedIn()) {
    navigate('/', { replace: true });
    return function cleanup() {};
  }

  function validate(values) {
    if (!EMAIL_PATTERN.test(values.email)) return t('auth.invalidEmail');
    if (values.password.length < 8) return t('auth.shortPassword');
    if (isRegister && !values.displayName.trim()) return t('auth.missingName');
    return '';
  }

  function render() {
    clear(container);
    const title = isRegister ? t('auth.registerTitle') : t('auth.loginTitle');
    const subtitle = isRegister ? t('auth.registerSubtitle') : t('auth.loginSubtitle');
    const emailInput = h('input', {
      class: 'input',
      type: 'email',
      name: 'email',
      autocomplete: 'email',
      required: '',
      placeholder: t('auth.emailPlaceholder'),
      'aria-label': t('auth.email')
    });
    const passwordInput = h('input', {
      class: 'input',
      type: 'password',
      name: 'password',
      autocomplete: isRegister ? 'new-password' : 'current-password',
      required: '',
      minlength: '8',
      placeholder: t('auth.passwordPlaceholder'),
      'aria-label': t('auth.password')
    });
    const nameInput = isRegister
      ? h('input', {
          class: 'input',
          type: 'text',
          name: 'displayName',
          autocomplete: 'nickname',
          required: '',
          maxlength: '32',
          placeholder: t('auth.displayNamePlaceholder'),
          'aria-label': t('auth.displayName')
        })
      : null;

    const submitButton = h('button', {
      type: 'submit',
      class: 'btn btn--primary btn--lg btn--block',
      disabled: busy ? '' : null
    },
      busy ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('arrowRight', 16),
      busy ? t('auth.busy') : isRegister ? t('auth.submitRegister') : t('auth.submitLogin')
    );

    const form = h('form', {
      class: 'auth-form',
      novalidate: '',
      onsubmit: async (event) => {
        event.preventDefault();
        if (busy) return;
        const values = {
          email: emailInput.value.trim(),
          password: passwordInput.value,
          displayName: nameInput ? nameInput.value.trim() : ''
        };
        const validation = validate(values);
        if (validation) {
          errorMessage = validation;
          render();
          return;
        }
        busy = true;
        errorMessage = '';
        render();
        try {
          if (isRegister) {
            await signUp({ email: values.email, password: values.password, displayName: values.displayName });
          } else {
            await signIn(values.email, values.password);
          }
          toast(isRegister ? t('auth.registerTitle') : t('auth.loginTitle'), { type: 'success' });
          navigate(nextPath.replace(/^#/, ''), { replace: true });
        } catch (error) {
          busy = false;
          errorMessage = error && error.code === 'INVALID_CREDENTIALS'
            ? t('auth.loginError')
            : error && error.code === 'EMAIL_TAKEN'
              ? t('auth.registerError')
              : describeError(error);
          render();
        }
      }
    },
      h('div', { class: 'auth-head' },
        h('p', { class: 'eyebrow' }, t('app.name')),
        h('h2', { class: 'auth-title' }, title),
        h('p', { class: 'auth-subtitle' }, subtitle)
      ),
      field({ label: t('auth.email'), control: emailInput, required: true }),
      field({ label: t('auth.password'), control: passwordInput, hint: t('auth.passwordPlaceholder'), required: true }),
      nameInput ? field({ label: t('auth.displayName'), control: nameInput, required: true }) : null,
      errorMessage ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, errorMessage)) : null,
      submitButton
    );

    container.appendChild(h('div', { class: 'auth-layout' },
      h('div', { class: 'card auth-card' },
        form,
        h('div', { class: 'auth-alt' },
          isRegister
            ? h('a', { href: '#/login' + (nextPath !== '#/' ? '?next=' + encodeURIComponent(nextPath) : '') }, t('auth.toLogin'))
            : h('a', { href: '#/register' + (nextPath !== '#/' ? '?next=' + encodeURIComponent(nextPath) : '') }, t('auth.toRegister'))
        ),
        h('div', { class: 'auth-alt' }, h('a', { href: '#/' }, t('auth.backHome')))
      )
    ));
  }

  render();
  return function cleanup() {
    disposed = true;
  };
}
