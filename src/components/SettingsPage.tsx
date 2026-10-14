import { ArrowLeft, Check, Monitor, Moon, Smartphone, Sun, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import { Theme, useTheme } from '../hooks/useTheme';
import { FontSize, PreferredView, usePreferences } from '../hooks/usePreferences';

const FONT_SIZES: { value: FontSize; label: string }[] = [
  { value: 13, label: 'Compact' },
  { value: 15, label: 'Default' },
  { value: 17, label: 'Large' },
  { value: 19, label: 'Extra large' },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { preferredView, setPreferredView, fontSize, setFontSize } = usePreferences();
  const backPath = window.location.search.includes('from=mobile') ? '/m' : '/';

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
