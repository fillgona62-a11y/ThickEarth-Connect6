/**
 * Settings and about: language, motion, data location, AI agent provider,
 * account and versions.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t, getLang, setLang } from '../core/i18n.js';
import { getSession, requiresAuth, isSignedIn, UNKNOWN_VERSION } from '../core/store.js';
import { api } from '../core/api.js';
import {
  pageHeader,
  sectionCard,
  segmented,
  toggle,
  field,
  loadingBlock,
  confirmDialog,
  toast,
  describeError
} from '../core/ui.js';
import { copyText } from '../core/format.js';
import { navigate } from '../core/router.js';
import { humanKey } from './common.js';

const MOTION_KEY = 'thickearth.motion';
const SETUP_KEY = 'thickearth.setup.v1';
const LANG_KEY = 'thickearth.lang';

const AI_DEFAULTS = {
  enabled: false,
  provider: 'custom',
  baseUrl: '',
  model: '',
  temperature: '0.2',
  maxOutputTokens: '1200',
  maxMovesPerGame: '40',
  monthlyCallLimit: '500'
};

/**
 * Bounds for the numeric AI fields, shared by the inputs and by save-time
 * validation. They are intentionally tighter than the server's own limits: the
 * server is a backstop, the form is what people actually look at.
 */
const NUMBER_FIELDS = [
  { key: 'temperature', label: 'settingsAi.temperature', min: 0, max: 2, step: 0.05, integer: false, hintKey: 'settingsAi.temperatureHint' },
  { key: 'maxOutputTokens', label: 'settingsAi.maxOutputTokens', min: 64, max: 16384, step: 64, integer: true },
  { key: 'maxMovesPerGame', label: 'settingsAi.maxMovesPerGame', min: 0, max: 200, step: 1, integer: true },
  { key: 'monthlyCallLimit', label: 'settingsAi.monthlyCallLimit', min: 0, max: 1000000, step: 1, integer: true }
];

function readMotion() {
  try {
    return window.localStorage.getItem(MOTION_KEY) === 'reduced';
  } catch (error) {
    return false;
  }
}

