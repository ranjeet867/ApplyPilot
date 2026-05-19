/**
 * ApplyPilot — Job Application Page content script  (v2.4)
 *
 * New in v1.1:
 *  • ATS-specific JD extraction (Greenhouse, Lever, Ashby, Workday, etc.)
 *  • CAPTCHA detection + guidance banner
 *  • Login-wall detection + Google SSO prompt
 *  • Form error scan after fill
 *  • Multi-step form detection + "Next" auto-click
 *  • Re-fill button
 *  • Queue mode UI (position, Done→Next, Skip→Next)
 *  • TRIGGER_PANEL / TOGGLE_PANEL / GET_DETECTED_FIELDS / SHOW_FILL_PANEL message handlers
 *  • Cover letter auto-saved to Job record via SAVE_COVER_LETTER
 *  • Keyboard shortcut: Alt+Shift+A (forwarded from background)
 *
 * v1.6: Auto-submit support in full-auto mode (user opt-in).
 *        Resume upload via chrome.scripting.executeScript({ world: 'MAIN' }).
 */

import type {
  DetectedField,
  FieldType,
  Settings,
  UserProfile,
  TriggerPanelPayload,
} from '../types';

// ── State ─────────────────────────────────────────────────────────────────────

let shadowHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null     = null;
let detected:   DetectedField[]       = [];
let settings:   Settings | null       = null;
let resumeDataUrl = '';
let coverLetterDataUrl = '';
let queueMode: TriggerPanelPayload | null = null;  // set when panel is in queue mode
let panelVisible  = false;

// Iframe ↔ top-frame communication
interface IframeFieldInfo { type: string; label: string; confidence: number; }
let iframeFields: IframeFieldInfo[] = [];
let iframeFrameId: number | null = null;

const PANEL_ID = 'ap-panel-host';

// ── ATS platform detection + smart JD selectors ──────────────────────────────

interface ATSInfo {
  name:       string;
  jdSelectors: string[];
  needsRefill: boolean;  // Workday etc. can reset fields
}

const ATS_MAP: Record<string, ATSInfo> = {
  'greenhouse.io':       { name: 'Greenhouse',      jdSelectors: ['#app_body .job__description', '#content', '.job-post'], needsRefill: false },
  'lever.co':            { name: 'Lever',            jdSelectors: ['.section[data-qa="job-description"]', '.posting-description', '.content-wrapper .section'], needsRefill: false },
  'ashbyhq.com':         { name: 'Ashby',            jdSelectors: ['[class*="JobPosting_description"]', '[data-testid="job-description"]', '.ashby-job-posting-description'], needsRefill: false },
  'workday.com':         { name: 'Workday',          jdSelectors: ['[data-automation-id="jobPostingDescription"]', '[data-automation-id="job-posting-details"]'], needsRefill: true },
  'myworkdayjobs.com':   { name: 'Workday',          jdSelectors: ['[data-automation-id="jobPostingDescription"]'], needsRefill: true },
  'smartrecruiters.com': { name: 'SmartRecruiters',  jdSelectors: ['.job-sections', '.details-section', '[class*="jobDescription"]'], needsRefill: false },
  'jobvite.com':         { name: 'Jobvite',          jdSelectors: ['.jv-job-detail-description', '.description', '.job-description'], needsRefill: false },
  'icims.com':           { name: 'iCIMS',            jdSelectors: ['.iCIMS_JobContent', '[class*="jobDescription"]', '#iCIMS_Content_Candidate_Login_Widget'], needsRefill: false },
  'bamboohr.com':        { name: 'BambooHR',         jdSelectors: ['[class*="BambooHR-ATS"] .description', '.job-description'], needsRefill: false },
  'breezy.hr':           { name: 'Breezy HR',        jdSelectors: ['.description', '.job-description', 'section.primary'], needsRefill: false },
  'recruitee.com':       { name: 'Recruitee',        jdSelectors: ['.content-description', '.offer-description', '[class*="description"]'], needsRefill: false },
  'personio.de':         { name: 'Personio',         jdSelectors: ['[class*="JobDescription"]', '.job-description', '[data-test="job-description"]'], needsRefill: false },
  'join.com':            { name: 'Join',             jdSelectors: ['[class*="jobDescription"]', '.job-description', '[data-cy="job-description"]'], needsRefill: false },
  'stepstone.de':        { name: 'StepStone',        jdSelectors: ['[class*="jobContent"]', '[class*="JobContent"]', '.job-description'], needsRefill: false },
  'xing.com':            { name: 'XING',             jdSelectors: ['.job-description-text', '[class*="jobDescription"]'], needsRefill: false },
  'taleo.net':           { name: 'Taleo',            jdSelectors: ['.requisitionDescriptionInterface', '[class*="description"]'], needsRefill: true },
  'linkedin.com':        { name: 'LinkedIn',         jdSelectors: ['.description__text', '.jobs-description__content', '[class*="description"]'], needsRefill: false },
  'indeed.com':          { name: 'Indeed',           jdSelectors: ['#jobDescriptionText', '.jobsearch-jobDescriptionText', '[data-testid="job-description"]'], needsRefill: false },
  'glassdoor.com':       { name: 'Glassdoor',        jdSelectors: ['[class*="JobDetails_jobDescription"]', '.desc', '[data-test="jobDescriptionText"]', '[class*="jobDescription"]'], needsRefill: false },
  'arbeitsagentur.de':   { name: 'Arbeitsagentur',   jdSelectors: ['.stellenbeschreibung', '.jobDescription', '[class*="description"]'], needsRefill: false },
};

function detectATS(): { info: ATSInfo; key: string } | null {
  const host = location.hostname.replace('www.', '');
  for (const [key, info] of Object.entries(ATS_MAP)) {
    if (host.endsWith(key)) return { info, key };
  }
  return null;
}

/**
 * When we land on a job listing page instead of the apply form,
 * find a link or button that leads to the actual application.
 * Prefers external ATS links over on-site buttons.
 */
function findApplyButtonOnPage(): HTMLElement | null {
  const KNOWN_ATS = [
    'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkdayjobs.com',
    'personio.de', 'personio.com', 'smartrecruiters.com', 'jobvite.com', 'bamboohr.com',
    'recruitee.com', 'join.com', 'taleo.net', 'icims.com', 'breezy.hr', 'workable.com',
  ];

  // 1. Direct ATS anchor links on the page (most reliable)
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const atsLink = links.find((a) => {
    try {
      return KNOWN_ATS.some((d) => a.href.includes(d));
    } catch { return false; }
  });
  if (atsLink) return atsLink;

  // 2. "Apply" anchor that isn't the same domain (opens ATS in same/new tab)
  const externalApply = links.find((a) => {
    try {
      const url = new URL(a.href);
      const isSameDomain = url.hostname === location.hostname;
      const text = (a.textContent ?? '').trim().toLowerCase();
      const label = (a.getAttribute('aria-label') ?? '').toLowerCase();
      const isApplyText = /^apply(\s|$)/i.test(text) || /apply/i.test(label);
      return !isSameDomain && isApplyText;
    } catch { return false; }
  });
  if (externalApply) return externalApply;

  // 3. Button with "Apply" text (not "Easy Apply" — that stays on LinkedIn)
  const btns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
  const applyBtn = btns.find((b) => {
    const text = (b.textContent ?? '').trim().toLowerCase();
    const label = (b.getAttribute('aria-label') ?? '').toLowerCase();
    return (/^apply(\s|$)/i.test(text) || /^apply$/i.test(label)) &&
           !/easy\s*apply/i.test(text);
  });
  return applyBtn ?? null;
}

function extractJobDescription(): string {
  const ats = detectATS();

  // ATS-specific first
  if (ats) {
    for (const sel of ats.info.jdSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent && el.textContent.trim().length > 80) {
        return el.textContent.trim().slice(0, 5000);
      }
    }
  }

  // Generic high-confidence selectors
  const genericSelectors = [
    '.job-description', '.job-details', '#job-description',
    '[data-automation="job-description"]', '.description__text',
    '.jobsearch-JobComponent-description', '.job-posting-description',
    'section.description', '.posting-requirements', '[class*="jobDescription"]',
    '[class*="job-description"]', '[class*="jobContent"]',
  ];
  for (const sel of genericSelectors) {
    const el = document.querySelector(sel);
    if (el?.textContent && el.textContent.trim().length > 80) {
      return el.textContent.trim().slice(0, 5000);
    }
  }

  // Largest <article> or <main> block
  for (const tag of ['article', 'main', '[role="main"]']) {
    const el = document.querySelector(tag);
    const text = el?.textContent?.trim() ?? '';
    if (text.length > 200) return text.slice(0, 5000);
  }

  return document.body.innerText.slice(0, 3000);
}

// ── Captcha detection ─────────────────────────────────────────────────────────

function detectCaptcha(): boolean {
  return !!(
    document.querySelector('iframe[src*="hcaptcha.com"]') ||
    document.querySelector('.h-captcha') ||
    document.querySelector('iframe[src*="recaptcha"]') ||
    document.querySelector('.g-recaptcha') ||
    document.querySelector('#recaptcha') ||
    document.querySelector('.cf-turnstile') ||
    document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
    document.querySelector('[class*="captcha"]') ||
    document.querySelector('[id*="captcha"]') ||
    (document.body.innerText.toLowerCase().includes('i am not a robot') ||
     document.body.innerText.toLowerCase().includes("i'm not a robot"))
  );
}

// ── Login wall + SSO detection ────────────────────────────────────────────────

interface LoginWallInfo {
  isLoginWall: boolean;
  hasGoogleSSO: boolean;
  googleBtnEl?: HTMLElement;
  platform?: string;
}

function detectLoginWall(): LoginWallInfo {
  const text = document.body.innerText.toLowerCase();
  const url  = location.href.toLowerCase();

  // Signs we're on a login page, not an apply page
  const loginKeywords = ['sign in', 'log in', 'create account', 'register to apply', 'login required'];
  const isLoginPage   = loginKeywords.some((kw) => text.includes(kw)) &&
                        !document.querySelector('input[type="file"]');

  // Google SSO button
  const googleSelectors = [
    '[data-provider="google"]',
    '[aria-label*="Google"]',
    'a[href*="accounts.google.com"]',
    'button[class*="google"]',
    'div[class*="google-login"]',
    '[id*="google-signin"]',
  ];
  let googleBtnEl: HTMLElement | undefined;
  for (const sel of googleSelectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) { googleBtnEl = el; break; }
  }
  // Text-based fallback
  if (!googleBtnEl) {
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button, a, div[role="button"]'));
    googleBtnEl = btns.find((b) => /sign\s*in\s*with\s*google/i.test(b.textContent ?? ''));
  }

  // Detect platform name from URL
  const ats = detectATS();
  const platform = ats?.info.name;

  return {
    isLoginWall:  isLoginPage || url.includes('/login') || url.includes('/sign-in') || url.includes('/auth'),
    hasGoogleSSO: !!googleBtnEl,
    googleBtnEl,
    platform,
  };
}

// ── Form error scan ───────────────────────────────────────────────────────────

function scanFormErrors(): string[] {
  const errors: string[] = [];
  const errorSelectors = [
    '[aria-invalid="true"]',
    '.field-error', '.validation-error', '.error-message',
    '[class*="error"]:not(script)', '[class*="invalid"]',
  ];
  const errorEls = new Set<Element>();
  for (const sel of errorSelectors) {
    document.querySelectorAll(sel).forEach((el) => errorEls.add(el));
  }
  for (const el of errorEls) {
    const text = el.textContent?.trim();
    if (text && text.length < 200 && text.length > 2) {
      errors.push(text);
    }
  }
  return [...new Set(errors)].slice(0, 5);
}

// ── Multi-step detection ──────────────────────────────────────────────────────

interface MultiStepInfo {
  isMultiStep:  boolean;
  currentStep?: number;
  totalSteps?:  number;
  nextBtn?:     HTMLElement;
}

function detectMultiStep(): MultiStepInfo {
  // Look for step indicators
  const stepIndicators = document.querySelectorAll(
    '[class*="step"], [class*="wizard"], [class*="progress-step"], .stepper li, nav.steps li',
  );
  if (stepIndicators.length > 1) {
    const total    = stepIndicators.length;
    const current  = Array.from(stepIndicators).findIndex(
      (el) => el.classList.toString().includes('active') || el.getAttribute('aria-current') === 'step',
    ) + 1;

    // Find "Next" button (must NOT be a submit button)
    const nextBtn = findNextButton();
    return { isMultiStep: true, currentStep: current || 1, totalSteps: total, nextBtn: nextBtn ?? undefined };
  }
  return { isMultiStep: false };
}

function findNextButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, input[type="button"], a[role="button"]'),
  );
  const NEXT_RE   = /^(next|continue|proceed|weiter|nächste|vor|forward)\b/i;
  const SUBMIT_RE = /submit|apply|send|absenden|bewerben/i;

  return candidates.find((b) => {
    const text = b.textContent?.trim() ?? (b as HTMLInputElement).value ?? '';
    return NEXT_RE.test(text) && !SUBMIT_RE.test(text);
  }) ?? null;
}

/**
 * Find the Submit / Apply button on the form.
 *
 * Strategy:
 *  1. <button type="submit"> or <input type="submit"> inside a <form>
 *  2. Buttons whose text matches submit/apply/send keywords
 *  3. Prefer buttons inside the form that contains our detected fields
 *  4. Skip hidden, disabled, or tiny buttons
 */
