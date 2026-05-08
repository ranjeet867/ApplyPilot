/**
 * ApplyPilot — LinkedIn content script (READ-ONLY)
 *
 * Safety rules:
 *  ✗ Never clicks "Easy Apply" or "Apply"
 *  ✗ Never sends connection requests or messages
 *  ✗ Never scrapes search pages automatically
 *  ✓ Extracts job data from pages the user manually navigates to
 *  ✓ Shows save button for individual job postings
 *  ✓ Reads notification bell job alerts when user opens notifications
 */

import type { ExtractedJob } from '../types';
import { generateId, getDomain, isWithinDays } from '../shared/utils';

const STYLE_ID  = 'ap-li-style';
const BUTTON_ID = 'ap-li-save-btn';

let lastUrl = '';

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
  injectStyle();
  observeNavigation();
}

function observeNavigation() {
  let lastHref = location.href;

  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(handlePageChange, 1000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(handlePageChange, 1500);
}

async function handlePageChange() {
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;

  removeButton();

  const settings = await getSettings();
  if (!settings.enableLinkedInDetection) return;

  // Individual job posting page
  if (url.match(/\/jobs\/view\/\d+/)) {
    await handleJobPage();
    return;
  }

  // Notifications page — read job alerts
  if (url.includes('/notifications/') || url.includes('/mynetwork/')) {
    await handleNotificationsPage();
    return;
  }

  // Job search results — only add save buttons, no auto-scraping
  if (url.includes('/jobs/search/') || url.includes('/jobs/collections/')) {
    await handleJobSearchPage();
    return;
  }
}

// ── Individual job page ───────────────────────────────────────────────────────

async function handleJobPage() {
  // Wait for content to render
  await sleep(800);

  const titleEl    = document.querySelector('.job-details-jobs-unified-top-card__job-title h1, .top-card-layout__title, h1.t-24');
  const companyEl  = document.querySelector('.job-details-jobs-unified-top-card__company-name, .top-card-layout__company, .topcard__org-name-link');
  const locationEl = document.querySelector('.job-details-jobs-unified-top-card__primary-description-without-tagline .tvm__text, .top-card-layout__first-subline, .topcard__flavor--bullet');

  const title       = sanitise(titleEl?.textContent ?? '');
  const company     = sanitise(companyEl?.textContent ?? '');
  const locationText= sanitise(locationEl?.textContent ?? '');
  const pageUrl     = window.location.href;

  if (!title) return;

  // Try to find the actual external ATS apply URL embedded in the page
  // (LinkedIn external-apply jobs have a direct href to the company ATS)
  const knownATS = [
    'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkdayjobs.com',
    'personio.de', 'personio.com', 'smartrecruiters.com', 'jobvite.com', 'bamboohr.com',
    'recruitee.com', 'join.com', 'taleo.net', 'icims.com', 'breezy.hr',
    'workable.com', 'successfactors.com', 'careers.', 'jobs.',
  ];
  let applyUrl = pageUrl;
  const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const atsLink = allLinks.find((a) => {
    try {
      const href = a.href;
      return href && !href.includes('linkedin.com') && knownATS.some((d) => href.includes(d));
    } catch { return false; }
  });
  if (atsLink) applyUrl = atsLink.href;

  const job: ExtractedJob = {
    title,
    company,
    location:  extractGermanyLocation(locationText),
    applyUrl,
    sourceUrl: pageUrl,
  };

  showSaveButton([job], `Save: ${title} @ ${company}`);
}

// ── Job search results ────────────────────────────────────────────────────────

async function handleJobSearchPage() {
  await sleep(1200);

  // Add small "save" buttons next to each job card (user must click each one)
  const cards = document.querySelectorAll('.job-card-container, .jobs-search-results__list-item');
  if (cards.length === 0) return;

  const jobs: ExtractedJob[] = [];

  cards.forEach((card) => {
    const titleEl   = card.querySelector('.job-card-list__title, .job-card-container__link') as HTMLElement | null;
    const companyEl = card.querySelector('.job-card-container__primary-description, .job-card-container__company-name') as HTMLElement | null;
    const locationEl= card.querySelector('.job-card-container__metadata-item, .job-card-container__location') as HTMLElement | null;
    const linkEl    = card.querySelector('a[href*="/jobs/view/"]') as HTMLAnchorElement | null;

    if (!titleEl || !linkEl) return;

    jobs.push({
      title:     sanitise(titleEl.textContent ?? ''),
      company:   sanitise(companyEl?.textContent ?? ''),
      location:  sanitise(locationEl?.textContent ?? ''),
      applyUrl:  linkEl.href,
      sourceUrl: location.href,
    });
  });

  if (jobs.length === 0) return;

  // Show panel for visible results (max 10)
  showSaveButton(jobs.slice(0, 10), `Save ${Math.min(jobs.length, 10)} visible jobs`);
}

// ── Notifications page ────────────────────────────────────────────────────────

async function handleNotificationsPage() {
  await sleep(1500);

  const notifCards = document.querySelectorAll('.nt-card-list__item, .notification-item');
  const jobs: ExtractedJob[] = [];

  notifCards.forEach((card) => {
    const text   = card.textContent ?? '';
    const linkEl = card.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
    if (!linkEl) return;

    const { title, company } = extractJobFromNotificationText(text);
    if (!title) return;

    jobs.push({
      title,
      company,
      location:  extractGermanyLocation(text),
      applyUrl:  linkEl.href,
      sourceUrl: location.href,
    });
  });

  if (jobs.length > 0) {
    showSaveButton(jobs, `Save ${jobs.length} job alert${jobs.length > 1 ? 's' : ''}`);
  }
}

// ── Save button ───────────────────────────────────────────────────────────────

function showSaveButton(jobs: ExtractedJob[], label: string) {
  removeButton();

  const btn   = document.createElement('button');
  btn.id      = BUTTON_ID;
  btn.textContent = `✈ ${label}`;
  document.body.appendChild(btn);

  btn.addEventListener('click', async () => {
    btn.textContent = 'Saving…';
    btn.style.background = '#6D28D9';

    chrome.runtime.sendMessage(
      { type: 'JOBS_EXTRACTED', payload: jobs },
      (response: { saved: number; duplicates: number }) => {
        if (chrome.runtime.lastError) {
          btn.textContent = '✗ Error';
          btn.style.background = '#EF4444';
          return;
        }
        const { saved = 0, duplicates = 0 } = response ?? {};
        if (saved > 0) {
          btn.textContent = `✓ Saved ${saved}!${duplicates ? ` (${duplicates} dupes skipped)` : ''}`;
          btn.style.background = '#10B981';
        } else {
          btn.textContent = `✓ Already in list${duplicates ? ` (${duplicates} dupes)` : ''}`;
          btn.style.background = '#94A3B8';
        }
        setTimeout(removeButton, 4000);
      },
    );
  });

  // Auto-hide after 30s
  setTimeout(removeButton, 30000);
}

function removeButton() {
  document.getElementById(BUTTON_ID)?.remove();
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id    = STYLE_ID;
  s.textContent = `
    #${BUTTON_ID} {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: linear-gradient(135deg, #4F46E5, #6D28D9);
      color: #fff;
      border: none;
      border-radius: 24px;
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      z-index: 999999;
      box-shadow: 0 4px 14px rgba(79,70,229,.45);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: transform .15s, box-shadow .15s;
      white-space: nowrap;
    }
    #${BUTTON_ID}:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(79,70,229,.55);
    }
  `;
  document.head.appendChild(s);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise<{ enableLinkedInDetection: boolean }>((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
      resolve(s ?? { enableLinkedInDetection: true });
    });
  });
}

function sanitise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractGermanyLocation(text: string): string {
  const pat = /\b(Berlin|Munich|München|Hamburg|Frankfurt|Cologne|Köln|Stuttgart|Düsseldorf|Leipzig|Dresden|Nuremberg|Nürnberg|Germany|Deutschland|Remote|Hybrid)\b/gi;
  const matches = text.match(pat);
  return matches ? [...new Set(matches.map((m) => m.trim()))].slice(0, 2).join(', ') : '';
}

function extractJobFromNotificationText(text: string): { title: string; company: string } {
  // "New job: Senior Go Developer at Zalando"
  const match = text.match(/new job[:\s]+(.+?)\s+at\s+(.+?)(?:\.|$)/i);
  if (match) return { title: sanitise(match[1]), company: sanitise(match[2]) };

  // "Zalando is hiring: Senior Go Developer"
  const hiringMatch = text.match(/(.+?)\s+is hiring:?\s+(.+?)(?:\.|$)/i);
  if (hiringMatch) return { title: sanitise(hiringMatch[2]), company: sanitise(hiringMatch[1]) };

  return { title: sanitise(text.slice(0, 60)), company: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Init ──────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
