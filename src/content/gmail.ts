/**
 * ApplyPilot — Gmail content script
 *
 * Watches for job alert emails, extracts job links, and sends them to the
 * background worker to save. Shows a non-intrusive floating notification.
 *
 * Handles multi-job emails (LinkedIn Alerts, Indeed Digest, etc.) by
 * extracting per-job title / company / location from DOM context around
 * each link — not just from the email subject.
 *
 * Approach: MutationObserver on the email body; no Gmail API needed.
 */

import type { ExtractedJob } from '../types';
import { isJobEmail, isJobUrl, getDomain, generateId } from '../shared/utils';

const STYLE_ID = 'ap-gmail-style';
const PANEL_ID = 'ap-gmail-panel';

let lastEmailUrl = '';

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
  injectStyle();
  observeEmailOpen();
}

// ── Watch URL changes (Gmail is a SPA) ────────────────────────────────────────

function observeEmailOpen() {
  let lastUrl = location.href;

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(tryExtract, 1200);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(tryExtract, 2000);
}

// ── Main extraction logic ─────────────────────────────────────────────────────

async function tryExtract() {
  const url = location.href;
  if (url === lastEmailUrl) return;

  if (!url.includes('#inbox/') && !url.includes('#all/') && !url.includes('/mail/r/')) return;

  lastEmailUrl = url;
  removePanelIfExists();

  const subjectEl = document.querySelector('h2[data-legacy-thread-id], [data-thread-id] h2, .ha h2');
  const subject   = subjectEl?.textContent?.trim() ?? '';

  const bodyEl   = document.querySelector('.a3s.aiL, .a3s, [data-message-id] .nH');
  const bodyText = bodyEl?.textContent?.trim() ?? '';

  const settings = await getSettings();
  if (!settings.enableGmailDetection) return;
  if (!isJobEmail(subject, bodyText)) return;

  // Collect all anchors from body (or whole document as fallback)
  const anchors = Array.from(
    (bodyEl ?? document).querySelectorAll<HTMLAnchorElement>('a[href]'),
  );

  const jobs = extractJobsFromAnchors(anchors, subject, bodyText);
  if (jobs.length === 0) return;

  showPanel(jobs);
}

// ── Per-link job extraction ───────────────────────────────────────────────────
// For each qualifying link we walk up the DOM to find the nearest "card"
// container (table row, div, li) and pull title / company / location from
// the text nodes inside it — rather than guessing from the email subject.

function extractJobsFromAnchors(
  anchors: HTMLAnchorElement[],
  subject: string,
  bodyText: string,
): ExtractedJob[] {
  const jobs: ExtractedJob[] = [];

  for (const a of anchors) {
    const href = a.href;
    if (!href || !isJobUrl(href) || href.includes('mail.google.com')) continue;

    // Skip generic / non-job anchors (e.g. "View all jobs", "Unsubscribe")
    const anchorText = a.textContent?.trim() ?? '';
    if (anchorText.length < 3 || /^(view|see|unsubscribe|manage|settings)/i.test(anchorText)) continue;

    const info = extractJobInfoFromContext(a, subject, bodyText);
    jobs.push({
      title:     info.title,
      company:   info.company,
      location:  info.location,
      applyUrl:  href,
      sourceUrl: location.href,
    });
  }

  return deduplicateJobs(jobs);
}

