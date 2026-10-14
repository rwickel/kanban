import { useCallback, useEffect, useRef, useState } from 'react';

// Local offline STT: record mic -> Whisper tiny in-browser via
// @huggingface/transformers. No Google servers. First use downloads
// the model once, then cached (IndexedDB) and fully offline.
// Continuous dictation: audio is sliced into rolling chunks (CHUNK_MS)
// and each chunk is transcribed while recording continues, so words
// appear in the chat input until the user taps stop. Final chunk is
// transcribed on stop with isFinal=true.
// Language comes from Settings (kanban-speech-lang). English uses the
// small fast tiny.en model; other languages use multilingual tiny
// (~75MB each, cached separately).

import { readSpeechLang } from './usePreferences';

type Transcriber = (audio: Float32Array | Float32Array[]) => Promise<{ text: string }>;

// Long enough for Whisper context, short enough for live feedback.
const CHUNK_MS = 7000;

const transcriberCache = new Map<string, Promise<Transcriber>>();
function modelFor(lang: string): { id: string; lang: string | null } {
  if (lang === 'en') return { id: 'Xenova/whisper-tiny.en', lang: null };
  return { id: 'Xenova/whisper-tiny', lang };
}
// transformers.js reports per-file progress as 0-100 (plus loaded/total
// bytes). Normalize everything to a 0-1 fraction; -1 = indeterminate.
function toFraction(p: unknown): number | null {
  try {
    const o = p as { loaded?: unknown; total?: unknown; progress?: unknown } | null;
    if (o && typeof o.loaded === 'number' && typeof o.total === 'number' && o.total > 0) {
      return Math.min(1, Math.max(0, o.loaded / o.total));
    }
    if (o && typeof o.progress === 'number') {
      const v = o.progress;
      return v > 1 ? Math.min(1, Math.max(0, v / 100)) : Math.min(1, Math.max(0, v));
    }
  } catch { /* ignore */ }
  return null;
}
async function getTranscriber(onProgress?: (pct: number) => void): Promise<Transcriber> {
  const lang = readSpeechLang();
  const { id: modelId, lang: modelLang } = modelFor(lang);
  let pending = transcriberCache.get(modelId);
  if (!pending) {
    pending = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const pipe = await pipeline('automatic-speech-recognition', modelId, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        progress_callback: (p: any) => {
          try {
            if (p?.status === 'progress') {
              const frac = toFraction(p);
              onProgress?.(frac ?? -1);
            } else if (p?.status === 'downloading' || p?.status === 'download') onProgress?.(-1);
            else if (p?.status === 'done') onProgress?.(1);
          } catch { /* ignore */ }
        },
      });
      return (async (audio: Float32Array | Float32Array[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opts: any = { chunk_length_s: 30, stride_length_s: 5 };
        if (modelLang) { opts.language = modelLang; opts.task = 'transcribe'; }
        const out = await (pipe as any)(audio, opts);
        return { text: String(out?.text ?? '') };
      }) as Transcriber;
    })().catch((e) => { transcriberCache.delete(modelId); throw e; });
    transcriberCache.set(modelId, pending);
  }
  return pending;
}

