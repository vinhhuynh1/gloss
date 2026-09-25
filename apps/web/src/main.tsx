import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { applyTheme, readTheme } from "./lib/useTheme";
import "./styles.css";

// Before the first render, not from an effect: an effect runs after paint, so
// a dark-themed machine would get one light frame on every load.
applyTheme(readTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