function extractJobInfoFromContext(
  anchor: HTMLAnchorElement,
  subject: string,
  bodyText: string,
): { title: string; company: string; location: string } {

  // ── 1. Anchor text itself is usually the job title ────────────────────────
  const anchorText = anchor.textContent?.trim() ?? '';

  // ── 2. Walk up the DOM to find the surrounding card ───────────────────────
  const card = findJobCard(anchor);
  const cardText = card?.textContent?.trim() ?? '';

  // ── 3. Parse structured patterns from card text ───────────────────────────
  //   LinkedIn emails have lines like:
  //     "Koch (m/w/d)"            ← title (= anchor text)
  //     "Tipico"                  ← company
  //     "Germany, Frankfurt"      ← location
  //     "Actively recruiting"     ← noise
  //     "Easy Apply"              ← noise
  //   OR: "Tipico · Frankfurt (On-site)"

  const NOISE_PATTERNS = /^(actively recruiting|easy apply|promoted|viewed|applicants?|new|saved|applied|see more|view job|view all)/i;

  const lines = cardText
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1 && !NOISE_PATTERNS.test(l));

  let title    = '';
  let company  = '';
  let loc      = '';

  // Anchor text is reliably the title in LinkedIn/Indeed alert emails
  if (anchorText.length > 2 && anchorText.length < 120) {
    title = anchorText;
  }

  for (const line of lines) {
    // Skip the title line
    if (line === title) continue;
    // Skip lines that are just the domain or URL
    if (/^https?:\/\//i.test(line) || line === 'linkedin.com') continue;

    // Pattern: "Company · Location" or "Company – Location (On-site)"
    const dotSep = line.match(/^([^·•|–\n]{2,60})\s*[·•|–]\s*(.+)$/);
    if (dotSep) {
      const left  = dotSep[1].trim();
      const right = dotSep[2].trim().replace(/\s*\((On-site|Remote|Hybrid)\)\s*/gi, '').trim();
      if (!company)  company = left;
      if (!loc)      loc     = right;
      continue;
    }

    // If we already have the title but not the company, next meaningful short line is company
    if (title && !company && line.length < 60 && !/\d{4}/.test(line)) {
      const atMatch = line.match(/^at\s+(.+)$/i);
      company = atMatch ? atMatch[1].trim() : line;
      continue;
    }

    // If we have company but not location, next line with a place-like pattern is location
    if (company && !loc) {
      // "Germany, Frankfurt" or "Frankfurt (On-site)" or "Remote"
      const cleaned = line.replace(/\s*\((On-site|Remote|Hybrid)\)\s*/gi, '').trim();
      if (cleaned.length > 1 && cleaned.length < 80) {
        loc = cleaned;
      }
    }
  }

  // ── 4. Location from anywhere in the card ─────────────────────────────────
  if (!loc) {
    loc = extractLocation(cardText || bodyText);
  }

  // ── 5. Fallbacks ──────────────────────────────────────────────────────────
  if (!title)   title   = sanitiseSubjectToTitle(subject);
  if (!company) company = getDomain(anchor.href);

  return { title, company, location: loc };
}

/** Walk up the DOM to find the smallest block-level container that
 *  plausibly represents a single job listing.
 *
 *  LinkedIn job alert emails nest each job inside deeply nested tables.
 *  We need to climb high enough to capture the company + location lines
 *  that sit in sibling table cells, not just the link's immediate cell.
 *  Strategy: find the first ancestor that contains enough distinct text
 *  lines (title + company + location = at least 2 non-trivial lines). */
function findJobCard(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  let depth = 0;
  let bestCard: HTMLElement | null = null;

  while (node && depth < 12) {
    const tag = node.tagName.toLowerCase();

    // Skip tiny wrappers — keep climbing
    const text = node.textContent?.trim() ?? '';
    const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 2);

    // A good card has 2+ meaningful lines (title + company/location)
    // but isn't the entire email body
    if (lines.length >= 2 && text.length < 500) {
      bestCard = node;
      // For table-based emails, keep climbing to find the row-level container
      if (tag === 'tr' || tag === 'li') return node;
      // For div-based emails, a padded/margined div with enough content is good
      if (tag === 'div') {
        const style = node.getAttribute('style') ?? '';
        if (/padding|margin|border/i.test(style)) return node;
      }
    }

    // If we hit a TR that's too big (multiple jobs), return the best card so far
    if (tag === 'tr' && text.length > 500 && bestCard) return bestCard;
    // If we hit the email body container, stop
    if (tag === 'table' && text.length > 1000 && bestCard) return bestCard;

    node = node.parentElement;
    depth++;
  }

  return bestCard ?? el.parentElement;
}

