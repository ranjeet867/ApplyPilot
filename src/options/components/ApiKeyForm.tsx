import React, { useState } from 'react';
import type { Settings } from '../../types';
import { testAnthropicKey, testOpenAIKey } from '../../shared/api';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export default function ApiKeyForm({ settings, onChange }: Props) {
  const [anthStatus, setAnthStatus] = useState<'idle'|'testing'|'ok'|'error'>('idle');
  const [oaiStatus,  setOaiStatus]  = useState<'idle'|'testing'|'ok'|'error'>('idle');
  const [showAnth,   setShowAnth]   = useState(false);
  const [showOai,    setShowOai]    = useState(false);

  const testAnthropic = async () => {
    setAnthStatus('testing');
    const ok = await testAnthropicKey(settings.anthropicApiKey);
    setAnthStatus(ok ? 'ok' : 'error');
  };

  const testOpenAI = async () => {
    setOaiStatus('testing');
    const ok = await testOpenAIKey(settings.openaiApiKey);
    setOaiStatus(ok ? 'ok' : 'error');
  };

  const statusMsg = (s: typeof anthStatus) => {
    if (s === 'testing') return '⏳ Testing…';
    if (s === 'ok')      return '✓ Valid key';
    if (s === 'error')   return '✗ Invalid or no access';
    return '';
  };

  return (
    <>
      <div className="card">
        <div className="card-title">🤖 Anthropic (Claude Haiku)</div>

        <div className="field-group" style={{ marginBottom: 8 }}>
          <label>API Key</label>
          <div className="api-key-row">
            <input
              type={showAnth ? 'text' : 'password'}
              placeholder="sk-ant-…"
              value={settings.anthropicApiKey}
              onChange={(e) => onChange({ anthropicApiKey: e.target.value })}
            />
            <button
              className="btn-secondary"
              type="button"
              onClick={() => setShowAnth(!showAnth)}
              style={{ whiteSpace: 'nowrap', padding: '9px 12px' }}
            >
              {showAnth ? '🙈 Hide' : '👁 Show'}
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={testAnthropic}
              disabled={!settings.anthropicApiKey || anthStatus === 'testing'}
              style={{ whiteSpace: 'nowrap' }}
            >
              Test
            </button>
          </div>
          <div className={`api-status ${anthStatus}`}>{statusMsg(anthStatus)}</div>
        </div>

        <div className="field-group">
          <label>Model</label>
          <select
            value={settings.aiModel}
            onChange={(e) => onChange({ aiModel: e.target.value })}
          >
            <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (fast, cheap)</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6 (best quality)</option>
            <option value="claude-opus-4-6">claude-opus-4-6 (most capable)</option>
          </select>
        </div>

        <p style={{ fontSize: 11, color: '#64748B', marginTop: 10, lineHeight: 1.5 }}>
          🧠 <strong>Reasoning is enabled</strong> by default on Haiku — it thinks before writing your cover letter for better, more tailored output.
          Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noopener" style={{ color: '#4F46E5' }}>console.anthropic.com</a>.
        </p>
      </div>

      <div className="card">
        <div className="card-title">🟢 OpenAI (GPT fallback)</div>

        <div className="field-group" style={{ marginBottom: 8 }}>
          <label>API Key</label>
          <div className="api-key-row">
            <input
              type={showOai ? 'text' : 'password'}
              placeholder="sk-…"
              value={settings.openaiApiKey}
              onChange={(e) => onChange({ openaiApiKey: e.target.value })}
            />
            <button
              className="btn-secondary"
              type="button"
              onClick={() => setShowOai(!showOai)}
              style={{ whiteSpace: 'nowrap', padding: '9px 12px' }}
            >
              {showOai ? '🙈 Hide' : '👁 Show'}
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={testOpenAI}
              disabled={!settings.openaiApiKey || oaiStatus === 'testing'}
              style={{ whiteSpace: 'nowrap' }}
            >
              Test
            </button>
          </div>
          <div className={`api-status ${oaiStatus}`}>{statusMsg(oaiStatus)}</div>
        </div>

        <div className="field-group">
          <label>Default provider</label>
          <select
            value={settings.aiProvider}
            onChange={(e) => onChange({ aiProvider: e.target.value as 'anthropic' | 'openai' })}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
          </select>
        </div>
      </div>

      <div className="card" style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
        <div style={{ fontSize: 12, color: '#92400E', lineHeight: 1.6 }}>
          🔒 <strong>Your API keys are stored locally</strong> in <code>chrome.storage.local</code> only.
          They are never sent to any ApplyPilot server. API calls go directly from your browser to Anthropic/OpenAI.
        </div>
      </div>
    </>
  );
}
