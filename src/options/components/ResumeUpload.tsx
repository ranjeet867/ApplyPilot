import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ResumeRecord } from '../../types';
import { saveResume, getResume, deleteResume } from '../../shared/db';
import { extractTextFromFile } from '../../shared/db';
import { saveSettings } from '../../shared/storage';

interface Props {
  resumeFileName: string;
  resumeText:     string;
  onUpdate:       (patch: { resumeFileName: string; resumeText: string }) => void;
}

export default function ResumeUpload({ resumeFileName, resumeText, onUpdate }: Props) {
  const [drag,     setDrag]     = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [status,   setStatus]   = useState('');
  const [previewTxt, setPreview] = useState(resumeText.slice(0, 300));
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    const ext     = file.name.split('.').pop()?.toLowerCase();

    if (!allowed.includes(file.type) && !['pdf','docx','txt'].includes(ext ?? '')) {
      setStatus('❌ Only PDF, DOCX, or TXT files are supported.');
      return;
    }

    setLoading(true);
    setStatus('⏳ Reading file…');

    try {
      // Convert to dataUrl for storage
      const dataUrl = await fileToDataUrl(file);
      // Extract text
      setStatus('⏳ Extracting text…');
      const text = await extractTextFromFile(file);

      // Save to IndexedDB
      await saveResume({
        fileName:   file.name,
        fileSize:   file.size,
        mimeType:   file.type || 'application/octet-stream',
        dataUrl,
        text,
        uploadedAt: Date.now(),
      });

      // Save text + dataUrl to settings so content scripts can access them
      // (IndexedDB is options-page-only; chrome.storage.local is cross-context)
      await saveSettings({ resumeFileName: file.name, resumeText: text, resumeDataUrl: dataUrl });
      onUpdate({ resumeFileName: file.name, resumeText: text });

      setPreview(text.slice(0, 300));
      setStatus('✓ Resume saved successfully!');
    } catch (err) {
      setStatus(`❌ Error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [onUpdate]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const removeResume = async () => {
    if (!confirm('Remove saved resume?')) return;
    await deleteResume();
    await saveSettings({ resumeFileName: '', resumeText: '' });
    onUpdate({ resumeFileName: '', resumeText: '' });
    setPreview('');
    setStatus('Resume removed.');
  };

  const hasResume = Boolean(resumeFileName);

  return (
    <>
      <div className="card">
        <div className="card-title">📄 Resume</div>

        {!hasResume ? (
          <div
            className={`upload-zone ${drag ? 'drag-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={onInputChange}
              style={{ display: 'none' }}
            />
            <div className="upload-icon">📄</div>
            <div className="upload-label">Drop your resume here or click to browse</div>
            <div className="upload-sub">PDF, DOCX, or TXT · Stored locally only</div>
          </div>
        ) : (
          <div className="resume-preview">
            <div className="resume-icon">📄</div>
            <div className="resume-info">
              <div className="resume-name">{resumeFileName}</div>
              <div className="resume-sub">
                {resumeText.length > 0
                  ? `${resumeText.length.toLocaleString()} characters extracted`
                  : 'No text extracted'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn-secondary"
                onClick={() => inputRef.current?.click()}
              >🔄 Replace</button>
              <button className="btn-danger" onClick={removeResume}>🗑</button>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={onInputChange}
                style={{ display: 'none' }}
              />
            </div>
          </div>
        )}

        {status && (
          <p style={{ fontSize: 12, marginTop: 10, color: status.startsWith('✓') ? '#10B981' : status.startsWith('❌') ? '#EF4444' : '#F59E0B' }}>
            {status}
          </p>
        )}
      </div>

      {previewTxt && (
        <div className="card">
          <div className="card-title">🔍 Extracted Text Preview</div>
          <div style={{
            background: '#F8FAFC',
            border: '1px solid #E2E8F0',
            borderRadius: 8,
            padding: 12,
            fontSize: 11,
            fontFamily: 'monospace',
            color: '#475569',
            maxHeight: 160,
            overflow: 'auto',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}>
            {previewTxt}…
          </div>
          <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>
            This text is used for cover letter generation. If extraction looks poor, paste your resume text below.
          </p>
          <div className="field-group" style={{ marginTop: 10 }}>
            <label>Or paste resume text directly</label>
            <textarea
              rows={6}
              placeholder="Paste your resume text here if auto-extraction looks incomplete…"
              defaultValue={resumeText}
              onBlur={(e) => {
                const text = e.target.value.trim();
                if (text) {
                  saveSettings({ resumeText: text });
                  onUpdate({ resumeFileName: resumeFileName || 'pasted-resume.txt', resumeText: text });
                }
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