function findSubmitButton(): HTMLElement | null {
  const SUBMIT_TEXT = /^(submit|apply|send|absenden|bewerben|einreichen|confirm|continue to|submit application|apply now|submit my application)/i;
  const SKIP_TEXT   = /^(next|back|cancel|close|save|draft|sign|login|log in|register|create account)/i;

  // Find the form that contains most of our detected fields
  const forms = Array.from(document.querySelectorAll('form'));
  let bestForm: HTMLFormElement | null = null;
  let bestCount = 0;
  for (const form of forms) {
    const count = detected.filter((f) => form.contains(f.element)).length;
    if (count > bestCount) { bestCount = count; bestForm = form; }
  }

  // Gather candidates
  const scope = bestForm ?? document;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>(
      'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"]), [role="button"]',
    ),
  );

  // Also add any button/a whose text matches submit keywords (might be outside form)
  if (!bestForm) {
    document.querySelectorAll<HTMLElement>('button, a[role="button"], a.btn, a[class*="submit"], a[class*="apply"]').forEach((el) => {
      if (!candidates.includes(el)) candidates.push(el);
    });
  }

  // Score and filter
  for (const btn of candidates) {
    const text = (btn.textContent?.trim() ?? (btn as HTMLInputElement).value ?? '').substring(0, 80);
    const rect = btn.getBoundingClientRect();
    const isHidden = rect.width < 10 || rect.height < 10 ||
      getComputedStyle(btn).display === 'none' ||
      getComputedStyle(btn).visibility === 'hidden';
    const isDisabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';

    if (isHidden || isDisabled) continue;
    if (SKIP_TEXT.test(text)) continue;

    // type="submit" is high confidence
    if ((btn as HTMLButtonElement).type === 'submit' || (btn as HTMLInputElement).type === 'submit') {
      return btn;
    }
    // Text match
    if (SUBMIT_TEXT.test(text)) {
      return btn;
    }
  }

  // Last resort: the last visible primary-looking button in the form
  if (bestForm) {
    const allBtns = Array.from(bestForm.querySelectorAll<HTMLElement>('button'));
    for (let i = allBtns.length - 1; i >= 0; i--) {
      const btn = allBtns[i];
      const rect = btn.getBoundingClientRect();
      const text = btn.textContent?.trim() ?? '';
      if (rect.width > 50 && rect.height > 20 && !SKIP_TEXT.test(text) &&
          !btn.hasAttribute('disabled')) {
        return btn;
      }
    }
  }

  return null;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  const isIframe = window.top !== window.self;
  console.log('[ApplyPilot] boot() starting on', location.href, isIframe ? '(iframe)' : '(top)');

  settings = await getSettings();
  console.log('[ApplyPilot] Settings loaded — enabled:', settings.enabled,
    '| mode:', settings.automationMode,
    '| smartActivation:', settings.smartActivation,
    '| resumeFileName:', settings.resumeFileName || '(empty)',
    '| resumeDataUrl length:', (settings.resumeDataUrl || '').length,
    '| resumeText length:', (settings.resumeText || '').length);

  // ── Master kill switch ────────────────────────────────────────────────────
  if (!settings.enabled) { console.log('[ApplyPilot] Extension disabled — exiting.'); return; }
  if (settings.automationMode === 'off') { console.log('[ApplyPilot] Mode is off — exiting.'); return; }

  // ── Smart activation: skip non-job sites unless explicitly on a form page ─
  const host = location.hostname.replace(/^www\./, '');
  if (settings.smartActivation) {
    const isKnownJobSite = Object.keys(ATS_MAP).some((d) => host.endsWith(d)) ||
      /jobs?\.|career|apply|recruit|hiring|talent|arbeit|stellen/i.test(host + location.pathname);
    if (!isKnownJobSite) { console.log('[ApplyPilot] Not a known job site — exiting.'); return; }
  }

  // ── Per-site blocklist ────────────────────────────────────────────────────
  if (settings.disabledSites?.some((d) => host.includes(d.replace(/^www\./, '')))) {
    console.log('[ApplyPilot] Site is in blocklist — exiting.');
    return;
  }

  const resume = await getResume();
  console.log('[ApplyPilot] Resume lookup result:', resume ? `dataUrl length=${resume.dataUrl.length}` : 'null');
  console.log('[ApplyPilot] resumeText length:', (settings.resumeText ?? '').length,
    '| Has text fallback:', (settings.resumeText ?? '').length > 50);
  if (resume) resumeDataUrl = resume.dataUrl ?? '';
  coverLetterDataUrl = settings.coverLetterDataUrl ?? '';

  // Only run top-frame-specific checks when not in an iframe
  if (!isIframe) {
    await warnIfAlreadyApplied();
  }

  if (isIframe) {
    // ── Iframe mode: detect fields, notify top frame, wait for fill command ──
    setTimeout(async () => {
      detected = detectFields();
      console.log('[ApplyPilot] Iframe detected', detected.length, 'fields');
      if (detected.length > 0) {
        // Send field info to background → top frame
        const fieldInfo = detected.map((f) => ({
          type: f.type, label: f.label, confidence: f.confidence,
        }));
        chrome.runtime.sendMessage({
          type: 'IFRAME_FIELDS_DETECTED',
          payload: { fields: fieldInfo },
        });
      }
    }, 1500);

    // Re-detect on DOM mutations
    const observer = new MutationObserver(debounce(async () => {
      const fresh = detectFields();
      if (fresh.length !== detected.length) {
        detected = fresh;
        console.log('[ApplyPilot] Iframe re-detected', detected.length, 'fields');
        if (detected.length > 0) {
          chrome.runtime.sendMessage({
            type: 'IFRAME_FIELDS_DETECTED',
            payload: { fields: detected.map((f) => ({ type: f.type, label: f.label, confidence: f.confidence })) },
          });
        }
      }
    }, 800));
    observer.observe(document.body, { childList: true, subtree: true });
    return; // Don't run top-frame panel logic
  }

  // ── Top-frame mode: build panel, detect fields ────────────────────────────
  setTimeout(async () => {
    detected = detectFields();
    if (detected.length > 0 || iframeFields.length > 0) {
      buildPanel();
      if (settings!.automationMode === 'semi-auto' || settings!.automationMode === 'full-auto') {
        setTimeout(showFillPanel, 400);
      }
      if (settings!.automationMode === 'full-auto' && !queueMode) {
        setTimeout(() => fillFields(), 800);
      }
    }

    if (detectCaptcha()) showCaptchaBanner();
    const loginInfo = detectLoginWall();
    if (loginInfo.isLoginWall) showLoginBanner(loginInfo);

  }, 1500);

  // Re-detect on DOM mutations (multi-step forms)
  const observer = new MutationObserver(debounce(async () => {
    const fresh = detectFields();
    if (fresh.length !== detected.length) {
      detected = fresh;
      rebuildPanel();
    }
    if (detectCaptcha()) showCaptchaBanner();
  }, 800));
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Message listeners ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'TRIGGER_PANEL': {
      const payload = (msg.payload ?? {}) as TriggerPanelPayload;
      if (payload.done) {
        showQueueCompleteBanner();
        sendResponse({ ok: true });
        break;
      }
      if (payload.stuckAbort) {
        showToast(`⛔ Auto-apply stuck — skipping. Reason: ${payload.reason ?? 'unknown'}`, 'warn');
        sendResponse({ ok: true });
        break;
      }
      queueMode = payload;

      // Ensure fields are detected
      if (!shadowHost || detected.length === 0) {
        detected = detectFields();
      }

      // Smart navigation: if we're on a job listing page (no form fields), try to
      // click the external Apply button to reach the actual ATS application form.
      if (detected.length === 0 && iframeFields.length === 0) {
        const applyBtn = findApplyButtonOnPage();
        if (applyBtn) {
          showToast('🔍 Navigating to application form…', 'info');
          applyBtn.click();
          sendResponse({ ok: true });
          break;  // content script will re-initialise on the new page
        }
      }

      if (!shadowHost) buildPanel();
      showFillPanel();
      sendResponse({ ok: true });
      break;
    }

    case 'TOGGLE_PANEL':
      if (panelVisible) {
        rebuildPanel();  // collapse to button
      } else {
        if (!shadowHost) { detected = detectFields(); buildPanel(); }
        showFillPanel();
      }
      sendResponse({ ok: true });
      break;

    case 'GET_DETECTED_FIELDS':
      sendResponse({ count: detected.length + iframeFields.length });
      break;

    case 'SHOW_FILL_PANEL':
      if (!shadowHost) { detected = detectFields(); buildPanel(); }
      showFillPanel();
      sendResponse({ ok: true });
      break;

    // ── Iframe field relay (received by top frame from background) ────────
    case 'IFRAME_FIELDS_DETECTED': {
      const p = msg.payload as { fields: IframeFieldInfo[]; iframeFrameId: number };
      console.log('[ApplyPilot] Top frame received iframe fields:', p.fields.length, 'frameId:', p.iframeFrameId);
      iframeFields = p.fields;
      iframeFrameId = p.iframeFrameId;
      // Rebuild panel to show iframe fields
      if (!shadowHost) {
        buildPanel();
        showFillPanel();
      } else {
        rebuildPanel();
        showFillPanel();
      }
      sendResponse({ ok: true });
      break;
    }

    // ── Fill command from top frame (received by iframe) ──────────────────
    case 'FILL_IFRAME_FIELDS': {
      console.log('[ApplyPilot] Iframe received fill command, filling', detected.length, 'fields');
      fillFields();
      sendResponse({ ok: true });
      break;
    }

    case 'DETECT_JOB_ON_PAGE': {
      const atsInfo = detectATS();
      const jobInfo = extractPageJobInfo();
      sendResponse({
        ok:       true,
        hasJob:   Boolean(jobInfo.title),
        title:    jobInfo.title,
        company:  jobInfo.company,
        location: jobInfo.location,
        url:      location.href,
        atsName:  atsInfo?.info.name ?? 'Unknown',
      });
      break;
    }

    case 'CLICK_SELECTOR': {
      // Called by stuck-detection: try clicking the AI-suggested selector
      const { selector } = (msg.payload ?? {}) as { selector: string };
      try {
        const el = document.querySelector<HTMLElement>(selector);
        if (el) {
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: `Selector not found: ${selector}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: (err as Error).message });
      }
      break;
    }
  }
  return true;
});

// ── Page job info extraction (shared helper) ────────────────────────────────

function extractPageJobInfo(): { title: string; company: string; location: string } {
  let title = '', company = '', loc = '';

  // 1. JSON-LD structured data (most reliable)
  document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      const data = JSON.parse(el.textContent ?? '');
      const obj  = Array.isArray(data) ? data[0] : data;
      if (obj['@type'] === 'JobPosting' || obj.title) {
        title   = title   || obj.title || '';
        company = company || obj.hiringOrganization?.name || '';
        loc     = loc     || obj.jobLocation?.address?.addressLocality || '';
      }
    } catch { /* skip */ }
  });

  // 2. ATS-specific title selectors
  if (!title) {
    const selectors = [
      'h1[data-testid="job-title"]', 'h1.posting-headline', 'h1.job-title',
      '[data-automation-id="jobPostingHeader"] h1', '.job-title h1',
      'h1[class*="title"]', 'h1[class*="Title"]', 'h1',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { title = el.textContent.trim(); break; }
    }
  }

  // 3. Open Graph / meta tags
  if (!title) title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? '';
  if (!company) company = document.querySelector<HTMLMetaElement>('meta[name="author"]')?.content ?? '';

  // 4. Page title fallback
  if (!title) title = document.title.replace(/\s*[-|]\s*.+$/, '').trim();

  return { title: title.slice(0, 120), company: company.slice(0, 80), location: loc.slice(0, 80) };
}

// ── Duplicate URL + fuzzy match warning ──────────────────────────────────────

async function warnIfAlreadyApplied() {
  const url = location.href;
  const { title: pageTitle, company: pageCompany } = extractPageJobInfo();

  chrome.runtime.sendMessage(
    { type: 'CHECK_DUPLICATE_URL', payload: { url, company: pageCompany, title: pageTitle } },
    (resp: { found: boolean; job?: { status: string; title: string; company: string }; similar?: Array<{ title: string; company: string; status: string }> }) => {
      if (!resp) return;
      if (resp.found && resp.job?.status === 'applied') {
        showToast(`⚠️ You already applied to "${resp.job.title}" — check your job list.`, 'warn');
      } else if (resp.similar && resp.similar.length > 0) {
        const first = resp.similar[0];
        const status = first.status === 'applied' ? 'applied to' : 'opened';
        const atCompany = first.company ? ` at ${first.company}` : '';
        showToast(
          `🔍 Similar job found: you ${status} "${first.title}"${atCompany}. Possible duplicate?`,
          'warn',
        );
      }
    },
  );
  chrome.runtime.sendMessage({ type: 'MARK_JOB_OPENED', payload: url });
}

// ── Field detection ───────────────────────────────────────────────────────────

const FIELD_PATTERNS: Array<{
  type: FieldType;
  names: RegExp;
  labels: RegExp;
  autocomplete?: string;
}> = [
  { type: 'firstName',   names: /first[\s_-]?name|fname|given[\s_-]?name/i,          labels: /first\s*name|given\s*name|vorname/i,                   autocomplete: 'given-name' },
  { type: 'lastName',    names: /last[\s_-]?name|lname|surname|family[\s_-]?name/i,   labels: /last\s*name|surname|family\s*name|nachname/i,           autocomplete: 'family-name' },
  { type: 'fullName',    names: /^name$|full[\s_-]?name/i,                            labels: /^name$|full\s*name|your\s*name/i,                       autocomplete: 'name' },
  { type: 'email',       names: /e[\s_-]?mail/i,                                      labels: /e[\s_-]?mail/i,                                         autocomplete: 'email' },
  { type: 'phone',       names: /phone|mobile|tel/i,                                  labels: /phone|mobile|telephone/i,                               autocomplete: 'tel' },
  { type: 'city',        names: /city|location|\bcity\b/i,                            labels: /city|location|stadt/i,                                  autocomplete: 'address-level2' },
  { type: 'country',     names: /country/i,                                           labels: /country|land/i,                                         autocomplete: 'country' },
  { type: 'address',     names: /address|street/i,                                    labels: /address|street/i,                                       autocomplete: 'street-address' },
  { type: 'salary',      names: /salary|compensation|ctc|expected|desired[\s_-]?salary/i, labels: /salary|compensation|expected pay|desired pay|gehalt/i },
  { type: 'noticePeriod',names: /notice[\s_-]?period|notice/i,                        labels: /notice\s*period|current notice/i },
  { type: 'joiningDate', names: /start[\s_-]?date|joining[\s_-]?date|available[\s_-]?from/i, labels: /start\s*date|joining\s*date|earliest\s*start|available\s*from/i },
  { type: 'linkedin',    names: /linkedin|linked[\s_-]?in|lnkd/i,                    labels: /linkedin|linked\s*in|professional\s*profile/i },
  { type: 'github',      names: /github|git[\s_-]?hub|gh[\s_-]?profile/i,            labels: /github|git\s*hub|code\s*repository|source\s*code/i },
  { type: 'portfolio',   names: /portfolio|website|personal[\s_-]?site|web[\s_-]?url|homepage/i, labels: /portfolio|personal\s*website|personal\s*site|your\s*website|homepage/i },
  { type: 'yearsOfExperience', names: /years[\s_-]?of[\s_-]?experience|experience[\s_-]?years/i, labels: /years.+experience|how many years/i },
  { type: 'dateOfBirth', names: /date[\s_-]?of[\s_-]?birth|dob|birth[\s_-]?date|\bage\b/i,   labels: /date\s*of\s*birth|birth\s*date|birthday|geburtsdatum|\bage\b|\bhow old\b/i },
  { type: 'workAuthorization', names: /authorized|authorised|work[\s_-]?auth|legally[\s_-]?auth|eligible/i, labels: /authorized to work|work authorization|right to work|arbeitserlaubnis|legally.*work|eligible.*work/i },
  { type: 'visaSponsorship',   names: /visa[\s_-]?sponsor/i,                         labels: /visa sponsorship|require.*visa|need.*sponsorship/i },
  { type: 'workMode',    names: /work[\s_-]?mode|remote|hybrid/i,                    labels: /work\s*mode|work\s*arrangement|remote\s*preference/i },
  { type: 'relocation',  names: /reloca/i,                                            labels: /relocation|willing to move/i },
  { type: 'gender',      names: /\bgender\b|pronouns?/i,                              labels: /\bgender\b|pronouns?/i },
  { type: 'resume',      names: /resume|cv/i,                                        labels: /resume|cv|upload\s*resume/i },
  { type: 'coverLetter', names: /cover[\s_-]?letter|motivation[\s_-]?letter/i,       labels: /cover\s*letter|motivation\s*letter|anschreiben/i },
];

// ── EEO / demographic field patterns — filled with safe defaults ─────────────
const EEO_RACE_PATTERN       = /race|ethnicity|ethnic/i;
const EEO_VETERAN_PATTERN    = /veteran/i;
const EEO_DISABILITY_PATTERN = /disability|disab/i;
const EEO_SKIP_PATTERN       = /protected[\s_-]?class|sexual[\s_-]?orientation|lgbtq/i; // truly skip these

function detectFields(): DetectedField[] {
  const results: DetectedField[] = [];
  const inputs = document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select, input[type="file"]',
  );

  for (const el of Array.from(inputs)) {
    const { type, confidence, label } = classifyField(el);
    if (type !== 'unknown' && confidence > 0.4) {
      const inputType = el.tagName.toLowerCase() as 'input' | 'textarea' | 'select' | 'file';
      results.push({ type, element: el, inputType, label, confidence });
    }
  }

  // Merge radio-group detections (higher confidence wins per field type)
  for (const rf of detectRadioGroups()) results.push(rf);

  // Merge button-toggle group detections (Ashby Yes/No pill buttons, etc.)
  for (const bf of detectButtonGroups()) results.push(bf);

  // Greenhouse custom questions: detect unmatched selects/textareas and try smart mapping
  const detectedEls = new Set(results.map((r) => r.element));
  for (const el of Array.from(inputs)) {
    if (detectedEls.has(el)) continue; // already matched
    if (el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement;
      const labelText = getLabel(el).toLowerCase();
      // Work eligibility / authorization questions
      if (/eligible|authorized|authorised|right to work|legally.*work|work.*right|permitted.*work/i.test(labelText)) {
        results.push({ type: 'workAuthorization', element: el, inputType: 'select', label: getLabel(el), confidence: 0.82 });
        detectedEls.add(el);
      }
      // Pronouns
      else if (/pronouns?/i.test(labelText)) {
        results.push({ type: 'gender', element: el, inputType: 'select', label: getLabel(el), confidence: 0.82 });
        detectedEls.add(el);
      }
      // Country questions (when not already matched)
      else if (/\bcountry\b|where.*located|where.*based/i.test(labelText)) {
        results.push({ type: 'country', element: el, inputType: 'select', label: getLabel(el), confidence: 0.78 });
        detectedEls.add(el);
      }
      // Yes/No dropdowns — try to match by label context
      else if (sel.options.length <= 5) {
        const hasYesNo = Array.from(sel.options).some((o) => /^(yes|no)$/i.test(o.textContent?.trim() ?? ''));
        if (hasYesNo) {
          // Non-compete, work permit, sponsorship — auto-fill with smart defaults
          if (/non[\s-]?compete|non[\s-]?solicitation|restrictive.*covenant/i.test(labelText)) {
            // Non-compete → No
            results.push({ type: 'workAuthorization', element: el, inputType: 'select', label: getLabel(el), confidence: 0.75 });
            detectedEls.add(el);
          } else if (/sponsor|visa/i.test(labelText)) {
            results.push({ type: 'visaSponsorship', element: el, inputType: 'select', label: getLabel(el), confidence: 0.80 });
            detectedEls.add(el);
          }
        }
      }
    }
    // Unmatched text inputs — detect location/city questions missed by FIELD_PATTERNS
    // This catches Lever/Jobgether "Where are you located?" free-text questions
    else if (el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'text' || !(el as HTMLInputElement).type)) {
      const labelText = getLabel(el).toLowerCase();
      const placeholder = (el as HTMLInputElement).placeholder?.toLowerCase() ?? '';
      const combined = `${labelText} ${placeholder}`;
      if (/where.*(based|located|live)|current.*(location|city)|your.*(location|city)/i.test(combined)) {
        results.push({ type: 'city', element: el, inputType: 'input', label: getLabel(el), confidence: 0.82 });
        detectedEls.add(el);
      }
    }
    // Unmatched textareas — custom questions (motivation, values, technical, "why us", etc.)
    else if (el.tagName === 'TEXTAREA') {
      const labelText = getLabel(el).toLowerCase();
      const placeholder = (el as HTMLTextAreaElement).placeholder?.toLowerCase() ?? '';
      const combined = `${labelText} ${placeholder}`;
      // Skip if it looks like a cover letter field (already handled)
      if (/cover.?letter|motivation.?letter|anschreiben/i.test(combined)) continue;
      // Detect as coverLetter type so the fill system can write a generic response
      // We use 'unknown' type but with a fill value hint
      if (combined.length > 5) {
        results.push({
          type: 'unknown',
          element: el,
          inputType: 'textarea',
          label: getLabel(el) || placeholder || 'Custom question',
          confidence: 0.60,
          fillValue: generateTextareaResponse(labelText || placeholder),
        });
        detectedEls.add(el);
      }
    }
  }

  const best = new Map<FieldType, DetectedField>();
  for (const f of results) {
    const prev = best.get(f.type);
    if (!prev || f.confidence > prev.confidence) best.set(f.type, f);
  }
  return Array.from(best.values()).sort((a, b) => b.confidence - a.confidence);
}

function classifyField(el: HTMLElement): { type: FieldType; confidence: number; label: string } {
  const inputEl      = el as HTMLInputElement;
  const name         = (inputEl.name ?? '').toLowerCase();
  const id           = (el.id ?? '').toLowerCase();
  const placeholder  = (inputEl.placeholder ?? '').toLowerCase();
  const autocomplete = (inputEl.autocomplete ?? '').toLowerCase();
  const labelText    = getLabel(el).toLowerCase();
  const inputType    = (inputEl.type ?? '').toLowerCase();
  const dataFieldType = (el.getAttribute('data-field-type') ?? el.getAttribute('data-qa') ?? '').toLowerCase();
  const ariaDesc = (() => {
    const id2 = el.getAttribute('aria-describedby');
    if (!id2) return '';
    return (document.getElementById(id2)?.textContent ?? '').toLowerCase();
  })();

  if (inputType === 'file') {
    const combinedFileText = `${name} ${id} ${labelText}`;

    // Skip "Autofill from resume" / "Parse resume" file inputs — those feed ATS auto-fill,
    // not the actual resume attachment.  Identify them by their section heading.
    const sectionHeading = (() => {
      let p: HTMLElement | null = el.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const h = p.querySelector('h1,h2,h3,h4,p,label,legend');
        if (h && !h.querySelector('input')) {
          const t = h.textContent?.trim().toLowerCase() ?? '';
          if (t.length > 0 && t.length < 120) return t;
        }
        p = p.parentElement;
      }
      return '';
    })();
    if (/autofill|auto.fill|parse.+resume|resume.+parse|import.+resume/i.test(sectionHeading)) {
      return { type: 'unknown', confidence: 0, label: '' };
    }

    // Cover-letter file upload — check input attrs, nearest heading, and URL path
    const pageHeading = `${document.querySelector('h1')?.textContent ?? ''} ${document.querySelector('h2')?.textContent ?? ''}`.toLowerCase();
    const urlPath = location.pathname.toLowerCase();
    const isCLContext = /cover[\s_-]?letter|motivation[\s_-]?letter|anschreiben/i.test(
      `${combinedFileText} ${pageHeading} ${urlPath}`,
    );
    if (isCLContext) {
      return { type: 'coverLetter', confidence: 0.93, label: 'Cover Letter (file)' };
    }

    // Resume / CV file upload
    const accept = inputEl.accept ?? '';
    if (accept.includes('pdf') || accept.includes('doc') || !accept || /resume|cv\b/i.test(combinedFileText)) {
      return { type: 'resume', confidence: 0.95, label: 'Resume / CV' };
    }
  }

  // Exclude "how did you find" / referral-source dropdowns — we don't know the right answer
  const combinedText = `${labelText} ${name} ${id} ${placeholder} ${dataFieldType}`;
  if (/how.+find|where.+hear|referr(al)?[\s_-]?source|marketing[\s_-]?source|recruitment[\s_-]?channel|utm|channel_source/i.test(combinedText)) {
    return { type: 'unknown', confidence: 0, label: '' };
  }

  // EEO / demographic fields — detect as their specific types so they can be filled with safe defaults
  if (EEO_SKIP_PATTERN.test(combinedText)) {
    return { type: 'unknown', confidence: 0, label: '' };
  }
  if (EEO_RACE_PATTERN.test(combinedText)) {
    return { type: 'race', confidence: 0.90, label: labelText || 'Race / Ethnicity' };
  }
  if (EEO_VETERAN_PATTERN.test(combinedText)) {
    return { type: 'veteranStatus', confidence: 0.90, label: labelText || 'Veteran Status' };
  }
  if (EEO_DISABILITY_PATTERN.test(combinedText)) {
    return { type: 'disabilityStatus', confidence: 0.90, label: labelText || 'Disability Status' };
  }

  const urlPlaceholder = placeholder.includes('github.com')   ? 'github'
                       : placeholder.includes('linkedin.com') ? 'linkedin'
                       : placeholder.includes('portfolio')    ? 'portfolio'
                       : '';

  for (const pat of FIELD_PATTERNS) {
    let score = 0;
    if (urlPlaceholder && pat.type === urlPlaceholder)              score = Math.max(score, 0.99);
    if (pat.autocomplete && autocomplete.includes(pat.autocomplete)) score = Math.max(score, 0.98);
    if (pat.names.test(name) || pat.names.test(id))                 score = Math.max(score, 0.90);
    if (pat.names.test(dataFieldType))                              score = Math.max(score, 0.90);
    if (pat.labels.test(labelText))                                 score = Math.max(score, 0.85);
    if (pat.labels.test(ariaDesc))                                  score = Math.max(score, 0.80);
    if (pat.names.test(placeholder))                                score = Math.max(score, 0.75);
    if (pat.labels.test(placeholder))                               score = Math.max(score, 0.70);

    if (score > 0.4) return { type: pat.type, confidence: score, label: labelText || name || pat.type };
  }
  return { type: 'unknown', confidence: 0, label: '' };
}

function getLabel(el: HTMLElement): string {
  if (el.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`);
    if (label) return label.textContent?.trim() ?? '';
  }
  const parent = el.closest('label');
  if (parent) return parent.textContent?.replace(el.textContent ?? '', '').trim() ?? '';
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() ?? '';
  }
  const prev = el.previousElementSibling;
  if (prev && prev.tagName !== 'INPUT') return prev.textContent?.trim() ?? '';
  return '';
}

