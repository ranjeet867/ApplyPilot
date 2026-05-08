/**
 * Shared utility functions for ApplyPilot
 */

import type { Job, ApplicationStats, ExtractedJob } from '../types';

// ── Date helpers ──────────────────────────────────────────────────────────────

export function timeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const m    = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function isWithinDays(epochMs: number, days: number): boolean {
  return Date.now() - epochMs < days * 86_400_000;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function calcStats(jobs: Job[]): ApplicationStats {
  const applied = jobs.filter((j) => j.status === 'applied');
  const thisWeek = jobs.filter((j) => isWithinDays(j.savedAt, 7)).length;

  // ── Daily counts (last 7 days) ──────────────────────────────────────────────
  const dailyCounts: Array<{ date: string; count: number }> = [];
  const DAY_MS = 86_400_000;
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = dayStart.getTime() + DAY_MS;
    const label = dayStart.toLocaleDateString('en-US', { weekday: 'short' });
    const count = applied.filter((j) => {
      const t = j.appliedAt ?? j.savedAt;
      return t >= dayStart.getTime() && t < dayEnd;
    }).length;
    dailyCounts.push({ date: label, count });
  }

  // ── Today's count ───────────────────────────────────────────────────────────
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = applied.filter((j) => (j.appliedAt ?? j.savedAt) >= todayStart.getTime()).length;

  // ── Source breakdown (top 5 domains) ────────────────────────────────────────
  const sourceMap = new Map<string, number>();
  for (const j of applied) {
    const src = j.sourceDomain ? j.sourceDomain.replace(/^www\./, '') : 'unknown';
    // Simplify: keep just the main domain part
    const short = src.split('.').slice(-2).join('.');
    sourceMap.set(short, (sourceMap.get(short) || 0) + 1);
  }
  const bySource = [...sourceMap.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // ── Streak (consecutive days with ≥1 application) ──────────────────────────
  let streak = 0;
  const check = new Date(todayStart); // clone so we don't mutate todayStart
  let skippedToday = false;
  for (let safety = 0; safety < 365; safety++) {
    const dayStart = check.getTime();
    const dayEnd   = dayStart + DAY_MS;
    const hasApp   = applied.some((j) => {
      const t = j.appliedAt ?? j.savedAt;
      return t >= dayStart && t < dayEnd;
    });
    if (hasApp) { streak++; check.setDate(check.getDate() - 1); }
    else if (!skippedToday && dayStart === todayStart.getTime()) {
      // Today has no apps yet — check if yesterday started a streak
      skippedToday = true;
      check.setDate(check.getDate() - 1);
    }
    else break;
  }

  return {
    total:    jobs.length,
    applied:  applied.length,
    new:      jobs.filter((j) => j.status === 'new').length,
    skipped:  jobs.filter((j) => j.status === 'skipped').length,
    failed:   jobs.filter((j) => j.status === 'failed').length,
    thisWeek,
    dailyCounts,
    bySource,
    streak,
    today,
  };
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const JOB_DOMAINS = [
  'greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com',
  'jobvite.com', 'icims.com', 'smartrecruiters.com', 'taleo.net',
  'bamboohr.com', 'recruitee.com', 'personio.de', 'ashbyhq.com',
  'stepstone.de', 'indeed.com', 'glassdoor.com', 'xing.com',
  'jobs.de', 'careers.microsoft.com', 'amazon.jobs', 'careers.google.com',
  'careers.spotify.com', 'jobs.zalando.com',
];

export function isJobApplicationPage(url: string): boolean {
  const domain = getDomain(url);
  return JOB_DOMAINS.some((d) => domain.includes(d));
}

export function isJobUrl(url: string): boolean {
  try {
    const lower = url.toLowerCase();
    return (
      lower.includes('/jobs/') ||
      lower.includes('/career') ||
      lower.includes('/apply') ||
      lower.includes('/position') ||
      lower.includes('/vacancy') ||
      lower.includes('/opening') ||
      lower.includes('/job-') ||
      isJobApplicationPage(url)
    );
  } catch {
    return false;
  }
}

// ── Job keywords (Germany-focused) ───────────────────────────────────────────

const JOB_KEYWORDS = [
  'golang', 'go developer', 'go engineer',
  'php developer', 'php engineer',
  'kubernetes', 'k8s',
  'platform engineer', 'platform developer',
  'senior software engineer', 'senior engineer', 'senior developer',
  'ai engineer', 'ai agent', 'llm engineer',
  'product engineer', 'backend engineer', 'backend developer',
  'sre', 'devops', 'cloud engineer',
];

export function isJobEmail(subject: string, snippet: string): boolean {
  const lower = (subject + ' ' + snippet).toLowerCase();
  return (
    lower.includes('job alert') ||
    lower.includes('new job') ||
    lower.includes('job match') ||
    lower.includes('new opening') ||
    lower.includes('hiring') ||
    lower.includes('position available') ||
    lower.includes('jobs in') ||
    JOB_KEYWORDS.some((kw) => lower.includes(kw))
  );
}

// ── String helpers ────────────────────────────────────────────────────────────

export function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

export function sanitiseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractCompanyFromTitle(title: string): { title: string; company: string } {
  // "Senior Go Developer at Zalando" → { title: "Senior Go Developer", company: "Zalando" }
  const atMatch = title.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { title: atMatch[1].trim(), company: atMatch[2].trim() };

  // "Zalando | Senior Go Developer"
  const pipeMatch = title.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return { title: pipeMatch[2].trim(), company: pipeMatch[1].trim() };

  // "Senior Go Developer – Zalando"
  const dashMatch = title.match(/^(.+?)\s*[–—-]\s*(.+)$/);
  if (dashMatch) return { title: dashMatch[1].trim(), company: dashMatch[2].trim() };

  return { title, company: '' };
}

// ── ID generator ──────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Job de-duplication ────────────────────────────────────────────────────────

export function deduplicateJobs(incoming: ExtractedJob[], existing: Job[]): ExtractedJob[] {
  const existUrls = new Set(
    existing.map((j) => normaliseJobUrl(j.applyUrl))
  );
  return incoming.filter((j) => !existUrls.has(normaliseJobUrl(j.applyUrl)));
}

export function normaliseJobUrl(url: string): string {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'referer', 'source'].forEach((p) =>
      u.searchParams.delete(p),
    );
    return (u.origin + u.pathname).toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

// ── Status colours ────────────────────────────────────────────────────────────

export const STATUS_COLOR: Record<Job['status'], string> = {
  new:     '#6366F1',  // indigo
  opened:  '#F59E0B',  // amber
  applied: '#10B981',  // green
  skipped: '#94A3B8',  // slate
  failed:  '#EF4444',  // red
};

export const STATUS_LABEL: Record<Job['status'], string> = {
  new:     'New',
  opened:  'Opened',
  applied: 'Applied ✓',
  skipped: 'Skipped',
  failed:  'Failed',
};
