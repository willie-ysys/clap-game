import { forwardRef, useImperativeHandle, useRef, useState } from "react";

export type Verdict = "Perfect" | "Good" | "Miss" | "-";
export type DrumFXHandle = { pulse: () => void; celebrate: (v: Verdict) => void; };

export default forwardRef<DrumFXHandle, { clownImg?: string }>(function DrumFX(
  { clownImg = "/yy.png" }, ref
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drumRef = useRef<HTMLDivElement | null>(null);
  const sticksRef = useRef<HTMLDivElement | null>(null);
  const [confetti, setConfetti] = useState<Array<{id:number;x:number;y:number;rot:number;delay:number;dur:number}>>([]);

  useImperativeHandle(ref, () => ({
    pulse() {
      drumRef.current?.classList.remove("fx-pulse");
      void drumRef.current?.offsetWidth;
      drumRef.current?.classList.add("fx-pulse");
      sticksRef.current?.classList.remove("fx-sticks");
      void sticksRef.current?.offsetWidth;
      sticksRef.current?.classList.add("fx-sticks");
    },
    celebrate(v) {
      if (v === "Miss") {
        wrapRef.current?.classList.remove("fx-shake");
        void wrapRef.current?.offsetWidth;
        wrapRef.current?.classList.add("fx-shake");
        return;
      }
      const count = v === "Perfect" ? 28 : 14;
      const now = Date.now();
      const items = Array.from({ length: count }).map((_, i) => ({
        id: now + i, x: Math.random() * 100, y: 0, rot: Math.random() * 360,
        delay: Math.random() * 120, dur: 900 + Math.random() * 700,
      }));
      setConfetti(prev => [...prev, ...items]);
      setTimeout(() => setConfetti(prev => prev.filter(c => now + count <= c.id)), 2000);
    },
  }));

  return (
    <div className="fx-wrap" ref={wrapRef}>
      <div className="fx-clown">
        <img src={clownImg} alt="clown" className="fx-clown-img" />
        <div className="fx-sticks" ref={sticksRef} aria-hidden>
          <span className="fx-stick fx-stick-left" />
          <span className="fx-stick fx-stick-right" />
        </div>
        <div className="fx-drum" ref={drumRef} aria-hidden>
          <div className="fx-ring" />
          <div className="fx-head" />
        </div>
      </div>
      <div className="fx-confetti-layer" aria-hidden>
        {confetti.map(c => (
          <span key={c.id} className="fx-confetti"
            style={{ left: \`\${c.x}%\`, animationDelay: \`\${c.delay}ms\`,
                     animationDuration: \`\${c.dur}ms\`, rotate: \`\${c.rot}deg\` }} />
        ))}
      </div>
    </div>
  );
});
