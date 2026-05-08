import React, { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../types';
import { getSettings, saveSettings, DEFAULT_SETTINGS, DEFAULT_PROFILE } from '../shared/storage';
import { extractProfileFromResume } from '../shared/api';
import ProfileForm        from './components/ProfileForm';
import ResumeUpload       from './components/ResumeUpload';
import CoverLetterUpload  from './components/CoverLetterUpload';
import ApiKeyForm         from './components/ApiKeyForm';
import SettingsForm       from './components/SettingsForm';

type Section = 'profile' | 'resume' | 'apikeys' | 'settings' | 'about';

const NAV_ITEMS: Array<{ id: Section; icon: string; label: string }> = [
  { id: 'profile',  icon: '👤', label: 'Profile'    },
  { id: 'resume',   icon: '📄', label: 'Resume'     },
  { id: 'apikeys',  icon: '🔑', label: 'API Keys'   },
  { id: 'settings', icon: '⚙️', label: 'Automation' },
  { id: 'about',    icon: 'ℹ️', label: 'About'      },
];

export default function Options() {
  const [section,      setSection]     = useState<Section>('profile');
  const [settings,     setSettings]    = useState<Settings>(DEFAULT_SETTINGS);
  const [saved,        setSaved]       = useState(false);
  const [loading,      setLoading]     = useState(true);
  const [extracting,   setExtracting]  = useState(false);
  const [extractMsg,   setExtractMsg]  = useState('');

  useEffect(() => {
    getSettings().then((s) => { setSettings(s); setLoading(false); });
  }, []);

  const handleChange = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      return next;
    });
    setSaved(false);
  }, []);

  const handleProfileChange = useCallback((patch: Partial<typeof DEFAULT_PROFILE>) => {
    setSettings((prev) => ({ ...prev, profile: { ...prev.profile, ...patch } }));
    setSaved(false);
  }, []);

  const handleSave = async () => {
    await saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleExtractFromCV = async () => {
    if (!settings.resumeText) {
      setExtractMsg('⚠️ Upload your CV first (Resume tab), then come back here.');
      return;
    }
    if (!settings.anthropicApiKey) {
      setExtractMsg('⚠️ Add your Anthropic API key first (API Keys tab).');
      return;
    }
    setExtracting(true);
    setExtractMsg('⏳ Reading your CV…');
    try {
      const extracted = await extractProfileFromResume(settings.resumeText, settings.anthropicApiKey);
      // Merge extracted fields — only overwrite if currently blank
      const current = settings.profile;
      const merged = { ...current };
      for (const [k, v] of Object.entries(extracted)) {
        const key = k as keyof typeof current;
        const cur = current[key];
        // Overwrite only if the current value is empty / default empty array
        if (
          cur === '' ||
          cur === false ||
          (Array.isArray(cur) && cur.length === 0)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (merged as any)[key] = v;
        }
      }
      setSettings((prev) => ({ ...prev, profile: merged }));
      setSaved(false);
      setExtractMsg('✓ Profile prefilled from CV! Review and click Save Settings.');
    } catch (err) {
      setExtractMsg(`❌ ${(err as Error).message}`);
    } finally {
      setExtracting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#64748B' }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="options-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-logo">✈</span>
          <div>
            <div className="sidebar-name">ApplyPilot</div>
            <span className="sidebar-tagline">v2.0 · Local-first</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? 'active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          All data stored locally.<br />No servers. No tracking.
        </div>
      </aside>

      {/* Main */}
      <main className="main-content">

        {section === 'profile' && (
          <>
            <h1 className="section-title">Your Profile</h1>
            <p className="section-sub">This data is used to autofill job applications. Stored locally only.</p>

            {/* CV extraction banner */}
            {!settings.resumeText ? (
              <div style={{
                background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10,
                padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#1E40AF',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div style={{ flex: 1 }}>
                  <strong>Upload your CV first</strong> — ApplyPilot can auto-fill this profile from it.
                </div>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '5px 12px', whiteSpace: 'nowrap' }}
                  onClick={() => setSection('resume')}
                >Upload CV →</button>
              </div>
            ) : (
              <div style={{
                background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
                padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#14532D',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 20 }}>✨</span>
                <div style={{ flex: 1 }}>
                  {extractMsg || 'CV uploaded — use AI to prefill your profile fields automatically.'}
                </div>
                <button
                  className="btn-primary"
                  style={{ fontSize: 12, padding: '5px 14px', whiteSpace: 'nowrap', opacity: extracting ? .6 : 1 }}
                  onClick={handleExtractFromCV}
                  disabled={extracting}
                >
                  {extracting ? '⏳ Extracting…' : '✨ Fill from CV'}
                </button>
              </div>
            )}

            <ProfileForm profile={settings.profile} onChange={handleProfileChange} />
          </>
        )}

        {section === 'resume' && (
          <>
            <h1 className="section-title">Resume & Cover Letter</h1>
            <p className="section-sub">Your files are stored locally and used for auto-filling application forms. No API key needed for basic form filling.</p>
            <ResumeUpload
              resumeFileName={settings.resumeFileName}
              resumeText={settings.resumeText}
              onUpdate={(patch) => {
                setSettings((prev) => ({ ...prev, ...patch }));
                setSaved(false);
              }}
            />
            <CoverLetterUpload
              coverLetterFileName={settings.coverLetterFileName}
              onUpdate={(patch) => {
                setSettings((prev) => ({ ...prev, ...patch }));
                setSaved(false);
              }}
            />
          </>
        )}

        {section === 'apikeys' && (
          <>
            <h1 className="section-title">API Keys (Optional)</h1>
            <p className="section-sub">Optional — used for AI-generated cover letters. Form filling works without any API key. Keys never leave your browser.</p>
            <ApiKeyForm settings={settings} onChange={handleChange} />
          </>
        )}

        {section === 'settings' && (
          <>
            <h1 className="section-title">Automation Settings</h1>
            <p className="section-sub">Control how ApplyPilot behaves on job pages.</p>
            <SettingsForm settings={settings} onChange={handleChange} />
          </>
        )}

        {section === 'about' && <AboutSection />}

        {/* Save bar — shown on all sections except About */}
        {section !== 'about' && (
          <div className="save-bar">
            <button className="btn-primary" onClick={handleSave}>
              💾 Save Settings
            </button>
            {saved && <span className="save-message">✓ Saved!</span>}
          </div>
        )}
      </main>
    </div>
  );
}

// ── About section ─────────────────────────────────────────────────────────────

function AboutSection() {
  return (
    <div>
      <h1 className="section-title">About ApplyPilot</h1>
      <p className="section-sub">Your AI-powered job application co-pilot.</p>

      <div className="card">
        <div className="card-title">✈ What ApplyPilot does</div>
        <ul style={{ fontSize: 13, lineHeight: 2, color: '#475569', paddingLeft: 18 }}>
          <li>📧 Detects job links in <strong>Gmail job alert emails</strong></li>
          <li>💼 Reads jobs from <strong>LinkedIn</strong> (read-only, no auto-apply)</li>
          <li>📋 Maintains a local <strong>job tracking list</strong> with statuses</li>
          <li>🚀 <strong>Autofills application forms</strong> with your profile data</li>
          <li>📄 <strong>Uploads your resume</strong> to file input fields</li>
          <li>✨ Generates <strong>tailored cover letters</strong> using Claude Haiku with reasoning</li>
        </ul>
      </div>

      <div className="card" style={{ background: '#ECFDF5', borderColor: '#A7F3D0' }}>
        <div className="card-title" style={{ color: '#065F46' }}>🔒 Safety guarantees</div>
        <ul style={{ fontSize: 13, lineHeight: 2, color: '#065F46', paddingLeft: 18 }}>
          <li>✅ <strong>Auto-submit is opt-in only</strong> (Full-auto mode)</li>
          <li>✅ <strong>Smart activation</strong> — only runs on job sites</li>
          <li>✅ <strong>Quick on/off toggle</strong> from popup</li>
          <li>✅ <strong>Never scrapes</strong> LinkedIn search pages automatically</li>
          <li>✅ <strong>All data stays local</strong> — no backend server</li>
          <li>✅ API keys stored in <code>chrome.storage.local</code> only</li>
        </ul>
      </div>

      <div className="card">
        <div className="card-title">💡 Recommended workflow</div>
        <ol style={{ fontSize: 13, lineHeight: 2, color: '#475569', paddingLeft: 18 }}>
          <li>Fill in your profile + upload resume in this settings page</li>
          <li>Add your Anthropic API key</li>
          <li>Open Gmail → open a job alert email → save jobs with one click</li>
          <li>Go to the popup → open a job from the list</li>
          <li>On the application page → click Fill Application</li>
          <li>Generate cover letter → review everything → click Apply yourself</li>
        </ol>
      </div>

      <div className="card">
        <div className="card-title">🌍 Global job market support</div>
        <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.7 }}>
          ApplyPilot works with all major ATS platforms worldwide: Greenhouse, Lever, Ashby, Workday,
          SmartRecruiters, Personio, LinkedIn, Indeed, and more. It supports multiple job boards and
          handles work authorization generically — just indicate whether you're eligible to work in
          the country you're applying to.
        </p>
      </div>

      <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center', padding: '12px 0' }}>
        ApplyPilot v2.0 · Made for humans, powered by Claude · No tracking, no data collection
      </div>
    </div>
  );
}
