/**
 * Typed wrappers around chrome.storage.local
 * All settings + job list live here.
 * Resume binary lives in IndexedDB (see db.ts).
 */

import type { Job, Settings, UserProfile, QueueState } from '../types';

const JOBS_KEY     = 'ap_jobs';
const SETTINGS_KEY = 'ap_settings';
const QUEUE_KEY    = 'ap_queue';

// ── Default values ────────────────────────────────────────────────────────────

export const DEFAULT_PROFILE: UserProfile = {
  name:                 '',
  firstName:            '',
  lastName:             '',
  email:                '',
  phone:                '',
  city:                 '',
  country:              '',
  salaryMin:            '',
  salaryMax:            '',
  salaryCurrency:       'EUR',
  noticePeriod:         '',
  noticePeriodUnit:     'months',
  earliestJoiningDate:  '',
  workModePreference:   'hybrid',
  relocationPreference: false,
  germanPR:             false,
  noVisaSponsorship:    false,
  workPermitType:       '',
  gender:               '',
  raceEthnicity:        '',
  veteranStatus:        '',
  disabilityStatus:     '',
  ageRange:             '',
  dateOfBirth:          '',
  linkedinUrl:          '',
  githubUrl:            '',
  portfolioUrl:         '',
  targetRoles:          [],
  targetLocations:      [],
  skills:               [],
  yearsOfExperience:    '',
  currentJobTitle:      '',
  currentCompany:       '',
  summary:              '',
};

export const DEFAULT_SETTINGS: Settings = {
  openaiApiKey:            '',
  anthropicApiKey:         '',
  automationMode:          'assist',
  aiProvider:              'anthropic',
  aiModel:                 'claude-haiku-4-5-20251001',
  resumeFileName:          '',
  resumeText:              '',
  resumeDataUrl:           '',
  coverLetterFileName:     '',
  coverLetterDataUrl:      '',
  profile:                 DEFAULT_PROFILE,
  jobSearchKeywords:       [],
  jobSearchLocations:      [],
  maxJobAgeDays:           7,
  enableGmailDetection:    true,
  enableLinkedInDetection: true,
  enabled:                 true,
  disabledSites:           [],
  smartActivation:         true,
};

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      const saved = result[SETTINGS_KEY] as Partial<Settings> | undefined;
      if (!saved) {
        resolve(DEFAULT_SETTINGS);
        return;
      }
      // Deep merge: keep defaults for any missing keys
      resolve({
        ...DEFAULT_SETTINGS,
        ...saved,
        profile: { ...DEFAULT_PROFILE, ...(saved.profile ?? {}) },
      });
    });
  });
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      const current = (result[SETTINGS_KEY] as Settings) ?? DEFAULT_SETTINGS;
      const merged  = {
        ...current,
        ...settings,
        profile: { ...current.profile, ...(settings.profile ?? {}) },
      };
      chrome.storage.local.set({ [SETTINGS_KEY]: merged }, () => {
        if (chrome.runtime.lastError) {
          console.error('[ApplyPilot] saveSettings failed:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  });
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export async function getAllJobs(): Promise<Job[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(JOBS_KEY, (result) => {
      resolve((result[JOBS_KEY] as Job[]) ?? []);
    });
  });
}

export async function saveJob(job: Job): Promise<void> {
  const jobs = await getAllJobs();
  const idx  = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.unshift(job);
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOBS_KEY]: jobs }, resolve);
  });
}

export async function saveJobs(newJobs: Job[]): Promise<{ saved: number; duplicates: number }> {
  const existing  = await getAllJobs();
  const existUrls = new Set(existing.map((j) => normaliseUrl(j.applyUrl)));
  const toAdd     = newJobs.filter((j) => !existUrls.has(normaliseUrl(j.applyUrl)));

  const merged = [...toAdd, ...existing];
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOBS_KEY]: merged }, () => {
      resolve({ saved: toAdd.length, duplicates: newJobs.length - toAdd.length });
    });
  });
}

export async function updateJobStatus(
  id: string,
  status: Job['status'],
  extra?: Partial<Job>,
): Promise<void> {
  const jobs = await getAllJobs();
  const idx  = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return;
  jobs[idx] = { ...jobs[idx], status, ...extra };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOBS_KEY]: jobs }, resolve);
  });
}

export async function deleteJob(id: string): Promise<void> {
  const jobs = await getAllJobs();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOBS_KEY]: jobs.filter((j) => j.id !== id) }, resolve);
  });
}

/** Delete multiple jobs in a single atomic operation (avoids race condition with parallel deleteJob calls). */
export async function deleteJobs(ids: string[]): Promise<void> {
  const idSet = new Set(ids);
  const jobs = await getAllJobs();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOBS_KEY]: jobs.filter((j) => !idSet.has(j.id)) }, resolve);
  });
}

export async function findJobByUrl(url: string): Promise<Job | undefined> {
  const jobs = await getAllJobs();
  const norm = normaliseUrl(url);
  return jobs.find((j) => normaliseUrl(j.applyUrl) === norm);
}

/**
 * Find jobs with similar company + title (fuzzy match).
 * Warns users they may have already applied to the same role
 * even if the URL differs (reposted listing, different ATS link).
 */