// ── Show floating panel ───────────────────────────────────────────────────────

function showPanel(jobs: ExtractedJob[]) {
  const panel = document.createElement('div');
  panel.id    = PANEL_ID;

  // Show ALL jobs, grouped + scrollable
  const jobsHtml = jobs.map((j) => `
    <div class="ap-job-row">
      <div class="ap-job-info">
        <div class="ap-job-title">${escapeHtml(j.title)}</div>
        <div class="ap-job-company">
          ${escapeHtml(j.company || getDomain(j.applyUrl))}${j.location ? ' · ' + escapeHtml(j.location) : ''}
        </div>
      </div>
      <a class="ap-job-open" href="${escapeAttr(j.applyUrl)}" target="_blank" rel="noopener">Open</a>
    </div>
  `).join('');

  panel.innerHTML = `
    <div class="ap-header">
      <span class="ap-logo">✈</span>
      <span class="ap-title">ApplyPilot · ${jobs.length} job${jobs.length > 1 ? 's' : ''} found</span>
      <button class="ap-close" title="Dismiss">✕</button>
    </div>
    <div class="ap-jobs">${jobsHtml}</div>
    <button class="ap-save-btn">💾 Save all ${jobs.length} job${jobs.length > 1 ? 's' : ''}</button>
  `;

  document.body.appendChild(panel);

  panel.querySelector('.ap-close')?.addEventListener('click', removePanelIfExists);

  panel.querySelector('.ap-save-btn')?.addEventListener('click', async () => {
    const btn = panel.querySelector('.ap-save-btn') as HTMLButtonElement;
    btn.textContent = 'Saving…';
    btn.disabled    = true;

    chrome.runtime.sendMessage(
      { type: 'JOBS_EXTRACTED', payload: jobs },
      (response: { saved: number; duplicates: number }) => {
        if (response?.saved > 0) {
          btn.textContent = `✓ Saved ${response.saved} · ${response.duplicates} duplicates skipped`;
          btn.style.background = '#10B981';
        } else {
          btn.textContent = 'All already saved';
          btn.style.background = '#94A3B8';
        }
        setTimeout(removePanelIfExists, 3500);
      },
    );
  });

  // Auto-hide after 30 s (longer for bigger job lists)
  setTimeout(removePanelIfExists, 30000);
}

