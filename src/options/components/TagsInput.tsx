import React, { useRef, useState } from 'react';

interface Props {
  tags:        string[];
  onChange:    (tags: string[]) => void;
  placeholder?: string;
}

export default function TagsInput({ tags, onChange, placeholder }: Props) {
  const [input, setInput] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  const add = (value: string) => {
    const v = value.trim();
    if (!v || tags.includes(v)) { setInput(''); return; }
    onChange([...tags, v]);
    setInput('');
  };

  const remove = (tag: string) => onChange(tags.filter((t) => t !== tag));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(input);
    }
    if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div
      className="tags-container"
      onClick={() => ref.current?.focus()}
    >
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
          <button className="tag-remove" onClick={(e) => { e.stopPropagation(); remove(tag); }}>×</button>
        </span>
      ))}
      <input
        ref={ref}
        className="tag-input"
        value={input}
        placeholder={tags.length === 0 ? (placeholder ?? 'Add tag…') : ''}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (input.trim()) add(input); }}
      />
    </div>
  );
}
