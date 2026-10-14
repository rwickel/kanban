import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionInstance = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return (ctor as (new () => SpeechRecognitionInstance) | undefined) ?? null;
}

const ERROR_HINTS: Record<string, string> = {
  'not-allowed': 'Microphone blocked — tap the lock icon by the address bar, allow Mic, then tap mic again. Needs HTTPS.',
  'service-not-allowed': 'Speech blocked — open this page over HTTPS or localhost, then allow Mic and retry.',
  network: 'Speech service unreachable — speech needs internet (audio goes to Google servers). Check Wi-Fi, turn off VPN, allow Chrome through Windows Firewall, open https://www.google.com once, then retry.',
  'language-not-supported': 'Speech language not supported — switch Chrome to English (US) and retry.',
  'no-speech': 'No speech heard — speak right after tapping mic.',
  'audio-capture': 'No microphone found — check Windows Settings > Sound > Input + Chrome mic access.',
  aborted: 'Speech input stopped.',
  offline: 'No internet — speech input needs internet. Check Wi-Fi, then retry.',
};

function isSecureForSpeech(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.isSecureContext === 'boolean') {
      return window.isSecureContext;
    }
  } catch { /* ignore */ }
  try {
    const proto = window.location?.protocol;
    const host = window.location?.hostname ?? '';
    return proto === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch { return true; }
}

async function ensureMicPermission(): Promise<string | null> {
  try {
    const md = navigator?.mediaDevices;
    if (!md?.getUserMedia) return null;
    const stream = await md.getUserMedia({ audio: true });
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    return null;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone blocked — tap the lock icon by the address bar, allow Mic, then tap mic again. Needs HTTPS.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No microphone found — check device + Android permission for Chrome.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'Microphone is in use — close other apps using the mic, then retry.';
    }
    return 'Microphone blocked — allow mic access for this site, then retry.';
  }
}

export function useSpeechInput() {
  const [speechErrorCode, setSpeechErrorCode] = useState<string | null>(null);
  const [supported] = useState(() => getSpeechRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => () => {
    stoppedRef.current = true;
    try { recognitionRef.current?.abort?.(); } catch { /* ignore */ }
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  const toggle = useCallback(async (onText: (text: string, isFinal: boolean) => void) => {
    if (listening) {
      stop();
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setSpeechErrorCode('unsupported');
      setSpeechError('Speech input is not supported in this browser.');
      return;
    }
    if (!isSecureForSpeech()) {
      setSpeechErrorCode('service-not-allowed');
      setSpeechError(`${ERROR_HINTS['service-not-allowed']} (service-not-allowed)`);
      return;
    }
    setSpeechError(null);
    setSpeechErrorCode(null);
    // Android Chrome: trigger the OS permission prompt first.
    // Without this, recognition fails at once with not-allowed.
    const micBlocked = await ensureMicPermission();
    if (micBlocked) {
      setSpeechErrorCode('not-allowed');
      setSpeechError(`${micBlocked} (not-allowed)`);
      return;
    }
    stoppedRef.current = false;
    const recognition = new Ctor();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i]?.[0]?.transcript ?? '';
        // No isFinal flag in our minimal typing; treat last chunk as final.
        if (i === event.results.length - 1) finalText = transcript;
        else interim += transcript;
      }
      if (finalText) onText(finalText, true);
      else if (interim) onText(interim, false);
    };
    recognition.onerror = (event) => {
      if (stoppedRef.current) return;
      const code = event.error || 'unknown';
      setSpeechErrorCode(code);
      setSpeechError(`${ERROR_HINTS[code] ?? 'Speech input failed — try again.'} (${code})`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setSpeechErrorCode('start-failed');
      setSpeechError('Speech input failed to start (start-failed) — mic may be in use.');
      setListening(false);
    }
  }, [listening, stop]);

  return { supported, listening, speechError, speechErrorCode, toggle, stop, clearSpeechError: () => { setSpeechError(null); setSpeechErrorCode(null); } };
}