function applyMotion(reduced) {
  if (reduced) document.documentElement.setAttribute('data-motion', 'reduced');
  else document.documentElement.removeAttribute('data-motion');
  try {
    if (reduced) window.localStorage.setItem(MOTION_KEY, 'reduced');
    else window.localStorage.removeItem(MOTION_KEY);
  } catch (error) {
    // ignore storage failures
  }
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function mount(container, route) {
  const session = getSession();
  const features = session.features || {};
  const config = session.config || {};
  const rules = config.rules || {};
  const version = config.version || UNKNOWN_VERSION;
  const rulesVersion = rules.version || rules.ruleSetVersion || 'connect6/v1';
  const reducedMotion = readMotion();
  const aiFeatureEnabled = Boolean(features.llm);
  const aiAuthBlocked = requiresAuth() && !isSignedIn();
  let disposed = false;

  const aiState = {
    loading: aiFeatureEnabled && !aiAuthBlocked,
    error: '',
    settings: null,
    saving: false,
    testing: false,
    clearing: false,
    saveMessage: '',
    testResult: null
  };

  // The API key is only ever held in memory while being typed. It is cleared
  // after a successful save or clear and is never written to storage.
  const aiForm = Object.assign({}, AI_DEFAULTS);
  let aiRenderQueued = false;

  function scheduleAiRender() {
    if (aiRenderQueued || disposed) return;
    aiRenderQueued = true;
    Promise.resolve().then(() => {
      aiRenderQueued = false;
      if (!disposed) render();
    });
  }

  function applyAiSettings(data) {
    const source = data || {};
    aiState.settings = source;
    aiState.loading = false;
    aiState.error = '';
    aiForm.enabled = Boolean(source.enabled);
    aiForm.provider = source.provider || 'custom';
    aiForm.baseUrl = source.baseUrl || '';
    aiForm.model = source.model || '';
    aiForm.apiKey = '';
    aiForm.temperature = String(source.temperature !== undefined ? source.temperature : AI_DEFAULTS.temperature);
    aiForm.maxOutputTokens = String(source.maxOutputTokens !== undefined ? source.maxOutputTokens : AI_DEFAULTS.maxOutputTokens);
    aiForm.maxMovesPerGame = String(source.maxMovesPerGame !== undefined ? source.maxMovesPerGame : AI_DEFAULTS.maxMovesPerGame);
    aiForm.monthlyCallLimit = String(source.monthlyCallLimit !== undefined ? source.monthlyCallLimit : AI_DEFAULTS.monthlyCallLimit);
  }

  async function loadAiSettings() {
    if (!aiFeatureEnabled || aiAuthBlocked || disposed) return;
    aiState.loading = true;
    aiState.error = '';
    render();
    try {
      const data = await api.aiSettings();
      if (disposed) return;
      applyAiSettings(data);
    } catch (error) {
      if (disposed) return;
      aiState.loading = false;
      aiState.error = error && error.status === 401
        ? t('settingsAi.loginRequired')
        : t('settingsAi.unavailable', { message: describeError(error) });
    }
    render();
  }

  async function saveAiSettings() {
    if (aiState.saving) return;
    // Validate here so a typo comes back as "Max output tokens: 64–16384" in the
    // reader's language instead of a raw English 400 from the server.
    for (const spec of NUMBER_FIELDS) {
      const raw = String(aiForm[spec.key] ?? '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      const valid = Number.isFinite(value) && value >= spec.min && value <= spec.max
        && (!spec.integer || Number.isInteger(value));
      if (!valid) {
        aiState.error = t('settingsAi.saveError') + ' · '
          + t('settingsAi.fieldRange', { field: t(spec.label), min: spec.min, max: spec.max });
        render();
        return;
      }
    }
    aiState.saving = true;
    aiState.error = '';
    aiState.saveMessage = '';
    aiState.testResult = null;
    render();
    const payload = {
      enabled: aiForm.enabled,
      provider: aiForm.provider || 'custom',
      baseUrl: aiForm.baseUrl.trim(),
      model: aiForm.model.trim(),
      temperature: numberValue(aiForm.temperature, 0.2),
      maxOutputTokens: Math.round(numberValue(aiForm.maxOutputTokens, 1200)),
      maxMovesPerGame: Math.round(numberValue(aiForm.maxMovesPerGame, 40)),
      monthlyCallLimit: Math.round(numberValue(aiForm.monthlyCallLimit, 500))
    };
    const typedKey = aiForm.apiKey.trim();
    if (typedKey) payload.apiKey = typedKey;
    try {
      const data = await api.updateAiSettings(payload);
      if (disposed) return;
      applyAiSettings(data);
      aiState.saving = false;
      aiState.saveMessage = t('settingsAi.saved');
      toast(t('settingsAi.saved'), { type: 'success' });
    } catch (error) {
      if (disposed) return;
      aiState.saving = false;
      aiState.error = t('settingsAi.saveError') + ' · ' + describeError(error);
    }
    render();
  }

  async function testAiConnection() {
    if (aiState.testing) return;
    // Name the empty fields up front. The server can only say "not configured",
    // which reads as "I already typed the key" when the model or URL is the gap.
    const missing = [];
    if (!aiForm.baseUrl.trim()) missing.push(t('settingsAi.baseUrl'));
    if (!aiForm.model.trim()) missing.push(t('settingsAi.model'));
    const storedKeyMatches = aiState.settings && aiState.settings.hasKey
      && aiForm.baseUrl.trim().replace(/\/+$/, '') === aiState.settings.baseUrl;
    if (!aiForm.apiKey.trim() && !storedKeyMatches) {
      missing.push(t('settingsAi.apiKey'));
    }
    if (missing.length > 0) {
      aiState.testResult = {
        ok: false,
        text: t('settingsAi.testMissing', { fields: missing.join(t('common.listSeparator')) })
      };
      render();
      return;
    }
    aiState.testing = true;
    aiState.testResult = null;
    render();
    const payload = {
      baseUrl: aiForm.baseUrl.trim(),
      model: aiForm.model.trim()
    };
    const typedKey = aiForm.apiKey.trim();
    if (typedKey) payload.apiKey = typedKey;
    try {
      const data = await api.testAiConnection(payload);
      if (disposed) return;
      aiState.testing = false;
      aiState.testResult = {
        ok: true,
        text: t('settingsAi.testOk', {
          latency: data && data.latencyMs !== undefined ? data.latencyMs : '-',
          model: (data && data.model) || aiForm.model || '-'
        })
      };
      if (data && data.ok === false) {
        aiState.testResult = { ok: false, text: t('settingsAi.testFailed') };
      }
    } catch (error) {
      if (disposed) return;
      aiState.testing = false;
      aiState.testResult = {
        ok: false,
        text: t('settingsAi.testFailed') + ' · ' + describeError(error)
      };
    }
    aiForm.apiKey = '';
    render();
  }

  async function clearAiKey() {
    if (aiState.clearing) return;
    const confirmed = await confirmDialog({
      title: t('settingsAi.clearKeyTitle'),
      description: t('settingsAi.clearKeyBody'),
      confirmLabel: t('settingsAi.clearKey'),
      danger: true
    });
    if (!confirmed) return;
    aiState.clearing = true;
    render();
    try {
      await api.clearAiKey();
      if (disposed) return;
      aiForm.apiKey = '';
      aiState.clearing = false;
      aiState.testResult = null;
      toast(t('settingsAi.clearKeyDone'), { type: 'success' });
      await loadAiSettings();
    } catch (error) {
      if (disposed) return;
      aiState.clearing = false;
      aiState.error = t('settingsAi.clearKeyError') + ' · ' + describeError(error);
      render();
    }
  }

  function copyPath(value) {
    copyText(value).then((ok) => {
      toast(ok ? t('settings.copied') : t('common.copyFailed'), { type: ok ? 'success' : 'error' });
    });
  }

  function featureTag(enabled) {
    return h('span', { class: 'badge ' + (enabled ? 'badge--ok' : 'badge--muted') },
      enabled ? icon('check', 12) : icon('x', 12),
      enabled ? t('settings.featureOn') : t('settings.featureOff')
    );
  }

  async function handleLogout() {
    try {
      const store = await import('../core/store.js');
      await store.signOut();
      toast(t('auth.logoutDone'), { type: 'success' });
      navigate('/');
    } catch (error) {
      toast(t('settings.logoutError') + ' · ' + describeError(error), { type: 'error' });
    }
  }

  async function resetPreferences() {
    const confirmed = await confirmDialog({
      title: t('settings.confirmReset'),
      description: t('settings.resetDesc'),
      confirmLabel: t('settings.reset'),
      danger: true
    });
    if (!confirmed) return;
    try {
      window.localStorage.removeItem(MOTION_KEY);
      window.localStorage.removeItem(SETUP_KEY);
      window.localStorage.removeItem(LANG_KEY);
    } catch (error) {
      // ignore
    }
    document.documentElement.removeAttribute('data-motion');
    if (getLang() !== 'zh') {
      setLang('zh');
    } else {
      navigate('/settings', { replace: true, force: true });
    }
    toast(t('settings.resetDone'), { type: 'success' });
  }

  /* AI agent settings ------------------------------------------------------ */

  function aiPresetOptions() {
    const settings = aiState.settings || {};
    const presets = Array.isArray(settings.presets) ? settings.presets : [];
    const isZh = getLang() === 'zh';
    const hasCustomPreset = presets.some((preset) => preset && preset.id === 'custom');
    const options = presets.filter((preset) => preset && preset.id).map((preset) => {
      const label = isZh && preset.labelZh ? preset.labelZh : (preset.label || humanKey(preset.id));
      return { id: preset.id, label: label };
    });
    const matchesKnown = options.some((option) => option.id === aiForm.provider);
    const customSelected = aiForm.provider === 'custom' || (!matchesKnown && !hasCustomPreset && Boolean(aiForm.provider));
    const selectOptions = options.map((option) => h('option', {
      value: option.id,
      selected: aiForm.provider === option.id ? '' : null
    }, option.label));
    if (!hasCustomPreset) {
      selectOptions.push(h('option', {
        value: 'custom',
        selected: customSelected ? '' : null
      }, t('settingsAi.providerCustom')));
    }
    return selectOptions;
  }

  function applyPreset(presetId) {
    const settings = aiState.settings || {};
    const presets = Array.isArray(settings.presets) ? settings.presets : [];
    aiForm.provider = presetId;
    const preset = presets.find((item) => item && item.id === presetId);
    if (preset) {
      aiForm.baseUrl = preset.baseUrl || aiForm.baseUrl;
      aiForm.model = preset.model || aiForm.model;
    }
    render();
  }

  function aiStatusRow() {
    const settings = aiState.settings || {};
    const configured = Boolean(settings.configured);
    // "Not configured" covers two very different situations, and telling them
    // apart is the difference between "go flip the switch" and "go fill a field".
    const ready = Boolean(aiForm.baseUrl.trim() && aiForm.model.trim()
      && (aiForm.apiKey.trim() || settings.hasKey));
    const statusKey = configured ? 'settingsAi.configured'
      : !aiForm.enabled && ready ? 'settingsAi.notEnabled'
        : 'settingsAi.notConfigured';
    const usage = settings.usage || {};
    return h('div', { class: 'ai-status-row' },
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        h('span', { class: 'badge ' + (configured ? 'badge--ok' : 'badge--warn') },
          configured ? icon('check', 12) : icon('alert', 12),
          t(statusKey)
        ),
        settings.hasKey
          ? h('span', { class: 'badge badge--muted mono' }, t('settingsAi.keyChip', { hint: settings.keyHint || '----' }))
          : h('span', { class: 'badge badge--muted' }, icon('key', 12), t('settingsAi.apiKey'))
      ),
      h('div', { class: 'ai-usage' },
        h('span', { class: 'ai-usage-label' }, t('settingsAi.usage')),
        h('span', { class: 'ai-usage-value' }, t('settingsAi.calls', { n: usage.monthCalls || 0 })),
        h('span', { class: 'ai-usage-value' }, t('settingsAi.tokens', {
          input: usage.monthInputTokens || 0,
          output: usage.monthOutputTokens || 0
        }))
      )
    );
  }

  function aiFields() {
    const settings = aiState.settings || {};
    const disabled = aiState.saving || aiState.testing;
    const providerSelect = h('select', {
      class: 'select',
      id: 'ai-provider',
      'aria-label': t('settingsAi.provider'),
      disabled: disabled ? '' : null,
      onchange: (event) => applyPreset(event.target.value)
    }, aiPresetOptions());

    const baseUrlInput = h('input', {
      class: 'input',
      type: 'url',
      inputmode: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'https://api.deepseek.com/v1',
      value: aiForm.baseUrl,
      id: 'ai-base-url',
      disabled: disabled ? '' : null,
      oninput: (event) => { aiForm.baseUrl = event.target.value; }
    });

    const modelInput = h('input', {
      class: 'input',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '120',
      placeholder: t('settingsAi.modelPlaceholder'),
      value: aiForm.model,
      id: 'ai-model',
      disabled: disabled ? '' : null,
      oninput: (event) => { aiForm.model = event.target.value; }
    });

    const keyInput = h('input', {
      class: 'input',
      type: 'password',
      autocomplete: 'new-password',
      spellcheck: 'false',
      maxlength: '512',
      placeholder: settings.hasKey
        ? t('settingsAi.keySaved', { hint: settings.keyHint || '----' })
        : t('settingsAi.apiKeyPlaceholder'),
      value: aiForm.apiKey,
      id: 'ai-api-key',
      disabled: disabled ? '' : null,
      oninput: (event) => { aiForm.apiKey = event.target.value; }
    });

    const numberField = (spec) => field({
      label: t(spec.label),
      control: h('input', {
        class: 'input',
        type: 'number',
        min: String(spec.min),
        max: String(spec.max),
        step: String(spec.step),
        value: aiForm[spec.key],
        id: 'ai-' + spec.key,
        disabled: disabled ? '' : null,
        oninput: (event) => { aiForm[spec.key] = event.target.value; }
      }),
      hint: [spec.hintKey ? t(spec.hintKey) : '', t('settingsAi.rangeHint', { min: spec.min, max: spec.max })]
        .filter(Boolean)
        .join(' · ')
    });

    return h('div', { class: 'ai-form-grid' },
      field({ label: t('settingsAi.provider'), control: providerSelect, hint: t('settingsAi.presetsHint') }),
      field({ label: t('settingsAi.model'), control: modelInput }),
      h('div', { style: { gridColumn: '1 / -1' } },
        field({ label: t('settingsAi.baseUrl'), control: baseUrlInput, hint: t('settingsAi.baseUrlHint') })
      ),
      h('div', { style: { gridColumn: '1 / -1' } },
        field({ label: t('settingsAi.apiKey'), control: keyInput, hint: t('settingsAi.keyWriteOnly') })
      ),
      ...NUMBER_FIELDS.map(numberField)
    );
  }

  function aiActions() {
    const settings = aiState.settings || {};
    const busy = aiState.saving || aiState.testing || aiState.clearing;
    const actions = [
      h('button', {
        type: 'button',
        class: 'btn btn--primary',
        disabled: busy ? '' : null,
        onclick: saveAiSettings
      },
        aiState.saving ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('check', 15),
        aiState.saving ? t('settingsAi.saving') : t('settingsAi.save')
      ),
      h('button', {
        type: 'button',
        class: 'btn btn--secondary',
        disabled: busy ? '' : null,
        onclick: testAiConnection
      },
        aiState.testing ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('plug', 15),
        aiState.testing ? t('settingsAi.testing') : t('settingsAi.test')
      )
    ];
    if (settings.hasKey) {
      actions.push(h('button', {
        type: 'button',
        class: 'btn btn--danger btn--ghost',
        disabled: busy ? '' : null,
        onclick: clearAiKey
      },
        aiState.clearing ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('key', 15),
        t('settingsAi.clearKey')
      ));
    }
    return h('div', { class: 'ai-actions form-actions' }, actions);
  }

  function aiCardBody() {
    if (!aiFeatureEnabled) {
      return h('div', { class: 'notice' }, icon('info', 15), h('span', null, t('settingsAi.disabled')));
    }
    if (aiAuthBlocked) {
      return h('div', { class: 'stack-12' },
        h('div', { class: 'notice notice--warn' }, icon('lock', 15), h('span', null, t('settingsAi.loginRequired'))),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn--primary btn--sm', href: '#/login?next=' + encodeURIComponent('#/settings') }, t('auth.loginTitle')),
          h('a', { class: 'btn btn--ghost btn--sm', href: '#/register' }, t('auth.registerTitle'))
        )
      );
    }
    if (aiState.loading) {
      return loadingBlock(t('common.loading'));
    }
    if (aiState.error && !aiState.settings) {
      return h('div', { class: 'stack-12' },
        h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, aiState.error)),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: loadAiSettings },
          icon('refresh', 14), t('settingsAi.retry'))
      );
    }
    return h('div', { class: 'ai-settings' },
      aiStatusRow(),
      settings.sharedAvailable
        ? h('p', { class: 'muted', style: { margin: '0 0 12px', fontSize: '12px' } }, t('settingsAi.sharedNote'))
        : null,
      h('div', { class: 'ai-enable-row' },
        toggle({
          label: t('settingsAi.enabled'),
          description: t('settingsAi.enabledDesc'),
          checked: aiForm.enabled,
          onChange: (checked) => {
            aiForm.enabled = checked;
            scheduleAiRender();
          }
        })
      ),
      aiFields(),
      aiState.error ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, aiState.error)) : null,
      aiState.saveMessage ? h('div', { class: 'notice notice--ok' }, icon('check', 15), h('span', null, aiState.saveMessage)) : null,
      aiState.testResult
        ? h('div', { class: 'notice ' + (aiState.testResult.ok ? 'notice--ok' : 'notice--danger'), role: 'status' },
            icon(aiState.testResult.ok ? 'check' : 'alert', 15),
            h('span', null, aiState.testResult.text))
        : null,
      aiActions(),
      h('div', { class: 'ai-security' },
        h('div', { class: 'ai-security-title' }, icon('shield', 14), t('settingsAi.securityTitle')),
        h('p', { class: 'card-desc', style: { marginTop: '0' } }, t('settingsAi.securityBody'))
      )
    );
  }

  function aiCard() {
    return sectionCard({
      title: t('settingsAi.title'),
      description: t('settingsAi.desc'),
      actions: h('span', { class: 'badge ' + (aiFeatureEnabled ? 'badge--violet' : 'badge--muted') },
        aiFeatureEnabled ? t('settings.featureOn') : t('settings.featureOff')),
      content: aiCardBody()
    });
  }

  /* Existing settings sections --------------------------------------------- */

  function languageCard() {
    return sectionCard({
      title: t('settings.languageTitle'),
      description: t('settings.languageDesc'),
      content: h('div', { class: 'settings-row', style: { borderTop: 'none', paddingTop: '0' } },
        h('div', { class: 'settings-row-text' },
          h('div', { class: 'settings-row-title' }, t('common.language')),
          h('div', { class: 'settings-row-desc' }, getLang() === 'zh' ? t('settings.languageZh') : t('settings.languageEn'))
        ),
        h('div', { class: 'settings-row-control' },
          segmented({
            ariaLabel: t('settings.languageTitle'),
            value: getLang(),
            options: [
              { value: 'zh', label: t('settings.languageZh') },
              { value: 'en', label: t('settings.languageEn') }
            ],
            onChange: (value) => {
              if (value !== getLang()) setLang(value);
            }
          })
        )
      )
    });
  }

  function displayCard() {
    return sectionCard({
      title: t('settings.displayTitle'),
      content: toggle({
        label: t('settings.reducedMotion'),
        description: t('settings.reducedMotionDesc'),
        checked: reducedMotion,
        onChange: (checked) => {
          applyMotion(checked);
          toast(checked ? t('common.on') : t('common.off'), { type: 'info', timeout: 1400 });
        }
      })
    });
  }

  function dataCard() {
    const isDesktop = session.mode !== 'web';
    const path = isDesktop ? t('settings.dataDesktopPath') : t('settings.dataWebPath');
    return sectionCard({
      title: t('settings.dataTitle'),
      content: h('div', null,
        h('p', { class: 'card-desc', style: { marginTop: 0 } }, isDesktop ? t('settings.dataDesktopDesc') : t('settings.dataWebDesc')),
        h('div', { class: 'data-path' },
          h('span', { class: 'data-path-value' }, path),
          h('button', {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('settings.copyPath'),
            title: t('settings.copyPath'),
            onclick: () => copyPath(path)
          }, icon('copy', 15))
        )
      )
    });
  }

  function accountCard() {
    const children = [];
    if (requiresAuth()) {
      if (isSignedIn()) {
        const user = session.user || {};
        children.push(h('div', { class: 'kv-list' },
          h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('auth.displayName')), h('span', { class: 'kv-value' }, user.displayName || '-')),
          h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('auth.email')), h('span', { class: 'kv-value' }, user.email || '-'))
        ));
        children.push(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: handleLogout },
          icon('logout', 14), t('settings.logout')));
      } else {
        children.push(h('p', { class: 'card-desc', style: { marginTop: 0 } }, t('auth.loginSubtitle')));
        children.push(h('div', { class: 'row' },
          h('a', { class: 'btn btn--primary btn--sm', href: '#/login' }, t('auth.loginTitle')),
          h('a', { class: 'btn btn--ghost btn--sm', href: '#/register' }, t('auth.registerTitle'))
        ));
      }
    } else {
      children.push(h('div', { class: 'notice' }, icon('lock', 15), h('span', null, t('settings.desktopViewer'))));
    }
    return sectionCard({ title: t('settings.accountTitle'), content: h('div', { class: 'stack-12' }, children) });
  }

  function versionCard() {
    return sectionCard({
      title: t('settings.versionTitle'),
      content: h('div', { class: 'kv-list' },
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('settings.appVersion')), h('span', { class: 'kv-value' }, version)),
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('settings.rulesetVersion')), h('span', { class: 'kv-value' }, rulesVersion)),
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('settings.serverMode')), h('span', { class: 'kv-value' }, session.mode === 'web' ? t('app.mode.web') : t('app.mode.desktop'))),
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.board')), h('span', { class: 'kv-value' }, (rules.boardSize || 19) + ' × ' + (rules.boardSize || 19))),
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('setup.ruleWin')), h('span', { class: 'kv-value' }, t('setup.ruleWinValue', { n: rules.winLength || 6 }))),
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('setup.ruleTurn')), h('span', { class: 'kv-value' }, t('setup.ruleTurnValue', { n: rules.stonesPerTurn || 2 })))
      )
    });
  }

  function featureRow(label, enabled) {
    return h('div', { class: 'feature-row' },
      h('span', { class: 'feature-row-label' }, label),
      featureTag(enabled)
    );
  }

  function featuresCard() {
    return sectionCard({
      title: t('settings.features'),
      content: h('div', null,
        featureRow(t('settings.featureAuth'), features.auth),
        featureRow(t('settings.featureOnline'), features.online),
        featureRow(t('settings.featureLlm'), features.llm)
      )
    });
  }

  function aboutCard() {
    return sectionCard({
      title: t('settings.aboutTitle'),
      content: h('div', { class: 'about-body' },
        h('p', null, t('settings.aboutBody')),
        h('p', { class: 'mono' }, t('settings.aboutTech')),
        h('p', null, t('settings.privacyNote')),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn--ghost btn--sm', href: '#/rules' }, icon('book', 14), t('settings.openRules')),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: resetPreferences }, icon('refresh', 14), t('settings.reset'))
        )
      )
    });
  }

  function render() {
    clear(container);
    container.appendChild(pageHeader({
      eyebrow: t('nav.settings'),
      title: t('settings.title'),
      subtitle: t('settings.subtitle')
    }));
    const main = h('div', { class: 'settings-main' },
      languageCard(),
      displayCard(),
      dataCard(),
      aiCard(),
      aboutCard()
    );
    const aside = h('aside', { class: 'settings-aside' },
      accountCard(),
      versionCard(),
      featuresCard()
    );
    container.appendChild(h('div', { class: 'settings-layout' }, main, aside));
  }

  render();
  if (aiFeatureEnabled && !aiAuthBlocked) loadAiSettings();

  return function cleanup() {
    disposed = true;
  };
}
