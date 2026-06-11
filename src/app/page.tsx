'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────
type GpuState = 'off' | 'starting' | 'downloading' | 'loading' | 'ready' | 'stopping' | 'error';
type Quality  = 'Fast' | 'Balanced' | 'High Similarity';
type Style    = 'Natural' | 'Deep Reflective' | 'Warm Storyteller' | 'Soft Intimate' | 'Documentary';

const QUALITY_OPTIONS: Quality[] = ['Fast', 'Balanced', 'High Similarity'];
const STYLE_OPTIONS: Style[]     = ['Natural', 'Warm Storyteller', 'Deep Reflective', 'Soft Intimate', 'Documentary'];

const GPU_COST_HR = 0.77; // RTX 6000 Ada — update if using different GPU

function formatUptime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCost(seconds: number) {
  return ((seconds / 3600) * GPU_COST_HR).toFixed(4);
}

// ─── GPU Status Badge ─────────────────────────────────────────────────────────
function GpuBadge({ state, detail }: { state: GpuState; detail?: string }) {
  const map: Record<GpuState, { label: string; dotClass: string; textColor: string }> = {
    off:         { label: 'GPU Off',          dotClass: 'off',      textColor: '#9ca3af' },
    starting:    { label: 'Starting GPU…',    dotClass: 'starting', textColor: '#fbbf24' },
    downloading: { label: 'Downloading Model',dotClass: 'starting', textColor: '#fbbf24' },
    loading:     { label: 'Loading Model…',   dotClass: 'busy',     textColor: '#60a5fa' },
    ready:       { label: 'GPU Ready',        dotClass: 'ready',    textColor: '#10b981' },
    stopping:    { label: 'Stopping…',        dotClass: 'starting', textColor: '#fbbf24' },
    error:       { label: 'Error',            dotClass: 'error',    textColor: '#ef4444' },
  };
  const { label, dotClass, textColor } = map[state];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={`status-dot ${dotClass}`} />
        <span className="text-sm font-semibold" style={{ color: textColor }}>{label}</span>
      </div>
      {detail && <p className="text-xs ml-4" style={{ color: 'rgba(241,240,255,0.4)' }}>{detail}</p>}
    </div>
  );
}

// ─── Waveform Animation ───────────────────────────────────────────────────────
function Waveform() {
  return (
    <div className="waveform">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="waveform-bar" />
      ))}
    </div>
  );
}

