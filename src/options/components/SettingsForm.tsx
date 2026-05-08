import React from 'react';
import type { Settings } from '../../types';
import TagsInput from './TagsInput';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function SettingsForm({ settings, onChange }: Props) {
  return (
    <>
      {/* Automation mode */}
      <div className="card">
        <div className="card-title">⚡ Automation Mode</div>

        {(['off', 'assist', 'semi-auto', 'full-auto'] as const).map((mode) => (
          <label key={mode} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0',
            borderBottom: '1px solid #F1F5F9', cursor: 'pointer',
          }}>
            <input
              type="radio"
              name="automation"
              value={mode}
              checked={settings.automationMode === mode}
              onChange={() => onChange({ automationMode: mode })}
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                {mode === 'off'       && '🔴 Off'}
                {mode === 'assist'    && '🟡 Assist (recommended)'}
                {mode === 'semi-auto' && '🟢 Semi-auto'}
                {mode === 'full-auto' && '🔵 Full-auto'}
              </div>
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                {mode === 'off'       && 'Extension is passive — no UI shown automatically on job pages.'}
                {mode === 'assist'    && 'Shows the ApplyPilot button when a form is detected. You click to fill.'}
                {mode === 'semi-auto' && 'Automatically opens the fill panel when you land on a job application. Still requires your click to fill.'}
                {mode === 'full-auto' && '⚡ Fills AND submits automatically. Use with queue mode for batch applying. No human intervention needed.'}
              </div>
            </div>
          </label>
        ))}
      </div>

      {/* Job search preferences */}
      <div className="card">
        <div className="card-title">🔍 Job Search Preferences</div>

        <div className="form-grid">
          <div className="field-group">
            <label>Max job age (days)</label>
            <input
              type="number"
              min={1}
              max={90}
              value={settings.maxJobAgeDays}
              onChange={(e) => onChange({ maxJobAgeDays: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Search keywords</label>
          <TagsInput
            tags={settings.jobSearchKeywords}
            onChange={(tags) => onChange({ jobSearchKeywords: tags })}
            placeholder="Add keyword (e.g. golang, platform engineer)…"
          />
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Target locations</label>
          <TagsInput
            tags={settings.jobSearchLocations}
            onChange={(tags) => onChange({ jobSearchLocations: tags })}
            placeholder="Add location (e.g. Berlin, Remote Germany)…"
          />
        </div>
      </div>

      {/* Activation control */}
      <div className="card">
        <div className="card-title">🎯 Activation Control</div>

        <div className="toggle-row">
          <div>
            <div className="toggle-label">Smart activation (recommended)</div>
            <div className="toggle-desc">Only activate on known job boards and ATS platforms. Prevents the panel from appearing on random websites.</div>
          </div>
          <input
            type="checkbox"
            checked={settings.smartActivation ?? true}
            onChange={(e) => onChange({ smartActivation: e.target.checked })}
          />
        </div>

        <div className="field-group" style={{ marginTop: 14 }}>
          <label>Blocked sites (never activate)</label>
          <TagsInput
            tags={settings.disabledSites ?? []}
            onChange={(tags) => onChange({ disabledSites: tags })}
            placeholder="Add domain to block (e.g. example.com)…"
          />
          <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 4 }}>
            ApplyPilot will never show on these domains, even if they have forms.
          </div>
        </div>
      </div>

      {/* Source detection toggles */}
      <div className="card">
        <div className="card-title">📡 Source Detection</div>

        <div className="toggle-row">
          <div>
            <div className="toggle-label">Gmail job alert detection</div>
            <div className="toggle-desc">Extract job links from Gmail job alert emails</div>
          </div>
          <input
            type="checkbox"
            checked={settings.enableGmailDetection}
            onChange={(e) => onChange({ enableGmailDetection: e.target.checked })}
          />
        </div>

        <div className="toggle-row">
          <div>
            <div className="toggle-label">LinkedIn job detection</div>
            <div className="toggle-desc">Extract jobs from LinkedIn job pages (read-only, never auto-applies)</div>
          </div>
          <input
            type="checkbox"
            checked={settings.enableLinkedInDetection}
            onChange={(e) => onChange({ enableLinkedInDetection: e.target.checked })}
          />
        </div>
      </div>

      {/* Data management */}
      <div className="card">
        <div className="card-title">🗄️ Data Management</div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={() => {
              chrome.storage.local.get(null, (data) => {
                const json    = JSON.stringify(data, null, 2);
                const blob    = new Blob([json], { type: 'application/json' });
                const url     = URL.createObjectURL(blob);
                const a       = document.createElement('a');
                a.href        = url;
                a.download    = `applypilot-export-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              });
            }}
          >
            📥 Export all data
          </button>

          <button
            className="btn-danger"
            onClick={() => {
              if (confirm('Delete ALL saved jobs? This cannot be undone.')) {
                chrome.storage.local.remove('ap_jobs');
                alert('Jobs cleared.');
              }
            }}
          >
            🗑 Clear job list
          </button>

          <button
            className="btn-danger"
            onClick={() => {
              if (confirm('Reset ALL ApplyPilot data including settings? This cannot be undone.')) {
                chrome.storage.local.clear(() => {
                  alert('All data cleared. Reload the options page.');
                  location.reload();
                });
              }
            }}
          >
            ⚠️ Factory reset
          </button>
        </div>
      </div>
    </>
  );
}
