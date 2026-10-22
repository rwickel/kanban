import { ArrowLeft, Check, Languages, Monitor, Moon, Smartphone, Sun, Timer, Type } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Theme, useTheme } from '../hooks/useTheme';
import { FontSize, PreferredView, SPEECH_LANGS, usePreferences } from '../hooks/usePreferences';
import { AUTO_CONTINUE_IDLE_MS, AUTO_CONTINUE_MIN_OPTIONS, AUTO_CONTINUE_PROMPT, AUTO_CONTINUE_STANDARD_MIN, readAutoContinueIdleMin, readAutoContinuePrompt, saveAutoContinueIdleMin, saveAutoContinuePrompt } from '../hooks/autoContinue';

const FONT_SIZES: { value: FontSize; label: string }[] = [
  { value: 13, label: 'Compact' },
  { value: 15, label: 'Default' },
  { value: 17, label: 'Large' },
  { value: 19, label: 'Extra large' },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { preferredView, setPreferredView, fontSize, setFontSize, speechLang, setSpeechLang } = usePreferences();
  const [autoContinueIdleMin, setAutoContinueIdleMinState] = useState<number>(() => readAutoContinueIdleMin());
  const [autoContinuePrompt, setAutoContinuePromptState] = useState<string>(() => readAutoContinuePrompt());
  const [savedAutoContinuePrompt, setSavedAutoContinuePrompt] = useState<string>(() => readAutoContinuePrompt());
  const backPath = window.location.search.includes('from=mobile') ? '/m' : '/';

  const chooseAutoContinueIdle = (min: number) => {
    saveAutoContinueIdleMin(min);
    setAutoContinueIdleMinState(min);
  };

  const savePrompt = () => {
    saveAutoContinuePrompt(autoContinuePrompt);
    setSavedAutoContinuePrompt(autoContinuePrompt);
  };

  const resetPrompt = () => {
    setAutoContinuePromptState(AUTO_CONTINUE_PROMPT);
    saveAutoContinuePrompt(AUTO_CONTINUE_PROMPT);
    setSavedAutoContinuePrompt(AUTO_CONTINUE_PROMPT);
  };

  const chooseView = (value: PreferredView) => {
    setPreferredView(value);
    window.location.href = value === 'mobile' ? '/m' : '/';
  };

  return (
    <main className="settings-page">
      <header className="settings-head">
        <button className="settings-back" onClick={() => { window.location.href = backPath; }} aria-label="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <p className="settings-kicker">KANBAN / PREFERENCES</p>
          <h1>Settings</h1>
        </div>
      </header>

      <div className="settings-list">
        <SettingSection title="Theme" description="Choose the interface color scheme.">
          <Choice label="Light" icon={Sun} selected={theme === 'light'} onClick={() => setTheme('light' as Theme)} />
          <Choice label="Dark" icon={Moon} selected={theme === 'dark'} onClick={() => setTheme('dark' as Theme)} />
        </SettingSection>

        <SettingSection title="View" description="Choose which board layout opens next.">
          <Choice label="Desktop" icon={Monitor} selected={preferredView === 'desktop'} onClick={() => chooseView('desktop')} />
          <Choice label="Mobile" icon={Smartphone} selected={preferredView === 'mobile'} onClick={() => chooseView('mobile')} />
        </SettingSection>

        <SettingSection title="Font size" description={`Current base size: ${fontSize}px`}>
          {FONT_SIZES.map((option) => (
            <Choice
              key={option.value}
              label={option.label}
              detail={`${option.value}px`}
              icon={Type}
              selected={fontSize === option.value}
              onClick={() => setFontSize(option.value)}
            />
          ))}
        </SettingSection>

        <SettingSection title="Response and speech language" description="Chat output, task summaries, and voice input use this language.">
          {SPEECH_LANGS.map((option) => (
            <Choice
              key={option.value}
              label={option.label}
              icon={Languages}
              selected={speechLang === option.value}
              onClick={() => setSpeechLang(option.value)}
            />
          ))}
        </SettingSection>

        <SettingSection
          title="Auto-continue idle time"
          description={`Board assistant sends one continue prompt into the same session after this idle time. Only runs when "Automatisch fortsetzen" is enabled. Standard: ${AUTO_CONTINUE_IDLE_MS / 1000} seconds.`}
        >
          <Choice
            label="Standard"
            detail={`${AUTO_CONTINUE_IDLE_MS / 1000} seconds`}
            icon={Timer}
            selected={autoContinueIdleMin === AUTO_CONTINUE_STANDARD_MIN}
            onClick={() => chooseAutoContinueIdle(AUTO_CONTINUE_STANDARD_MIN)}
          />
          {AUTO_CONTINUE_MIN_OPTIONS.map((min) => (
            <Choice
              key={min}
              label={min === 1 ? '1 minute' : `${min} minutes`}
              icon={Timer}
              selected={autoContinueIdleMin === min}
              onClick={() => chooseAutoContinueIdle(min)}
            />
          ))}
        </SettingSection>

        <SettingSection
          title="Auto-continue prompt"
          description="Text the board assistant sends into the same session when it auto-continues. Leave empty or the default to use the built-in prompt."
        >
          <div className="settings-prompt">
            <textarea
              className="settings-textarea"
              rows={4}
              spellCheck={false}
              value={autoContinuePrompt}
              onChange={(e) => setAutoContinuePromptState(e.target.value)}
              aria-label="Auto-continue prompt"
            />
            <div className="settings-actions">
              <button
                className="settings-btn is-primary"
                onClick={savePrompt}
                disabled={autoContinuePrompt === savedAutoContinuePrompt}
              >
                Save prompt
              </button>
              <button
                className="settings-btn"
                onClick={resetPrompt}
                disabled={autoContinuePrompt.trim() === AUTO_CONTINUE_PROMPT}
              >
                Reset to default
              </button>
            </div>
          </div>
        </SettingSection>
      </div>
    </main>
  );
}

function SettingSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-copy"><h2>{title}</h2><p>{description}</p></div>
      <div className="settings-options">{children}</div>
    </section>
  );
}

function Choice({ label, detail, icon: Icon, selected, onClick }: {
  label: string;
  detail?: string;
  icon: typeof Sun;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`settings-choice ${selected ? 'is-selected' : ''}`} onClick={onClick} aria-pressed={selected}>
      <Icon className="w-4 h-4" strokeWidth={1.75} />
      <span>{label}</span>
      {detail && <span className="settings-detail">{detail}</span>}
      {selected && <Check className="w-4 h-4 settings-check" strokeWidth={2} />}
    </button>
  );
}
