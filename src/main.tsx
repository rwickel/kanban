import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import SettingsPage from "./components/SettingsPage.tsx";
import MobileApp from "./mobile/MobileApp.tsx";
import { useTheme } from "./hooks/useTheme.ts";

function SettingsRoot() {
  useTheme();
  return (
    <div className="app-shell">
      <SettingsPage />
    </div>
  );
}

function applyStoredFontSize() {
  try {
    const raw = Number(localStorage.getItem('kanban-font-size'));
    if (raw === 13 || raw === 15 || raw === 17 || raw === 19) {
      document.documentElement.style.setProperty('--app-font-size', `${raw}px`);
    }
  } catch { /* keep default */ }
}

applyStoredFontSize();

const path = window.location.pathname;
const isSettingsRoute = path === "/settings" || path.startsWith("/settings/");
const isMobileRoute = path.startsWith("/m");
ReactDOM.createRoot(document.getElementById("root")!).render(
  isSettingsRoute ? <SettingsRoot /> : isMobileRoute ? <MobileApp /> : <App />
);