export async function findSimilarJobs(
  company: string,
  title: string,
  excludeUrl?: string,
): Promise<Job[]> {
  if (!company && !title) return [];
  const jobs = await getAllJobs();
  const normCompany = normalizeFuzzy(company);
  const normTitle   = normalizeFuzzy(title);
  const excludeNorm = excludeUrl ? normaliseUrl(excludeUrl) : '';

  return jobs.filter((j) => {
    if (excludeNorm && normaliseUrl(j.applyUrl) === excludeNorm) return false;
    if (j.status !== 'applied' && j.status !== 'opened') return false;

    const jCompany = normalizeFuzzy(j.company);
    const jTitle   = normalizeFuzzy(j.title);

    // Skip very short names to avoid false positives (e.g. "AI" matching everything)
    const companyMatch = normCompany.length > 2 && jCompany.length > 2 && (
      jCompany.includes(normCompany) ||
      normCompany.includes(jCompany) ||
      fuzzyScore(normCompany, jCompany) > 0.7
    );

    const titleMatch = normTitle.length > 3 && jTitle.length > 3 && (
      titleKeywordOverlap(normTitle, jTitle) >= 0.5
    );

    return companyMatch && titleMatch;
  });
}

function normalizeFuzzy(s: string): string {
  return s.toLowerCase()
    .replace(/\b(gmbh|inc|ltd|llc|corp|ag|se|co|limited|plc|pty)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function fuzzyScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2);
      m.set(bi, (m.get(bi) || 0) + 1);
    }
    return m;
  };
  const aBi = bigrams(a), bBi = bigrams(b);
  let overlap = 0;
  for (const [bi, count] of aBi) overlap += Math.min(count, bBi.get(bi) || 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function titleKeywordOverlap(a: string, b: string): number {
  const STOP = new Set(['the','a','an','and','or','for','in','at','of','to','with','mfd','mwd','fmd']);
  const toKw = (s: string) => s.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
  const aW = toKw(a), bW = new Set(toKw(b));
  if (aW.length === 0 || bW.size === 0) return 0;
  const matches = aW.filter(w => bW.has(w)).length;
  // Jaccard-like: shared / larger set → prevents inflated scores
  return matches / Math.max(aW.length, bW.size);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Returns a stable fingerprint for deduplication.
 *
 * Priority:
 *  1. For known platforms — extract the numeric/slug job ID from the URL path.
 *     This handles LinkedIn comm/jobs vs jobs/view, Greenhouse token variants, etc.
 *  2. Strip common tracking params and normalise origin+path+remaining query.
 */
export function normaliseUrl(url: string): string {
  try {
    const u    = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;

    // ── LinkedIn ──────────────────────────────────────────────────────────────
    // https://www.linkedin.com/jobs/view/4123456789/
    // https://www.linkedin.com/comm/jobs/view/4123456789/?refId=…
    if (host.includes('linkedin.com')) {
      const m = path.match(/\/jobs\/view\/(\d+)/);
      if (m) return `linkedin.com/jobs/view/${m[1]}`;
    }

    // ── Greenhouse ────────────────────────────────────────────────────────────
    // https://boards.greenhouse.io/company/jobs/12345
    // https://company.greenhouse.io/jobs/12345?gh_jid=12345
    if (host.includes('greenhouse.io')) {
      const m = path.match(/\/jobs\/(\d+)/);
      if (m) return `greenhouse.io/jobs/${m[1]}`;
    }

    // ── Lever ─────────────────────────────────────────────────────────────────
    // https://jobs.lever.co/company/uuid-slug
    if (host.includes('lever.co')) {
      const m = path.match(/\/([^/]+)\/([a-f0-9-]{36})/);
      if (m) return `lever.co/${m[1]}/${m[2]}`;
    }

    // ── Ashby ─────────────────────────────────────────────────────────────────
    // https://jobs.ashbyhq.com/company/uuid
    if (host.includes('ashbyhq.com')) {
      const m = path.match(/\/([^/]+)\/([a-f0-9-]{36})/);
      if (m) return `ashbyhq.com/${m[1]}/${m[2]}`;
    }

    // ── Indeed ────────────────────────────────────────────────────────────────
    // https://de.indeed.com/viewjob?jk=abc123def456
    // https://www.indeed.com/jobs?vjk=abc123
    if (host.includes('indeed.com')) {
      const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
      if (jk) return `indeed.com/jk/${jk}`;
    }

    // ── Glassdoor ─────────────────────────────────────────────────────────────
    // https://www.glassdoor.com/job-listing/...-JVTO123456.htm
    if (host.includes('glassdoor.com') || host.includes('glassdoor.de')) {
      const m = path.match(/JV_KO\d+,\d+_KE\d+,\d+\.htm|JVTO?(\d+)\.htm/i) ||
                path.match(/-(\d{6,})\./);
      if (m) return `glassdoor.com/${m[1] ?? m[0]}`;
    }

    // ── StepStone ─────────────────────────────────────────────────────────────
    // https://www.stepstone.de/stellenangebote--xyz--12345678.html
    if (host.includes('stepstone.de')) {
      const m = path.match(/--(\d{6,})/);
      if (m) return `stepstone.de/${m[1]}`;
    }

    // ── Xing ──────────────────────────────────────────────────────────────────
    // https://www.xing.com/jobs/berlin-senior-golang-1234567
    if (host.includes('xing.com')) {
      const m = path.match(/\/jobs\/[^/]+-(\d{5,})/);
      if (m) return `xing.com/${m[1]}`;
    }

    // ── Generic fallback: strip tracking params ───────────────────────────────
    const TRACKING_PARAMS = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'ref', 'referer', 'refId', 'trackingId', 'trk', 'src', 'source',
    ];
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    return (u.origin + u.pathname + (u.search || '')).toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────────

export async function getQueue(): Promise<QueueState | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(QUEUE_KEY, (result) => {
      resolve((result[QUEUE_KEY] as QueueState) ?? null);
    });
  });
}

export async function saveQueue(state: QueueState): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [QUEUE_KEY]: state }, resolve);
  });
}

export async function clearQueue(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(QUEUE_KEY, resolve);
  });
}
