import React, { useCallback, useEffect, useState } from 'react';
import type { Job, ApplicationStats, Settings } from '../types';
import { getAllJobs, saveJobs, generateId, getSettings, saveSettings } from '../shared/storage';
import { calcStats } from '../shared/utils';
import JobList from './components/JobList';

type Tab = 'jobs' | 'page' | 'stats' | 'profile';

export default function Popup() {
  const [tab,     setTab]     = useState<Tab>('jobs');
  const [jobs,    setJobs]    = useState<Job[]>([]);
  const [stats,   setStats]   = useState<ApplicationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  const loadJobs = useCallback(() => {
    getAllJobs().then((all) => {
      setJobs(all);
      setStats(calcStats(all));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    loadJobs();
    getSettings().then((s) => setEnabled(s.enabled));
  }, [loadJobs]);

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    await saveSettings({ enabled: next });
    // Update badge to show disabled state
    chrome.action?.setBadgeText?.({ text: next ? '' : 'OFF' });
    chrome.action?.setBadgeBackgroundColor?.({ color: '#EF4444' });
  };

  const openOptions = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    window.close();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 560 }}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="header">
        <span className="header-logo">✈</span>
        <div style={{ flex: 1 }}>
          <div className="header-title">
            ApplyPilot
            <span className="header-subtitle">{enabled ? 'Active' : 'Paused'}</span>
          </div>
        </div>
        {/* Power toggle */}
        <button
          onClick={toggleEnabled}
          title={enabled ? 'Pause ApplyPilot' : 'Resume ApplyPilot'}
          style={{
            background: enabled ? '#10B981' : '#EF4444',
            color: '#fff', border: 'none', borderRadius: 20,
            padding: '4px 10px', fontSize: 11, fontWeight: 700,
            cursor: 'pointer', marginRight: 6, transition: 'background 0.2s',
          }}
        >
          {enabled ? '● ON' : '○ OFF'}
        </button>
        {stats && (
          <div style={{ textAlign: 'center', fontSize: 11, opacity: .85, marginRight: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{stats.total}</div>
            <div>jobs</div>
          </div>
        )}
        <button className="header-settings" onClick={openOptions} title="Settings">⚙️</button>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────── */}
      <div className="tabs">
        <button className={`tab ${tab === 'jobs'  ? 'active' : ''}`} onClick={() => setTab('jobs')}>
          📋 Jobs {stats?.new ? <span style={{ color: '#4F46E5', fontWeight: 800 }}>({stats.new})</span> : null}
        </button>
        <button className={`tab ${tab === 'page'  ? 'active' : ''}`} onClick={() => setTab('page')}>
          📝 This Page
        </button>
        <button className={`tab ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}>
          📊 Stats
        </button>
        <button className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>
          👤 Profile
        </button>
      </div>

      {/* ── Tab content ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* Jobs list */}
        {tab === 'jobs' && (
          loading
            ? <div className="loading-state">Loading…</div>
            : <JobList jobs={jobs} onUpdate={loadJobs} />
        )}

        {/* This Page */}
        {tab === 'page' && <PageTab />}

        {/* Stats */}
        {tab === 'stats' && stats && <StatsTab stats={stats} jobs={jobs} />}

        {/* Quick Profile */}
        {tab === 'profile' && <QuickProfileTab onOpenFull={openOptions} />}
      </div>
    </div>
  );
}

// ── This Page Tab ─────────────────────────────────────────────────────────────

interface DetectedJobInfo {
  hasJob:   boolean;
  title:    string;
  company:  string;
  location: string;
  url:      string;
  atsName:  string;
}

function PageTab() {
  const [tabUrl,       setTabUrl]       = useState('');
  const [tabId,        setTabId]        = useState<number | null>(null);
  const [scanning,     setScanning]     = useState(true);
  const [hasForm,      setHasForm]      = useState(false);
  const [fieldCount,   setFieldCount]   = useState(0);
  const [detectedJob,  setDetectedJob]  = useState<DetectedJobInfo | null>(null);
  const [filling,      setFilling]      = useState(false);
  const [saveMsg,      setSaveMsg]      = useState('');
  const [contentReady, setContentReady] = useState(true);  // assume ready; set false on lastError

  const scan = useCallback((tid: number, url: string) => {
    setScanning(true);
    setHasForm(false);
    setFieldCount(0);
    setDetectedJob(null);
    setSaveMsg('');
    setContentReady(true);

    // 1. Detect form fields
    chrome.tabs.sendMessage(tid, { type: 'GET_DETECTED_FIELDS' }, (resp) => {
      if (chrome.runtime.lastError) {
        // Content script not injected yet (e.g. on chrome:// or fresh page)
        setContentReady(false);
        setScanning(false);
        return;
      }
      setHasForm((resp?.count ?? 0) > 0);
      setFieldCount(resp?.count ?? 0);
    });

    // 2. Detect job info from the page
    chrome.tabs.sendMessage(tid, { type: 'DETECT_JOB_ON_PAGE' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        setScanning(false);
        return;
      }
      if (resp.hasJob) {
        setDetectedJob({
          hasJob:   true,
          title:    resp.title   ?? '',
          company:  resp.company ?? '',
          location: resp.location ?? '',
          url:      resp.url     ?? url,
          atsName:  resp.atsName ?? '',
        });
      }
      setScanning(false);
    });
  }, []);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const url = tab?.url ?? '';
      const tid = tab?.id  ?? null;
      setTabUrl(url);
      setTabId(tid);
      if (tid && url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')) {
        scan(tid, url);
      } else {
        setScanning(false);
      }
    });
  }, [scan]);

  const handleRescan = () => {
    if (tabId && tabUrl) scan(tabId, tabUrl);
  };

  const triggerFill = () => {
    if (!tabId) return;
    setFilling(true);
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_FILL_PANEL' }, () => {
      // Close popup after a short delay so the panel has time to open
      if (chrome.runtime.lastError) {
        setFilling(false);
        return;
      }
      setTimeout(() => window.close(), 200);
    });
  };

  const saveDetectedJob = async () => {
    if (!detectedJob) return;
    const job: Job = {
      id:           generateId(),
      title:        detectedJob.title   || 'Unknown title',
      company:      detectedJob.company || 'Unknown company',
      location:     detectedJob.location || '',
      applyUrl:     detectedJob.url,
      sourceUrl:    detectedJob.url,
      sourceDomain: (() => { try { return new URL(detectedJob.url).hostname; } catch { return ''; } })(),
      status:       'new',
      notes:        '',
      savedAt:      Date.now(),
    };
    const { saved, duplicates } = await saveJobs([job]);
    if (duplicates > 0) {
      setSaveMsg('Already saved!');
    } else if (saved > 0) {
      setSaveMsg('✅ Job saved!');
    }
  };

  const isRegularPage = tabUrl &&
    !tabUrl.startsWith('chrome://') &&
    !tabUrl.startsWith('chrome-extension://') &&
    !tabUrl.startsWith('about:');

  return (
    <div className="page-tab-inner">

      {/* Not a web page */}
      {!isRegularPage && (
        <>
          <div className="empty-icon" style={{ fontSize: 28, textAlign: 'center' }}>🌐</div>
          <p className="page-tab-sub" style={{ textAlign: 'center' }}>
            Navigate to a job application page and ApplyPilot will detect form fields automatically.
          </p>
        </>
      )}

      {/* Regular web page */}
      {isRegularPage && (
        <>
          {/* URL + Rescan */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 10 }}>
            <div style={{ flex: 1, fontSize: 11, color: '#64748B', wordBreak: 'break-all', lineHeight: 1.4 }}>
              {tabUrl.slice(0, 70)}{tabUrl.length > 70 ? '…' : ''}
            </div>
            <button
              onClick={handleRescan}
              disabled={scanning}
              style={{
                flexShrink: 0, background: 'none', border: '1px solid #CBD5E1',
                borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: scanning ? 'default' : 'pointer',
                color: '#475569', whiteSpace: 'nowrap',
              }}
            >
              {scanning ? '⏳' : '🔄'} {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </div>

          {/* Content script not ready */}
          {!contentReady && (
            <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400E', marginBottom: 8 }}>
              ⚠️ ApplyPilot couldn't reach this page. Try refreshing the tab, then rescan.
            </div>
          )}

          {/* Detected job card */}
          {contentReady && detectedJob && (
            <div style={{
              background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8,
              padding: '10px 12px', marginBottom: 8, fontSize: 12,
            }}>
              <div style={{ fontWeight: 700, color: '#1E40AF', marginBottom: 2 }}>
                💼 {detectedJob.title || 'Job detected'}
              </div>
              {detectedJob.company && (
                <div style={{ color: '#3B82F6', marginBottom: 2 }}>{detectedJob.company}</div>
              )}
              {(detectedJob.location || detectedJob.atsName) && (
                <div style={{ color: '#6B7280', fontSize: 11 }}>
                  {[detectedJob.location, detectedJob.atsName && `via ${detectedJob.atsName}`]
                    .filter(Boolean).join(' · ')}
                </div>
              )}
              {saveMsg ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#059669', fontWeight: 600 }}>{saveMsg}</div>
              ) : (
                <button
                  onClick={saveDetectedJob}
                  style={{
                    marginTop: 8, background: '#2563EB', color: '#fff', border: 'none',
                    borderRadius: 6, padding: '4px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  💾 Save this job
                </button>
              )}
            </div>
          )}

          {/* No job detected and content script is ready */}
          {contentReady && !detectedJob && !scanning && (
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: 10, fontSize: 12, color: '#64748B', marginBottom: 8 }}>
              🔍 No job posting detected on this page.
            </div>
          )}

          {/* Form fields status */}
          {contentReady && (
            <div style={{ marginBottom: 8 }}>
              {hasForm ? (
                <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: 10, fontSize: 12, color: '#065F46' }}>
                  ✅ {fieldCount} form field{fieldCount !== 1 ? 's' : ''} detected — ready to autofill.
                </div>
              ) : scanning ? null : (
                <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400E' }}>
                  📋 No fillable fields found yet. Try scrolling to the form first, then rescan.
                </div>
              )}
            </div>
          )}

          {/* Fill button */}
          {contentReady && (
            <button
              className="page-fill-btn"
              onClick={triggerFill}
              disabled={filling || scanning}
              style={{ opacity: (filling || scanning) ? 0.6 : 1, background: hasForm ? undefined : '#6B7280' }}
            >
              {filling ? '⏳ Opening…' : '🚀 Open Fill Panel'}
            </button>
          )}

          <p className="page-warning">💡 Review filled fields before submitting.</p>
        </>
      )}
    </div>
  );
}

// ── Quick Profile Tab ─────────────────────────────────────────────────────────

function QuickProfileTab({ onOpenFull }: { onOpenFull: () => void }) {
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<{ name: string; size: number } | null>(null);

  useEffect(() => {
    getSettings().then(setSettingsState);
    // Check if resume exists via settings (filename is stored there)
    getSettings().then((s) => {
      if (s.resumeFileName) {
        setResumeInfo({ name: s.resumeFileName, size: 0 });
      }
    });
  }, []);

  const handleChange = (field: string, value: string) => {
    if (!settings) return;
    setSettingsState({
      ...settings,
      profile: { ...settings.profile, [field]: value },
    });
    setSaved(false);
  };

  const handleSave = async () => {
    if (!settings) return;
    await saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) return <div className="loading-state">Loading…</div>;

  const p = settings.profile;
  const fields: Array<{ key: string; label: string; value: string; type?: string }> = [
    { key: 'firstName', label: 'First Name', value: p.firstName },
    { key: 'lastName',  label: 'Last Name',  value: p.lastName },
    { key: 'email',     label: 'Email',       value: p.email, type: 'email' },
    { key: 'phone',     label: 'Phone',       value: p.phone, type: 'tel' },
    { key: 'city',      label: 'City',        value: p.city },
    { key: 'country',   label: 'Country',     value: p.country },
    { key: 'linkedinUrl', label: 'LinkedIn',  value: p.linkedinUrl, type: 'url' },
    { key: 'githubUrl',   label: 'GitHub',    value: p.githubUrl, type: 'url' },
    { key: 'noticePeriod', label: 'Notice Period', value: p.noticePeriod },
    { key: 'yearsOfExperience', label: 'Years Exp.', value: p.yearsOfExperience },
  ];

  return (
    <div style={{ overflow: 'auto', maxHeight: 470, padding: '8px 12px' }}>
      {/* Resume status */}
      <div style={{
        background: resumeInfo ? '#ECFDF5' : '#FEF3C7',
        border: `1px solid ${resumeInfo ? '#A7F3D0' : '#FDE68A'}`,
        borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 11,
        color: resumeInfo ? '#065F46' : '#92400E',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {resumeInfo
          ? <>📄 <strong>{resumeInfo.name}</strong> — ready to upload</>
          : <>⚠️ No resume uploaded — <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={onOpenFull}>upload in Settings</span></>
        }
      </div>

      {/* Quick fields */}
      {fields.map(({ key, label, value, type }) => (
        <div key={key} style={{ marginBottom: 4 }}>
          <label style={{ fontSize: 10, color: '#64748B', fontWeight: 600, display: 'block', marginBottom: 1 }}>
            {label}
          </label>
          <input
            type={type || 'text'}
            value={value}
            onChange={(e) => handleChange(key, e.target.value)}
            style={{
              width: '100%', padding: '5px 8px', fontSize: 12, border: '1px solid #E2E8F0',
              borderRadius: 6, outline: 'none', boxSizing: 'border-box',
            }}
            placeholder={label}
          />
        </div>
      ))}

      {/* Save + Full settings */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          onClick={handleSave}
          style={{
            flex: 1, background: '#4F46E5', color: '#fff', border: 'none',
            borderRadius: 6, padding: '7px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}
        >
          {saved ? '✓ Saved!' : '💾 Save'}
        </button>
        <button
          onClick={onOpenFull}
          style={{
            flex: 1, background: '#F1F5F9', color: '#475569', border: '1px solid #CBD5E1',
            borderRadius: 6, padding: '7px 0', fontSize: 12, cursor: 'pointer',
          }}
        >
          Full Settings →
        </button>
      </div>
    </div>
  );
}

// ── Stats Tab ─────────────────────────────────────────────────────────────────

function StatsTab({ stats, jobs }: { stats: ApplicationStats; jobs: Job[] }) {
  const recentApplied = jobs
    .filter((j) => j.status === 'applied' && j.appliedAt)
    .sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
    .slice(0, 5);

  const successRate = stats.total > 0
    ? Math.round((stats.applied / stats.total) * 100)
    : 0;

  const maxDaily = Math.max(...stats.dailyCounts.map((d) => d.count), 1);

  return (
    <div style={{ overflow: 'auto', maxHeight: '470px' }}>
      {/* Top stats row */}
      <div className="stats-grid">
        <StatCard value={stats.today}   label="Today"        color="#10B981" />
        <StatCard value={stats.applied} label="Applied"      color="#4F46E5" />
        <StatCard value={stats.thisWeek} label="This week"   color="#F59E0B" />
        <StatCard value={`${successRate}%`} label="Apply rate" color="#8B5CF6" />
        <StatCard value={stats.streak > 0 ? `${stats.streak}🔥` : '0'} label="Day streak" color="#EF4444" />
        <StatCard value={stats.new}     label="In queue"     color="#6366F1" />
      </div>

      {/* Daily bar chart */}
      <div style={{ padding: '8px 14px 4px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#1E293B', marginBottom: 8 }}>
          Last 7 Days
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 60 }}>
          {stats.dailyCounts.map((d, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>{d.count || ''}</span>
              <div style={{
                width: '100%', borderRadius: '4px 4px 0 0',
                background: d.count > 0 ? '#4F46E5' : '#E2E8F0',
                height: Math.max(d.count > 0 ? (d.count / maxDaily) * 44 : 3, 3),
                transition: 'height 0.3s',
              }} />
              <span style={{ fontSize: 9, color: '#94A3B8' }}>{d.date}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Source breakdown */}
      {stats.bySource.length > 0 && (
        <div style={{ padding: '8px 14px 4px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1E293B', marginBottom: 6 }}>
            By Source
          </div>
          {stats.bySource.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{
                flex: 1, background: '#F1F5F9', borderRadius: 4, height: 18, overflow: 'hidden', position: 'relative',
              }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4,
                  background: ['#4F46E5', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4'][i % 6],
                  width: `${stats.applied > 0 ? (s.count / stats.applied) * 100 : 0}%`,
                  transition: 'width 0.3s',
                }} />
                <span style={{ position: 'relative', fontSize: 10, fontWeight: 600, color: '#1E293B', padding: '0 6px', lineHeight: '18px' }}>
                  {s.source}
                </span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', minWidth: 24, textAlign: 'right' }}>{s.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent applications */}
      {recentApplied.length > 0 && (
        <div style={{ padding: '8px 14px 14px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1E293B', marginBottom: 8 }}>
            Recent Applications
          </div>
          {recentApplied.map((job) => (
            <div key={job.id} style={{
              display: 'flex', justifyContent: 'space-between', padding: '6px 0',
              borderBottom: '1px solid #F1F5F9', fontSize: 12,
            }}>
              <div>
                <div style={{ fontWeight: 600 }}>{job.title}</div>
                <div style={{ color: '#64748B', fontSize: 11 }}>{job.company}</div>
              </div>
              <div style={{ fontSize: 10, color: '#94A3B8', textAlign: 'right', marginLeft: 8 }}>
                {job.appliedAt ? new Date(job.appliedAt).toLocaleDateString() : '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ value, label, color }: { value: string | number; label: string; color: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
