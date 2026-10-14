import { useCallback, useEffect, useState } from 'react';

export type PreferredView = 'desktop' | 'mobile';
export type FontSize = 13 | 15 | 17 | 19;
export type SpeechLang = 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'nl';

export const SPEECH_LANGS: { value: SpeechLang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
  { value: 'nl', label: 'Nederlands' },
];

const VIEW_KEY = 'kanban-preferred-view';
const FONT_SIZE_KEY = 'kanban-font-size';
export const SPEECH_LANG_KEY = 'kanban-speech-lang';
const CHANGE_EVENT = 'kanban-preferences-change';

function readView(): PreferredView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'mobile' ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

function readFontSize(): FontSize {
  try {
    const value = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (value === 13 || value === 15 || value === 17 || value === 19) return value;
  } catch { /* use default */ }
  return 15;
}

export function readSpeechLang(): SpeechLang {
  try {
    const v = localStorage.getItem(SPEECH_LANG_KEY);
    if (SPEECH_LANGS.some((l) => l.value === v)) return v as SpeechLang;
  } catch { /* use default */ }
  return 'en';
}

export function usePreferences() {
  const [preferredView, setPreferredViewState] = useState<PreferredView>(readView);
  const [fontSize, setFontSizeState] = useState<FontSize>(readFontSize);
  const [speechLang, setSpeechLangState] = useState<SpeechLang>(readSpeechLang);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`);
  }, [fontSize]);

  useEffect(() => {
    const sync = () => {
      setPreferredViewState(readView());
      setFontSizeState(readFontSize());
      setSpeechLangState(readSpeechLang());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const setPreferredView = useCallback((value: PreferredView) => {
    localStorage.setItem(VIEW_KEY, value);
    setPreferredViewState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const setFontSize = useCallback((value: FontSize) => {
    localStorage.setItem(FONT_SIZE_KEY, String(value));
    setFontSizeState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const setSpeechLang = useCallback((value: SpeechLang) => {
    localStorage.setItem(SPEECH_LANG_KEY, value);
    setSpeechLangState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { preferredView, setPreferredView, fontSize, setFontSize, speechLang, setSpeechLang };
}
