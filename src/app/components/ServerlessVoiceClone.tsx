'use client';

import { useState, useRef, useEffect } from 'react';
import { STYLE_PRESETS, normalizeBurmesePhonetics } from '../page';

type Speed = 'Normal' | 'Slower' | 'Slowest';
const SPEED_OPTIONS: Speed[] = ['Normal', 'Slower', 'Slowest'];

export default function ServerlessVoiceClone() {
  const [text, setText] = useState('');
  const [refAudio, setRefAudio] = useState<File | null>(null);
  const [promptText, setPromptText] = useState('');
  const [seed, setSeed] = useState<number>(42);
  const [selectedPreset, setSelectedPreset] = useState<string>('audiobook');
  const [customStyle, setCustomStyle] = useState<string>(STYLE_PRESETS[0].prompt);
  const [speed, setSpeed] = useState<Speed>('Normal');
  const [autoFixBurmese, setAutoFixBurmese] = useState<boolean>(true);

  const handlePresetSelect = (presetId: string) => {
    setSelectedPreset(presetId);
    const found = STYLE_PRESETS.find(p => p.id === presetId);
    if (found) {
      setCustomStyle(found.prompt);
    }
  };

  // Serverless Job State
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>('idle');
  const [statusDetail, setStatusDetail] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<{ url: string; label: string; ts: string }[]>([]);

  // Endpoint info
  const [endpointInfo, setEndpointInfo] = useState<{
    endpointId?: string;
    workers?: { ready: number; running: number; idle: number; unhealthy: number };
    jobs?: { inQueue: number; inProgress: number };
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Poll endpoint health once on mount
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/voiceclone/api/serverless?action=health');
        if (res.ok) {
          const data = await res.json();
          setEndpointInfo(data);
        }
      } catch {
        // non-blocking
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  // Cleanup polling timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const handleGenerate = async () => {
    if (!text.trim() || !refAudio) return;
    setGenerating(true);
    setErrorMsg('');
    setAudioUrl(null);
    setJobStatus('SUBMITTING');
    setStatusDetail('Submitting task to RunPod Serverless queue…');

    const fd = new FormData();
    const processedText = autoFixBurmese ? normalizeBurmesePhonetics(text.trim()) : text.trim();
    fd.append('text', processedText);
    fd.append('reference_audio', refAudio);
    if (promptText.trim()) fd.append('prompt_text', promptText.trim());
    fd.append('seed', String(seed));
    fd.append('style', 'Natural');
    fd.append('custom_style', customStyle);
    fd.append('speed', speed);

    try {
      const res = await fetch('/voiceclone/api/serverless?action=generate', {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const currentJobId = data.id;
      if (!currentJobId) throw new Error('No job ID returned from Serverless endpoint');

      setJobId(currentJobId);
      setJobStatus(data.status || 'IN_QUEUE');
      setStatusDetail('Queued — waiting for worker execution…');

      // Start polling status
      const startTime = Date.now();
      pollTimerRef.current = setInterval(async () => {
        try {
          const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
          const pollRes = await fetch(`/voiceclone/api/serverless?action=status&jobId=${encodeURIComponent(currentJobId)}`);
          if (!pollRes.ok) return;

          const pollData = await pollRes.json();
          const st = pollData.status;
          setJobStatus(st);

          if (st === 'IN_QUEUE') {
            setStatusDetail(`In queue (${elapsedSec}s) — container initializing if cold…`);
          } else if (st === 'IN_PROGRESS') {
            setStatusDetail(`Active on GPU (${elapsedSec}s) — generating voice chunks…`);
          } else if (st === 'COMPLETED') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setGenerating(false);

            const b64 = pollData.output?.audio_base64;
            const mime = pollData.output?.mime_type || 'audio/wav';
            if (b64) {
              const url = `data:${mime};base64,${b64}`;
              setAudioUrl(url);
              setStatusDetail(`Completed in ${elapsedSec}s!`);
              setHistory(prev => [
                {
                  url,
                  label: text.trim().slice(0, 35) + (text.length > 35 ? '…' : ''),
                  ts: new Date().toLocaleTimeString(),
                },
                ...prev,
              ].slice(0, 5));
            } else {
              setErrorMsg('Worker completed but returned no audio data.');
            }
          } else if (st === 'FAILED' || st === 'CANCELLED') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setGenerating(false);
            setErrorMsg(pollData.error || pollData.output?.error || 'Serverless generation failed');
          }
        } catch {
          // ignore transient poll error
        }
      }, 3000);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setGenerating(false);
      setJobStatus('idle');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ── Serverless Status Banner ── */}
      <section className="glass-card p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-l-4 border-l-purple-500">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <h2 className="text-base font-bold text-purple-300">RunPod Serverless Mode</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
              Pay strictly per second
            </span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'rgba(241,240,255,0.55)' }}>
            $0.00 while idle · No GPU hourly rent · Automatically stops the microsecond audio completes
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs bg-black/30 px-3.5 py-2 rounded-lg border border-white/10">
          <div>
            <span className="text-gray-400">Endpoint: </span>
            <span className="font-mono text-purple-300">{endpointInfo?.endpointId || '9i7bqsopxktm7t'}</span>
          </div>
          <div className="h-3 w-px bg-white/10" />
          <div>
            <span className="text-gray-400">Queue: </span>
            <span className="font-mono text-emerald-400">{endpointInfo?.jobs?.inQueue ?? 0}</span>
          </div>
        </div>
      </section>

      {/* ── Main Inputs Grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left Column: Voice Audio & Settings */}
        <section className="glass-card p-6 flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-purple-300">
              Reference Voice Clip
            </h3>
            <p className="text-xs mt-1 text-gray-400">
              Upload a 3–30 second clean voice sample to clone
            </p>
          </div>

          {/* Audio Upload Box */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="cursor-pointer border-2 border-dashed border-white/15 hover:border-purple-400/50 rounded-xl p-5 text-center transition-all bg-white/[0.02] hover:bg-white/[0.04]"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) setRefAudio(f);
              }}
            />
            {refAudio ? (
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-2xl">🎙️</span>
                <p className="text-sm font-semibold text-emerald-400">{refAudio.name}</p>
                <p className="text-xs text-gray-400">
                  {(refAudio.size / 1024 / 1024).toFixed(2)} MB — click to change
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5 py-2">
                <span className="text-3xl opacity-70">🎤</span>
                <p className="text-sm font-medium text-gray-300">Click or drag audio here</p>
                <p className="text-xs text-gray-500">WAV, MP3, FLAC (clean reference)</p>
              </div>
            )}
          </div>

          {/* Ultimate Cloning: Reference Transcript */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-gray-300 flex items-center gap-1.5">
                <span>⭐ Reference Transcript</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  Ultimate Mode
                </span>
              </label>
            </div>
            <textarea
              rows={2}
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              placeholder="Optional: Type the exact words spoken in your audio clip for 100% consistent pacing & cadence across all chunks."
              className="w-full text-xs px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-gray-100 placeholder-gray-500 focus:border-purple-400 focus:outline-none"
            />
          </div>

          {/* Style Presets */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase tracking-wider block text-gray-400">
                Style Preset
              </label>
              <span className="text-[10px] text-purple-300">
                ⚡ Auto-populates prompt
              </span>
            </div>
            <select
              className="w-full text-xs px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-gray-200"
              value={selectedPreset}
              onChange={e => handlePresetSelect(e.target.value)}
            >
              {STYLE_PRESETS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {STYLE_PRESETS.find(p => p.id === selectedPreset)?.desc && (
              <p className="text-[10px] mt-1 text-gray-400">
                💡 {STYLE_PRESETS.find(p => p.id === selectedPreset)?.desc}
              </p>
            )}
          </div>

          {/* Speed */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider block mb-1 text-gray-400">
              Speaking Speed
            </label>
            <select
              className="w-full text-xs px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-gray-200"
              value={speed}
              onChange={e => setSpeed(e.target.value as Speed)}
            >
              {SPEED_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Active Voice Prompt (Editable) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase tracking-wider block text-gray-400">
                Voice Prompt <span className="text-gray-500">(applied to all chunks)</span>
              </label>
              {customStyle && (
                <button
                  type="button"
                  onClick={() => { setCustomStyle(''); setSelectedPreset('custom'); }}
                  className="text-[10px] text-purple-400 hover:text-purple-300"
                >
                  Clear
                </button>
              )}
            </div>
            <textarea
              rows={2}
              value={customStyle}
              onChange={e => {
                setCustomStyle(e.target.value);
                setSelectedPreset('custom');
              }}
              placeholder="Type delivery directives (e.g. steady pacing, calm tone, clear articulation)…"
              className="w-full text-xs px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-gray-100 placeholder-gray-500 focus:border-purple-400 focus:outline-none resize-y"
            />
          </div>

          {/* Consistency Seed */}
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/5">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider block text-gray-400">
                Consistency Seed
              </span>
              <p className="text-[11px] text-gray-500">Locks noise distribution</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={seed}
                onChange={e => setSeed(parseInt(e.target.value) || 0)}
                className="w-20 text-xs px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-center font-mono text-gray-200"
              />
              <button
                type="button"
                onClick={() => setSeed(Math.floor(Math.random() * 1000000))}
                className="text-xs px-2 py-1.5 rounded-lg border border-purple-400/30 text-purple-300 hover:bg-purple-500/10"
              >
                🎲
              </button>
            </div>
          </div>
        </section>

        {/* Right Column: Script Text & Actions */}
        <section className="glass-card p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wider text-purple-300">
              Script Text
            </h3>
            <span className="text-xs text-gray-400">
              {text.length} / 15,000 chars
            </span>
          </div>

          <textarea
            rows={8}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste your text to clone here (Burmese or English). Long text will automatically be segmented into balanced chunks…"
            className="w-full text-sm p-3.5 rounded-xl bg-white/[0.04] border border-white/10 text-gray-100 placeholder-gray-500 focus:border-purple-400 focus:outline-none resize-y"
          />

          {/* Auto-fix Burmese Pronunciation Checkbox */}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-purple-300 hover:text-purple-200 select-none">
            <input
              type="checkbox"
              checked={autoFixBurmese}
              onChange={e => setAutoFixBurmese(e.target.checked)}
              className="rounded border-white/20 text-purple-600 focus:ring-purple-500 bg-white/5"
            />
            <span>🔤 Auto-fix Burmese Pronunciation (အံ့ဩ ➔ အံ့အော်, လျှာ ➔ ရှာ)</span>
          </label>

          <button
            onClick={handleGenerate}
            disabled={generating || !text.trim() || !refAudio}
            className="w-full py-3.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white shadow-lg shadow-purple-900/30"
          >
            {generating ? (
              <>
                <span className="animate-spin text-base">⏳</span>
                <span>Generating with Serverless…</span>
              </>
            ) : (
              <>
                <span>⚡</span>
                <span>Generate Cloned Audio</span>
              </>
            )}
          </button>

          {/* Status / Progress Indicator */}
          {generating && (
            <div className="p-4 rounded-xl bg-purple-950/30 border border-purple-500/20 flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-purple-300">Status: {jobStatus}</span>
                <span className="text-gray-400 font-mono">Job: {jobId?.slice(0, 8)}</span>
              </div>
              <p className="text-xs text-gray-300">{statusDetail}</p>
            </div>
          )}

          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-red-950/40 border border-red-500/30 text-xs text-red-300 flex items-start gap-2">
              <span>⚠️</span>
              <p>{errorMsg}</p>
            </div>
          )}

          {/* Audio Result Player */}
          {audioUrl && (
            <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                  <span>✅</span> Audio Ready!
                </span>
                <a
                  href={audioUrl}
                  download={`serverless-voice-${Date.now()}.wav`}
                  className="text-xs px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 font-medium"
                >
                  ⬇ Download WAV
                </a>
              </div>
              <audio controls src={audioUrl} className="w-full" autoPlay />
            </div>
          )}
        </section>
      </div>

      {/* ── Generation History ── */}
      {history.length > 0 && (
        <section className="glass-card p-5 flex flex-col gap-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400">
            Recent Serverless Outputs
          </h4>
          <div className="flex flex-col gap-2">
            {history.map((h, i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">{h.ts}</span>
                  <span className="text-xs text-gray-200">{h.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <audio controls src={h.url} className="h-8 w-48" />
                  <a
                    href={h.url}
                    download={`serverless-voice-${i}.wav`}
                    className="text-xs text-purple-300 hover:underline px-2 py-1"
                  >
                    ⬇
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
