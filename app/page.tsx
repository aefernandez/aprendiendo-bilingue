'use client';

import { useState } from 'react';
import type { Segment, Level } from '@/lib/types';

const LEVELS: { value: Level; label: string; description: string }[] = [
  { value: 1, label: 'Dipping In', description: '~30% Italian' },
  { value: 2, label: 'Wading In', description: '~60% Italian' },
  { value: 3, label: 'Deep End', description: '~90% Italian' },
];

interface ActiveWord {
  text: string;
  translation: string;
}

export default function Home() {
  const [inputText, setInputText] = useState('');
  const [level, setLevel] = useState<Level>(1);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null);

  async function handleSubmit() {
    if (!inputText.trim()) return;

    setLoading(true);
    setError(null);
    setSegments(null);
    setActiveWord(null);

    try {
      const response = await fetch('/api/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: inputText, level }),
      });

      if (!response.ok) throw new Error('Request failed');

      const data = await response.json();
      setSegments(data.segments);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Aprendiendo Bilingue</h1>
        <p className="text-sm text-gray-500 mt-1">Read anything in Italian, starting today.</p>
      </header>

      {/* Input view */}
      {!segments && !loading && (
        <div className="space-y-6">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Paste any English text here..."
            className="w-full h-48 p-4 border border-gray-200 rounded-xl resize-none text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400 text-base"
          />

          <div>
            <p className="text-sm font-medium text-gray-700 mb-3">How much Italian do you want?</p>
            <div className="flex gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l.value}
                  onClick={() => setLevel(l.value)}
                  className={`flex-1 py-3 px-2 rounded-xl border text-sm font-medium transition-colors ${
                    level === l.value
                      ? 'bg-amber-400 border-amber-400 text-white'
                      : 'bg-white border-gray-200 text-gray-700 hover:border-amber-300'
                  }`}
                >
                  <div>{l.label}</div>
                  <div className={`text-xs mt-0.5 ${level === l.value ? 'text-amber-100' : 'text-gray-400'}`}>
                    {l.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!inputText.trim()}
            className="w-full py-3 bg-amber-400 hover:bg-amber-500 disabled:bg-gray-100 disabled:text-gray-400 text-white font-semibold rounded-xl transition-colors"
          >
            Mix it up
          </button>

          {error && <p className="text-red-500 text-sm text-center">{error}</p>}
        </div>
      )}

      {/* Loading view */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-500 text-sm">Mixing your text…</p>
        </div>
      )}

      {/* Reader view */}
      {segments && (
        <div className="pb-40">
          <div className="flex items-center justify-between mb-6">
            <p className="text-sm text-gray-400">Tap any Italian word to see its meaning</p>
            <button
              onClick={() => { setSegments(null); setActiveWord(null); }}
              className="text-sm text-amber-500 hover:text-amber-600 font-medium"
            >
              ← New text
            </button>
          </div>

          <p className="text-lg leading-relaxed text-gray-900">
            {segments.map((segment, segIndex) =>
              segment.lang === 'source' ? (
                <span key={segIndex}>{segment.text}</span>
              ) : (
                <button
                  key={segIndex}
                  onClick={() =>
                    setActiveWord(
                      activeWord?.text === segment.text
                        ? null
                        : { text: segment.text, translation: segment.translation ?? '' }
                    )
                  }
                  className={`inline rounded px-0.5 -mx-0.5 transition-colors ${
                    activeWord?.text === segment.text
                      ? 'bg-amber-500 text-white'
                      : 'bg-amber-100 text-amber-900 hover:bg-amber-200'
                  }`}
                >
                  {segment.text}
                </button>
              )
            )}
          </p>
        </div>
      )}

      {/* Definition card */}
      {activeWord && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-xl p-6">
          <div className="max-w-2xl mx-auto flex items-start justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-1">{activeWord.text}</p>
              <p className="text-xl font-semibold">
                <mark className="bg-amber-200 text-gray-900 rounded px-1">{activeWord.translation}</mark>
              </p>
            </div>
            <button
              onClick={() => setActiveWord(null)}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none ml-6 mt-0.5"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
