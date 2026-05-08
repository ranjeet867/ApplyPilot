import React, { useState } from 'react';
import type { Job } from '../../types';
import StatusBadge from './StatusBadge';
import { timeAgo, truncate } from '../../shared/utils';
import { updateJobStatus, deleteJob } from '../../shared/storage';

interface Props {
  job:        Job;
  onUpdate:   () => void;
  selected?:  boolean;
  onSelect?:  (id: string, checked: boolean) => void;
}

export default function JobCard({ job, onUpdate, selected = false, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [note,     setNote]     = useState(job.notes);
  const [showCL,   setShowCL]   = useState(false);

  const openJob = () => {
    chrome.tabs.create({ url: job.applyUrl, active: true });
    if (job.status === 'new') {
      updateJobStatus(job.id, 'opened').then(onUpdate);
    }
  };

  /** Open tab + auto-trigger fill panel */
  const quickFill = (e: React.MouseEvent) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'OPEN_AND_APPLY', payload: { jobUrl: job.applyUrl } });
    if (job.status === 'new') updateJobStatus(job.id, 'opened').then(onUpdate);
    window.close();
  };

  const markApplied = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateJobStatus(job.id, 'applied', { appliedAt: Date.now() }).then(onUpdate);
  };

  const markSkipped = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateJobStatus(job.id, 'skipped').then(onUpdate);
  };

  const saveNote = () => {
    updateJobStatus(job.id, job.status, { notes: note } as Partial<Job>).then(onUpdate);
  };

  const removeJob = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Remove "${job.title}"?`)) deleteJob(job.id).then(onUpdate);
  };

  return (
    <div
      className="job-card"
      style={{ flexDirection: 'column', cursor: 'pointer', outline: selected ? '2px solid #4F46E5' : 'none' }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Main row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%' }}>

        {/* Checkbox */}
        {onSelect && (
          <div style={{ paddingTop: 2 }} onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onSelect(job.id, e.target.checked)}
              style={{ width: 15, height: 15, accentColor: '#4F46E5', cursor: 'pointer' }}
            />
          </div>
        )}

        <div className="job-card-body" style={{ flex: 1, minWidth: 0 }}>
          <div className="job-title" title={job.title}>{truncate(job.title, 42)}</div>
          <div className="job-company">
            {job.company && <span>{job.company}</span>}
            {job.location && <span> · {truncate(job.location, 28)}</span>}
          </div>
          <div className="job-meta">
            <StatusBadge status={job.status} />
            <span className="job-age">{timeAgo(job.savedAt)}</span>
            {job.salary && <span className="job-age">💰 {job.salary}</span>}
            {job.coverLetter && (
              <span
                style={{ fontSize: 10, color: '#7C3AED', cursor: 'pointer', marginLeft: 4 }}
                onClick={(e) => { e.stopPropagation(); setExpanded(true); setShowCL(!showCL); }}
                title="Cover letter saved"
              >📄 CL</span>
            )}
          </div>
        </div>

        <div className="job-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn-open" onClick={quickFill} title="Open & auto-trigger fill panel">⚡ Fill</button>
          <button className="btn-open" onClick={openJob} style={{ background: '#E2E8F0', color: '#1E293B' }}>Open ↗</button>
          {job.status !== 'applied' && (
            <button className="btn-applied" onClick={markApplied}>✓</button>
          )}
          {job.status === 'new' && (
            <button className="btn-skip" onClick={markSkipped}>Skip</button>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{ width: '100%', marginTop: 10, borderTop: '1px solid #F1F5F9', paddingTop: 10 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, fontSize: 11, color: '#64748B', lineHeight: 1.7 }}>
              {/* JD link (where the job was found) */}
              <div>
                <strong>📋 JD:</strong>{' '}
                <span
                  style={{ color: '#3B82F6', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => chrome.tabs.create({ url: job.sourceUrl || job.applyUrl, active: true })}
                  title={job.sourceUrl || job.applyUrl}
                >
                  {(job.sourceDomain || (job.sourceUrl && new URL(job.sourceUrl).hostname)) || 'view listing'}
                </span>
              </div>
              {/* Apply link (actual application form) — only show if different from JD */}
              {job.applyUrl && job.applyUrl !== job.sourceUrl && (
                <div>
                  <strong>🚀 Apply:</strong>{' '}
                  <span
                    style={{ color: '#10B981', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => chrome.tabs.create({ url: job.applyUrl, active: true })}
                    title={job.applyUrl}
                  >
                    {(() => { try { return new URL(job.applyUrl).hostname.replace('www.',''); } catch { return 'open form'; } })()}
                  </span>
                </div>
              )}
              {job.appliedAt && <div><strong>Applied:</strong> {new Date(job.appliedAt).toLocaleDateString()}</div>}
              {job.postedDate && <div><strong>Posted:</strong> {job.postedDate}</div>}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
              {job.coverLetter && (
                <button
                  style={{ fontSize: 10, padding: '3px 7px', border: '1px solid #DDD6FE', borderRadius: 5, cursor: 'pointer', background: '#F5F3FF', color: '#7C3AED' }}
                  onClick={() => setShowCL(!showCL)}
                >📄 {showCL ? 'Hide CL' : 'View CL'}</button>
              )}
              <button
                style={{ fontSize: 10, padding: '3px 7px', border: '1px solid #E2E8F0', borderRadius: 5, cursor: 'pointer', background: '#fff', color: '#64748B' }}
                onClick={() => navigator.clipboard.writeText(job.applyUrl)}
              >📋 Copy URL</button>
              <button
                style={{ fontSize: 10, padding: '3px 7px', border: '1px solid #FCA5A5', borderRadius: 5, cursor: 'pointer', background: '#FEF2F2', color: '#DC2626' }}
                onClick={removeJob}
              >🗑 Delete</button>
            </div>
          </div>

          {/* Cover letter preview */}
          {showCL && job.coverLetter && (
            <div style={{
              background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 6,
              padding: '8px 10px', fontSize: 11, color: '#1E293B', marginBottom: 8,
              maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.5,
            }}>
              {job.coverLetter}
            </div>
          )}

          <textarea
            className="notes-textarea"
            rows={2}
            placeholder="Add notes (recruiter name, interview date, impression…)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
          />
        </div>
      )}
    </div>
  );
}