// ── Shadow DOM panel ──────────────────────────────────────────────────────────

function buildPanel() {
  if (document.getElementById(PANEL_ID)) return;
  shadowHost         = document.createElement('div');
  shadowHost.id      = PANEL_ID;
  shadowHost.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;';
  document.body.appendChild(shadowHost);
  shadowRoot = shadowHost.attachShadow({ mode: 'open' });
  shadowRoot.innerHTML = getPanelHTML(false);
  attachPanelListeners();
  panelVisible = false;
}

function rebuildPanel() {
  if (!shadowRoot) { buildPanel(); return; }
  shadowRoot.innerHTML = getPanelHTML(false);
  attachPanelListeners();
  panelVisible = false;
}

function showFillPanel() {
  if (!shadowRoot) return;
  shadowRoot.innerHTML = getPanelHTML(true);
  attachPanelListeners();
  panelVisible = true;

  // Populate the cover letter area with the pre-generated letter (from queue)
  if (queueMode?.coverLetter) {
    const letterArea = shadowRoot.getElementById('ap-letter-area') as HTMLElement | null;
    const letterText = shadowRoot.getElementById('ap-letter-text') as HTMLTextAreaElement | null;
    if (letterArea) letterArea.style.display = 'block';
    if (letterText) letterText.value = queueMode.coverLetter;
  }

  // Check for duplicate/similar jobs in the panel
  checkDuplicateForPanel();

  // Auto-fill when opened by queue
  if (queueMode?.autoFill && detected.length > 0) {
    setTimeout(async () => {
      await fillFields();         // fills all fields incl. CL textarea if letter is set

      // Auto-mode: start countdown then advance queue automatically
      if (queueMode?.autoMode) {
        startAutoAdvanceCountdown();
      }
    }, 700);
  }
}

const AUTO_ADVANCE_SECS = 8;
let autoAdvanceTimer: ReturnType<typeof setInterval> | null = null;

function startAutoAdvanceCountdown() {
  let remaining = AUTO_ADVANCE_SECS;
  const statusEl = shadowRoot?.getElementById('ap-status');
  if (!statusEl) return;

  // Cancel any existing timer
  if (autoAdvanceTimer) clearInterval(autoAdvanceTimer);

  const update = () => {
    if (!shadowRoot) { clearInterval(autoAdvanceTimer!); return; }
    if (remaining <= 0) {
      clearInterval(autoAdvanceTimer!);
      autoAdvanceTimer = null;
      // Auto-advance: mark as skipped (user can manually mark applied)
      chrome.runtime.sendMessage({ type: 'QUEUE_ADVANCE', payload: { markApplied: false } }, (resp) => {
        if (resp?.done) { showQueueCompleteBanner(); queueMode = null; rebuildPanel(); }
      });
      return;
    }
    statusEl.innerHTML = `⏳ Auto-advancing in <strong>${remaining}s</strong>… &nbsp;<button id="ap-auto-cancel" style="font-size:11px;padding:2px 8px;cursor:pointer;border:1px solid #CBD5E1;border-radius:4px;background:#fff">Cancel</button>`;
    shadowRoot?.getElementById('ap-auto-cancel')?.addEventListener('click', () => {
      clearInterval(autoAdvanceTimer!);
      autoAdvanceTimer = null;
      statusEl.textContent = '✋ Auto-advance cancelled — apply manually then click Applied → Next.';
    });
    remaining--;
  };

  update(); // show immediately
  autoAdvanceTimer = setInterval(update, 1000);
}

function checkDuplicateForPanel() {
  const { title: pageTitle, company: pageCompany } = extractPageJobInfo();
  if (!pageTitle && !pageCompany) return;

  chrome.runtime.sendMessage(
    { type: 'CHECK_DUPLICATE_URL', payload: { url: location.href, company: pageCompany, title: pageTitle } },
    (resp: { found: boolean; job?: any; similar?: Array<{ title: string; company: string; status: string }> }) => {
      if (!resp || !shadowRoot) return;
      const banner = shadowRoot.getElementById('ap-dupe-banner');
      if (!banner) return;

      if (resp.found && resp.job?.status === 'applied') {
        banner.style.display = 'block';
        banner.innerHTML = `<div style="background:#FEF2F2;border:1px solid #FCA5A5;color:#991B1B;padding:8px 12px;font-size:12px;border-radius:0">⚠️ <strong>Already applied</strong> to "${escHtml(resp.job.title)}" — this may be a duplicate.</div>`;
      } else if (resp.similar && resp.similar.length > 0) {
        const first = resp.similar[0];
        const verb  = first.status === 'applied' ? 'applied to' : 'opened';
        const atCompany = first.company ? ` at ${escHtml(first.company)}` : '';
        banner.style.display = 'block';
        banner.innerHTML = `<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;padding:8px 12px;font-size:12px;border-radius:0">🔍 Similar: you ${verb} "<strong>${escHtml(first.title)}</strong>"${atCompany}. Possible duplicate?</div>`;
      }
    },
  );
}

function getPanelHTML(expanded: boolean): string {
  const totalCount  = detected.length + iframeFields.length;
  const fillableCount = detected.filter(f => {
    if (f.type === 'resume') return !!settings?.resumeFileName;
    if (f.type === 'coverLetter') return !!(queueMode?.coverLetter) || !!(coverLetterDataUrl && settings?.coverLetterFileName);
    return !!getValueForField(f.type, settings?.profile, f);
  }).length + iframeFields.filter(f => !!getValueForField(f.type as any, settings?.profile)).length;
  const fields = detected.slice(0, 14);
  const ats    = detectATS();
  const step   = detectMultiStep();
  const captcha = detectCaptcha();
  const isQueue = !!queueMode;

  const fieldsHtml = fields.map((f) => {
    let value = getValueForField(f.type, settings?.profile, f);
    if (f.type === 'resume') {
      value = settings?.resumeFileName
        ? `📎 ${settings.resumeFileName}`
        : '⚠️ No CV — upload in Settings';
    }
    if (f.type === 'coverLetter' && (f.element as HTMLInputElement).type === 'file') {
      const hasLetter = !!(queueMode?.coverLetter);
      const hasDefaultCL = !!(coverLetterDataUrl && settings?.coverLetterFileName);
      value = hasLetter ? '📄 Cover letter ready (will upload)'
            : hasDefaultCL ? `📄 ${settings!.coverLetterFileName}`
            : '✏️ Generate CL first';
    }
    return `
      <div class="field-row">
        <span class="field-icon">${fieldIcon(f.type)}</span>
        <div class="field-info">
          <span class="field-label">${escHtml(f.label || f.type)}</span>
          <span class="field-value">${escHtml(value || '—')}</span>
        </div>
        <span class="field-conf ${f.confidence > 0.8 ? 'high' : 'med'}">${Math.round(f.confidence * 100)}%</span>
      </div>
    `;
  }).join('');

  // Iframe fields (from embedded ATS form)
  const iframeFieldsHtml = iframeFields.map((f) => {
    const value = getValueForField(f.type as any, settings?.profile) || '—';
    return `
      <div class="field-row">
        <span class="field-icon">${fieldIcon(f.type as any)}</span>
        <div class="field-info">
          <span class="field-label">${escHtml(f.label || f.type)}</span>
          <span class="field-value">${escHtml(value)}</span>
        </div>
        <span class="field-conf ${f.confidence > 0.8 ? 'high' : 'med'}">${Math.round(f.confidence * 100)}%</span>
      </div>
    `;
  }).join('');

  const hasCL = isQueue && !!queueMode!.coverLetter;
  const queueBanner = isQueue ? `
    <div class="ap-queue-banner">
      ⚡ Queue · Job ${queueMode!.queuePos ?? '?'} of ${queueMode!.queueTotal ?? '?'}
      ${queueMode!.company ? `<span style="opacity:.8"> · ${escHtml(queueMode!.company)}</span>` : ''}
      ${hasCL ? `<span style="color:#A7F3D0;margin-left:6px">✓ CL ready</span>` : ''}
    </div>
  ` : '';

  const atsBadge = ats ? `<span class="ap-ats-badge">${ats.info.name}</span>` : '';

  const workdayWarning = ats?.info.needsRefill ? `
    <div class="ap-warn-bar">⚠️ ${ats.info.name} may reset fields — use Re-fill if values disappear.</div>
  ` : '';

  const stepBanner = step.isMultiStep ? `
    <div class="ap-step-bar">📋 Multi-step form · Step ${step.currentStep ?? '?'} of ${step.totalSteps ?? '?'}</div>
  ` : '';

  const captchaBanner = captcha ? `
    <div class="ap-captcha-bar">🤖 CAPTCHA detected — complete it, then click Re-fill.</div>
  ` : '';

  const queueActions = isQueue ? `
    <div class="ap-queue-actions">
      <button id="ap-queue-applied" class="btn-green">✅ Applied → Next</button>
      <button id="ap-queue-skip"    class="btn-gray">⏭ Skip → Next</button>
    </div>
  ` : '';

  return `
    <style>${panelCSS()}</style>
    ${!expanded ? `
      <button id="ap-toggle-btn">
        <span class="ap-icon">✈</span>
        <span>ApplyPilot</span>
        <span class="ap-badge">${totalCount}</span>
        ${isQueue ? `<span class="ap-queue-dot">${queueMode!.queuePos}/${queueMode!.queueTotal}</span>` : ''}
      </button>
    ` : `
      <div id="ap-panel">
        <div class="ap-header">
          <span class="ap-logo">✈ ApplyPilot ${atsBadge}</span>
          <span class="ap-count">${fillableCount}/${totalCount} ready</span>
          <button id="ap-dismiss-site" title="Disable on this site" style="font-size:10px;padding:2px 6px;cursor:pointer;background:none;border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:4px;margin-right:4px">🚫</button>
          <button id="ap-minimize">−</button>
        </div>
        ${queueBanner}
        ${captchaBanner}
        ${workdayWarning}
        ${stepBanner}
        <div id="ap-dupe-banner" style="display:none"></div>
        <div class="ap-body">
          <div class="ap-fields">${fieldsHtml}${iframeFieldsHtml}</div>
          <div class="ap-actions">
            <button id="ap-gen-letter" class="btn-secondary">✨ Generate & Upload CL</button>
            <button id="ap-fill-btn"   class="btn-primary">🚀 Fill Form</button>
          </div>
          <div class="ap-refill-row">
            <button id="ap-refill-btn" class="btn-refill">↩ Re-fill</button>
            <span class="ap-warning">${settings?.automationMode === 'full-auto' ? '🚀 Auto-submit ON' : 'Never auto-submits.'}</span>
          </div>
          <div id="ap-letter-area" style="display:none">
            <div class="ap-letter-label">Cover Letter</div>
            <textarea id="ap-letter-text" rows="8" placeholder="Cover letter will appear here…"></textarea>
            <div style="display:flex;gap:8px;margin-top:6px">
              <button id="ap-copy-letter" class="btn-secondary">📋 Copy</button>
              <button id="ap-download-letter" class="btn-secondary">⬇ Download PDF</button>
            </div>
          </div>
          <div id="ap-status"></div>
          ${queueActions}
        </div>
      </div>
    `}
  `;
}

function attachPanelListeners() {
  if (!shadowRoot) return;

  shadowRoot.getElementById('ap-toggle-btn')?.addEventListener('click', () => showFillPanel());

  // Dismiss + disable on this site
  shadowRoot.getElementById('ap-dismiss-site')?.addEventListener('click', async () => {
    const host = location.hostname.replace(/^www\./, '');
    const s = await getSettings();
    const sites = s.disabledSites ?? [];
    if (!sites.includes(host)) {
      sites.push(host);
      await saveSettings({ disabledSites: sites });
    }
    // Remove the panel entirely
    if (shadowHost) { shadowHost.remove(); shadowHost = null; shadowRoot = null; }
    showToast(`✓ ApplyPilot disabled on ${host}. Re-enable in Settings.`, 'info');
  });
  shadowRoot.getElementById('ap-minimize')?.addEventListener('click', rebuildPanel);

  shadowRoot.getElementById('ap-fill-btn')?.addEventListener('click', async () => {
    await fillFields();
    // Also fill iframe fields if present
    if (iframeFrameId !== null) {
      chrome.runtime.sendMessage({
        type: 'FILL_IFRAME_FIELDS',
        payload: { iframeFrameId },
      });
    }
  });

  shadowRoot.getElementById('ap-refill-btn')?.addEventListener('click', async () => {
    // Re-detect fields (page may have re-rendered) then fill
    detected = detectFields();
    rebuildPanel();
    showFillPanel();
    setTimeout(async () => {
      await fillFields();
      if (iframeFrameId !== null) {
        chrome.runtime.sendMessage({
          type: 'FILL_IFRAME_FIELDS',
          payload: { iframeFrameId },
        });
      }
    }, 200);
  });

  shadowRoot.getElementById('ap-gen-letter')?.addEventListener('click', async () => {
    await generateCoverLetter();
  });

  shadowRoot.getElementById('ap-copy-letter')?.addEventListener('click', () => {
    const ta = shadowRoot?.getElementById('ap-letter-text') as HTMLTextAreaElement;
    if (ta?.value) {
      navigator.clipboard.writeText(ta.value).catch(() => {});
      showStatus('✓ Copied to clipboard');
    }
  });

  shadowRoot.getElementById('ap-download-letter')?.addEventListener('click', () => {
    const ta = shadowRoot?.getElementById('ap-letter-text') as HTMLTextAreaElement;
    if (!ta?.value) { showStatus('No cover letter to download'); return; }
    const file = buildCoverLetterFile(ta.value);
    const url  = URL.createObjectURL(file);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus(`✓ Downloaded ${file.name}`);
  });

  // Queue actions
  shadowRoot.getElementById('ap-queue-applied')?.addEventListener('click', () => {
    if (autoAdvanceTimer) { clearInterval(autoAdvanceTimer); autoAdvanceTimer = null; }
    chrome.runtime.sendMessage({
      type: 'QUEUE_ADVANCE',
      payload: { markApplied: true, tabId: undefined },
    }, (resp) => {
      if (resp?.done) {
        showQueueCompleteBanner();
        queueMode = null;
        rebuildPanel();
      } else {
        showStatus('⏳ Opening next job…');
      }
    });
  });

  shadowRoot.getElementById('ap-queue-skip')?.addEventListener('click', () => {
    if (autoAdvanceTimer) { clearInterval(autoAdvanceTimer); autoAdvanceTimer = null; }
    chrome.runtime.sendMessage({
      type: 'QUEUE_SKIP',
      payload: { tabId: undefined },
    }, (resp) => {
      if (resp?.done) {
        showQueueCompleteBanner();
        queueMode = null;
        rebuildPanel();
      } else {
        showStatus('⏭ Skipping…');
      }
    });
  });
}

