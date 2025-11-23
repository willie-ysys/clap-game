import DrumFX, { DrumFXHandle, Verdict } from "./components/DrumFX";
import "./drumfx.css";
import "./score-cards.css";
import React, { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import "./drum-pulse.css";

type GamePhase = "idle" | "calibrating" | "ready" | "playing" | "finished";
type Level = 1 | 2 | 3;
type StickSide = "L" | "R";
type BeatLog = {
  expectedAt: number;
  receivedAt?: number;
  delta?: number;
  verdict?: "Perfect" | "Good" | "Miss";
};
type UINote = { id: number; x: number; delay: number; color: string };
const DEFAULT_BPM = 59;
const CALI_BEATS = 5;
const PERFECT_MS = 220;
const GOOD_MS = 500;
const MIN_CLAP_GAP_MS = 120;
const EMA_DIST_ALPHA = 0.6;
const EMA_VEL_ALPHA = 0.7;
const APPROACH_VEL = -0.4;
const CONTACT_MARGIN = 1.05;
const SEPARATE_MARGIN = 1.25;
const FAST_DROP_PX = 28;
// ⭐ Level 3：變速設定（你以後只要改這兩個數字就能調整）
const LEVEL3_CHANGE_BEAT = 14; // 第 17 拍開始換速度（1-based：1=第一拍）
const LEVEL3_NEW_BPM = 116; // 換成的新 BPM（例如 130）

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "0.0");
const ema = (x: number, prev: number | null, alpha: number) =>
  prev == null ? x : prev * (1 - alpha) + x * alpha;

// ⭐ 每個 Level：自己的 BPM / 音樂 / 前奏長度 / 拍數
const LEVEL_SETTINGS: Record<
  Level,
  { bpm: number; music: string; introMs: number; beats: number }
> = {
  1: {
    bpm: 58,
    music: "/audio/level1.mp3",
    introMs: 2240,
    beats: 16,
  },
  2: {
    bpm: 99,
    music: "/audio/level2.mp3",
    introMs: 4200,
    beats: 31,
  },
  3: {
    bpm: 115,
    music: "/audio/level3.mp3",
    introMs: 4000,
    beats: 29,
  },
};

