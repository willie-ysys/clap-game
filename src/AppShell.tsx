import React from "react";
import RhythmClapGame from "./RhythmClapGame";

class ErrorBoundary extends React.Component<{children: React.ReactNode},{err?: any}> {
  constructor(p:any){ super(p); this.state = { err: undefined }; }
  static getDerivedStateFromError(err:any){ return { err }; }
  componentDidCatch(err:any, info:any){ console.error("[RenderError]", err, info); }
  render(){
    if (this.state.err) {
      return (
        <div style={{padding:16,color:"#fff"}}>
          <h2>😵 程式渲染失敗</h2>
          <pre style={{whiteSpace:"pre-wrap",background:"#1a2030",padding:12,borderRadius:8}}>
            {String(this.state.err?.message || this.state.err)}
          </pre>
        </div>
      );
    }
    return (
      <>
        <div style={{margin:12,padding:"8px 10px",border:"1px dashed #6aa0ff",
          borderRadius:8,color:"#dce6ff",fontSize:14}}>
          PAGE LOADED ✅（Shell）
        </div>
        {this.props.children}
      </>
    );
  }
}
export default function AppShell(){
  return (
    <ErrorBoundary>
      <RhythmClapGame />
    </ErrorBoundary>
  );
}