// ── Fill fields ───────────────────────────────────────────────────────────────

async function fillFields() {
  if (!settings) return;
  const statusEl = shadowRoot?.getElementById('ap-status');
  if (statusEl) statusEl.textContent = 'Filling…';

  let filled = 0;
  const errors: string[] = [];

  for (const field of detected) {
   try {
    if (field.type === 'resume') {
      await fillFileInput(field.element as HTMLInputElement);
      filled++;
      continue;
    }

    if (field.type === 'coverLetter') {
      let panelLetter = (shadowRoot?.getElementById('ap-letter-text') as HTMLTextAreaElement)?.value;
      let letter = panelLetter || queueMode?.coverLetter || '';

      // If cover letter is still generating (Thinking…), wait for it
      if (!letter) {
        const btn = shadowRoot?.getElementById('ap-gen-letter') as HTMLButtonElement;
        if (btn?.disabled) {
          console.log('[ApplyPilot] Cover letter still generating — waiting…');
          for (let wait = 0; wait < 30; wait++) {
            await new Promise((r) => setTimeout(r, 1000));
            panelLetter = (shadowRoot?.getElementById('ap-letter-text') as HTMLTextAreaElement)?.value;
            if (panelLetter) { letter = panelLetter; break; }
            if (!btn.disabled) break; // generation finished (success or fail)
          }
        }
      }

      // If this is a file upload and we have a stored default cover letter file, use it directly
      if (!letter && (field.element as HTMLInputElement).type === 'file' && coverLetterDataUrl && settings?.coverLetterFileName) {
        try {
          const arr   = coverLetterDataUrl.split(',');
          const mime  = arr[0].match(/:(.*?);/)?.[1] ?? 'application/pdf';
          const bstr  = atob(arr[1]);
          const bytes = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
          const clFile = new File([new Blob([bytes], { type: mime })], settings.coverLetterFileName, { type: mime, lastModified: Date.now() });
          console.log('[ApplyPilot] Using stored default cover letter file:', settings.coverLetterFileName);
          await smartFileUpload(field.element as HTMLInputElement, clFile);
          filled++;
          continue;
        } catch (err) {
          console.warn('[ApplyPilot] Failed to use stored cover letter:', err);
        }
      }

      // If still no letter and this is a file upload, build a minimal one from resume
      if (!letter && (field.element as HTMLInputElement).type === 'file') {
        const resumeText = settings?.resumeText || '';
        if (resumeText.length > 50) {
          const name    = settings?.profile?.firstName ? `${settings.profile.firstName} ${settings.profile.lastName}`.trim() : 'Applicant';
          const jobTitle = extractPageJobTitle() || 'this position';
          const company  = detectCompanyName() || 'your company';
          letter = `Dear Hiring Manager,\n\nI am writing to express my interest in the ${jobTitle} position at ${company}. Please find my CV attached for your review.\n\nBest regards,\n${name}`;
          console.log('[ApplyPilot] Generated minimal cover letter for file upload');
        }
      }

      if (!letter) continue;

      // CL file upload (some ATSes have a separate "upload cover letter" input)
      if ((field.element as HTMLInputElement).type === 'file') {
        const clInput = field.element as HTMLInputElement;
        const clFile = buildCoverLetterFile(letter);
        await smartFileUpload(clInput, clFile);
        filled++;
      } else {
        // CL textarea / rich-text field
        setNativeValue(field.element, letter);
        filled++;
      }
      continue;
    }

    let value = getValueForField(field.type, settings.profile, field) || field.fillValue || '';
    if (!value) continue;

    // Smart age handling: if field is dateOfBirth but the input expects a number (age), compute age from DOB
    if (field.type === 'dateOfBirth') {
      const inp = field.element as HTMLInputElement;
      const isAgeField = inp.type === 'number' || inp.inputMode === 'numeric' ||
                         /\bage\b/i.test(field.label) || /\bage\b/i.test(inp.name || '');
      if (isAgeField && settings.profile.dateOfBirth) {
        const dob = new Date(settings.profile.dateOfBirth);
        const now = new Date();
        let age = now.getFullYear() - dob.getFullYear();
        if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age--;
        value = String(age);
      }
      // If field expects a select (age range dropdown), try matching ageRange
      if (field.element.tagName === 'SELECT' && settings.profile.ageRange) {
        value = settings.profile.ageRange;
      }
    }

    // Radio group (element is a radio input representing the whole group)
    if ((field.element as HTMLInputElement).type === 'radio') {
      if (fillRadioGroup(field.element as HTMLInputElement, value)) filled++;
      continue;
    }

    // Button-toggle group (Ashby Yes/No pill buttons, etc.)
    if (field.element.tagName === 'BUTTON' ||
        field.element.getAttribute('role') === 'radio' ||
        field.element.getAttribute('role') === 'option') {
      // For location questions, derive Yes/No from profile country/city
      let answer = value;
      if (field.type === 'city') {
        answer = answerLocationQuestion(field.label, settings.profile) || value;
      }
      if (fillButtonGroup(field.element as HTMLElement, answer)) filled++;
      continue;
    }

    if (field.element.tagName === 'SELECT') {
      // EEO fields need special handling — look for "decline" / "prefer not" / "don't wish" options
      if (field.type === 'race' || field.type === 'veteranStatus' || field.type === 'disabilityStatus') {
        fillEEOSelect(field.element as HTMLSelectElement, field.type);
      } else {
        fillSelect(field.element as HTMLSelectElement, value);
      }
    } else {
      // For numeric-only fields, strip non-digit characters (phone: "+49 152..." → "49152...", salary: "75000 EUR" → "75000")
      // Extended to detect SmartRecruiters and other ATS that use pattern/step/min attributes (#49)
      let fillValue = value;
      const inp = field.element as HTMLInputElement;
      const isNumericField = inp.type === 'number' || inp.inputMode === 'numeric' || inp.inputMode === 'decimal'
        || (inp.pattern && /^\[?\\?d/.test(inp.pattern))  // pattern="[0-9]*" or pattern="\d+"
        || (inp.step && inp.step !== 'any')                // step="1" etc. implies numeric
        || (inp.min !== '' && inp.min != null && !isNaN(Number(inp.min)));  // min="0" implies numeric
      if (isNumericField) {
        if (field.type === 'phone') {
          fillValue = value.replace(/[^\d]/g, '');   // digits only for phone number fields
        } else if (field.type === 'salary' || field.type === 'salaryMin' || field.type === 'salaryMax') {
          fillValue = value.replace(/[^\d.]/g, '');  // digits + decimal for salary fields
        } else if (field.type === 'yearsOfExperience') {
          fillValue = value.replace(/[^\d]/g, '');   // digits only
        }
      }
      setNativeValue(field.element, fillValue);
    }
    filled++;
   } catch (err) {
    console.warn(`[ApplyPilot] Failed to fill ${field.type}:`, err);
    errors.push(`${field.type}: ${(err as Error).message}`);
   }
  }

  // Auto-check consent / privacy / agree checkboxes
  autoCheckConsentBoxes();

  // Auto-fill checkbox-group questions (location, start date, salary, how heard)
  autoFillCheckboxGroups();

  // Fill searchable/filterable dropdowns (react-select, select2, combobox)
  filled += await fillSearchableDropdowns();

  const total = detected.length;
  const skipped = total - filled - errors.length;
  const errSuffix = errors.length > 0 ? `, ${errors.length} failed` : '';
  const skipSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
  if (statusEl) statusEl.textContent = `✓ ${filled}/${total} fields filled${errSuffix}${skipSuffix}. Review before submitting!`;

  // Scan for errors 700ms after fill (Workday, iCIMS show async validation)
  setTimeout(() => {
    const errors = scanFormErrors();
    if (errors.length > 0 && statusEl) {
      statusEl.innerHTML = `⚠️ Validation errors detected:<br>${errors.map(escHtml).join('<br>')}`;
      statusEl.style.color = '#EF4444';
    }
  }, 700);

  // Check for multi-step after fill
  const step = detectMultiStep();
  if (step.isMultiStep && step.nextBtn && statusEl) {
    statusEl.innerHTML += ' &nbsp;|&nbsp; 💡 Multi-step form — click Next when ready.';
  }

  // ── Auto-submit in full-auto mode ──────────────────────────────────────────
  // Safety: never auto-submit on Indeed — their forms often pre-select defaults for salary,
  // work-from-office, and privacy that may not reflect user preferences (#56)
  const currentATS = detectATS();
  const isIndeed = currentATS?.key === 'indeed.com' || location.hostname.includes('indeed');
  if (settings?.automationMode === 'full-auto' && isIndeed) {
    console.log('[ApplyPilot] Auto-submit blocked on Indeed — review answers before submitting.');
    if (statusEl) {
      statusEl.innerHTML = `✓ ${filled} fields filled. ⚠️ <strong>Indeed: please review answers and submit manually.</strong>`;
      statusEl.style.color = '#D97706';
    }
  } else if (settings?.automationMode === 'full-auto') {
    // Wait for async validation to settle, then check for errors before submitting
    setTimeout(async () => {
      const errors = scanFormErrors();
      if (errors.length > 0) {
        console.warn('[ApplyPilot] Auto-submit blocked — validation errors:', errors);
        if (statusEl) {
          statusEl.innerHTML = `⚠️ Auto-submit blocked — fix errors first:<br>${errors.map(escHtml).join('<br>')}`;
          statusEl.style.color = '#EF4444';
        }
        return;
      }

      // Handle multi-step: click Next first, then re-detect and re-fill
      if (step.isMultiStep && step.nextBtn) {
        console.log('[ApplyPilot] Multi-step: clicking Next…');
        step.nextBtn.click();
        if (statusEl) statusEl.textContent = '⏳ Multi-step: moving to next page…';
        // After navigation, re-detect and re-fill on the next step
        setTimeout(async () => {
          detected = detectFields();
          // Clear stale cover letter from previous step so it's not carried over
          const letterText = shadowRoot?.getElementById('ap-letter-text') as HTMLTextAreaElement | null;
          if (letterText) letterText.value = '';
          if (detected.length > 0) await fillFields();
        }, 1500);
        return;
      }

      // Find and click the submit button
      const submitBtn = findSubmitButton();
      if (submitBtn) {
        console.log('[ApplyPilot] Auto-submitting…', submitBtn.textContent?.trim());
        if (statusEl) statusEl.textContent = '🚀 Auto-submitting application…';
        await new Promise((r) => setTimeout(r, 300)); // brief pause for UX
        submitBtn.click();

        // Wait and check if submission succeeded, then advance queue
        setTimeout(() => {
          if (statusEl) statusEl.textContent = '✅ Application submitted!';
          // In queue mode, auto-advance after submit
          if (queueMode) {
            setTimeout(() => {
              chrome.runtime.sendMessage({
                type: 'QUEUE_ADVANCE',
                payload: { markApplied: true },
              }, (resp) => {
                if (resp?.done) { showQueueCompleteBanner(); queueMode = null; rebuildPanel(); }
              });
            }, 2000);
          }
        }, 1500);
      } else {
        console.warn('[ApplyPilot] No submit button found for auto-submit.');
        if (statusEl) statusEl.textContent = `✓ Filled ${filled} fields. ⚠️ Could not find Submit button — please submit manually.`;
      }
    }, 1200); // wait for validation
  }
}

function setNativeValue(el: HTMLElement, value: string) {
  const nativeInputSetter    = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
    nativeTextareaSetter.call(el, value);
  } else if (nativeInputSetter) {
    nativeInputSetter.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
}

function fillSelect(sel: HTMLSelectElement, value: string) {
  const lower = value.toLowerCase();
  for (const opt of Array.from(sel.options)) {
    const optLower = opt.textContent?.toLowerCase() ?? '';
    if (optLower.includes(lower) || opt.value.toLowerCase().includes(lower)) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
}

/** Fill EEO dropdown (race, veteran, disability) with safe "decline/prefer not" option. */
function fillEEOSelect(sel: HTMLSelectElement, type: 'race' | 'veteranStatus' | 'disabilityStatus') {
  const opts = Array.from(sel.options);

  // Priority 1: look for "decline" / "prefer not" / "don't wish" / "choose not"
  const declinePatterns = /decline|prefer\s*not|don'?t\s*wish|choose\s*not|rather\s*not|not\s*disclose|no\s*answer/i;
  for (const opt of opts) {
    const text = opt.textContent?.trim() ?? '';
    if (declinePatterns.test(text) && opt.value) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }

  // Priority 2: for specific types, look for matching values
  // Priority 2: match against user's profile value for this field
  const profileValues: Record<string, string> = {
    race:             settings?.profile?.raceEthnicity || '',
    veteranStatus:    settings?.profile?.veteranStatus || '',
    disabilityStatus: settings?.profile?.disabilityStatus || '',
  };
  const profileVal = profileValues[type] || '';
  if (profileVal) {
    for (const opt of opts) {
      const text = (opt.textContent?.trim() ?? '').toLowerCase();
      if (text.includes(profileVal.toLowerCase()) && opt.value) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }

  // Priority 3: type-specific fallback patterns
  if (type === 'veteranStatus') {
    for (const opt of opts) {
      const text = (opt.textContent?.trim() ?? '').toLowerCase();
      if ((/not\s*a\s*(protected\s*)?veteran/i.test(text) || text === 'no') && opt.value) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }

  if (type === 'disabilityStatus') {
    for (const opt of opts) {
      const text = (opt.textContent?.trim() ?? '').toLowerCase();
      if ((/no.*don'?t\s*have/i.test(text) || /don'?t\s*have.*disab/i.test(text) || text === 'no') && opt.value) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }

  // Fallback: pick the last non-placeholder option (often "Prefer not to answer" is last)
  for (let i = opts.length - 1; i >= 1; i--) {
    const text = (opts[i].textContent?.trim() ?? '').toLowerCase();
    if (text && !/^(select|choose|--|please)/i.test(text) && opts[i].value) {
      sel.value = opts[i].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
}

/** Generate a brief generic response for custom textarea questions based on the label. */
function generateTextareaResponse(label: string): string {
  const l = label.toLowerCase();
  const name = settings?.profile?.firstName
    ? `${settings.profile.firstName} ${settings.profile.lastName}`.trim()
    : 'the applicant';
  const experience = settings?.profile?.yearsOfExperience || '5+';
  const skills = settings?.profile?.skills?.slice(0, 5).join(', ') || 'relevant technologies';

  // Location questions — return city, country directly (not a long-form answer)
  if (/where.*(based|located|live)|current.*(location|city)|your.*(location|city)/i.test(l)) {
    const city = (settings?.profile?.city || '').split(',')[0].trim();
    const country = settings?.profile?.country || '';
    return country ? `${city}, ${country}` : city;
  }
  if (/why.*interest|why.*apply|why.*join|why.*company|why.*us|what.*attract/i.test(l)) {
    return `I am excited about this opportunity because the role aligns with my ${experience} years of experience in ${skills}. I am eager to contribute to the team and grow professionally.`;
  }
  if (/motivation|what.*motivat/i.test(l)) {
    return `I am motivated by challenging technical problems and building impactful products. With ${experience} years of experience, I bring a strong foundation in ${skills} and a passion for continuous learning.`;
  }
  if (/strength|what.*bring|qualif|why.*good.*fit|what.*offer/i.test(l)) {
    return `With ${experience} years of professional experience in ${skills}, I bring strong problem-solving skills, a collaborative mindset, and a track record of delivering high-quality software solutions.`;
  }
  if (/salary|compensation|expect/i.test(l)) {
    const min = settings?.profile?.salaryMin || '';
    const max = settings?.profile?.salaryMax || '';
    if (min || max) return `My salary expectation is in the range of ${min}${max ? '-' + max : '+'} ${settings?.profile?.salaryCurrency || 'EUR'} annually, negotiable based on the overall package.`;
    return 'Open to discussion based on the role scope and total compensation package.';
  }
  if (/notice|start.*date|when.*start|avail/i.test(l)) {
    const notice = settings?.profile?.noticePeriod;
    if (notice) return `I can start after my ${notice} ${settings?.profile?.noticePeriodUnit || 'months'} notice period.`;
    return 'Available to start within a reasonable timeframe.';
  }
  if (/additional|anything.*else|comment|note|message/i.test(l)) {
    return `Thank you for considering my application. I look forward to the opportunity to discuss how my experience in ${skills} can contribute to your team.`;
  }
  // Generic fallback
  return `With ${experience} years of experience in ${skills}, I am confident in my ability to contribute effectively to this role. I welcome the opportunity to discuss further.`;
}

/**
 * Fill searchable/filterable dropdowns (react-select, select2, Choices.js, combobox).
 * These have a text input inside a container — type the value, wait for filtered options, click the match.
 */
async function fillSearchableDropdowns(): Promise<number> {
  if (!settings?.profile) return 0;
  let filled = 0;

  // Find combobox-style inputs: [role="combobox"], react-select containers, select2 inputs
  const comboboxes = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="combobox"], [class*="react-select"], [class*="select2"], [class*="searchable-select"], [class*="autocomplete"]'
  ));

  for (const container of comboboxes) {
    // Skip if already has a value selected
    const hasValue = container.querySelector('[class*="singleValue"], [class*="select2-selection__rendered"]:not([title=""])');
    if (hasValue && hasValue.textContent?.trim()) continue;

    // Find the search input inside
    const input = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
    if (!input) continue;

    // Determine what this dropdown is for based on label
    const labelText = getLabel(container).toLowerCase() || getLabel(input).toLowerCase();
    const containerText = (container.getAttribute('aria-label') ?? '').toLowerCase();
    const combined = `${labelText} ${containerText}`;

    let typeValue = '';
    if (/country|where.*located|location/i.test(combined)) {
      typeValue = settings.profile.country || (settings.profile.city || '').split(',')[0].trim();
    } else if (/city|location/i.test(combined)) {
      typeValue = (settings.profile.city || '').split(',')[0].trim();
    } else if (/gender|pronouns/i.test(combined)) {
      typeValue = settings.profile.gender || '';
    } else if (/race|ethnicity/i.test(combined)) {
      typeValue = settings.profile.raceEthnicity || '';
    } else if (/language/i.test(combined)) {
      typeValue = 'English';
    }

    if (!typeValue) continue;

    try {
      // Focus and type to filter
      input.focus();
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      setNativeValue(input, typeValue);

      // Also dispatch keyboard events for React-based selects
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: typeValue, inputType: 'insertText' }));

      // Wait for dropdown options to appear
      await new Promise(r => setTimeout(r, 500));

      // Find and click the first matching option
      const options = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="option"], [class*="option"], [class*="select2-results__option"], [class*="menu"] [class*="option"]'
      ));

      const lower = typeValue.toLowerCase();
      for (const opt of options) {
        const optText = (opt.textContent ?? '').toLowerCase();
        if (optText.includes(lower) && !opt.getAttribute('aria-disabled')) {
          opt.click();
          filled++;
          console.log('[ApplyPilot] Filled searchable dropdown:', combined.trim().slice(0, 60), '→', opt.textContent?.trim());
          break;
        }
      }
    } catch (err) {
      console.warn('[ApplyPilot] Searchable dropdown fill failed:', err);
    }
  }

  return filled;
}