// ─── Upload Zone ──────────────────────────────────────────────────────────────
function UploadZone({
  file, onFile, disabled,
}: { file: File | null; onFile: (f: File) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.type.startsWith('audio/') || f.name.endsWith('.wav') || f.name.endsWith('.mp3')))
      onFile(f);
  };

  return (
    <div
      className={`upload-zone ${drag ? 'drag-over' : ''} ${file ? 'has-file' : ''}`}
      style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
      {file ? (
        <div className="flex flex-col items-center gap-3">
          <div className="text-3xl">🎙️</div>
          <div className="text-sm font-semibold" style={{ color: '#10b981' }}>{file.name}</div>
          <div className="text-xs" style={{ color: 'rgba(241,240,255,0.45)' }}>
            {(file.size / 1024 / 1024).toFixed(2)} MB — click to replace
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="text-4xl opacity-60">🎤</div>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'rgba(241,240,255,0.8)' }}>
              Drop your voice sample here
            </p>
            <p className="text-xs mt-1" style={{ color: 'rgba(241,240,255,0.4)' }}>
              WAV, MP3, FLAC — any 3–30 second clip
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  // GPU state
  const [gpuState, setGpuState]       = useState<GpuState>('off');
  const [gpuDetail, setGpuDetail]     = useState('');
  const [uptime, setUptime]           = useState(0);
  const [podUrl, setPodUrl]           = useState('');
  const [currentPodId, setCurrentPodId] = useState('');
  const pollRef                       = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptimeRef                     = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetGpu = () => {
    clearInterval(pollRef.current!);
    clearInterval(uptimeRef.current!);
    setGpuState('off');
    setGpuDetail('');
    setUptime(0);
    setPodUrl('');
    setCurrentPodId('');
  };

  // Form
  const [text, setText]           = useState('');
  const [refAudio, setRefAudio]   = useState<File | null>(null);
  const [quality, setQuality]     = useState<Quality>('Balanced');
  const [style, setStyle]         = useState<Style>('Natural');
  const [customStyle, setCustomStyle] = useState('');

  // Output
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl]     = useState<string | null>(null);
  const [genError, setGenError]     = useState('');
  const [history, setHistory]       = useState<{ url: string; label: string }[]>([]);

  // ── Poll /health until ready ──────────────────────────────────────────────
  const startHealthPoll = useCallback((url: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/health?podUrl=${encodeURIComponent(url)}`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (d.status === 'downloading') {
          setGpuState('downloading');
          setGpuDetail('Saving model to network volume (first time only)…');
        } else if (d.status === 'loading') {
          setGpuState('loading');
          setGpuDetail('Loading VoxCPM2 into GPU memory…');
        } else if (d.status === 'ready') {
          setGpuState('ready');
          setGpuDetail('');
          clearInterval(pollRef.current!);
          uptimeRef.current = setInterval(() => setUptime(u => u + 1), 1000);
        } else if (d.status === 'error') {
          setGpuState('error');
          setGpuDetail(d.detail || 'Unknown error');
          clearInterval(pollRef.current!);
        }
      } catch {
        // Pod not yet reachable — still starting
      }
    }, 4000);
  }, []);

  // ── Start GPU (create fresh pod) ──────────────────────────────────────────
  const startGpu = async () => {
    setGpuState('starting');
    setGpuDetail('Finding available GPU and creating pod…');
    setUptime(0);
    setPodUrl('');
    setCurrentPodId('');
    try {
      const r = await fetch('/api/pod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' }),
      });
      const d = await r.json();
      console.log('[StartGPU] Response:', JSON.stringify(d));
      if (!d.success) {
        setGpuState('error');
        setGpuDetail(d.error || 'Failed to create pod');
        return;
      }
      setPodUrl(d.podUrl);
      setCurrentPodId(d.podId);
      setGpuDetail(`Pod created (${d.gpuType}) — booting…`);
      startHealthPoll(d.podUrl);
    } catch (e) {
      setGpuState('error');
      setGpuDetail(String(e));
    }
  };

  // ── Stop GPU (terminate pod completely) ─────────────────────────────────
  const stopGpu = async () => {
    setGpuState('stopping');
    clearInterval(pollRef.current!);
    clearInterval(uptimeRef.current!);
    try {
      if (currentPodId) {
        await fetch('/api/pod', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'terminate', podId: currentPodId }),
        });
      }
    } finally {
      setGpuState('off');
      setGpuDetail('');
      setUptime(0);
      setPodUrl('');
      setCurrentPodId('');
    }
  };

  // ── Generate Voice ────────────────────────────────────────────────────────
  const generate = async () => {
    if (!text.trim() || !refAudio) return;
    setGenerating(true);
    setGenError('');
    setAudioUrl(null);

    const fd = new FormData();
    fd.append('text', text.trim());
    fd.append('reference_audio', refAudio);
    fd.append('quality', quality);
    fd.append('style', style);
    fd.append('custom_style', customStyle);

    try {
      const r = await fetch(`/api/health?endpoint=generate&podUrl=${encodeURIComponent(podUrl)}`, {
        method: 'POST',
        body: fd,
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      setAudioUrl(url);
      const label = text.trim().slice(0, 40) + (text.length > 40 ? '…' : '');
      setHistory(h => [{ url, label }, ...h].slice(0, 5));
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    clearInterval(pollRef.current!);
    clearInterval(uptimeRef.current!);
  }, []);

  const isReady    = gpuState === 'ready';
  const canGenerate = isReady && !!text.trim() && !!refAudio && !generating;

  return (
    <main className="relative z-10 min-h-screen p-6 md:p-10 max-w-5xl mx-auto">

      {/* ── Header ── */}
      <header className="mb-10 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" style={{
            background: 'linear-gradient(135deg, #a78bfa, #60a5fa)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            🎙️ Voice Studio
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'rgba(241,240,255,0.45)' }}>
            AI voice cloning · Burmese &amp; 29 languages · Powered by VoxCPM2
          </p>
        </div>
        <a
          href="https://github.com/shinnemoe/Voice-Studio"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost text-xs"
        >
          GitHub ↗
        </a>
      </header>

      {/* ── GPU Control Panel ── */}
      <section className="glass-card p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          {/* Status */}
          <div className="flex flex-col gap-3">
            <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(241,240,255,0.35)' }}>
              GPU Status
            </div>
            <GpuBadge state={gpuState} detail={gpuDetail} />

            {/* Progress bar while starting/loading */}
            {['starting', 'downloading', 'loading'].includes(gpuState) && (
              <div className="progress-bar w-64">
                <div className="progress-fill" />
              </div>
            )}

            {/* Uptime & Cost */}
            {isReady && (
              <div className="flex items-center gap-3">
                <span className="text-xs" style={{ color: 'rgba(241,240,255,0.4)' }}>
                  Uptime: {formatUptime(uptime)}
                </span>
                <span className="cost-badge">
                  💰 ${formatCost(uptime)} / session
                </span>
              </div>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            {gpuState === 'off' || gpuState === 'error' ? (
              <button id="btn-start-gpu" className="btn btn-primary" onClick={startGpu}>
                ⚡ Start GPU
              </button>
            ) : gpuState === 'ready' ? (
              <button id="btn-stop-gpu" className="btn btn-danger" onClick={stopGpu}>
                ⏹ Stop GPU
              </button>
            ) : gpuState === 'stopping' ? (
              <button className="btn btn-ghost" disabled>Stopping…</button>
            ) : (
              <div className="flex gap-2">
                <button className="btn btn-ghost" disabled>Starting…</button>
                <button id="btn-cancel-gpu" className="btn btn-danger" onClick={resetGpu} title="Cancel and reset">
                  ✕ Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* GPU tip when off */}
        {gpuState === 'off' && (
          <p className="mt-4 text-xs" style={{ color: 'rgba(241,240,255,0.3)' }}>
            💡 GPU starts in ~30–60 sec · Model loads in ~1 min · Remember to stop when done
          </p>
        )}
      </section>

      {/* ── Voice Cloning Panel ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">

        {/* Left: Reference Audio */}
        <section className="glass-card p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-widest" style={{ color: 'rgba(241,240,255,0.5)' }}>
              Reference Voice
            </h2>
            <p className="text-xs mt-1" style={{ color: 'rgba(241,240,255,0.35)' }}>
              Upload any 3–30 sec voice clip to clone
            </p>
          </div>
          <UploadZone file={refAudio} onFile={setRefAudio} disabled={!isReady} />

          {/* Style */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider block mb-2"
              style={{ color: 'rgba(241,240,255,0.4)' }}>
              Style Preset
            </label>
            <select
              className="style-select"
              value={style}
              onChange={e => setStyle(e.target.value as Style)}
              disabled={!isReady}
            >
              {STYLE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Custom style */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider block mb-2"
              style={{ color: 'rgba(241,240,255,0.4)' }}>
              Custom Style <span style={{ color: 'rgba(241,240,255,0.25)' }}>(optional)</span>
            </label>
            <input
              type="text"
              value={customStyle}
              onChange={e => setCustomStyle(e.target.value)}
              placeholder="e.g. warm and energetic, Burmese accent"
              disabled={!isReady}
              className="w-full text-sm px-3 py-2 rounded-lg"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(241,240,255,0.9)',
                outline: 'none',
              }}
            />
          </div>
        </section>

        {/* Right: Text Input */}
        <section className="glass-card p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-widest" style={{ color: 'rgba(241,240,255,0.5)' }}>
              Text to Speak
            </h2>
            <p className="text-xs mt-1" style={{ color: 'rgba(241,240,255,0.35)' }}>
              မြန်မာဘာသာ (Burmese) or English — any of 30 languages
            </p>
          </div>

          <textarea
            id="text-input"
            className="voice-input flex-1"
            rows={7}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={"Type in Burmese:\nမင်္ဂလာပါ။ ကျွန်တော်တို့ Voice Studio မှ ကြိုဆိုပါတယ်။\n\nOr English:\nHello! Welcome to Voice Studio."}
            disabled={!isReady}
          />

          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'rgba(241,240,255,0.3)' }}>
              {text.length} characters
            </span>
            {!isReady && (
              <span className="text-xs" style={{ color: 'rgba(241,240,255,0.3)' }}>
                Start GPU to enable editing
              </span>
            )}
          </div>

          {/* Quality */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider block mb-2"
              style={{ color: 'rgba(241,240,255,0.4)' }}>
              Quality
            </label>
            <div className="pill-group">
              {QUALITY_OPTIONS.map(q => (
                <button
                  key={q}
                  className={`pill ${quality === q ? 'active' : ''}`}
                  onClick={() => setQuality(q)}
                  disabled={!isReady}
                >
                  {q === 'Fast' ? '⚡ Fast' : q === 'Balanced' ? '⚖ Balanced' : '💎 High Similarity'}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* ── Generate Button ── */}
      <section className="mb-6">
        <button
          id="btn-generate"
          className="btn btn-generate"
          onClick={generate}
          disabled={!canGenerate}
        >
          {generating ? (
            <span className="flex items-center gap-3">
              <Waveform />
              Generating cloned voice…
            </span>
          ) : (
            <span className="flex items-center gap-2">
              🎧 Generate Cloned Voice
            </span>
          )}
        </button>

        {!isReady && (
          <p className="text-center text-xs mt-2" style={{ color: 'rgba(241,240,255,0.3)' }}>
            Start the GPU first to enable generation
          </p>
        )}
        {isReady && !refAudio && (
          <p className="text-center text-xs mt-2" style={{ color: 'rgba(241,240,255,0.3)' }}>
            Upload a reference voice sample to continue
          </p>
        )}
        {isReady && refAudio && !text.trim() && (
          <p className="text-center text-xs mt-2" style={{ color: 'rgba(241,240,255,0.3)' }}>
            Type some text to speak
          </p>
        )}
      </section>

      {/* ── Error ── */}
      {genError && (
        <div className="glass-card p-4 mb-6" style={{ borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)' }}>
          <p className="text-sm" style={{ color: '#fca5a5' }}>❌ {genError}</p>
        </div>
      )}

      {/* ── Audio Output ── */}
      {audioUrl && (
        <section className="audio-result mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Waveform />
              <div>
                <p className="text-sm font-semibold">Generated Audio</p>
                <p className="text-xs" style={{ color: 'rgba(241,240,255,0.4)' }}>
                  48kHz · Voice cloned with VoxCPM2
                </p>
              </div>
            </div>
            <a
              href={audioUrl}
              download={`voice-clone-${Date.now()}.wav`}
              className="btn btn-ghost text-xs"
            >
              ⬇ Download
            </a>
          </div>
          <audio controls autoPlay src={audioUrl} className="w-full" />
        </section>
      )}

      {/* ── History ── */}
      {history.length > 1 && (
        <section className="glass-card p-5">
          <h3 className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: 'rgba(241,240,255,0.4)' }}>
            Recent Generations
          </h3>
          <div className="flex flex-col gap-3">
            {history.slice(1).map((item, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <span className="text-sm" style={{ color: 'rgba(241,240,255,0.6)' }}>
                  {i + 2}. {item.label}
                </span>
                <div className="flex gap-2">
                  <audio src={item.url} controls className="h-8" style={{ width: '200px' }} />
                  <a href={item.url} download={`clone-${i + 2}.wav`} className="btn btn-ghost text-xs py-1 px-3">
                    ⬇
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Footer ── */}
      <footer className="mt-12 pb-6 text-center text-xs" style={{ color: 'rgba(241,240,255,0.2)' }}>
        Voice Studio · VoxCPM2 · Apache 2.0 · Running on RunPod
      </footer>
    </main>
  );
}
