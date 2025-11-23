import "./global.css";   // ✅ 全域樣式，背景圖會寫在這個檔案
import React from "react";
import { createRoot } from "react-dom/client";
import RhythmClapGame from "./RhythmClapGame";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root not found in index.html");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <RhythmClapGame />
  </React.StrictMode>
);