/** Build a File object from the stored resume dataUrl, with text fallback. */
function buildResumeFile(): File | null {
  // Primary: build from binary dataUrl
  if (resumeDataUrl && settings?.resumeFileName) {
    try {
      const arr   = resumeDataUrl.split(',');
      const mime  = arr[0].match(/:(.*?);/)?.[1] ?? 'application/pdf';
      const bstr  = atob(arr[1]);
      const bytes = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
      console.log('[ApplyPilot] Built resume file from dataUrl:', settings.resumeFileName, '| size:', bytes.length);
      return new File([new Blob([bytes], { type: mime })], settings.resumeFileName, { type: mime, lastModified: Date.now() });
    } catch (err) {
      console.warn('[ApplyPilot] Failed to build resume from dataUrl:', err);
    }
  }

  // Fallback: build a minimal PDF from resumeText (when dataUrl is missing/corrupted)
  // Using PDF format instead of .txt so dropzones that restrict to PDF/DOCX won't reject it.
  if (settings?.resumeText && settings.resumeText.length > 50) {
    console.log('[ApplyPilot] Using resumeText fallback — building PDF from text (' + settings.resumeText.length + ' chars)');
    try {
      const pdfBytes = buildMinimalPdf(settings.resumeText);
      const name = (settings.resumeFileName || 'resume').replace(/\.[^.]+$/, '') + '.pdf';
      return new File([pdfBytes], name, { type: 'application/pdf', lastModified: Date.now() });
    } catch (err) {
      console.warn('[ApplyPilot] PDF generation failed, falling back to .txt:', err);
      const blob = new Blob([settings.resumeText], { type: 'text/plain' });
      const name = (settings.resumeFileName || 'resume').replace(/\.[^.]+$/, '') + '.txt';
      return new File([blob], name, { type: 'text/plain', lastModified: Date.now() });
    }
  }

  return null;
}

/**
 * Build a cover letter File with a personalised filename:
 *   "{FirstName} {LastName} - Cover Letter - {Company}.pdf"
 * Falls back to generic name if profile/company info is unavailable.
 */
function buildCoverLetterFile(text: string): File {
  const firstName = settings?.profile?.firstName || '';
  const lastName  = settings?.profile?.lastName  || '';
  const namePart  = (firstName + ' ' + lastName).trim() || 'Cover_Letter';

  // Try to extract company name from the page (ATS pages usually have it)
  const company = detectCompanyName();
  const fileName = company
    ? `${namePart} - Cover Letter - ${company}.pdf`
    : `${namePart} - Cover Letter.pdf`;

  // Sanitise for filesystem safety
  const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');

  try {
    const pdfBytes = buildMinimalPdf(text);
    return new File([pdfBytes], safeName, { type: 'application/pdf', lastModified: Date.now() });
  } catch (err) {
    console.warn('[ApplyPilot] Minimal PDF generation failed, falling back to .txt:', err);
    const blob = new Blob([text], { type: 'text/plain' });
    return new File([blob], safeName.replace(/\.pdf$/, '.txt'), { type: 'text/plain', lastModified: Date.now() });
  }
}

/** Try to extract the company name from the current page. */
function detectCompanyName(): string {
  // 1. Ashby: company name in the header / logo area
  const ashbyCompany = document.querySelector<HTMLElement>(
    '[class*="CompanyName"], [class*="companyName"], [data-testid="company-name"]'
  );
  if (ashbyCompany?.textContent?.trim()) return ashbyCompany.textContent.trim();

  // 2. Greenhouse: company name in the page title or header
  const ghCompany = document.querySelector<HTMLElement>('.company-name, #company-name');
  if (ghCompany?.textContent?.trim()) return ghCompany.textContent.trim();

  // 3. Generic: parse from <title> — many ATS pages use "Role at Company" or "Company - Role"
  const title = document.title || '';
  const atMatch = title.match(/\bat\s+(.+?)(?:\s*[-–|]|$)/i);
  if (atMatch?.[1]?.trim()) return atMatch[1].trim().replace(/\s*[-–|].*/,'');

  const dashMatch = title.match(/^(.+?)\s*[-–|]\s*.+/);
  if (dashMatch?.[1]?.trim() && dashMatch[1].trim().length < 40) return dashMatch[1].trim();

  // 4. OG meta tag
  const ogSite = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]');
  if (ogSite?.content?.trim()) return ogSite.content.trim();

  return '';
}

/**
 * Generate a minimal valid PDF 1.4 document from plain text.
 * No external libraries — hand-rolled PDF structure.
 * Supports line wrapping and basic pagination.
 */
function buildMinimalPdf(text: string): Uint8Array {
  const PAGE_W  = 595;   // A4 width in points
  const PAGE_H  = 842;   // A4 height in points
  const MARGIN  = 72;    // 1 inch margins
  const FONT_SZ = 11;
  const LEADING = 14;    // line spacing in points
  const MAX_X   = PAGE_W - 2 * MARGIN;
  const CHARS_PER_LINE = Math.floor(MAX_X / (FONT_SZ * 0.5)); // approx for Helvetica

  // Escape PDF special chars in text strings
  function esc(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  // Word-wrap text into lines
  const rawLines = text.split('\n');
  const lines: string[] = [];
  for (const raw of rawLines) {
    if (raw.length <= CHARS_PER_LINE) {
      lines.push(raw);
    } else {
      const words = raw.split(' ');
      let cur = '';
      for (const w of words) {
        if (cur.length + w.length + 1 > CHARS_PER_LINE) {
          lines.push(cur);
          cur = w;
        } else {
          cur = cur ? cur + ' ' + w : w;
        }
      }
      if (cur) lines.push(cur);
    }
  }

  // Split lines into pages
  const linesPerPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push(['']);

  // Build PDF objects
  const objects: string[] = [];
  const offsets: number[] = [];
  let body = '';

  function addObj(content: string): number {
    const num = objects.length + 1;
    objects.push(content);
    return num;
  }

  // Obj 1: Catalog
  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Obj 2: Pages (placeholder — we'll fill Kids after creating page objects)
  addObj(''); // placeholder

  // Obj 3: Font
  addObj('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  // Create page objects
  const pageObjNums: number[] = [];
  for (const pageLines of pages) {
    // Content stream
    let stream = `BT\n/F1 ${FONT_SZ} Tf\n${MARGIN} ${PAGE_H - MARGIN} Td\n`;
    for (const line of pageLines) {
      stream += `(${esc(line)}) Tj\n0 -${LEADING} Td\n`;
    }
    stream += 'ET\n';
    const streamObj = addObj('');
    objects[streamObj - 1] = `${streamObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`;

    const pageObj = addObj('');
    objects[pageObj - 1] = `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${streamObj} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`;
    pageObjNums.push(pageObj);
  }

  // Fill in Pages object
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects[1] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>\nendobj\n`;

  // Assemble
  body = '%PDF-1.4\n';
  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += objects[i];
  }

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  body += xref;

  // Convert to bytes
  const encoder = new TextEncoder();
  return encoder.encode(body);
}

/**
 * Walk up from a file input to find the dropzone root element.
 *
 * Priority:
 *  1. tabindex="0" on an ancestor with decent bounding rect  ← react-dropzone always sets this
 *  2. Known class / data-testid / role="button" markers
 *  3. Ancestor whose OWN text nodes contain drag/drop/browse language (join.com)
 *  4. First ancestor larger than 150×40px (last resort)
 */
function findDropzoneContainer(input: HTMLInputElement): HTMLElement | null {
  let el: HTMLElement | null = input.parentElement;
  let fallback: HTMLElement | null = null;

  for (let i = 0; i < 12 && el; i++) {
    const cls    = (el.className ?? '').toLowerCase();
    const testId = (el.getAttribute('data-testid') ?? '').toLowerCase();
    const role   = (el.getAttribute('role') ?? '').toLowerCase();
    const rect   = el.getBoundingClientRect();

    // 1. react-dropzone root always has tabindex (default 0)
    //    Make sure it has meaningful size so we don't grab a tiny wrapper div
    if (el.hasAttribute('tabindex') && rect.width > 80 && rect.height > 30) {
      return el;
    }

    // 2. Explicit class / testid / role signals
    if (/drop|upload|file[\s-]?area|file[\s-]?picker/i.test(cls) ||
        /upload|drop/i.test(testId) ||
        role === 'button') {
      return el;
    }

    // 3. Own text nodes (not inherited from deep children) mention drag/drop/browse
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE ||
        (n.nodeType === Node.ELEMENT_NODE && !(n as Element).querySelector('input,button')))
      .map((n) => n.textContent ?? '')
      .join(' ')
      .toLowerCase();

    if (/drag.+drop|drag.+here|drop.+here|click.+upload|upload.+file|browse/i.test(ownText) &&
        rect.width > 80) {
      return el;
    }

    // Track first big ancestor as last-resort fallback
    if (!fallback && rect.width > 150 && rect.height > 40) {
      fallback = el;
    }

    el = el.parentElement;
  }

  return fallback ?? input.parentElement;
}

/** Assign a File to a file input AND dispatch a drop event on its dropzone parent. */
/**
 * Check if a file upload was accepted by the UI
 * (dropzone shows filename, or input.files has entries).
 */
function isFileAccepted(input: HTMLInputElement, file: File): boolean {
  if (input.files && input.files.length > 0) return true;
  const dropzone = findDropzoneContainer(input);
  if (!dropzone) return false;
  const nameSlug = file.name.toLowerCase().replace(/\.[^.]+$/, '');
  const areaText = (dropzone.textContent ?? '').toLowerCase();
  return areaText.includes(nameSlug);
}

/**
 * Inject a file into a single input via content-script realm.
 * Does NOT fire drop events — that's a separate step.
 */
function injectFileContentScript(input: HTMLInputElement, file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
  if (nativeSetter) nativeSetter.call(input, dt.files);

  try {
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
  } catch { /* ignore */ }

  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Fire a drag+drop sequence on the dropzone container.
 */
async function fireDropOnZone(input: HTMLInputElement, file: File): Promise<void> {
  const dropzone = findDropzoneContainer(input);
  if (!dropzone) return;

  const dt = new DataTransfer();
  dt.items.add(file);

  const mkEvt = (name: string) =>
    new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: dt });

  dropzone.dispatchEvent(mkEvt('dragenter'));
  await new Promise((r) => setTimeout(r, 50));
  dropzone.dispatchEvent(mkEvt('dragover'));
  await new Promise((r) => setTimeout(r, 50));
  dropzone.dispatchEvent(mkEvt('drop'));
}

/**
 * Smart file upload — tries each injection strategy in order, stops at first success.
 *
 * Strategy order:
 *  1. Content-script direct input injection  (works on non-React forms)
 *  2. Content-script dropzone drop events    (works on some dropzone implementations)
 *  3. Main-world injection via background    (works on React/dropzone sites)
 */
async function smartFileUpload(input: HTMLInputElement, file: File): Promise<void> {
  // Strategy 1: direct content-script injection
  injectFileContentScript(input, file);
  await new Promise((r) => setTimeout(r, 300));
  if (isFileAccepted(input, file)) {
    console.log('[ApplyPilot] File accepted via content-script injection');
    return;
  }

  // Strategy 2: drop events on the dropzone container
  await fireDropOnZone(input, file);
  await new Promise((r) => setTimeout(r, 400));
  if (isFileAccepted(input, file)) {
    console.log('[ApplyPilot] File accepted via dropzone drop events');
    return;
  }

  // Strategy 3: main-world injection (React realm)
  try {
    await applyFileViaPageContext(input, file);
    await new Promise((r) => setTimeout(r, 500));
    if (isFileAccepted(input, file)) {
      console.log('[ApplyPilot] File accepted via main-world injection');
      return;
    }
  } catch (err) {
    console.warn('[ApplyPilot] Main-world injection failed:', err);
  }

  console.log('[ApplyPilot] File upload attempted all strategies for:', file.name);
}

async function fillFileInput(input: HTMLInputElement) {
  console.log('[ApplyPilot] fillFileInput called — resumeDataUrl length:', resumeDataUrl.length,
    '| resumeFileName:', settings?.resumeFileName || '(empty)');

  // If resumeDataUrl wasn't loaded at boot, try one more time (race condition safety)
  if (!resumeDataUrl) {
    console.log('[ApplyPilot] resumeDataUrl empty — re-reading from storage…');
    const freshResume = await getResume();
    if (freshResume?.dataUrl) {
      resumeDataUrl = freshResume.dataUrl;
      console.log('[ApplyPilot] Re-read succeeded — resumeDataUrl length:', resumeDataUrl.length);
    }
    if (!settings?.resumeFileName) {
      settings = await getSettings();
    }
  }

  const hasDataUrl  = resumeDataUrl.length > 0;
  const hasText     = (settings?.resumeText ?? '').length > 50;
  const hasFileName = !!(settings?.resumeFileName);

  if (!hasDataUrl && !hasText && !hasFileName) {
    console.warn('[ApplyPilot] No resume data at all — upload your CV in Settings first.');
    showToast('⚠️ No resume uploaded — go to Settings → Resume to add your CV.', 'warn');
    return;
  }
  console.log('[ApplyPilot] Resume state: dataUrl=' + hasDataUrl + ' text=' + hasText + ' fileName=' + hasFileName);
  const file = buildResumeFile();
  if (!file) { console.warn('[ApplyPilot] Could not build resume file.'); return; }

  await smartFileUpload(input, file);
  console.log(`[ApplyPilot] Resume injection complete: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
}

// ── Page-context file injection (bypasses content-script isolated world) ─────
//
// DataTransfer / File / DragEvent objects created in a content script are from
// a different JS realm than the page's React runtime.  React's synthetic event
// system rejects them silently.
//
// Fix: use chrome.scripting.executeScript({ world: 'MAIN' }) — a first-class
// MV3 API that injects directly into the page's JS realm.  File data is passed
// via the `args` parameter (no sessionStorage bridge, no <script> tag hack).
// The background service worker handles the chrome.scripting call; the content
// script sends a message with the file's dataUrl.

async function applyFileViaPageContext(
  input: HTMLInputElement,
  file: File,
): Promise<void> {
  // Read file data into a dataUrl
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  // Find the index of the target input among all file inputs on the page,
  // so the main-world script only injects into the correct one.
  const allFileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const inputIndex    = allFileInputs.indexOf(input);

  // Send to background — it calls chrome.scripting.executeScript({ world: 'MAIN' })
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'INJECT_FILE_MAIN_WORLD',
        payload: { name: file.name, ftype: file.type, dataUrl, inputIndex },
      },
      () => resolve(),
    );
  });
}

// ── Button-toggle group detection (Ashby "Yes/No" pill buttons, etc.) ─────────

interface ButtonGroup {
  question: string;
  buttons:  HTMLElement[];
}

function collectButtonGroups(): ButtonGroup[] {
  const seen  = new Set<HTMLElement>();
  const found: ButtonGroup[] = [];

  // Approach 1: [role="group"] / [role="radiogroup"] containing short buttons
  document.querySelectorAll<HTMLElement>('[role="group"],[role="radiogroup"],fieldset').forEach((container) => {
    const btns = Array.from(container.querySelectorAll<HTMLElement>('button,[role="radio"],[role="option"]'))
      .filter((b) => (b.textContent?.trim().length ?? 0) < 60 && !seen.has(b));
    if (btns.length >= 2 && btns.length <= 8) {
      const q = container.getAttribute('aria-label')
        ?? container.querySelector('legend')?.textContent?.trim()
        ?? '';
      found.push({ question: q, buttons: btns });
      btns.forEach((b) => seen.add(b));
    }
  });

  // Approach 2: label/heading immediately followed by a sibling with short buttons
  document.querySelectorAll<HTMLElement>('label,p,[class*="label"],[class*="question"],[class*="Label"],[class*="Question"]').forEach((label) => {
    if (label.querySelector('input,select,textarea,button')) return;
    const q = label.textContent?.trim() ?? '';
    if (q.length < 8 || q.length > 250) return;

    let sib: Element | null = label.nextElementSibling;
    for (let i = 0; i < 4 && sib; i++) {
      const btns = Array.from(sib.querySelectorAll<HTMLElement>('button,[role="button"]'))
        .filter((b) => (b.textContent?.trim().length ?? 0) < 40 && !seen.has(b));
      if (btns.length >= 2 && btns.length <= 8) {
        found.push({ question: q, buttons: btns });
        btns.forEach((b) => seen.add(b));
        break;
      }
      sib = sib.nextElementSibling;
    }
  });

  return found;
}

