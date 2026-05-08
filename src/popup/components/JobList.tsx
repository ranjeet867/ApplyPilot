import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from '../../types';
import { deleteJobs } from '../../shared/storage';
import JobCard from './JobCard';

interface Props {
  jobs:     Job[];
  onUpdate: () => void;
}

const STATUS_OPTIONS = [
  { value: 'all',     label: 'All' },
  { value: 'new',     label: '🔵 New' },
  { value: 'opened',  label: '🟡 Opened' },
  { value: 'applied', label: '🟢 Applied' },
  { value: 'skipped', label: '⚪ Skipped' },
  { value: 'failed',  label: '🔴 Failed' },
];

export default function JobList({ jobs, onUpdate }: Props) {
  const [search,      setSearch]      = useState('');
  const [filter,      setFilter]      = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [queueBusy,   setQueueBusy]   = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search on mount
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Check if a queue is already active
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'QUEUE_GET_STATE' }, (resp) => {
      if (resp?.active) setQueueBusy(true);
    });
  }, []);

  const filtered = jobs.filter((job) => {
    if (filter !== 'all' && job.status !== filter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      job.title.toLowerCase().includes(q)   ||
      job.company.toLowerCase().includes(q) ||
      job.location.toLowerCase().includes(q)
    );
  });

  // Compute which filtered IDs are selectable (new or opened only makes most sense)
  const selectableIds = filtered.map((j) => j.id);

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  };

  const handleSelect = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const startQueue = (autoMode: boolean) => {
    const ids = [...selectedIds].filter((id) => jobs.find((j) => j.id === id));
    if (ids.length === 0) return;
    setQueueBusy(true);
    chrome.runtime.sendMessage({ type: 'QUEUE_START', payload: { jobIds: ids, autoMode } }, (resp) => {
      if (!resp?.ok) {
        setQueueBusy(false);
        alert('Failed to start queue: ' + (resp?.error ?? 'unknown error'));
      } else {
        setSelectedIds(new Set());
        window.close();
      }
    });
  };

  const abortQueue = () => {
    chrome.runtime.sendMessage({ type: 'QUEUE_CLEAR' }, () => {
      setQueueBusy(false);
    });
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} job${ids.length > 1 ? 's' : ''} from your list?`)) return;
    await deleteJobs(ids);
    setSelectedIds(new Set());
    onUpdate();
  };

  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">✈️</div>
        <p>No jobs saved yet.</p>
        <p style={{ marginTop: 6, fontSize: 11 }}>
          Open a Gmail job alert or visit a job posting — ApplyPilot will find jobs automatically.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="jobs-toolbar">
        <input
          ref={searchRef}
          className="search-input"
          placeholder="🔍 Search jobs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="filter-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* ── Selection toolbar ────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '6px 10px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0',
        fontSize: 12,
      }}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleSelectAll}
          title="Select / deselect all visible"
          style={{ accentColor: '#4F46E5', width: 14, height: 14, cursor: 'pointer', flexShrink: 0 }}
        />
        <span style={{ color: '#64748B', flex: 1, minWidth: 60 }}>
          {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select to batch apply'}
        </span>

        {queueBusy ? (
          <button
            onClick={abortQueue}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #FCA5A5',
                     background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontWeight: 600 }}
          >⏹ Stop Queue</button>
        ) : (
          <>
            {selectedIds.size > 0 && (
              <button
                onClick={deleteSelected}
                style={{
                  fontSize: 11, padding: '4px 8px', borderRadius: 6, fontWeight: 600,
                  border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer',
                }}
                title="Delete selected jobs"
              >🗑 Delete</button>
            )}
            <button
              onClick={() => startQueue(false)}
              disabled={selectedIds.size === 0}
              title="Open each job, fill form, wait for you to submit then advance"
              style={{
                fontSize: 11, padding: '4px 8px', borderRadius: 6, fontWeight: 600,
                border: 'none', cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed',
                background: selectedIds.size > 0 ? '#4F46E5' : '#E2E8F0',
                color: selectedIds.size > 0 ? '#fff' : '#94A3B8', whiteSpace: 'nowrap',
              }}
            >🚀 Fill &amp; Wait {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}</button>
            <button
              onClick={() => startQueue(true)}
              disabled={selectedIds.size === 0}
              title="Auto-fill each form and auto-advance every 8 seconds"
              style={{
                fontSize: 11, padding: '4px 8px', borderRadius: 6, fontWeight: 600,
                border: 'none', cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed',
                background: selectedIds.size > 0 ? '#7C3AED' : '#E2E8F0',
                color: selectedIds.size > 0 ? '#fff' : '#94A3B8', whiteSpace: 'nowrap',
              }}
            >⚡ Auto-fill {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}</button>
          </>
        )}
      </div>

      <div className="jobs-list">
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>
            <div className="empty-icon" style={{ fontSize: 24 }}>🔍</div>
            <p>No jobs match this filter.</p>
          </div>
        ) : (
          filtered.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onUpdate={onUpdate}
              selected={selectedIds.has(job.id)}
              onSelect={handleSelect}
            />
          ))
        )}
      </div>

      <div className="add-job-bar">
        <button
          className="btn-add-job"
          onClick={() => {
            chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
              if (!tab?.url) return;
              const title = tab.title ?? 'Job from ' + new URL(tab.url).hostname;
              chrome.runtime.sendMessage({
                type: 'JOBS_EXTRACTED',
                payload: [{
                  title,
                  company: new URL(tab.url).hostname.replace('www.', ''),
                  location: '',
                  applyUrl: tab.url,
                  sourceUrl: tab.url,
                }],
              }, onUpdate);
            });
          }}
        >
          + Save current tab as job
        </button>
      </div>
    </>
  );
}
