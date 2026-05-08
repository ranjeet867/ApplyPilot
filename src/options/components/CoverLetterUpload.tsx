import React, { useCallback, useRef, useState } from 'react';
import { saveSettings } from '../../shared/storage';

interface Props {
  coverLetterFileName: string;
  onUpdate:            (patch: { coverLetterFileName: string; coverLetterDataUrl: string }) => void;
}

export default function CoverLetterUpload({ coverLetterFileName, onUpdate }: Props) {
  const [drag,    setDrag]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [status,  setStatus]  = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['pdf', 'docx', 'txt'].includes(ext ?? '')) {
      setStatus('❌ Only PDF, DOCX, or TXT files are supported.');
      return;
    }

    setLoading(true);
    setStatus('⏳ Reading file…');

    try {
      const dataUrl = await fileToDataUrl(file);
      await saveSettings({ coverLetterFileName: file.name, coverLetterDataUrl: dataUrl });
      onUpdate({ coverLetterFileName: file.name, coverLetterDataUrl: dataUrl });
      setStatus('✓ Default cover letter saved!');
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

  const removeCoverLetter = async () => {
    if (!confirm('Remove saved cover letter?')) return;
    await saveSettings({ coverLetterFileName: '', coverLetterDataUrl: '' });
    onUpdate({ coverLetterFileName: '', coverLetterDataUrl: '' });
    setStatus('Cover letter removed.');
  };

  const hasCL = Boolean(coverLetterFileName);

  return (
    <div className="card">
      <div className="card-title">📝 Default Cover Letter</div>
      <p style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>
        Upload a default cover letter to use when no AI-generated letter is available.
        This file will be uploaded automatically to cover letter fields on application forms.
        No API key needed.
      </p>

      {!hasCL ? (
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
          <div className="upload-icon">📝</div>
          <div className="upload-label">Drop your cover letter here or click to browse</div>
          <div className="upload-sub">PDF, DOCX, or TXT · Used as fallback when no AI letter is generated</div>
        </div>
      ) : (
        <div className="resume-preview">
          <div className="resume-icon">📝</div>
          <div className="resume-info">
            <div className="resume-name">{coverLetterFileName}</div>
            <div className="resume-sub">Default cover letter · Will auto-upload to application forms</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => inputRef.current?.click()}>
              🔄 Replace
            </button>
            <button className="btn-danger" onClick={removeCoverLetter}>🗑</button>
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