function removePanelIfExists() {
  document.getElementById(PANEL_ID)?.remove();
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id    = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 360px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.18);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      overflow: hidden;
      border: 1px solid #E2E8F0;
      animation: ap-slide-in .25s ease;
    }
    @keyframes ap-slide-in {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #${PANEL_ID} .ap-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: linear-gradient(135deg, #4F46E5, #6D28D9);
      color: #fff;
    }
    #${PANEL_ID} .ap-logo { font-size: 16px; }
    #${PANEL_ID} .ap-title { flex: 1; font-weight: 600; font-size: 13px; }
    #${PANEL_ID} .ap-close {
      background: none; border: none; color: #fff; cursor: pointer;
      font-size: 14px; opacity: .7; padding: 0 2px;
    }
    #${PANEL_ID} .ap-close:hover { opacity: 1; }
    #${PANEL_ID} .ap-jobs {
      padding: 6px 14px;
      max-height: 260px;
      overflow-y: auto;
    }
    #${PANEL_ID} .ap-job-row {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 0; border-bottom: 1px solid #F1F5F9;
    }
    #${PANEL_ID} .ap-job-row:last-child { border-bottom: none; }
    #${PANEL_ID} .ap-job-info { flex: 1; min-width: 0; }
    #${PANEL_ID} .ap-job-title {
      font-weight: 600; color: #1E293B;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${PANEL_ID} .ap-job-company {
      color: #64748B; font-size: 11px; margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${PANEL_ID} .ap-job-open {
      text-decoration: none; color: #4F46E5; font-size: 11px;
      font-weight: 600; white-space: nowrap;
      padding: 3px 8px; border-radius: 4px;
      border: 1px solid #E0E7FF; background: #EEF2FF;
    }
    #${PANEL_ID} .ap-job-open:hover { background: #E0E7FF; }
    #${PANEL_ID} .ap-save-btn {
      display: block; width: 100%; padding: 10px 14px;
      background: #4F46E5; color: #fff; border: none;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: background .15s;
    }
    #${PANEL_ID} .ap-save-btn:hover:not(:disabled) { background: #4338CA; }
    #${PANEL_ID} .ap-save-btn:disabled { cursor: default; }
  `;
  document.head.appendChild(style);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise<{ enableGmailDetection: boolean }>((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
      resolve(s ?? { enableGmailDetection: true });
    });
  });
}

function sanitiseSubjectToTitle(subject: string): string {
  return subject
    .replace(/^(\[.*?\]\s*)+/, '')
    .replace(/^\d+\s+new\s+jobs?\s*[:–-]?\s*/i, '')
    .trim()
    .slice(0, 80);
}

const LOCATION_PATTERN = /\b(Berlin|Munich|München|Hamburg|Frankfurt|Cologne|Köln|Stuttgart|Düsseldorf|Leipzig|Dresden|Nuremberg|Nürnberg|Karlsruhe|Bamberg|Lottstetten|Dortmund|Essen|Hannover|Bremen|Bonn|Mannheim|Augsburg|Wiesbaden|Germany|Deutschland|Amsterdam|Rotterdam|Netherlands|London|UK|Ireland|Dublin|Paris|France|Vienna|Austria|Zurich|Switzerland|Stockholm|Sweden|Copenhagen|Denmark|Helsinki|Finland|Madrid|Barcelona|Spain|Milan|Rome|Italy|Luxembourg|Brussels|Belgium|Prague|Czech|Warsaw|Poland|Lisbon|Portugal|Oslo|Norway|Remote|Fully\s*Remote|On-site|Hybrid)\b/gi;

function extractLocation(text: string): string {
  const matches = text.match(LOCATION_PATTERN);
  if (!matches) return '';
  // Dedupe case-insensitively, keep first 2 distinct locations
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const m of matches) {
    const key = m.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m.trim());
    if (unique.length >= 2) break;
  }
  return unique.join(', ');
}

/**
 * Deduplicate jobs using TWO keys:
 *   1. URL-based (strip tracking params, extract LinkedIn job ID)
 *   2. Content-based (title + company + location) — catches same job with different tracking URLs
 * A job is a duplicate if EITHER key was already seen.
 */
function deduplicateJobs(jobs: ExtractedJob[]): ExtractedJob[] {
  const seenUrls    = new Set<string>();
  const seenContent = new Set<string>();

  return jobs.filter((j) => {
    // URL key: extract LinkedIn job ID if present, otherwise strip query
    let urlKey = j.applyUrl.toLowerCase();
    const linkedInMatch = urlKey.match(/\/jobs\/view\/(\d+)/);
    if (linkedInMatch) {
      urlKey = `li:${linkedInMatch[1]}`;
    } else {
      urlKey = urlKey.split('?')[0];
    }

    // Content key: normalised title + company + location
    const contentKey = [
      j.title.toLowerCase().replace(/\s+/g, ' ').trim(),
      j.company.toLowerCase().replace(/\s+/g, ' ').trim(),
      j.location.toLowerCase().replace(/\s+/g, ' ').trim(),
    ].join('|');

    if (seenUrls.has(urlKey) || seenContent.has(contentKey)) return false;
    seenUrls.add(urlKey);
    seenContent.add(contentKey);
    return true;
  });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
