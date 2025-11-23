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

// 小丑打鼓的特效層（被 RhythmClapGame 用 <DrumFX ref={...}/> 呼叫）
const DrumFX = forwardRef<DrumFXHandle>((props, ref) => {
  const [flash, setFlash] = useState(false);
  const [label, setLabel] = useState<Verdict | "-">("-");

  useImperativeHandle(ref, () => ({
    pulse() {
      // 只做一下閃爍效果
      setFlash(true);
      setTimeout(() => setFlash(false), 120);
    },
    celebrate(v: Verdict) {
      // 顯示這次評分 + 閃一下
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