async function blobTo16kMono(blob: Blob): Promise<Float32Array> {  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('no-audio-context');
  const ctx = new Ctx();
  try {
    // Mobile Safari creates the context suspended outside a tap handler.
    try { await ctx.resume(); } catch { /* ignore */ }
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const targetRate = 16000;
    const ch0 = audio.getChannelData(0);
    if (audio.sampleRate === targetRate) return new Float32Array(ch0);
    // Resample via OfflineAudioContext.
    const Off = window.OfflineAudioContext
      ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Off) return new Float32Array(ch0);
    const frames = Math.ceil((audio.duration || ch0.length / audio.sampleRate) * targetRate);
    const off = new Off(1, Math.max(1, frames), targetRate);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

export function useSpeechInput() {
  // Capability (browser can do it) vs. context (HTTPS needed for mic).
  // Keep these separate: on plain-http LAN, Chrome hides getUserMedia but
  // the browser itself is fine — toggle() then reports insecure-context
  // instead of the misleading "not supported".
  const [supported] = useState(() =>
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    (typeof AudioContext !== 'undefined' ||
      typeof (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== 'undefined'));
  const [micAvailable] = useState(() =>
    typeof window !== 'undefined' && !!navigator?.mediaDevices?.getUserMedia);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechErrorCode, setSpeechErrorCode] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stoppedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mimeRef = useRef<string | undefined>(undefined);
  const heardRef = useRef(false);
  const preloadedRef = useRef(false);
  const onTextRef = useRef<((text: string, isFinal: boolean) => void) | null>(null);

  // Warm the model when the chat mounts, so tapping mic later starts
  // transcribing immediately instead of showing "Loading voice model".
  // Cached in IndexedDB after first download; no-op when ready.
  useEffect(() => {
    if (!supported || preloadedRef.current) return;
    if (typeof window === 'undefined' || !window.isSecureContext) return;
    preloadedRef.current = true;
    const timer = setTimeout(() => {
      getTranscriber((pct) => setDownloadPct(pct)).then(
        () => setDownloadPct(null),
        () => setDownloadPct(null),
      );
    }, 1000);
    return () => clearTimeout(timer);
  }, [supported]);

  useEffect(() => () => {
    stoppedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    try { mediaRef.current?.stop(); } catch { /* ignore */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  }, []);

  const stopTracks = useCallback(() => {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    streamRef.current = null;
    mediaRef.current = null;
  }, []);

  const fail = useCallback((code: string, message: string) => {
    setSpeechErrorCode(code);
    setSpeechError(message);
  }, []);

  const transcribeChunks = useCallback(async (chunks: Blob[], mime: string | undefined, isFinal: boolean) => {
    if (chunks.length === 0) return false;
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    if (blob.size < 2000) return false;
    let pcm: Float32Array;
    try {
      pcm = await blobTo16kMono(blob);
    } catch { return false; }
    if (pcm.length < 8000) return false;
    try {
      const transcribe = await getTranscriber((pct) => setDownloadPct(pct));
      setDownloadPct(null);
      const { text } = await transcribe(pcm);
      const clean = text.trim();
      if (clean) {
        heardRef.current = true;
        onTextRef.current?.(clean.slice(0, 4000), isFinal);
        return true;
      }
    } catch {
      if (isFinal) fail('transcribe-failed', 'Local transcription failed — first use downloads the model (~75MB), check internet once, then retry offline.');
    }
    return false;
  }, [fail]);

  const startChunk = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || stoppedRef.current) return;
    const chunks: Blob[] = [];
    chunksRef.current = chunks;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    } catch {
      return;
    }
    mediaRef.current = rec;
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onerror = () => {
      fail('unavailable', 'Recording failed — check mic permission and retry.');
    };
    rec.onstop = async () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      const userStopped = stoppedRef.current;
      const got = await transcribeChunks([...chunks], mimeRef.current, userStopped);
      void got;
      if (userStopped) {
        setListening(false);
        setTranscribing(false);
        stopTracks();
        if (!heardRef.current) fail('no-speech', 'No speech heard — speak right after tapping mic.');
      } else {
        // Keep dictating: next chunk starts immediately.
        startChunk();
      }
    };
    try {
      rec.start(250);
    } catch {
      return;
    }
    // Slice the stream: stop this chunk after CHUNK_MS, onstop chains the next.
    timerRef.current = setTimeout(() => {
      try { rec.state !== 'inactive' && rec.stop(); } catch { /* ignore */ }
    }, CHUNK_MS);
  }, [fail, stopTracks, transcribeChunks]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    try { mediaRef.current?.state !== 'inactive' && mediaRef.current?.stop(); } catch { /* ignore */ }
    // onstop transcribes the final chunk; flip to transcribing spinner.
    setTranscribing(true);
  }, []);

  const toggle = useCallback(async (onText: (text: string, isFinal: boolean) => void) => {
    if (listening || transcribing) { stop(); return; }
    if (!supported) {
      fail('unsupported', 'Speech input not supported in this browser — try Chrome on Android.');
      return;
    }
    // Mic input requires a secure context (HTTPS or localhost).
    // Android Chrome HIDES getUserMedia on plain http://LAN URLs, so check
    // this BEFORE micAvailable: otherwise http://192.168.x.x reports the
    // misleading "not supported" instead of the real HTTPS fix.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      fail('insecure-context', 'Microphone needs HTTPS — this browser is fine, but the page must load over https:// (or localhost). Plain http://LAN never prompts for mic on Android.');
      return;
    }
    if (!micAvailable) {
      fail('unsupported', 'Speech input not supported in this browser — try Chrome on Android.');
      return;
    }
    setSpeechError(null);
    setSpeechErrorCode(null);
    onTextRef.current = onText;
    stoppedRef.current = false;
    heardRef.current = false;
    // Kick off model download early so interim chunks transcribe fast.
    getTranscriber((pct) => setDownloadPct(pct)).then(
      () => setDownloadPct(null),
      () => setDownloadPct(null),
    );
    // 1. Mic permission + start recording immediately (fast UX).
    // Android Chrome: if the OS permission is hard-denied ("Don't allow" with
    // "never ask again" or site set to Block), getUserMedia throws
    // NotAllowedError without a prompt. Surface the exact Android fix path.
    let stream: MediaStream;
    try {
      try {
        const perm = await (navigator as unknown as { permissions?: { query: (o: { name: string }) => Promise<{ state: string }> } }).permissions?.query({ name: 'microphone' as never });
        if (perm && perm.state === 'denied') {
          fail('not-allowed',
            'Microphone blocked on this phone — in Chrome tap ⋮ > Settings > Site settings > Microphone, allow it for this site; then Android Settings > Apps > Chrome > Permissions > Microphone > Allow, reload, retry.');
          return;
        }
      } catch { /* Permissions API missing — fall through to getUserMedia */ }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        fail('not-allowed',
          'Microphone blocked — tap the lock/tune icon left of the address bar, set Microphone to Allow, reload. Still blocked? Chrome ⋮ > Settings > Site settings > Microphone + Android Settings > Apps > Chrome > Permissions > Microphone > Allow.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        fail('not-found', 'No microphone found — check the device has a mic and it is enabled.');
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        fail('not-readable',
          'Microphone busy — close other apps or tabs using the mic, then retry.');
      } else {
        fail('unavailable', 'Microphone unavailable — check permission and retry.');
      }
      return;
    }
    try {
      mimeRef.current = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
        : undefined;
    } catch { mimeRef.current = undefined; }
    streamRef.current = stream;
    setListening(true);
    startChunk();
  }, [listening, transcribing, supported, micAvailable, stop, startChunk, fail]);

  return {
    supported, listening: listening || transcribing, speechError,
    speechErrorCode,
    transcribing, downloadPct,
    toggle, stop,
    clearSpeechError: () => { setSpeechError(null); setSpeechErrorCode(null); },
  };
}