export default function RhythmClapGame() {
  const fxRef = useRef<DrumFXHandle>(null);
  (window as any).fxPulse = () => fxRef.current?.pulse();
  (window as any).fxCelebrate = (v: "Perfect" | "Good" | "Miss" | "-") =>
    fxRef.current?.celebrate(v as Verdict);

  // ⭐ 音符特效狀態
  const [notes, setNotes] = useState<UINote[]>([]);
  const noteIdRef = useRef(0);
  const musicRef = useRef<HTMLAudioElement | null>(null);

  const [phase, setPhase] = useState<GamePhase>("idle");
  const [level, setLevel] = useState<Level>(1);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [showCalibModal, setShowCalibModal] = useState(true); // ⭐ 一進頁面先顯示校準視窗
  const [baseDelayMs, setBaseDelayMs] = useState(0);
  const [beats, setBeats] = useState<BeatLog[]>([]);
  const [progress, setProgress] = useState(0);

  const [clapCount, setClapCount] = useState(0);
  const [_lastVerdict, _setLastVerdict] = useState<BeatLog["verdict"] | "-">("-");
  const lastVerdict = _lastVerdict;
  const setLastVerdict = (v: BeatLog["verdict"] | "-") => {
    _setLastVerdict(v);
    if (v !== "-") fxRef.current?.celebrate(v as any);
  };
  const [showResultModal, setShowResultModal] = useState(false);

  const [imgAnim, setImgAnim] = useState<"" | "clown-hitL" | "clown-hitR">("");
  const [downbeatAnim, setDownbeatAnim] = useState(false);
  const altRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const handRef = useRef<HandLandmarker | null>(null);
  const animRef = useRef<number>();
  const lastClapAtRef = useRef(0);

  const [sensitivity, setSensitivity] = useState(1.0);
  const [metronomeOn, setMetronomeOn] = useState(true);

  const emaDistRef = useRef<number | null>(null);
  const emaVelRef = useRef(0);
  const detPhaseRef = useRef<"SEPARATE" | "APPROACH" | "CONTACT">("SEPARATE");
  const handScaleRef = useRef(120);
  const debugRef = useRef({
    dist: 0,
    vel: 0,
    thr: 0,
    state: "SEPARATE",
  });
  const prevRawDistRef = useRef<number>(0);

  const offsetAdjRef = useRef(0);

  const beatsRef = useRef<BeatLog[]>([]);
  const phaseRef = useRef<GamePhase>("idle");

  useEffect(() => {
    beatsRef.current = beats;
  }, [beats]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    if (phase === "finished") {
      setShowResultModal(true);
    }
  }, [phase]);
  const lastPalm1Ref = useRef<{ x: number; y: number; time: number } | null>(
    null
  );
  const lastPalm2Ref = useRef<{ x: number; y: number; time: number } | null>(
    null
  );
  const PALM_KEEP_MS = 300;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const drumKitRef = useRef<ReturnType<typeof createDrumKit> | null>(null);

  const ensureAudio = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      drumKitRef.current = createDrumKit(audioCtxRef.current);
    }
    return audioCtxRef.current!;
  };

  function createDrumKit(ctx: AudioContext) {
    function tick(v = 0.55) {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 1800;
      f.Q.value = 6;
      o.type = "square";
      o.frequency.setValueAtTime(1800, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.06);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(f).connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.09);
    }
    function kick(v = 0.7) {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.15);
    }
    function snare(v = 0.35) {
      const t = ctx.currentTime;
      const b = ctx.createBuffer(
        1,
        Math.floor(ctx.sampleRate * 0.2),
        ctx.sampleRate
      );
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const s = ctx.createBufferSource();
      s.buffer = b;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      s.connect(bp).connect(hp).connect(g).connect(ctx.destination);
      s.start(t);
      s.stop(t + 0.2);
    }
    function accent(v = 0.85) {
      kick(Math.min(1, v * 0.95));
      tick(v);
    }
    return { tick, kick, snare, accent };
  }

  const vibrate = (ms = 30) =>
    "vibrate" in navigator && navigator.vibrate(ms);

  const hit = (side: StickSide, down = false) => {
    setImgAnim(side === "L" ? "clown-hitL" : "clown-hitR");
    setTimeout(() => setImgAnim(""), 130);
    if (down) {
      setDownbeatAnim(true);
      setTimeout(() => setDownbeatAnim(false), 180);
    }
  };
  const NOTE_COLORS = ["note-yellow", "note-pink", "note-blue", "note-green"];
  // ⭐ 每一拍產生多顆音符，短時間後自動消失
  const spawnNote = () => {
    const COUNT = 3; // 一拍幾顆音符
    const newNotes: UINote[] = [];

    for (let i = 0; i < COUNT; i++) {
      const id = noteIdRef.current++;
      const x = -18 + Math.random() * 36;   // 左右範圍 -18% ~ +18%，比較滿
      const delay = i * 0.05;               // 每顆稍微錯開時間

      const color =
        NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];

      newNotes.push({ id, x, delay, color });


      // 約 1.1 秒後把這顆音符移除
      setTimeout(() => {
        setNotes((prev) => prev.filter((n) => n.id !== id));
      }, 1100);
    }

    setNotes((prev) => [...prev, ...newNotes]);
  };

  const missTimerRef = useRef<number | undefined>(undefined);
  function startMissTimer() {
    stopMissTimer();
    missTimerRef.current = window.setInterval(sweepTimeoutMisses, 50);
  }
  function stopMissTimer() {
    if (missTimerRef.current !== undefined) {
      clearInterval(missTimerRef.current);
      missTimerRef.current = undefined;
    }
  }

  function sweepTimeoutMisses() {
    const list = beatsRef.current;
    if (!list || list.length === 0) return;
    const offset = baseDelayMs + offsetAdjRef.current;
    const now = performance.now();
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.receivedAt !== undefined) continue;
      if (now > b.expectedAt + offset + GOOD_MS) {
        b.receivedAt = now;
        b.delta = now - (b.expectedAt + offset);
        b.verdict = "Miss";
        changed = true;
      } else {
        break;
      }
    }
    if (changed) {
      setBeats(() => {
        const updated = [...list];
        const done = updated.filter((x) => x.receivedAt !== undefined).length;
        setProgress((done / updated.length) * 100);
        return updated;
      });
    }
    if (list.every((b) => b.receivedAt !== undefined)) {
      stopMissTimer();
      if (phaseRef.current === "playing")
        setTimeout(() => setPhase("finished"), 250);
    }
  }

  useEffect(() => {
    let stopped = false;
    (async () => {
      const files = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      const hand = await HandLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });

      if (!stopped) {
        handRef.current = hand;
      }


      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {}
        loop();
      }
    })();

    function loop() {
      cancelAnimationFrame(animRef.current!);
      const raf = () => {
        try {
          detect();
        } catch (e) {
          console.error("detect error", e);
        }
        animRef.current = requestAnimationFrame(raf);
      };
      animRef.current = requestAnimationFrame(raf);
    }

    function detect() {
      const v = videoRef.current,
        c = overlayRef.current,
        h = handRef.current;
      if (!v || !c || !h) return;
      if (v.readyState < 2) return;
      const w = v.videoWidth,
        hg = v.videoHeight;
      if (c.width !== w) c.width = w;
      if (c.height !== hg) c.height = hg;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, hg);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(v, 0, 0, w, hg);

      const now = performance.now();
      const res: any = h.detectForVideo(v, now);

      // ⭐ 先畫「手部」關節點（跟原本一樣）
      ctx.fillStyle = "#00e0ff";
      res?.landmarks?.forEach((L: any) =>
        L.forEach((p: any) => {
          ctx.beginPath();
          ctx.arc(p.x * w, p.y * hg, 2.2, 0, Math.PI * 2);
          ctx.fill();
        })
      );


      // ～～ 接著再放回你原本的 palm/sizeFn 函式 ～～
      const palm = (lm: any[]) => {
        const a = lm[0],
          b = lm[9];
        return {
          x: ((a.x + b.x) / 2) * w,
          y: ((a.y + b.y) / 2) * hg,
        };
      };

      const sizeFn = (lm: any[]) => {
        const a = lm[0],
          b = lm[9];
        return Math.hypot((a.x - b.x) * w, (a.y - b.y) * hg);
      };

      let palms: { x: number; y: number }[] = [];
      if (res?.landmarks?.[0]) {
        const p = palm(res.landmarks[0]);
        palms.push(p);
        lastPalm1Ref.current = { ...p, time: now };
      }
      if (res?.landmarks?.[1]) {
        const p = palm(res.landmarks[1]);
        palms.push(p);
        lastPalm2Ref.current = { ...p, time: now };
      }

      if (palms.length < 2) {
        const lp1 = lastPalm1Ref.current,
          lp2 = lastPalm2Ref.current;
        if (
          lp1 &&
          lp2 &&
          now - lp1.time < PALM_KEEP_MS &&
          now - lp2.time < PALM_KEEP_MS
        ) {
          palms = [
            { x: lp1.x, y: lp1.y },
            { x: lp2.x, y: lp2.y },
          ];
        }
      }

      if (palms.length < 2) {
        emaDistRef.current = null;
        emaVelRef.current = 0;
        detPhaseRef.current = "SEPARATE";
        debugRef.current = {
          dist: 0,
          vel: 0,
          thr: 0,
          state: "SEPARATE",
        };
        return;
      }

      if (res?.landmarks?.[0] && res?.landmarks?.[1]) {
        const scale =
          (sizeFn(res.landmarks[0]) + sizeFn(res.landmarks[1])) / 2 ||
          handScaleRef.current;
        handScaleRef.current = 0.9 * handScaleRef.current + 0.1 * scale;
      }

      const [p1, p2] = palms;
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const eDist = ema(dist, emaDistRef.current, EMA_DIST_ALPHA);
      const velRaw =
        emaDistRef.current !== null ? eDist - emaDistRef.current : 0;
      const eVel = ema(velRaw, emaVelRef.current, EMA_VEL_ALPHA);
      emaDistRef.current = eDist;
      emaVelRef.current = eVel;

      const thr =
        handScaleRef.current * 1.0 * clamp(sensitivity, 0.6, 1.6);
      const rawDrop = Math.abs(dist - prevRawDistRef.current);
      prevRawDistRef.current = dist;

      let st = detPhaseRef.current;
      if (st === "SEPARATE") {
        if (eVel < APPROACH_VEL) st = "APPROACH";
      } else if (st === "APPROACH") {
        const contactByNear = eDist < thr * CONTACT_MARGIN;
        const contactByFast = rawDrop > FAST_DROP_PX && dist < thr * 1.2;
        if (contactByNear || contactByFast) {
          const ts = performance.now();
          if (ts - lastClapAtRef.current > MIN_CLAP_GAP_MS) {
            lastClapAtRef.current = ts;
            onClap(ts);
          }
          st = "CONTACT";
        }
        if (eVel >= 0 && eDist >= thr * SEPARATE_MARGIN) st = "SEPARATE";
      } else if (st === "CONTACT") {
        if (eDist > thr * SEPARATE_MARGIN) st = "SEPARATE";
      }
      detPhaseRef.current = st;

      ctx.strokeStyle = "#00ff99";
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "12px monospace";
      ctx.fillText(
        `dist:${fmt(eDist)} vel:${fmt(eVel, 2)} thr:${fmt(thr)} state:${st}`,
        10,
        18
      );
      debugRef.current = {
        dist: eDist,
        vel: eVel,
        thr,
        state: st,
      };
    }

    return () => {
      cancelAnimationFrame(animRef.current!);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream)
          .getTracks()
          .forEach((t) => t.stop());
      }
      handRef.current?.close();
      stopMissTimer();


      if (musicRef.current) {
        musicRef.current.pause();
        musicRef.current = null;
      }
      stopped = true;
    };
  }, [sensitivity]);

  function onClap(ts: number) {
    const curPhase = phaseRef.current;
    if (!(curPhase === "calibrating" || curPhase === "playing")) return;
    const list = beatsRef.current;
    if (list.length === 0) return;
    const idx = list.findIndex((b) => b.receivedAt === undefined);
    if (idx === -1) return;

    setClapCount((c) => c + 1);

    const offsetBase = baseDelayMs + offsetAdjRef.current;
    const target = list[idx];
    let diff = ts - (target.expectedAt + offsetBase);

    let verdict: BeatLog["verdict"] =
      Math.abs(diff) <= PERFECT_MS
        ? "Perfect"
        : Math.abs(diff) <= GOOD_MS
        ? "Good"
        : "Miss";

    if (verdict === "Miss") {
      offsetAdjRef.current = ema(-diff, offsetAdjRef.current, 0.9);
      const newOffset = baseDelayMs + offsetAdjRef.current;
      diff = ts - (target.expectedAt + newOffset);
      verdict =
        Math.abs(diff) <= PERFECT_MS
          ? "Perfect"
          : Math.abs(diff) <= GOOD_MS
          ? "Good"
          : "Miss";
    } else {
      offsetAdjRef.current = ema(-diff, offsetAdjRef.current, 0.25);
    }

    setBeats((prev) => {
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        receivedAt: ts,
        delta: diff,
        verdict,
      };
      const done = updated.filter((b) => b.receivedAt !== undefined).length;
      setProgress((done / updated.length) * 100);
      setLastVerdict(verdict);
      beatsRef.current = updated;
      return updated;
    });

    // 👇 保留視覺動畫 & 震動，不再播放任何拍手音效
    const side: StickSide = (altRef.current = !altRef.current) ? "L" : "R";
    if (verdict === "Perfect") {
      hit(side, true);
      vibrate(40);
    } else if (verdict === "Good") {
      hit(side, false);
      vibrate(20);
    } else {
      hit(side, false);
    }

    const left = beatsRef.current.findIndex((b) => b.receivedAt === undefined);
    if (left === -1 && curPhase === "playing") {
      setTimeout(() => setPhase("finished"), 250);
      stopMissTimer();
    }
  }

  async function startCalibration() {
    setPhase("calibrating");
    setBpm(DEFAULT_BPM);
    setClapCount(0);
    setLastVerdict("-");
    offsetAdjRef.current = 0;

    // ✅ 校準：固定用 CALI_BEATS 拍、DEFAULT_BPM 速度
    const seq = prepareBeats(CALI_BEATS, DEFAULT_BPM);
    setBeats(seq);
    beatsRef.current = seq;
    setProgress(0);
    startMissTimer();

    // 跑完整個校準節奏（不論有沒有拍手）
    await run(seq, { variable: false, distract: false });

    // ✅ 多等一小段時間，讓「最後一拍」也超過 GOOD_MS，會被判成 Miss
    await new Promise((r) => setTimeout(r, GOOD_MS + 80));
    sweepTimeoutMisses(); // 再掃一次，把最後還沒判定的拍子補成 Miss

    // 用「最後版的 beatsRef」來算基準延遲
    const finalBeats = beatsRef.current;
    const deltas = finalBeats
      .filter((b) => b.receivedAt !== undefined)
      .map((b) => (b.receivedAt as number) - b.expectedAt);

    setBaseDelayMs(deltas.length ? median(deltas) : 300);
    stopMissTimer();
    setPhase("ready");
  }

  async function startGame() {
    const { bpm: levelBpm, music, beats, introMs } = LEVEL_SETTINGS[level];

    // ⭐ 開新的一局時，把上一次的結算視窗關掉
    setShowResultModal(false);

    if (musicRef.current) {
      musicRef.current.pause();
      musicRef.current = null;
    }

    const audio = new Audio(music);
    audio.currentTime = 0;
    audio.loop = false;
    musicRef.current = audio;

    try {
      await audio.play();
    } catch (err) {
      console.warn("music play error:", err);
    }

    // ⭐ 節奏開始時間 = 現在時間 + 各等級自己的前奏毫秒數
    const startAt = performance.now() + introMs;

    setPhase("playing");
    setBpm(levelBpm);
    setClapCount(0);
    setLastVerdict("-");
    offsetAdjRef.current = 0;

    const seq = prepareBeats(beats, levelBpm, startAt);
    setBeats(seq);
    beatsRef.current = seq;
    setProgress(0);
    startMissTimer();

    await run(seq, {
      variable: level === 3,
      distract: level === 3,
    });

    // ⭐ 拍子跑完 → 遊戲結束，但音樂繼續播到自然結束
  }

  async function run(seq: BeatLog[], opt: { variable: boolean; distract: boolean }) {
    const ctx = ensureAudio();
    if (ctx.state === "suspended") await ctx.resume();
    const drums = drumKitRef.current!;

    for (let i = 0; i < seq.length; i++) {
      // ⭐ 先等到這一拍應該發生的時間（expectedAt）
      const targetAt = seq[i].expectedAt;
      const wait = targetAt - performance.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }

      // 然後才讓小丑揮鼓 + 每一拍都閃光
      const down = true; // ✅ 每一拍都啟動 stage-center-inner--pulse
      hit(i % 2 === 0 ? "L" : "R", down);
      spawnNote(); // ⭐ 每一拍都噴出一個音符



      // ⭐ Level3 專用變速：
      // 在「第 LEVEL3_CHANGE_BEAT 拍打完之後」，重新幫「後面」的拍子排時間
      if (opt.variable && i === LEVEL3_CHANGE_BEAT - 1) {
        const nb = LEVEL3_NEW_BPM; // 新 BPM
        setBpm(nb); // UI 上的 BPM 跟著更新

        // 從「現在時間」往後排，重新算後面每一拍的 expectedAt
        let t = performance.now();
        for (let k = i + 1; k < seq.length; k++) {
          t += 60000 / nb; // 每拍間隔（毫秒）
          seq[k].expectedAt = t;
        }
      }

      // ⭐ 節拍器聲音 + 干擾音效（每一拍都一樣）
      if (metronomeOn) {
        drums.accent(1.0);        // ✅ 每拍都一樣的強度
        fxRef.current?.pulse?.(); // ✅ 每拍都觸發 DrumFX 特效
        if (opt.distract && i % 2 === 1) {
          setTimeout(() => drums.snare(0.2), 120);
        }
      }



      // ⭐ 每打一拍就掃一次逾時 Miss
      sweepTimeoutMisses();
    }
  }

  const prepareBeats = (n: number, b: number, startAt?: number) => {
    const s = (startAt ?? performance.now()) + 650;
    const iv = 60000 / b;
    return Array.from({ length: n }, (_, i) => ({
      expectedAt: s + i * iv,
    }));
  };

  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const judged = beats.filter((b) => b.verdict);
  const perfect = judged.filter((b) => b.verdict === "Perfect").length;
  const good = judged.filter((b) => b.verdict === "Good").length;
  const miss = judged.filter((b) => b.verdict === "Miss").length;
  const acc = Math.round(
    ((perfect + good * 0.7) / (judged.length || 1)) * 100
  );

  // 🎁 根據綜合分數決定糖果數量
  let candyCount = 0;
  if (acc >= 40 && acc < 55) {
    candyCount = 1;
  } else if (acc >= 55 && acc < 70) {
    candyCount = 2;
  } else if (acc >= 70) {
    candyCount = 3;
  }

  // ⭐ 說明文字（固定）
  const candyText = "恭喜你🎉";


  return (
    <div className="game-root">

      {/* 🎪 中央舞台上的小丑（固定在背景舞台正中間） */}
      <div className="stage-center">
        <div
          className={
            "stage-center-inner" + (downbeatAnim ? " stage-center-inner--pulse" : "")
          }
        >
          <div id="clown-hero" className={imgAnim}>
            <img src="/yy.png" alt="clown" />
          </div>

          {/* ⭐ 音符特效層 */}
          <div className="note-layer">
            {notes.map((n) => (
              <div
                key={n.id}
                className={`music-note ${n.color}`}
                style={{
                  left: `${50 + n.x}%`,          // 以舞台中央為基準，左右小小飄動
                  animationDelay: `${n.delay}s`, // 起跳時間錯開一點
                }}
              >
                ♪
              </div>
            ))}
          </div>
        </div>
      </div>


      {/* 🎛 左側控制面板 */}
      <div className="card side-panel left-panel">
        <div className="left-panel-inner">
          <h2 className="left-panel-title">🎭 小丑打鼓台</h2>


          <div
            style={{
              marginTop: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {/* 等級選擇卡片 */}
            <div
              style={{
                background: "#0f1635",
                borderRadius: 12,
                padding: "10px 12px",
                border: "1px solid #2b3874",
              }}
            >
              <div style={{ marginBottom: 6, fontWeight: 600 }}>等級選擇</div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  className="btn ghost"
                  onClick={() => setLevel(1)}
                  disabled={phase === "calibrating" || phase === "playing"}
                >
                  Level 1
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setLevel(2)}
                  disabled={phase === "calibrating" || phase === "playing"}
                >
                  Level 2
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setLevel(3)}
                  disabled={phase === "calibrating" || phase === "playing"}
                >
                  Level 3
                </button>
                <span className="pill">目前難度：{level}</span>
              </div>
            </div>

            {/* 遊戲控制卡片 + 進度條 */}
            <div
              style={{
                background: "#0f1635",
                borderRadius: 12,
                padding: "10px 12px",
                border: "1px solid #2b3874",
              }}
            >
              <div style={{ marginBottom: 6, fontWeight: 600 }}>🎮 遊戲控制</div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  className="btn"
                  onClick={startCalibration}
                  disabled={phase === "calibrating" || phase === "playing"}
                >
                  校準
                </button>
                <button
                  className="btn"
                  onClick={startGame}
                  disabled={phase !== "ready" && phase !== "finished"}
                >
                  開始遊戲
                </button>
                <span className="pill">基準延遲：{Math.round(baseDelayMs)} ms</span>
                <span className="pill">BPM：{bpm}</span>
              </div>

              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.85,
                    marginBottom: 4,
                  }}
                >
                  本輪進度
                </div>
                <div
                  className="meter"
                  style={{ display: progress > 0 ? "block" : "none" }}
                >
                  <div style={{ width: `${progress}%` }} />
                </div>
              </div>
            </div>

            {/* 拍手靈敏度 + 偵測狀態 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2,minmax(0,1fr))",
                gap: 8,
              }}
            >
              {/* ⚙️ 拍手靈敏度 + 節拍器 */}
              <div
                style={{
                  background: "#0f1635",
                  border: "1px dashed #2b3874",
                  borderRadius: 12,
                  padding: 10,
                }}
              >
                <div>
                  <b>⚙️ 拍手靈敏度</b>
                </div>
                <input
                  style={{ width: "100%" }}
                  type="range"
                  min="0.6"
                  max="1.6"
                  step="0.02"
                  value={sensitivity}
                  onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                />
                <div>
                  倍率：<b>{fmt(sensitivity, 2)}×</b>
                </div>

                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <input
                    id="metronome-toggle"
                    type="checkbox"
                    checked={metronomeOn}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setMetronomeOn(e.target.checked)
                    }
                  />
                  <label htmlFor="metronome-toggle">播放節拍器滴答聲</label>
                </div>
              </div>

              {/* 🧪 偵測狀態 */}
              <div
                style={{
                  background: "#0f1635",
                  border: "1px dashed #2b3874",
                  borderRadius: 12,
                  padding: 10,
                }}
              >
                <div>
                  <b>🧪 偵測狀態</b>
                </div>

                {/* 數值表格：左右對齊，避免換行醜掉 */}
                <div
                  style={{
                    marginTop: 6,
                    display: "grid",
                    rowGap: 4,
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>手掌距離</span>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {fmt(debugRef.current.dist)} px
                    </span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>手掌速度</span>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {fmt(debugRef.current.vel, 2)} px
                    </span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>判定門檻</span>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {fmt(debugRef.current.thr)} px
                    </span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>狀態</span>
                    <span style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                      {debugRef.current.state === "SEPARATE"
                        ? "分開"
                        : debugRef.current.state === "APPROACH"
                        ? "靠近中"
                        : "碰撞（拍手）"}
                    </span>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>


      {/* 🎥＋📊 右側：攝影機＋遊戲結果整合面板 */}
      <div className="card side-panel right-panel">
        {/* 上面：攝影機畫面 */}
        <div className="camera-box">
          <video ref={videoRef} playsInline muted style={{ display: "none" }} />
          <canvas ref={overlayRef} />
        </div>

        {/* 下面：同一框裡的遊戲結果（與相機有一點間距） */}
        <div className="right-score-box" style={{ marginTop: "12px" }}>
          <div className="score-grid score-grid-right">
            <div className="kpi perfect">
              <div className="v">{perfect}</div>
              <div className="t">Perfect</div>
            </div>
            <div className="kpi good">
              <div className="v">{good}</div>
              <div className="t">Good</div>
            </div>
            <div className="kpi miss">
              <div className="v">{miss}</div>
              <div className="t">Miss</div>
            </div>
            <div className="kpi acc">
              <div className="v">{acc}%</div>
              <div className="t">綜合分數</div>
            </div>
          </div>
        </div>
      </div>

      {/* ⭐ 遊戲結束結果視窗 */}
      {showResultModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            style={{
              background: "#10153a",
              borderRadius: 20,
              padding: "28px 32px",
              width: "min(520px, 92vw)",
              boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
              border: "1px solid #3848b8",
            }}
          >
            <h2 style={{ fontSize: 24, marginBottom: 12 }}>
              🎉 本輪打鼓結果
            </h2>
            <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
              辛苦了！來看看你這一輪的小丑打鼓表現吧～
            </p>

            {/* 成績小卡 */}
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  flex: "1 1 100px",
                  background: "#183c6b",
                  borderRadius: 12,
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.8 }}>Perfect</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{perfect}</div>
              </div>
              <div
                style={{
                  flex: "1 1 100px",
                  background: "#184f3b",
                  borderRadius: 12,
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.8 }}>Good</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{good}</div>
              </div>
              <div
                style={{
                  flex: "1 1 100px",
                  background: "#642539",
                  borderRadius: 12,
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.8 }}>Miss</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{miss}</div>
              </div>
              <div
                style={{
                  flex: "1 1 120px",
                  background: "#8a5a1f",
                  borderRadius: 12,
                  padding: "10px 12px",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.8 }}>綜合分數</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{acc}%</div>
              </div>
            </div>

            <p style={{ fontSize: 14, opacity: 0.9, marginBottom: 18 }}>
              再多練幾次，小丑就會跟著你一起變成節奏大師啦！🥁✨
            </p>
            {/* 🎁 本輪糖果獎勵 */}
            <div
              style={{
                marginBottom: 18,
                padding: "12px 14px",
                borderRadius: 14,
                background: "#13204f",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              {/* 左邊：文字說明 */}
              <div>
                <div
                  style={{
                    fontSize: 13,
                    opacity: 0.85,
                    marginBottom: 4,
                  }}
                >
                  🎁 本輪獎勵糖果
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.5 }}>{candyText}</div>
              </div>

              {/* 右邊：顯示 0～3 顆 candy.png 圖片（橫向並排） */}
              <div
                style={{
                  minWidth: 110,
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {candyCount === 0 ? (
                  <span style={{ fontSize: 18, opacity: 0.8 }}>沒有糖果</span>
                ) : (
                  Array.from({ length: candyCount }).map((_, i) => (
                    <img
                      key={i}
                      src="/candy.png"
                      alt="candy"
                      style={{
                        width: 40,
                        height: "auto",
                      }}
                    />
                  ))
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 4,
              }}
            >
              <button
                className="btn ghost"
                onClick={() => setShowResultModal(false)}
              >
                先休息一下
              </button>
              <button
                className="btn"
                onClick={() => {
                  setShowResultModal(false);
                  startGame(); // ⭐ 直接再玩一次
                }}
              >
                再玩一次
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fx-layer">
        <DrumFX ref={fxRef} />
      </div>

      {/* ⭐ 一進頁面先跳出的校準視窗 */}
      {showCalibModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#0f1635",
              borderRadius: 18,
              padding: "28px 32px", // ⭐ 內距多一點
              width: "min(600px, 92vw)", // ⭐ 視窗更寬
              boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
              border: "1px solid #2b3874",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 12 }}>
              📏 先進行拍手校準
            </h2>
            <p style={{ marginBottom: 12, lineHeight: 1.6 }}>
              請先完成 <b>{CALI_BEATS}</b> 拍的校準，讓系統學習你的拍手延遲。
            </p>
            <ul style={{ paddingLeft: 18, marginBottom: 16, lineHeight: 1.5 }}>
              <li>對著鏡頭，雙手在畫面中間出現。</li>
              <li>聽著節拍聲，跟著節奏拍手。</li>
              <li>不用太緊張，只要大概跟上就可以。</li>
            </ul>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 8,
              }}
            >
              <button
                className="btn ghost"
                onClick={() => setShowCalibModal(false)}
              >
                先看看畫面
              </button>
              <button
                className="btn"
                onClick={async () => {
                  // 關掉視窗 + 直接開始校準
                  setShowCalibModal(false);
                  await startCalibration();
                }}
              >
                立即開始校準
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
