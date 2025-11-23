// src/components/DrumFX.tsx
import React, {
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";

export type Verdict = "Perfect" | "Good" | "Miss" | "-";

export interface DrumFXHandle {
  pulse: () => void;
  celebrate: (v: Verdict) => void;
}

// ⭐ 這版 DrumFX：只負責閃光 & 評分標籤，不畫小丑、不畫鼓
const DrumFX = forwardRef<DrumFXHandle>((props, ref) => {
  const [flash, setFlash] = useState(false);
  const [label, setLabel] = useState<Verdict | "-">("-");

  useImperativeHandle(ref, () => ({
    pulse() {
      setFlash(true);
      setTimeout(() => setFlash(false), 120);
    },
    celebrate(v: Verdict) {
      setLabel(v);
      setFlash(true);
      setTimeout(() => setFlash(false), 200);
    },
  }));

  return (
    <div className={`fx-root ${flash ? "fx-flash" : ""}`}>
      {label !== "-" && (
        <div className={`fx-tag fx-${label.toLowerCase()}`}>
          {label}
        </div>
      )}
    </div>
  );
});

export default DrumFX;
