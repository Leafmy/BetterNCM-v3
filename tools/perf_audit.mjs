import { Session, fetchTargets, evaluate } from './cdp_inject.mjs';
import { writeFileSync } from 'node:fs';
const label = process.argv[2] || 'current';
const targets = await fetchTargets({host:'127.0.0.1',port:9222});
const target = targets.find(t=>t.url.includes('orpheus/pub/app.html'));
const s = new Session(target.webSocketDebuggerUrl);
await s.open();
try {
  await s.send('Performance.enable');
  const before = await s.send('Performance.getMetrics');
  await s.send('Profiler.enable');
  await s.send('Profiler.start');
  await new Promise(r=>setTimeout(r,4000));
  const {profile} = await s.send('Profiler.stop');
  const after = await s.send('Performance.getMetrics');
  const a = Object.fromEntries(before.metrics.map(m=>[m.name,m.value]));
  const b = Object.fromEntries(after.metrics.map(m=>[m.name,m.value]));
  const delta = Object.fromEntries(['TaskDuration','ScriptDuration','RecalcStyleDuration','LayoutDuration','RecalcStyleCount','LayoutCount'].map(k=>[k,b[k]-a[k]]));
  const stats = JSON.parse((await evaluate(`JSON.stringify((function(){
    var styles=Array.from(document.querySelectorAll('style')), unique=new Set(styles.map(s=>s.textContent));
    return {nodes:document.querySelectorAll('*').length,styles:styles.length,duplicateStyles:styles.length-unique.size,
      lyricRoots:document.querySelectorAll('.rnp-lyrics').length};
  })())`)).value);
  const counts = new Map();
  for(const id of profile.samples||[]) counts.set(id,(counts.get(id)||0)+1);
  const hot = profile.nodes.map(n=>({fn:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,samples:counts.get(n.id)||0})).sort((a,b)=>b.samples-a.samples).slice(0,12);
  const report={label,stats,delta,heapBytes:b.JSHeapUsedSize,dom:await s.send('Memory.getDOMCounters'),hot};
  writeFileSync(new URL('../out/perf-'+label+'.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { s.close(); }