function detectButtonGroups(): DetectedField[] {
  const groups  = collectButtonGroups();
  const results: DetectedField[] = [];

  for (const { question, buttons } of groups) {
    const q = question.toLowerCase();
    if (/how.+find|where.+hear|referr(al)?|source|channel/i.test(q)) continue;

    let type: FieldType = 'unknown';
    let confidence = 0;

    if (/where.+locat|currently.+locat|are you based|which.+(city|office|country)|locat.+in/i.test(q) ||
        // "Are you currently located in Germany, Spain, Portugal or the UK?"
        /located in .*(germany|uk|spain|france|portugal|austria|netherlands|europe)/i.test(q)) {
      type = 'city'; confidence = 0.88;
    } else if (/authoriz|authoris|right to work|work permit|eligible|legally.+work/i.test(q)) {
      type = 'workAuthorization'; confidence = 0.90;
    } else if (/visa.+sponsor|require.*sponsor|need.*visa/i.test(q)) {
      type = 'visaSponsorship'; confidence = 0.90;
    } else if (/relocat/i.test(q)) {
      type = 'relocation'; confidence = 0.85;
    } else if (/remote|hybrid|onsite|work.+mode|work.+arrang/i.test(q)) {
      type = 'workMode'; confidence = 0.80;
    } else if (/\bgender\b|pronouns?/i.test(q)) {
      type = 'gender'; confidence = 0.88;
    } else if (/race\b|ethnicity|ethnic/i.test(q)) {
      type = 'race'; confidence = 0.88;
    } else if (/veteran/i.test(q)) {
      type = 'veteranStatus'; confidence = 0.88;
    } else if (/disability|disab/i.test(q)) {
      type = 'disabilityStatus'; confidence = 0.88;
    }

    if (type === 'unknown') continue;
    results.push({
      type,
      element:   buttons[0],
      inputType: 'input',
      label:     question,
      confidence,
    });
  }
  return results;
}

