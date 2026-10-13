import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import MobileApp from "./mobile/MobileApp.tsx";

const isMobileRoute = window.location.pathname.startsWith("/m");
ReactDOM.createRoot(document.getElementById("root")!).render(
  isMobileRoute ? <MobileApp /> : <App />
);
