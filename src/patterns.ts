export type BeatLogLite = { expectedAt: number; accent?: boolean };

type Pattern = { bpm:number; bars:number; grid:number; hits:number[]; name:string };

const LEVEL_PATTERNS: Record<1|2|3, Pattern> = {
  1: { bpm: 80,  bars: 4, grid: 16, hits: [0,4,8,12],                 name: "Straight 4" },
  2: { bpm: 92,  bars: 4, grid: 16, hits: [0,3,4,7,8,11,12,15],       name: "Syncopation" },
  3: { bpm: 104, bars: 4, grid: 16, hits: [0,5,7,8,10,12,15],         name: "Clave-ish" },
};

export function preparePatternBeats(level: 1|2|3): { beats: BeatLogLite[]; bpm:number }{
  const pat = LEVEL_PATTERNS[level] ?? LEVEL_PATTERNS[1];
  const iv = 60000/pat.bpm;
  const bar = iv*4;
  const step = bar/pat.grid;
  const start = performance.now()+700;
  const beats: BeatLogLite[] = [];
  for(let b=0;b<pat.bars;b++){
    for(const h of pat.hits){
      const t = start + b*bar + h*step;
      const accent = (h % pat.grid)===0;
      beats.push({ expectedAt: t, accent });
    }
  }
  return { beats, bpm: pat.bpm };
}

export async function playCountIn(kit: any, bpm:number){
  if(!kit) return;
  const iv = 60000/bpm;
  const now = performance.now();
  const taps = [0, iv, iv*2, iv*3];
  for(let i=0;i<taps.length;i++){
    const down = i===taps.length-1;
    kit.tick(down?0.9:0.6);
    await new Promise(r=>setTimeout(r, Math.max(0, now+taps[i]-performance.now())));
  }
}

export function playLevelMusic(ctx: AudioContext, level: 1|2|3){
  let stopped=false;
  const pat = LEVEL_PATTERNS[level] ?? LEVEL_PATTERNS[1];
  const beat = 60/pat.bpm;
  const start = ctx.currentTime + 0.1;

  function hatLoop(){
    if(stopped) return;
    const t0 = ctx.currentTime;
    for(let i=0;i<8;i++){
      const t = start + i*beat/2;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const hp = ctx.createBiquadFilter();
      hp.type="highpass"; hp.frequency.value=6000;
      o.type="square"; o.frequency.value=8000;
      g.gain.setValueAtTime(0.04, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t+0.03);
      o.connect(hp).connect(g).connect(ctx.destination);
      o.start(t); o.stop(t+0.035);
    }
  }

  function kick(t:number, v=0.9){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type="sine"; o.frequency.setValueAtTime(160,t);
    o.frequency.exponentialRampToValueAtTime(60,t+0.12);
    g.gain.setValueAtTime(v,t);
    g.gain.exponentialRampToValueAtTime(0.0001,t+0.14);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t+0.15);
  }
  function snare(t:number, v=0.35){
    const b=ctx.createBuffer(1, Math.floor(ctx.sampleRate*.2), ctx.sampleRate);
    const d=b.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);
    const s=ctx.createBufferSource(); s.buffer=b;
    const bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=1800;
    const hp=ctx.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=1200;
    const g=ctx.createGain(); g.gain.setValueAtTime(v,t); g.gain.exponentialRampToValueAtTime(0.0001,t+.18);
    s.connect(bp).connect(hp).connect(g).connect(ctx.destination); s.start(t); s.stop(t+.2);
  }

  const loopLen = 4*beat;
  const base = ctx.currentTime + 0.2;

  if(level===1){
    for(let i=0;i<8;i++){
      const bt = base + i*beat;
      kick(bt,0.9);
      snare(bt+2*beat,0.35);
    }
  }else if(level===2){
    const offs=[0,1.5,2,3.5];
    for(let i=0;i<offs.length;i++){
      const t = base + offs[i]*beat;
      if(i%2===0) kick(t,0.85); else snare(t,0.4);
    }
  }else{
    const offs=[0,1.25,2,3.5];
    for(let i=0;i<offs.length;i++){
      const t = base + offs[i]*beat;
      if(i%2===0) kick(t,0.9); else snare(t,0.42);
    }
  }

  hatLoop();
  const id = setInterval(()=>{ if(!stopped) hatLoop(); }, (loopLen*1000)|0);

  return () => { stopped=true; clearInterval(id); };
}