function fillButtonGroup(firstBtn: HTMLElement, value: string): boolean {
  if (!value) return false;
  // Find sibling buttons in the same container
  const container = firstBtn.closest('[role="group"],[role="radiogroup"],fieldset') ??
                    firstBtn.parentElement;
  const allBtns = container
    ? Array.from(container.querySelectorAll<HTMLElement>('button,[role="radio"],[role="option"]'))
    : [firstBtn];

  const vLow = value.toLowerCase().trim();
  let best: HTMLElement | null = null;
  let bestScore = 0;

  for (const btn of allBtns) {
    const label = (btn.textContent?.trim() ?? '').toLowerCase();
    let score = 0;
    if (label === vLow)                   score = 100;
    else if (label.includes(vLow))        score = 70;
    else if (vLow.includes(label) && label.length > 1) score = 60;
    if (/^yes$/i.test(vLow) && /^yes|^ja|true/i.test(label))  score = Math.max(score, 95);
    if (/^no$/i.test(vLow)  && /^no|^nein|false/i.test(label)) score = Math.max(score, 95);
    if (score > bestScore) { bestScore = score; best = btn; }
  }

  if (best && bestScore >= 10) {
    best.click();
    best.dispatchEvent(new MouseEvent('click',  { bubbles: true, cancelable: true }));
    best.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

// Answer location-country questions from the profile (no Haiku needed for clear cases)
function answerLocationQuestion(questionText: string, profile: UserProfile): string {
  const q = questionText.toLowerCase();
  // Extract countries / regions mentioned in the question
  const COUNTRY_KEYWORDS: Record<string, string[]> = {
    germany:     ['germany','deutschland','berlin','munich','hamburg','frankfurt','cologne'],
    spain:       ['spain','españa','madrid','barcelona'],
    portugal:    ['portugal','lisbon','porto'],
    uk:          ['uk','united kingdom','england','london','britain'],
    france:      ['france','paris'],
    austria:     ['austria','vienna','österreich'],
    netherlands: ['netherlands','amsterdam','holland'],
    europe:      ['europe','eu'],
  };
  const mentionedRegions = Object.keys(COUNTRY_KEYWORDS).filter((r) => q.includes(r));
  if (mentionedRegions.length === 0) return '';

  const profileLoc = `${profile.country ?? ''} ${profile.city ?? ''}`.toLowerCase();
  const match = mentionedRegions.some((region) =>
    COUNTRY_KEYWORDS[region].some((kw) => profileLoc.includes(kw)),
  );
  return match ? 'Yes' : 'No';
}

// ── Consent / Privacy / Agreement auto-check ─────────────────────────────────

function autoCheckConsentBoxes() {
  const CONSENT_RE = /i agree|confirm|consent|privacy|terms|gdpr|dsgvo|datenschutz|accept|acknowledge|einwillig/i;

  // 1. Native checkboxes
  const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  for (const cb of checkboxes) {
    if (cb.checked) continue;
    const labelText = getLabel(cb).toLowerCase();
    const name      = cb.name?.toLowerCase() ?? '';
    const id        = cb.id?.toLowerCase() ?? '';
    const combined  = `${labelText} ${name} ${id}`;
    if (CONSENT_RE.test(combined)) {
      console.log('[ApplyPilot] Auto-checking consent checkbox:', combined.trim().slice(0, 80));
      // Just click — it toggles from unchecked→checked and fires React's onChange
      cb.click();
      // Ensure it's actually checked after the click (some frameworks need this)
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  // 2. Native radio buttons — look for "Confirm" / "Yes" radio in consent-related groups
  const allRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  for (const radio of allRadios) {
    if (radio.checked) continue;
    const groupLabel = getRadioGroupLabel(radio).toLowerCase();
    const optionLabel = getRadioOptionLabel(radio).toLowerCase().trim();
    // Only check if the group label mentions privacy/consent AND the option says Confirm/Yes
    if (CONSENT_RE.test(groupLabel) && /^(confirm|yes|ja|accept|agree)$/i.test(optionLabel)) {
      console.log('[ApplyPilot] Auto-selecting consent radio:', groupLabel.trim().slice(0, 60), '→', optionLabel);
      radio.click();  // click handles both checked state and React event propagation
      if (!radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // 3. Button-style toggles (Ashby uses [role="radio"] or plain <button> for Yes/No/Confirm)
  const consentContainers = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="group"], [role="radiogroup"], fieldset'
  ));
  for (const container of consentContainers) {
    const groupText = (container.getAttribute('aria-label') ?? container.textContent ?? '').toLowerCase();
    if (!CONSENT_RE.test(groupText)) continue;

    // Look for Confirm/Yes button that isn't already selected
    const btns = Array.from(container.querySelectorAll<HTMLElement>('button, [role="radio"], [role="option"]'));
    for (const btn of btns) {
      const btnText = (btn.textContent ?? '').trim().toLowerCase();
      const isSelected = btn.getAttribute('aria-checked') === 'true' ||
                         btn.classList.contains('active') ||
                         btn.classList.contains('selected') ||
                         btn.getAttribute('data-state') === 'checked';
      if (isSelected) continue;
      if (/^(confirm|yes|ja|accept|agree)$/i.test(btnText)) {
        console.log('[ApplyPilot] Auto-clicking consent button:', btnText, 'in group:', groupText.trim().slice(0, 60));
        btn.click();
      }
    }
  }

  // 4. Standalone consent-like buttons not inside a role=group (e.g. Ashby inline "Confirm" / "Yes")
  //    Search for buttons whose NEARBY label/heading mentions privacy/consent
  const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="radio"], [role="option"]'));
  for (const btn of allButtons) {
    const btnText = (btn.textContent ?? '').trim();
    if (!/^(Confirm|Yes|Ja)$/i.test(btnText)) continue;
    // Already handled by approach 3?
    if (btn.closest('[role="group"], [role="radiogroup"], fieldset')) continue;
    // Check if a nearby sibling/parent label mentions consent
    const parent = btn.parentElement;
    const grandparent = parent?.parentElement;
    const context = (parent?.textContent ?? '') + ' ' + (grandparent?.textContent ?? '');
    if (CONSENT_RE.test(context.toLowerCase())) {
      const isSelected = btn.getAttribute('aria-checked') === 'true' ||
                         btn.classList.contains('active') ||
                         btn.classList.contains('selected');
      if (!isSelected) {
        console.log('[ApplyPilot] Auto-clicking standalone consent button:', btnText);
        btn.click();
      }
    }
  }

  // 5. Consent/privacy <select> dropdowns — auto-select first non-default option
  //    (handles cases like "Acknowledge" being the only real option)
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  for (const sel of selects) {
    if (sel.value && sel.selectedIndex > 0) continue; // already has a selection
    const labelText = getLabel(sel).toLowerCase();
    const name      = sel.name?.toLowerCase() ?? '';
    const combined  = `${labelText} ${name}`;
    if (!CONSENT_RE.test(combined)) continue;

    // Find the first non-empty, non-placeholder option
    for (const opt of Array.from(sel.options)) {
      const text = opt.textContent?.trim() ?? '';
      if (text && !/^(select|choose|--|please)/i.test(text) && opt.value) {
        console.log('[ApplyPilot] Auto-selecting consent dropdown:', combined.trim().slice(0, 60), '→', text);
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  }

  // 6. Uncheck "Follow [Company]" checkboxes (LinkedIn Easy Apply, etc.)
  for (const cb of checkboxes) {
    if (!cb.checked) continue;
    const labelText = getLabel(cb).toLowerCase();
    const name      = cb.name?.toLowerCase() ?? '';
    const combined  = `${labelText} ${name}`;
    if (/follow\s+(this\s+)?company|follow\s+\w+\s+to/i.test(combined) || /^follow-company/i.test(name)) {
      console.log('[ApplyPilot] Unchecking Follow checkbox:', combined.trim().slice(0, 80));
      cb.click();
      if (cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
}

/**
 * Auto-fill checkbox-group questions (where each option is a checkbox).
 * Handles: location/city, earliest start date, salary expectations, "how did you hear".
 */
function autoFillCheckboxGroups() {
  if (!settings?.profile) return;
  const profile = settings.profile;

  // Collect checkbox groups: sets of checkboxes that share a common question/container
  const groups = collectCheckboxGroups();
  console.log('[ApplyPilot] Found', groups.length, 'checkbox groups');

  for (const group of groups) {
    const q = group.question.toLowerCase();
    const opts = group.options;

    // Skip consent groups — handled by autoCheckConsentBoxes
    if (/i agree|consent|privacy|terms|gdpr|dsgvo|datenschutz|accept|acknowledge/i.test(q)) continue;

    // ── Location / city ──────────────────────────────────────────────────
    if (/where.*(based|located|live)|location|city|office|standort/i.test(q)) {
      const userCity    = (profile.city || '').toLowerCase();
      const userCountry = (profile.country || '').toLowerCase();
      if (!userCity && !userCountry) continue;
      for (const opt of opts) {
        const optText = opt.label.toLowerCase();
        if (userCity && optText.includes(userCity)) {
          clickCheckbox(opt.checkbox, opt.label, q);
        } else if (userCountry && optText.includes(userCountry)) {
          clickCheckbox(opt.checkbox, opt.label, q);
        }
      }
      continue;
    }

    // ── Earliest starting date / availability ────────────────────────────
    if (/earliest.*(start|date|joining|available)|start.*date|availab|notice|when.*start|beginn/i.test(q)) {
      const notice   = profile.noticePeriod || '';
      const unit     = profile.noticePeriodUnit || 'months';
      // Derive months from notice period
      let noticeMonths = 0;
      if (notice) {
        const n = parseInt(notice, 10);
        if (!isNaN(n)) noticeMonths = unit === 'weeks' ? Math.ceil(n / 4) : n;
      }

      // Find the best matching option
      let bestOpt: typeof opts[0] | null = null;
      for (const opt of opts) {
        const t = opt.label.toLowerCase();
        if (noticeMonths === 0 && /immediate|sofort|asap|right away/i.test(t)) {
          bestOpt = opt; break;
        }
        if (noticeMonths <= 1 && /within 1 month|1 month or less|innerhalb.*monat/i.test(t)) {
          bestOpt = opt; break;
        }
        if (noticeMonths <= 3 && /1\s*[-–]\s*3 month|within 3|1 to 3/i.test(t)) {
          bestOpt = opt; break;
        }
        if (noticeMonths > 3 && /over 3|more than 3|über 3|3\+/i.test(t)) {
          bestOpt = opt; break;
        }
      }
      if (bestOpt) clickCheckbox(bestOpt.checkbox, bestOpt.label, q);
      continue;
    }

    // ── Salary expectations ──────────────────────────────────────────────
    if (/salary|compensation|gehalt|vergütung|pay.*expect/i.test(q)) {
      const salMin = parseInt(profile.salaryMin || '0', 10);
      const salMax = parseInt(profile.salaryMax || '0', 10);
      const target = salMax || salMin;
      if (!target) continue;

      // Parse ranges like "80 000 - 100 000", "Up to 60 000", "Above 130 000"
      let bestOpt: typeof opts[0] | null = null;
      for (const opt of opts) {
        const t = opt.label.replace(/[,.\s]/g, '');
        // "Up to X" or "Under X"
        const upTo = t.match(/upto(\d+)|under(\d+)|bis(\d+)/i);
        if (upTo) {
          const cap = parseInt(upTo[1] || upTo[2] || upTo[3], 10);
          if (target <= cap) { bestOpt = opt; break; }
          continue;
        }
        // "Above X" or "Over X"
        const above = t.match(/above(\d+)|over(\d+)|ab(\d+)|mehr.*?(\d+)/i);
        if (above) {
          const floor = parseInt(above[1] || above[2] || above[3] || above[4], 10);
          if (target >= floor) { bestOpt = opt; break; }
          continue;
        }
        // "X - Y" range
        const range = t.match(/(\d+)\D+(\d+)/);
        if (range) {
          const lo = parseInt(range[1], 10);
          const hi = parseInt(range[2], 10);
          if (target >= lo && target <= hi) { bestOpt = opt; break; }
        }
      }
      if (bestOpt) clickCheckbox(bestOpt.checkbox, bestOpt.label, q);
      continue;
    }

    // ── How did you hear about us? ───────────────────────────────────────
    if (/how.*hear|how.*find|where.*find|how.*learn|wie.*erfahren|quelle/i.test(q)) {
      // Prefer "Job post" / "Job board", then "LinkedIn" / "Social media"
      const preference = [
        /job\s*post|job\s*board|stellenanzeige|stellenbörse/i,
        /linkedin|social\s*media/i,
        /website|career/i,
        /online|internet|search/i,
      ];
      for (const re of preference) {
        const match = opts.find((o) => re.test(o.label));
        if (match) {
          clickCheckbox(match.checkbox, match.label, q);
          break;
        }
      }
      continue;
    }

    // ── Work permit / authorization ──────────────────────────────────────
    if (/work\s*permit|work\s*auth|right\s*to\s*work|legally\s*authorized|arbeitserlaubnis|aufenthaltstitel/i.test(q)) {
      const wpt = (profile.workPermitType || '').toLowerCase();
      let matched = false;
      if (wpt) {
        for (const opt of opts) {
          const t = opt.label.toLowerCase();
          if (wpt === 'eu_citizen' && /eu\s*citizen/i.test(t)) { clickCheckbox(opt.checkbox, opt.label, q); matched = true; break; }
          if ((wpt === 'german_pr' || wpt === 'blue_card' || wpt === 'work_permit') &&
              /german\s*work|residence\s*permit|blue\s*card|aufenthalts|niederlass/i.test(t)) { clickCheckbox(opt.checkbox, opt.label, q); matched = true; break; }
          if (wpt === 'job_seeking_visa' && /job\s*seek/i.test(t)) { clickCheckbox(opt.checkbox, opt.label, q); matched = true; break; }
          if (wpt === 'need_sponsorship' && /need\s*support|need\s*sponsor|benötige/i.test(t)) { clickCheckbox(opt.checkbox, opt.label, q); matched = true; break; }
        }
      }
      // Fallback to Yes if germanPR or noVisaSponsorship is set
      if (!matched && (profile.germanPR || profile.noVisaSponsorship)) {
        const yesOpt = opts.find((o) => /^(yes|ja)$/i.test(o.label.trim()));
        if (yesOpt) clickCheckbox(yesOpt.checkbox, yesOpt.label, q);
      }
      continue;
    }

    // ── Preferred working setup / work mode ──────────────────────────────
    if (/preferred\s*work(ing)?\s*(setup|mode|arrangement|model)|work\s*model|arbeitsmodell|how.*want.*work/i.test(q)) {
      const pref = (profile.workModePreference || '').toLowerCase();
      const city = (profile.city || '').toLowerCase();
      const reloc = profile.relocationPreference;
      for (const opt of opts) {
        const t = opt.label.toLowerCase();
        if (pref === 'remote' && /fully\s*remote|remote.*current|remote.*location|vollständig\s*remote/i.test(t)) {
          clickCheckbox(opt.checkbox, opt.label, q); break;
        }
        if (pref === 'hybrid' || pref === 'onsite' || pref === 'flexible') {
          // Check if option mentions user's city
          if (city && t.includes(city)) { clickCheckbox(opt.checkbox, opt.label, q); break; }
          // Or "In Germany" if user is in Germany
          if (/in\s*germany|in\s*deutschland/i.test(t) && !t.includes('not')) { clickCheckbox(opt.checkbox, opt.label, q); break; }
          // Or relocation option if user is open to it
          if (reloc && /relocation|umzug/i.test(t)) { clickCheckbox(opt.checkbox, opt.label, q); break; }
        }
      }
      continue;
    }

    // ── Gender identity ──────────────────────────────────────────────────
    if (/gender|geschlecht/i.test(q)) {
      const g = (profile.gender || '').toLowerCase();
      if (!g) continue;
      const genderMap: Record<string, RegExp> = {
        'man':                /^man$|^male$|^männlich$/i,
        'woman':              /^woman$|^female$|^weiblich$/i,
        'non-binary':         /non[\s-]*binary|nicht[\s-]*binär/i,
        'other':              /^other$|^andere$/i,
        'prefer_not_to_say':  /choose\s*not|prefer\s*not|keine\s*angabe/i,
      };
      const re = genderMap[g];
      if (re) {
        const match = opts.find((o) => re.test(o.label.trim()));
        if (match) clickCheckbox(match.checkbox, match.label, q);
      }
      continue;
    }

    // ── Age range ────────────────────────────────────────────────────────
    if (/age\s*range|age\s*group|alter|altersgruppe/i.test(q)) {
      const ar = (profile.ageRange || '').toLowerCase();
      if (!ar) continue;
      if (ar === 'prefer_not_to_say') {
        const match = opts.find((o) => /choose\s*not|prefer\s*not|keine\s*angabe/i.test(o.label));
        if (match) clickCheckbox(match.checkbox, match.label, q);
      } else {
        // ar is like "30s" — match "30's" or "30s"
        const decade = ar.replace('s', '');
        const match = opts.find((o) => o.label.includes(decade + "'s") || o.label.includes(decade + "s") || o.label.includes(decade + "er"));
        if (match) clickCheckbox(match.checkbox, match.label, q);
      }
      continue;
    }

    // ── Preferred work location ──────────────────────────────────────────
    if (/preferred\s*work\s*location|bevorzugter?\s*arbeitsort|work\s*location/i.test(q)) {
      const city = (profile.city || '').toLowerCase();
      const country = (profile.country || '').toLowerCase();
      const locs = (profile.targetLocations || []).map((l) => l.toLowerCase());
      for (const opt of opts) {
        const t = opt.label.toLowerCase();
        if (city && t.includes(city)) { clickCheckbox(opt.checkbox, opt.label, q); continue; }
        if (country && t.includes(country)) { clickCheckbox(opt.checkbox, opt.label, q); continue; }
        for (const loc of locs) {
          if (t.includes(loc) || loc.includes(t.replace(/[^a-z]/g, ''))) { clickCheckbox(opt.checkbox, opt.label, q); break; }
        }
      }
      continue;
    }
  }
}

function clickCheckbox(cb: HTMLInputElement, label: string, question: string) {
  if (cb.checked) return;
  console.log('[ApplyPilot] Auto-checking:', label, 'for question:', question.trim().slice(0, 60));
  cb.click();
  if (!cb.checked) {
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    cb.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * Collect checkbox groups by walking upward from each checkbox to find its
 * question container (fieldset, labeled div, etc.).
 */
function collectCheckboxGroups(): Array<{
  question: string;
  options: Array<{ checkbox: HTMLInputElement; label: string }>;
}> {
  const allCheckboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const grouped = new Map<HTMLElement, Array<{ checkbox: HTMLInputElement; label: string }>>();

  for (const cb of allCheckboxes) {
    // Find question container: fieldset, role=group, or a common ancestor with a heading/label
    const container = cb.closest('fieldset')
      || cb.closest('[role="group"]')
      || cb.closest('[role="radiogroup"]')
      || findQuestionContainer(cb);
    if (!container) continue;

    if (!grouped.has(container as HTMLElement)) {
      grouped.set(container as HTMLElement, []);
    }
    grouped.get(container as HTMLElement)!.push({
      checkbox: cb,
      label: getLabel(cb),
    });
  }

  const result: Array<{ question: string; options: Array<{ checkbox: HTMLInputElement; label: string }> }> = [];
  for (const [container, options] of grouped.entries()) {
    if (options.length < 2) continue; // single checkbox isn't a group
    const question = getContainerQuestion(container);
    if (question) result.push({ question, options });
  }
  return result;
}

/** Walk up from a checkbox to find a reasonable question container (div/section with a heading). */
function findQuestionContainer(cb: HTMLInputElement): HTMLElement | null {
  let el: HTMLElement | null = cb.parentElement;
  for (let i = 0; i < 12 && el; i++) {
    // If this container has multiple checkboxes, it's likely the group container
    const checkboxCount = el.querySelectorAll('input[type="checkbox"]').length;
    if (checkboxCount >= 2) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** Extract the question text from a checkbox group container. */
function getContainerQuestion(container: HTMLElement): string {
  // 1. Fieldset legend
  const legend = container.querySelector('legend');
  if (legend?.textContent?.trim()) return legend.textContent.trim();

  // 2. aria-label
  const ariaLabel = container.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // 3. aria-labelledby
  const lby = container.getAttribute('aria-labelledby');
  if (lby) {
    const ref = document.getElementById(lby);
    if (ref?.textContent?.trim()) return ref.textContent.trim();
  }

  // 4. Direct <label> child that's not wrapping a checkbox
  const directLabels = container.querySelectorAll(':scope > label, :scope > div > label');
  for (const lbl of directLabels) {
    if (lbl.querySelector('input[type="checkbox"]')) continue;
    const t = lbl.textContent?.trim();
    if (t && t.length > 3 && t.length < 300) return t;
  }

  // 5. First heading or strong text
  const headings = container.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b');
  for (const h of headings) {
    const text = h.textContent?.trim();
    if (text && text.length > 3 && text.length < 300) return text;
  }

  // 6. First element before the first checkbox (sibling or parent sibling)
  const firstCheckbox = container.querySelector('input[type="checkbox"]');
  if (firstCheckbox) {
    // Walk up to find the checkbox's wrapper, then look at previous siblings
    let wrapper: HTMLElement | null = firstCheckbox.closest('label') ?? firstCheckbox.parentElement;
    while (wrapper && wrapper !== container) {
      let sib = wrapper.previousElementSibling;
      while (sib) {
        const t = sib.textContent?.trim();
        if (t && t.length > 3 && t.length < 300 && !sib.querySelector('input')) return t;
        sib = sib.previousElementSibling;
      }
      wrapper = wrapper.parentElement;
    }
  }

  // 7. First paragraph or span with meaningful text (not containing a checkbox)
  const paras = container.querySelectorAll('p, span, div');
  for (const p of paras) {
    if (p.querySelector('input')) continue;
    const t = p.textContent?.trim();
    if (t && t.length > 5 && t.length < 300) return t;
  }

  return '';
}

// ── Radio group detection + filling ─────────────────────────────────────────

/** Collect all same-name radio inputs into logical groups. */
function collectRadioGroups(): Array<{ name: string; radios: HTMLInputElement[]; legend: string }> {
  const allRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const byName = new Map<string, HTMLInputElement[]>();
  for (const r of allRadios) {
    const key = r.name || `__noname_${r.id || Math.random()}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(r);
  }
  const groups: Array<{ name: string; radios: HTMLInputElement[]; legend: string }> = [];
  for (const [name, radios] of byName.entries()) {
    if (radios.length < 2) continue;   // single radio is effectively a checkbox
    groups.push({ name, radios, legend: getRadioGroupLabel(radios[0]) });
  }
  return groups;
}

/** Walk up the DOM to find the label for a radio group (fieldset legend, role="group", nearby heading). */
function getRadioGroupLabel(firstRadio: HTMLInputElement): string {
  // 1. Fieldset > legend
  const fieldset = firstRadio.closest('fieldset');
  if (fieldset) {
    const leg = fieldset.querySelector('legend');
    if (leg?.textContent?.trim()) return leg.textContent.trim();
  }
  // 2. role="group" / role="radiogroup" with aria-labelledby or aria-label
  const group = firstRadio.closest('[role="group"],[role="radiogroup"]');
  if (group) {
    const lby = group.getAttribute('aria-labelledby');
    if (lby) {
      const labelEl = document.getElementById(lby);
      if (labelEl?.textContent?.trim()) return labelEl.textContent.trim();
    }
    const al = group.getAttribute('aria-label');
    if (al) return al;
  }
  // 3. Nearest preceding sibling text (up to 5 levels)
  let el: Element | null = firstRadio.parentElement;
  for (let i = 0; i < 5 && el; i++) {
    const prev = el.previousElementSibling;
    if (prev && !prev.querySelector('input')) {
      const t = prev.textContent?.trim();
      if (t && t.length < 160) return t;
    }
    el = el.parentElement;
  }
  // 4. Parent with class containing "label" / "question" / "field"
  const wrapper = firstRadio.closest('[class*="label"],[class*="question"],[class*="field"],[class*="group"]');
  if (wrapper) {
    for (const child of Array.from(wrapper.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent?.trim();
        if (t && t.length > 2) return t;
      }
      if (child.nodeType === Node.ELEMENT_NODE) {
        const ce = child as Element;
        if (!ce.querySelector('input')) {
          const t = ce.textContent?.trim();
          if (t && t.length > 2 && t.length < 160) return t;
        }
      }
    }
  }
  return '';
}

/** Classify radio groups by FieldType and return pseudo-DetectedField entries. */
function detectRadioGroups(): DetectedField[] {
  const groups = collectRadioGroups();
  const results: DetectedField[] = [];

  for (const { radios, legend } of groups) {
    const lg = legend.toLowerCase();

    // Skip referral / source questions
    if (/how.+find|where.+hear|referr(al)?|marketing[\s_-]?source|recruitment[\s_-]?channel|utm/i.test(lg)) continue;

    let type: FieldType = 'unknown';
    let confidence = 0;

    if (/where.+locat|current.+locat|are you based|office.+locat|which.+(city|office|location)/i.test(lg)) {
      type = 'city'; confidence = 0.82;
    } else if (/authoriz|authoris|right to work|work permit|eligible to work|legally.+work/i.test(lg)) {
      type = 'workAuthorization'; confidence = 0.90;
    } else if (/visa.+sponsor|require.*sponsor|need.*visa|sponsorship/i.test(lg)) {
      type = 'visaSponsorship'; confidence = 0.90;
    } else if (/relocat/i.test(lg)) {
      type = 'relocation'; confidence = 0.85;
    } else if (/work.+mode|work.+arrang|work.+type|remote|hybrid|onsite|in[\s-]?office/i.test(lg)) {
      type = 'workMode'; confidence = 0.80;
    } else if (/notice[\s_-]?period/i.test(lg)) {
      type = 'noticePeriod'; confidence = 0.78;
    } else if (/years.+exp|experience.+years|how many years/i.test(lg)) {
      type = 'yearsOfExperience'; confidence = 0.72;
    } else if (/salary|compensation|expected pay|desired pay/i.test(lg)) {
      type = 'salary'; confidence = 0.70;
    } else if (/\bgender\b|sex\b|pronouns?/i.test(lg)) {
      type = 'gender'; confidence = 0.88;
    } else if (/race\b|ethnicity|ethnic/i.test(lg)) {
      type = 'race'; confidence = 0.88;
    } else if (/veteran/i.test(lg)) {
      type = 'veteranStatus'; confidence = 0.88;
    } else if (/disability|disab/i.test(lg)) {
      type = 'disabilityStatus'; confidence = 0.88;
    }

    if (type === 'unknown') continue;

    results.push({
      type,
      element:   radios[0],     // first radio is the group representative
      inputType: 'input',
      label:     legend || type,
      confidence,
    });
  }
  return results;
}

/** Get the human-readable label for a single radio option. */
function getRadioOptionLabel(radio: HTMLInputElement): string {
  if (radio.id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(radio.id)}"]`);
    if (lbl) {
      const clone = lbl.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input').forEach((i) => i.remove());
      const t = clone.textContent?.trim();
      if (t) return t;
    }
  }
  const parentLbl = radio.closest('label');
  if (parentLbl) {
    const clone = parentLbl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input').forEach((i) => i.remove());
    const t = clone.textContent?.trim();
    if (t) return t;
  }
  const ariaLabel = radio.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const next = radio.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE) return next.textContent?.trim() ?? '';
  const nextEl = radio.nextElementSibling;
  if (nextEl && !nextEl.querySelector('input')) return nextEl.textContent?.trim() ?? '';
  return radio.value;
}

/**
 * Given the first radio of a group (as stored in DetectedField.element),
 * pick and click the option whose label/value best matches `value`.
 */
function fillRadioGroup(firstRadio: HTMLInputElement, value: string): boolean {
  if (!value) return false;
  const name = firstRadio.name;
  const allRadios = name
    ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`))
    : [firstRadio];

  const vLow = value.toLowerCase().trim();

  let best: HTMLInputElement | null = null;
  let bestScore = 0;

  for (const radio of allRadios) {
    const label = getRadioOptionLabel(radio).toLowerCase().trim();
    const val   = radio.value.toLowerCase().trim();
    let score   = 0;

    if (label === vLow || val === vLow)          score = 100;
    else if (label.includes(vLow))               score = 80;
    else if (vLow.includes(label) && label.length > 2) score = 70;
    else if (val.includes(vLow) || vLow.includes(val)) score = 60;
    else {
      // Token overlap
      const vTokens = vLow.split(/[\s,/]+/);
      const lTokens = label.split(/[\s,/]+/);
      const overlap = vTokens.filter((t) => lTokens.some((l) => l.includes(t) || t.includes(l)));
      score = overlap.length * 15;
    }
    // Yes / No boolean shorthands
    if (/^yes$/i.test(vLow) && /^yes|^ja|true|affirmative|i am|i have/i.test(label)) score = Math.max(score, 90);
    if (/^no$/i.test(vLow)  && /^no|^nein|false|negative|i am not|i don.?t/i.test(label)) score = Math.max(score, 90);

    if (score > bestScore) { bestScore = score; best = radio; }
  }

  if (best && bestScore >= 15) {
    best.checked = true;
    best.dispatchEvent(new Event('change', { bubbles: true }));
    best.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    best.click();
    return true;
  }
  return false;
}

// ── Cover letter generation ───────────────────────────────────────────────────

async function generateCoverLetter() {
  const letterArea = shadowRoot?.getElementById('ap-letter-area') as HTMLElement;
  const letterText = shadowRoot?.getElementById('ap-letter-text') as HTMLTextAreaElement;
  const btn        = shadowRoot?.getElementById('ap-gen-letter') as HTMLButtonElement;

  if (!settings?.anthropicApiKey && !settings?.openaiApiKey) {
    // No API key — upload stored default CL or build a minimal one
    const clField = detected.find((f) => f.type === 'coverLetter');

    if (coverLetterDataUrl && settings?.coverLetterFileName) {
      // Upload the stored default cover letter file directly
      showStatus('⏳ Uploading your default cover letter…');
      try {
        const arr   = coverLetterDataUrl.split(',');
        const mime  = arr[0].match(/:(.*?);/)?.[1] ?? 'application/pdf';
        const bstr  = atob(arr[1]);
        const bytes = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
        const clFile = new File([new Blob([bytes], { type: mime })], settings.coverLetterFileName, { type: mime, lastModified: Date.now() });
        if (clField && (clField.element as HTMLInputElement).type === 'file') {
          await smartFileUpload(clField.element as HTMLInputElement, clFile);
          showStatus('✓ Default cover letter uploaded!');
        } else if (clField) {
          showStatus('ℹ️ Cover letter field is a text area — default file can\'t be pasted. Add an API key for AI-generated text.');
        } else {
          showStatus('ℹ️ No cover letter field detected on this page.');
        }
      } catch (err) {
        console.warn('[ApplyPilot] Failed to upload stored CL:', err);
        showStatus('✗ Failed to upload default cover letter.');
      }
      if (letterArea) letterArea.style.display = 'block';
      if (letterText) letterText.value = '(Default cover letter uploaded)';
      return;
    }

    // No stored CL either — generate a minimal one from profile data and upload
    const name     = settings?.profile?.firstName ? `${settings.profile.firstName} ${settings.profile.lastName}`.trim() : '';
    const jobTitle = extractPageJobTitle() || 'this position';
    const company  = detectCompanyName() || 'your company';
    if (name) {
      const minimalLetter = `Dear Hiring Manager,\n\nI am writing to express my interest in the ${jobTitle} position at ${company}. With my background and experience, I am confident I would be a strong addition to your team. Please find my CV attached for your review.\n\nBest regards,\n${name}`;
      if (letterArea) letterArea.style.display = 'block';
      if (letterText) letterText.value = minimalLetter;
      if (clField) {
        if ((clField.element as HTMLInputElement).type === 'file') {
          const clFile = buildCoverLetterFile(minimalLetter);
          await smartFileUpload(clField.element as HTMLInputElement, clFile);
          showStatus('✓ Minimal cover letter generated & uploaded (add API key for AI-written letters).');
        } else {
          setNativeValue(clField.element, minimalLetter);
          showStatus('✓ Minimal cover letter filled (add API key for AI-written letters).');
        }
      } else {
        showStatus('ℹ️ No cover letter field found — letter shown in panel.');
      }
    } else {
      showStatus('ℹ️ Add an API key in Settings for AI-generated letters, or fill your name in Profile.');
    }
    return;
  }

  if (btn) { btn.textContent = '⏳ Thinking…'; btn.disabled = true; }

  const jobDesc = extractJobDescription();
  const title   = extractPageJobTitle();
  const company = extractPageCompany();

  chrome.runtime.sendMessage(
    {
      type: 'GENERATE_COVER_LETTER',
      payload: {
        jobTitle:       title,
        company,
        location:       location.href,
        jobDescription: jobDesc,
        resumeText:     settings!.resumeText ?? '',
        profile:        settings!.profile,
      },
    },
    (resp: { ok: boolean; letter?: string; error?: string }) => {
      if (btn) { btn.textContent = '✨ Generate & Upload CL'; btn.disabled = false; }

      if (resp?.ok && resp.letter) {
        if (letterArea) letterArea.style.display = 'block';
        if (letterText) letterText.value = resp.letter;
        showStatus('✓ Cover letter generated!');

        // Auto-paste into cover letter textarea OR upload as PDF to file input
        const clField = detected.find((f) => f.type === 'coverLetter');
        if (clField) {
          if ((clField.element as HTMLInputElement).type === 'file') {
            // Build a PDF from the generated letter and upload it — replaces any default CL
            const clFile = buildCoverLetterFile(resp.letter);
            smartFileUpload(clField.element as HTMLInputElement, clFile).then(() => {
              console.log('[ApplyPilot] AI-generated cover letter uploaded as PDF to file input');
            }).catch((err) => {
              console.warn('[ApplyPilot] Failed to upload generated CL:', err);
            });
          } else {
            setNativeValue(clField.element, resp.letter);
          }
        }

        // Persist letter to Job record
        chrome.runtime.sendMessage({
          type:    'SAVE_COVER_LETTER',
          payload: { jobUrl: location.href, letter: resp.letter },
        });
      } else {
        showStatus(`✗ ${resp?.error ?? 'Generation failed'}`);
      }
    },
  );
}

// ── Page info extractors ──────────────────────────────────────────────────────

function extractPageJobTitle(): string {
  for (const sel of ['h1', '[class*="jobTitle"]', '[class*="job-title"]', '[class*="position-title"]']) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim().slice(0, 100);
  }
  return document.title.split('|')[0].trim().slice(0, 80);
}

function extractPageCompany(): string {
  for (const sel of ['[class*="companyName"]', '[class*="company-name"]', '[class*="employer"]', '[class*="organization"]']) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim().slice(0, 80);
  }
  return location.hostname.replace('www.', '');
}

// ── Social URL smart fill ─────────────────────────────────────────────────────

function smartSocialUrl(storedUrl: string, domainFragment: string, field?: DetectedField): string {
  if (!storedUrl) return '';
  const el = field?.element as HTMLInputElement | undefined;
  let username = storedUrl;
  try {
    const u = new URL(storedUrl.startsWith('http') ? storedUrl : 'https://' + storedUrl);
    username = u.pathname.replace(/^\//, '').replace(/\/$/, '');
    if (domainFragment.includes('linkedin') && username.startsWith('in/')) username = username.slice(3);
  } catch {
    username = storedUrl.replace(/^https?:\/\/(www\.)?/, '').replace(domainFragment, '').replace(/\/$/, '');
  }

  const placeholder = (el?.placeholder ?? '').toLowerCase();
  const maxLen      = el?.maxLength ?? -1;
  const expectsUrl  = placeholder.includes('http') || placeholder.includes('www.') ||
                      placeholder.includes('.com') || maxLen > 30 || maxLen === -1;

  if (expectsUrl) {
    return storedUrl.startsWith('http') ? storedUrl : `https://${domainFragment}${username}`;
  }
  return username;
}

// ── Field value mapping ───────────────────────────────────────────────────────

function getValueForField(type: FieldType, profile?: UserProfile, field?: DetectedField): string {
  if (!profile) return '';
  switch (type) {
    case 'firstName':        return profile.firstName || profile.name.split(' ')[0] || '';
    case 'lastName':         return profile.lastName  || profile.name.split(' ').slice(1).join(' ') || '';
    case 'fullName':         return `${profile.firstName} ${profile.lastName}`.trim() || profile.name || '';
    case 'email':            return profile.email;
    case 'phone':            return profile.phone;
    case 'city': {
      const cityOnly = (profile.city || '').split(',')[0].trim();
      // For open-ended "Where are you located?" questions, return "City, Country" for clarity
      // For autocomplete-style fields (name/id contains "city"), return just city name
      if (field) {
        const fl = (field.label || '').toLowerCase();
        const fn = ((field.element as HTMLInputElement).name || '').toLowerCase();
        const fi = ((field.element as HTMLInputElement).id || '').toLowerCase();
        if (/where.*(based|located|live)|current.*location|your.*location/i.test(fl) && !/\bcity\b/i.test(`${fn} ${fi}`)) {
          return profile.country ? `${cityOnly}, ${profile.country}` : cityOnly;
        }
      }
      return cityOnly; // "Munich, Germany" → "Munich" for autocomplete compatibility
    }
    case 'country':          return profile.country;
    case 'salary':
    case 'salaryMin':        return profile.salaryMin;
    case 'salaryMax':        return profile.salaryMax;
    case 'noticePeriod':     return `${profile.noticePeriod} ${profile.noticePeriodUnit}`;
    case 'joiningDate':      return profile.earliestJoiningDate;
    case 'dateOfBirth':      return profile.dateOfBirth || '';
    case 'linkedin':         return smartSocialUrl(profile.linkedinUrl, 'linkedin.com/in/', field);
    case 'github':           return smartSocialUrl(profile.githubUrl,   'github.com/',      field);
    case 'portfolio':        return profile.portfolioUrl;
    case 'yearsOfExperience':return profile.yearsOfExperience;
    case 'workAuthorization':return profile.noVisaSponsorship ? 'Yes' : 'No';
    case 'visaSponsorship':  return profile.noVisaSponsorship ? 'No' : 'Yes';
    case 'workMode':         return profile.workModePreference;
    case 'relocation':       return profile.relocationPreference ? 'Yes' : 'No';
    case 'gender':           return profile.gender || '';
    case 'race':             return profile.raceEthnicity || 'Decline';
    case 'veteranStatus':    return profile.veteranStatus || 'Decline';
    case 'disabilityStatus': return profile.disabilityStatus || 'Decline';
    default:                 return '';
  }
}

// ── Banners ───────────────────────────────────────────────────────────────────

function showCaptchaBanner() {
  if (document.getElementById('ap-captcha-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'ap-captcha-banner';
  banner.style.cssText = [
    'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2147483647', 'background:#FFFBEB', 'color:#92400E',
    'border:2px solid #FCD34D', 'border-radius:10px',
    'padding:10px 20px', 'font-size:13px', 'font-weight:600',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.15)', 'max-width:420px',
    'text-align:center', 'line-height:1.5',
  ].join(';');
  banner.innerHTML = '🤖 <strong>Human verification required.</strong> Complete the CAPTCHA on the page, then click ↩ Re-fill in the ApplyPilot panel. &nbsp;<button id="ap-captcha-dismiss" style="cursor:pointer;background:none;border:none;font-size:14px;opacity:.6">✕</button>';
  document.body.appendChild(banner);
  banner.querySelector('#ap-captcha-dismiss')?.addEventListener('click', () => banner.remove());
  setTimeout(() => banner.remove(), 30000);
}

function showLoginBanner(info: ReturnType<typeof detectLoginWall>) {
  if (document.getElementById('ap-login-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'ap-login-banner';
  banner.style.cssText = [
    'position:fixed', 'top:60px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2147483647', 'background:#EEF2FF', 'color:#3730A3',
    'border:2px solid #C7D2FE', 'border-radius:10px',
    'padding:12px 20px', 'font-size:13px', 'font-weight:600',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.12)', 'max-width:440px',
    'text-align:center', 'line-height:1.6',
  ].join(';');

  const platform = info.platform ? ` on ${info.platform}` : '';
  const ssoHint  = info.hasGoogleSSO
    ? `<br><span style="color:#10B981">✓ Google Sign-In detected — click it to authenticate${platform}. I'll re-fill after login.</span>`
    : `<br>Sign in${platform}, then open the apply form — ApplyPilot will detect it automatically.`;

  banner.innerHTML = `🔐 <strong>Login required to apply.</strong>${ssoHint} &nbsp;<button id="ap-login-dismiss" style="cursor:pointer;background:none;border:none;font-size:14px;opacity:.6">✕</button>`;
  document.body.appendChild(banner);
  banner.querySelector('#ap-login-dismiss')?.addEventListener('click', () => banner.remove());

  // Watch for navigation post-SSO (MutationObserver on URL)
  if (info.hasGoogleSSO) {
    let watchUrl = location.href;
    const loginObserver = new MutationObserver(async () => {
      if (location.href !== watchUrl) {
        watchUrl = location.href;
        // If we're no longer on a login page, trigger re-boot
        await new Promise((r) => setTimeout(r, 1500));
        const newLogin = detectLoginWall();
        if (!newLogin.isLoginWall) {
          banner.remove();
          loginObserver.disconnect();
          detected = detectFields();
          if (detected.length > 0) {
            buildPanel();
            showFillPanel();
          }
        }
      }
    });
    loginObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function showQueueCompleteBanner() {
  showToast('🎉 Queue complete! All selected jobs processed.', 'info');
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  const existing = document.getElementById('ap-toast');
  existing?.remove();

  const toast = document.createElement('div');
  toast.id    = 'ap-toast';
  const bg     = level === 'warn'  ? '#FFFBEB' : level === 'error' ? '#FEF2F2' : '#EEF2FF';
  const color  = level === 'warn'  ? '#92400E' : level === 'error' ? '#991B1B' : '#3730A3';
  const border = level === 'warn'  ? '#FDE68A' : level === 'error' ? '#FECACA' : '#C7D2FE';

  toast.style.cssText = [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
    `background:${bg}`, `color:${color}`, `border:1px solid ${border}`,
    'border-radius:10px', 'padding:10px 16px', 'font-size:13px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-weight:600', 'box-shadow:0 4px 12px rgba(0,0,0,.12)',
    'max-width:340px', 'line-height:1.4', 'animation:ap-toast-in .2s ease',
  ].join(';');

  if (!document.getElementById('ap-toast-style')) {
    const s = document.createElement('style');
    s.id = 'ap-toast-style';
    s.textContent = '@keyframes ap-toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(s);
  }

  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function showStatus(msg: string) {
  const el = shadowRoot?.getElementById('ap-status');
  if (el) { el.textContent = msg; el.style.color = ''; }
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function panelCSS(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :host { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; }
    #ap-toggle-btn {
      display: flex; align-items: center; gap: 6px;
      background: linear-gradient(135deg, #4F46E5, #6D28D9);
      color: #fff; border: none; border-radius: 24px;
      padding: 9px 16px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(79,70,229,.4);
      font-size: 13px; font-weight: 700; transition: transform .15s;
    }
    #ap-toggle-btn:hover { transform: translateY(-1px); }
    .ap-badge {
      background: rgba(255,255,255,.25); border-radius: 10px;
      padding: 1px 7px; font-size: 11px;
    }
    .ap-queue-dot {
      background: #F59E0B; color: #fff; border-radius: 10px;
      padding: 1px 7px; font-size: 11px; font-weight: 800;
    }
    #ap-panel {
      width: 310px; background: #fff; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.18); border: 1px solid #E2E8F0; overflow: hidden;
    }
    .ap-header {
      display: flex; align-items: center; gap: 6px;
      padding: 10px 14px;
      background: linear-gradient(135deg, #4F46E5, #6D28D9); color: #fff;
    }
    .ap-logo { font-weight: 700; font-size: 13px; flex: 1; display: flex; align-items: center; gap: 5px; }
    .ap-ats-badge {
      font-size: 9px; background: rgba(255,255,255,.25); border-radius: 6px;
      padding: 1px 6px; font-weight: 700; letter-spacing: .4px;
    }
    .ap-count { font-size: 11px; opacity: .8; }
    #ap-minimize { background: none; border: none; color: #fff; cursor: pointer; font-size: 18px; opacity: .7; }
    #ap-minimize:hover { opacity: 1; }
    .ap-queue-banner {
      background: #F59E0B; color: #fff; font-size: 12px; font-weight: 700;
      padding: 5px 14px; text-align: center;
    }
    .ap-captcha-bar {
      background: #FEF3C7; color: #92400E; font-size: 11px; font-weight: 600;
      padding: 5px 14px; border-bottom: 1px solid #FDE68A;
    }
    .ap-warn-bar {
      background: #FEF3C7; color: #92400E; font-size: 11px;
      padding: 5px 14px; border-bottom: 1px solid #FDE68A;
    }
    .ap-step-bar {
      background: #EEF2FF; color: #4338CA; font-size: 11px; font-weight: 600;
      padding: 5px 14px; border-bottom: 1px solid #C7D2FE;
    }
    .ap-body { padding: 10px 12px; max-height: 440px; overflow-y: auto; }
    .ap-fields { margin-bottom: 10px; }
    .field-row {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 0; border-bottom: 1px solid #F1F5F9;
    }
    .field-row:last-child { border: none; }
    .field-icon { font-size: 14px; width: 20px; text-align: center; }
    .field-info { flex: 1; min-width: 0; }
    .field-label { color: #64748B; font-size: 10px; display: block; text-transform: uppercase; letter-spacing: .4px; }
    .field-value { color: #1E293B; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 155px; }
    .field-conf { font-size: 10px; border-radius: 4px; padding: 1px 5px; }
    .field-conf.high { background: #D1FAE5; color: #065F46; }
    .field-conf.med  { background: #FEF3C7; color: #92400E; }
    .ap-actions { display: flex; gap: 8px; margin-bottom: 6px; }
    .ap-refill-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .btn-primary {
      flex: 1; padding: 8px; background: #4F46E5; color: #fff;
      border: none; border-radius: 7px; font-size: 12px; font-weight: 700;
      cursor: pointer; transition: background .15s;
    }
    .btn-primary:hover { background: #4338CA; }
    .btn-secondary {
      flex: 1; padding: 8px; background: #F1F5F9; color: #4F46E5;
      border: 1px solid #E0E7FF; border-radius: 7px; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: background .15s;
    }
    .btn-secondary:hover { background: #E0E7FF; }
    .btn-refill {
      padding: 5px 12px; background: #FEF9C3; color: #854D0E;
      border: 1px solid #FDE047; border-radius: 7px; font-size: 11px; font-weight: 700;
      cursor: pointer; white-space: nowrap;
    }
    .btn-refill:hover { background: #FEF08A; }
    .btn-green {
      flex: 1; padding: 7px; background: #10B981; color: #fff;
      border: none; border-radius: 7px; font-size: 11px; font-weight: 700; cursor: pointer;
    }
    .btn-green:hover { background: #059669; }
    .btn-gray {
      flex: 1; padding: 7px; background: #F1F5F9; color: #475569;
      border: 1px solid #CBD5E1; border-radius: 7px; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .btn-gray:hover { background: #E2E8F0; }
    .ap-queue-actions { display: flex; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #F1F5F9; }
    .ap-warning { font-size: 10px; color: #F59E0B; flex: 1; }
    .ap-letter-label { font-size: 11px; font-weight: 600; color: #64748B; margin-bottom: 4px; }
    #ap-letter-text {
      width: 100%; border: 1px solid #E2E8F0; border-radius: 6px;
      padding: 8px; font-size: 11px; font-family: inherit; resize: vertical; color: #1E293B;
    }
    #ap-status { font-size: 11px; color: #10B981; margin-top: 6px; text-align: center; min-height: 16px; }
  `;
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fieldIcon(type: FieldType): string {
  const map: Partial<Record<FieldType, string>> = {
    firstName: '👤', lastName: '👤', fullName: '👤',
    email: '✉️', phone: '📱',
    city: '📍', country: '🌍', address: '🏠',
    salary: '💰', salaryMin: '💰', salaryMax: '💰',
    noticePeriod: '📅', joiningDate: '📅',
    linkedin: '💼', github: '⌨️', portfolio: '🌐',
    resume: '📄', coverLetter: '📝',
    workAuthorization: '✅', visaSponsorship: '🛂',
    workMode: '🏠', relocation: '✈️',
    yearsOfExperience: '⏳',
  };
  return map[type] ?? '📋';
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

// ── Direct chrome.storage.local access (no message passing) ─────────────────
// Content scripts CAN read chrome.storage.local directly.
// This avoids chrome.runtime.sendMessage size limits which silently drop
// large payloads like resume dataUrls (base64-encoded PDFs can be 500KB+).

const DEFAULT_PROFILE_STUB = {
  name: '', firstName: '', lastName: '', email: '', phone: '',
  city: '', country: '', salaryMin: '', salaryMax: '', salaryCurrency: 'EUR',
  noticePeriod: '', noticePeriodUnit: 'months' as const,
  earliestJoiningDate: '', workModePreference: 'hybrid' as const,
  relocationPreference: false, germanPR: false, noVisaSponsorship: false,
  workPermitType: '', gender: '', ageRange: '',
  linkedinUrl: '', githubUrl: '', portfolioUrl: '',
  targetRoles: [] as string[], targetLocations: [] as string[], skills: [] as string[],
  yearsOfExperience: '', currentJobTitle: '', currentCompany: '', summary: '',
};

const DEFAULT_SETTINGS_STUB: Settings = {
  openaiApiKey: '', anthropicApiKey: '',
  automationMode: 'assist', aiProvider: 'anthropic',
  aiModel: 'claude-haiku-4-5-20251001',
  resumeFileName: '', resumeText: '', resumeDataUrl: '',
  profile: DEFAULT_PROFILE_STUB,
  jobSearchKeywords: [], jobSearchLocations: [],
  maxJobAgeDays: 7,
  enableGmailDetection: true, enableLinkedInDetection: true,
  enabled: true, disabledSites: [], smartActivation: true,
};

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('ap_settings', (result) => {
      if (chrome.runtime.lastError) {
        console.error('[ApplyPilot] getSettings storage error:', chrome.runtime.lastError.message);
        resolve(DEFAULT_SETTINGS_STUB);
        return;
      }
      const saved = result['ap_settings'] as Partial<Settings> | undefined;
      if (!saved) {
        console.warn('[ApplyPilot] No ap_settings found in storage — using defaults.');
        resolve(DEFAULT_SETTINGS_STUB);
        return;
      }
      resolve({
        ...DEFAULT_SETTINGS_STUB,
        ...saved,
        profile: { ...DEFAULT_PROFILE_STUB, ...(saved.profile ?? {}) },
      });
    });
  });
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get('ap_settings', (result) => {
      const current = result['ap_settings'] ?? {};
      const merged = { ...current, ...patch };
      chrome.storage.local.set({ 'ap_settings': merged }, () => {
        if (chrome.runtime.lastError) {
          console.error('[ApplyPilot] saveSettings failed:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    });
  });
}

async function getResume(): Promise<{ dataUrl: string } | null> {
  // 1. Try chrome.storage.local first (fast path)
  const fromStorage = await new Promise<string>((resolve) => {
    chrome.storage.local.get('ap_settings', (result) => {
      if (chrome.runtime.lastError) {
        console.error('[ApplyPilot] getResume storage error:', chrome.runtime.lastError.message);
        resolve('');
        return;
      }
      const s = result['ap_settings'] as Partial<Settings> | undefined;
      resolve(s?.resumeDataUrl ?? '');
    });
  });

  if (fromStorage) {
    console.log('[ApplyPilot] getResume — found in storage, length:', fromStorage.length);
    return { dataUrl: fromStorage };
  }

  // 2. Fallback: recover from IndexedDB via background service worker
  //    Content scripts can't access the extension's IndexedDB directly,
  //    so we ask the background to read it and auto-repair storage.
  console.log('[ApplyPilot] resumeDataUrl empty in storage — attempting IndexedDB recovery via background…');
  try {
    const resp = await new Promise<any>((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_RESUME_FROM_IDB' }, (r) => {
        if (chrome.runtime.lastError) {
          console.warn('[ApplyPilot] IDB recovery message failed:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(r);
        }
      });
    });
    if (resp?.ok && resp.dataUrl) {
      console.log('[ApplyPilot] ✅ Resume recovered from IndexedDB! fileName:', resp.fileName,
        '| dataUrl length:', resp.dataUrl.length);
      // Update settings in memory too
      if (settings) {
        settings.resumeDataUrl  = resp.dataUrl;
        settings.resumeFileName = resp.fileName;
        settings.resumeText     = resp.text || settings.resumeText;
      }
      return { dataUrl: resp.dataUrl };
    }
    console.log('[ApplyPilot] No resume in IndexedDB either.');
  } catch (err) {
    console.warn('[ApplyPilot] IndexedDB recovery error:', err);
  }

  return null;
}

// ── Init ──────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
