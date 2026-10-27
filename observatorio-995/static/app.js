"use strict";
const $=id=>document.getElementById(id);
const groups={
  "presentation-routers":["presentation-entry","presentation-lb-master","presentation-lb-backup","presentation-keepalived-master","presentation-keepalived-backup"],
  "presentation-workers":["web1","web2","web3"],
  "application-routers":["application-lb-master","application-lb-backup","application-keepalived-master","application-keepalived-backup"],
  "application-workers":["app1","app2","app3"],
  "data-galera":["galera-proxy","galera-proxy-backup","galera-keepalived-master","galera-keepalived-backup","galera1","galera2","galera3"],
  "data-mongo":["mongodb","mongodb2","mongodb-arbiter"],
  "data-redis":["redis","redis-replica","redis-sentinel-1","redis-sentinel-2","redis-sentinel-3"],
  "supportNodes":["nagios","catalog-init"]
};
const labels={"presentation-entry":"HTTP entry","presentation-lb-master":"HAProxy principal","presentation-lb-backup":"HAProxy respaldo","presentation-keepalived-master":"VRRP principal","presentation-keepalived-backup":"VRRP respaldo","application-lb-master":"HAProxy principal","application-lb-backup":"HAProxy respaldo","application-keepalived-master":"VRRP principal","application-keepalived-backup":"VRRP respaldo","galera-proxy":"SQL proxy principal","galera-proxy-backup":"SQL proxy respaldo","galera-keepalived-master":"VRRP principal","galera-keepalived-backup":"VRRP respaldo","mongodb-arbiter":"Árbitro de elección","catalog-init":"Inicializador","nagios":"Monitoreo"};
let previous=null;
let focusRoute=false;
let motionPaused=false;
let mapMotionPaused=false;
let latestSnapshot=null;
const prefersReducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
let lastJourneySeq=-1;
const html=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
function nodeState(service,d){
  const c=d.containers?.[service];
  if(!c)return {cls:"off",name:"No detectado",detail:"sin contenedor"};
  if(service==="catalog-init"&&c.state==="exited"&&c.exit_code===0)return {cls:"finished",detail:"Completado · exit 0"};
  if(c.state!=="running")return {cls:"off",detail:`${c.state} · exit ${c.exit_code??"?"}`};
  if(c.health==="unhealthy")return {cls:"off",detail:"No saludable"};
  if(c.health==="starting")return {cls:"start",detail:"Iniciando…"};
  return {cls:"up",detail:c.health==="healthy"?"Healthy":"En ejecución"};
}
function roleOf(service,d){
  if(service==="redis"||service==="redis-replica"){
    const r=d.redis?.roles?.[service];
    if(!r?.role)return null;
    const ismaster=r.role==="master";
    return {cls:ismaster?"primary":"",text:ismaster?"PRIMARIO":"RÉPLICA"+(r.link==="up"?" · SYNC":"")};
  }
  if(service==="mongodb"||service==="mongodb2"){
    const r=d.mongo?.[service];
    return r?{cls:r==="primary"?"primary":"",text:r==="primary"?"PRIMARIO":"SECUNDARIO"}:null;
  }
  return null;
}
// Resolver solo servicios explícitos en X-Request-Trace. Redis/MongoDB genéricos
// terminan en el destino LÓGICO, nunca en un contenedor físico inventado.
function resolvedRoute(d){
  const tokens=String(d.catalog?.trace||'').split('->').map(t=>t.trim()).filter(Boolean);
  const targets=[];
  for(const t of tokens){
    const exact=t.match(/\b(presentation-lb-(?:master|backup)|application-lb-(?:master|backup)|app[123]|galera[123]|webnode[123])\b/i);
    if(exact){targets.push({id:exact[1].toLowerCase().replace('webnode','web'),logical:false,label:t});continue;}
    if(/\bredis\b/i.test(t))targets.push({id:'logical-redis',logical:true,label:t});
    else if(/\bmongodb\b/i.test(t))targets.push({id:'logical-mongo',logical:true,label:t});
  }
  return targets;
}
function traceHits(d){return new Set(resolvedRoute(d).filter(t=>!t.logical).map(t=>t.id));}
function serviceNode(s,d,hits){
  let state=nodeState(s,d),role=roleOf(s,d),highlight=hits.has(s)?' trace':'';
  const smallName=labels[s]||s;
  return `<div class="node ${state.cls}${highlight}" id="node-${s}" title="${html(s)} · ${html(state.detail)}"><span class="status"></span><div class="node-content"><div class="node-name">${html(smallName)}</div><div class="node-meta">${html(s)} · ${html(state.detail)}</div>${role?`<span class="node-role ${role.cls}">${html(role.text)}</span>`:''}</div></div>`;
}
function updateNodes(d){
  const hits=traceHits(d);
  for(const [id, services] of Object.entries(groups))$(id).innerHTML=services.map(s=>serviceNode(s,d,hits)).join('');
  for(const [key,tier] of Object.entries(d.tiers||{})){
    if(key==='support')continue;
    const n=tier.services.filter(s=>nodeState(s,d).cls==='up').length;
    $('tierStatus-'+key).textContent=`${n} / ${tier.services.length}`;
  }
  $('topologyBoard').classList.toggle('route-focus',focusRoute);
  requestAnimationFrame(drawLinks);
}
function drawLinks(){
  const board=$('topologyBoard'),svg=$('links');
  if(!board||getComputedStyle(svg).display==='none'||!latestSnapshot){if(svg)svg.innerHTML='';return;}
  const rect=board.getBoundingClientRect(),w=rect.width,h=rect.height;
  if(w<1||h<1)return;
  svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  // Conexiones fijas entre capas: topología LÓGICA, no telemetría de red.
  const tiers=['tier-presentation','tier-application','tier-data'].map(x=>$(x).getBoundingClientRect());
  const backbone=[];
  for(let i=0;i<2;i++){
    const a=tiers[i],b=tiers[i+1];
    const x1=a.right-rect.left,x2=b.left-rect.left,y1=a.top-rect.top+90,y2=b.top-rect.top+90;
    backbone.push(`<path class="backbone" d="M${x1},${y1} C${(x1+x2)/2},${y1} ${(x1+x2)/2},${y2} ${x2},${y2}"/>`);
  }
  const steps=resolvedRoute(latestSnapshot);
  const segments=[];
  for(let i=0;i<steps.length-1;i++){
    const a=$(steps[i].logical?steps[i].id:'node-'+steps[i].id);
    const b=$(steps[i+1].logical?steps[i+1].id:'node-'+steps[i+1].id);
    if(!a||!b)continue;
    const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
    const rightward=br.left>=ar.right;
    const leftward=ar.left>=br.right;
    let x1,y1,x2,y2;
    if(rightward){x1=ar.right-rect.left-2;y1=(ar.top+ar.bottom)/2-rect.top;x2=br.left-rect.left+2;y2=(br.top+br.bottom)/2-rect.top;}
    else if(leftward){x1=ar.left-rect.left;y1=(ar.top+ar.bottom)/2-rect.top;x2=br.right-rect.left;y2=(br.top+br.bottom)/2-rect.top;}
    else{
      // Dentro de la misma capa, rodear las tarjetas por la derecha.
      x1=ar.right-rect.left-4;y1=(ar.top+ar.bottom)/2-rect.top;
      x2=br.right-rect.left-4;y2=(br.top+br.bottom)/2-rect.top;
    }
    const dx=x2-x1,dy=y2-y1;
    let path;
    if(steps[i+1].logical){
      // El destino es un SERVICIO LÓGICO. Enrutar por el pasillo izquierdo
      // de la capa de datos para evitar atravesar las tarjetas de MongoDB.
      const dataRect=$('tier-data').getBoundingClientRect();
      const corridor=Math.max(0,dataRect.left-rect.left+7);
      path=`M${x1.toFixed(1)},${y1.toFixed(1)} L${corridor.toFixed(1)},${y1.toFixed(1)} L${corridor.toFixed(1)},${y2.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`;
    }else if(!rightward&&!leftward){
      const wrap=Math.min(w-8,Math.max(x1,x2)+16);
      path=`M${x1.toFixed(1)},${y1.toFixed(1)} C${wrap.toFixed(1)},${y1.toFixed(1)} ${wrap.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    }else{
      const bend=Math.max(15,Math.abs(dx)*.42);
      const sign=Math.sign(dx)||1;
      path=`M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1+sign*bend).toFixed(1)},${y1.toFixed(1)} ${(x2-sign*bend).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    }
    segments.push(path);
  }
  const all=segments.map((path,i)=>{
    const begin=(i*.59).toFixed(2);
    const moving=(!mapMotionPaused&&!prefersReducedMotion?.matches)?`<circle r="5" fill="#fbfcff" filter="url(#routeGlow)"><animateMotion path="${path}" begin="${begin}s" dur="0.56s" fill="freeze"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.12;.80;1" begin="${begin}s" dur="0.56s" fill="freeze"/></circle>`:'';
    return `<path class="route-halo" d="${path}"/><path class="active-route" d="${path}"/><circle class="route-endpoint" cx="0" cy="0" r="0"/>${moving}`;
  }).join('');
  svg.innerHTML=`<defs><filter id="routeGlow" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${backbone.join('')}${all}`;
  if(mapMotionPaused||prefersReducedMotion?.matches)svg.pauseAnimations?.();
  else svg.unpauseAnimations?.();
}
function updateTrace(d){
  const c=d.catalog||{};
  $('traceCode').textContent=c.http?`HTTP ${c.http}`:'SIN RESPUESTA';
  $('traceCode').className='chip'+(!c.ok?' fail':'');
  const segments=String(c.trace||'').split('->').map(s=>s.trim()).filter(Boolean);
  $('traceChips').innerHTML=segments.length?segments.map((s,i)=>`${i?'<span class="hop-arrow">→</span>':''}<span class="hop">${html(s)}</span>`).join(''):'<span class="empty">La solicitud respondió, pero no incluyó X-Request-Trace.</span>';
  $('traceTime').textContent=`Última consulta: ${new Date(d.timestamp).toLocaleTimeString('es-MX')} · ${c.latency_ms??'—'} ms. La traza depende de la caché y del balanceador.`;
}
function updateJourney(d){
  const c=d.catalog||{};
  const seq=Number(d.request_sequence||0);
  if(seq===lastJourneySeq)return;
  lastJourneySeq=seq;
  const segments=String(c.trace||'').split('->').map(s=>s.trim()).filter(Boolean);
  $('journeyCode').textContent=c.ok?`HTTP ${c.http} · ${c.latency_ms} ms`:'SIN RESPUESTA';
  $('journeyCode').classList.toggle('fail',!c.ok);
  const lane=$('journeyHops');
  lane.classList.toggle('motion-off',motionPaused);
  lane.innerHTML=segments.length?segments.map((name,i)=>{
    const arrow=i?`<span class="travel-link" aria-hidden="true"><span class="travel-dot" style="animation-delay:${((i-1)*0.36+0.18).toFixed(2)}s"></span></span>`:'';
    const m=name.match(/webnode\d|app\d|redis|galera\d|mongodb/);
    let cls=m?'special':'';
    return `${arrow}<span class="journey-stop ${cls}" style="animation-delay:${(i*0.36).toFixed(2)}s"><span class="journey-step">${String(i+1).padStart(2,'0')}</span>${html(name)}</span>`;
  }).join(''):'<span class="empty">Sin traza disponible. La solicitud no devolvió una ruta identificable.</span>';
  $('journeyMeta').textContent=`Sondeo #${seq} · ${new Date(d.timestamp).toLocaleTimeString('es-MX')} · Ruta informada por la aplicación`;
}
function updateRecovery(d){
  const r=d.last_recovery;
  $('recoveryInfo').textContent=r?`Última recuperación observada: ${r.service} · ${r.observed_seconds} s entre las detecciones de caída y regreso. No equivale a un tiempo de interrupción exacto.`:'El tiempo de recuperación se calculará cuando observemos una caída y posterior reaparición del mismo contenedor. Es una aproximación basada en sondeos cada 4 s.';
}
function updateChart(d){
  const history=d.history||[],valid=history.map((h,i)=>({...h,i})).filter(h=>typeof h.latency==='number');
  if(!valid.length){$('spark').innerHTML='';return;}
  const w=480,h=144,pad=12,max=Math.max(...valid.map(x=>x.latency),30)*1.15;
  const toXY=v=>({x:pad+(v.i/Math.max(1,history.length-1))*(w-pad*2),y:h-pad-v.latency/max*(h-2*pad)});
  const points=valid.map(toXY),poly=points.map(p=>`${p.x},${p.y}`).join(' ');
  const area=`M${points[0].x},${h} L${points.map(p=>`${p.x},${p.y}`).join(' L')} L${points[points.length-1].x},${h} Z`;
  $('spark').innerHTML=`<defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#2bd0c5" stop-opacity=".27"/><stop offset="1" stop-color="#2bd0c5" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#area)"/><polyline points="${poly}" fill="none" stroke="#48e2cb" stroke-width="2.5" stroke-linejoin="round"/>${points.length?`<circle cx="${points[points.length-1].x}" cy="${points[points.length-1].y}" r="4" fill="#6effdd"/>`:''}`;
}
function updateEvents(d){
  const events=d.events||[];
  $('eventsCount').textContent=`${events.length} EVENTOS`;
  $('eventList').innerHTML=events.length?events.slice(0,16).map(e=>`<div class="event ${e.level||'info'}"><div class="event-symbol">${e.level==='warning'?'!':e.level==='success'?'✓':'↻'}</div><div class="event-body"><b>${html(e.title)}</b><p>${html(e.detail)}</p></div><time>${html(new Date(e.at).toLocaleTimeString('es-MX'))}</time></div>`).join(''):'<div class="empty">Sin cambios detectados todavía.</div>';
}
function paint(d){
  latestSnapshot=d;
  $('clock').textContent=new Date().toLocaleTimeString('es-MX');
  if(!d.ready){$('updated').textContent='Esperando primer sondeo…';return;}
  $('updated').textContent=`Actualizado ${new Date(d.timestamp).toLocaleTimeString('es-MX')}`;
  $('activeCount').textContent=d.required_running;
  $('activeTotal').textContent=`/ ${d.required_total}`;
  $('activeDesc').textContent=d.required_running===d.required_total?'Todos los servicios principales activos':`${d.required_total-d.required_running} servicio(s) sin ejecutar`;
  const api=d.api||{};
  $('apiValue').textContent=api.ok?(api.status==='degraded'?'DEGRADADO':'OK'):'ERROR';
  $('apiCode').textContent=api.http?`HTTP ${api.http}`:'';
  $('apiDesc').textContent=api.ok?`Redis: ${api.redis??'sin dato'}`:'La API no respondió correctamente';
  const redis=d.redis||{};
  $('redisValue').textContent=redis.master||'SIN CONFIRMAR';
  $('redisDesc').textContent=redis.master?`Coinciden ${redis.reported_by} de 3 Sentinel`:'No hay acuerdo verificable de Sentinel';
  const catalog=d.catalog||{};
  $('latencyValue').textContent=catalog.ok?catalog.latency_ms:'—';
  $('latencyDesc').textContent=catalog.ok?'Solicitud de catálogo exitosa':'Fallo en sondeo HTTP';
  updateNodes(d);updateJourney(d);updateTrace(d);updateChart(d);updateEvents(d);updateRecovery(d);
  $('logical-redis')?.classList.toggle('logical-active',resolvedRoute(d).some(t=>t.id==='logical-redis'));
  $('logical-mongo')?.classList.toggle('logical-active',resolvedRoute(d).some(t=>t.id==='logical-mongo'));
}
async function update(){
  try{
    const r=await fetch('/api/state',{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    paint(d);previous=d;
    document.querySelector('.live').innerHTML='<i></i> EN VIVO';
  }catch(e){
    document.querySelector('.live').innerHTML='<i style="background:#ff647a"></i> SIN CONEXIÓN';
    $('updated').textContent='No se pudo consultar la telemetría';
  }
}
update();setInterval(update,4000);setInterval(()=>$('clock').textContent=new Date().toLocaleTimeString('es-MX'),1000);window.addEventListener('resize',drawLinks);

$('onlyRoute').addEventListener('click',()=>{
  focusRoute=!focusRoute;
  $('onlyRoute').setAttribute('aria-pressed',String(focusRoute));
  $('onlyRoute').textContent=focusRoute?'Mostrar todos':'Resaltar ruta';
  if(previous)updateNodes(previous);
});
$('motionToggle').addEventListener('click',()=>{
  motionPaused=!motionPaused;
  $('motionToggle').setAttribute('aria-pressed',String(motionPaused));
  $('motionToggle').textContent=motionPaused?'Reanudar animación':'Pausar animación';
  $('journeyHops').classList.toggle('motion-off',motionPaused);
});

// Botones solo de presentación: nunca envían comandos a Docker.
$('mapMotionToggle').addEventListener('click',()=>{
  mapMotionPaused=!mapMotionPaused;
  $('mapMotionToggle').setAttribute('aria-pressed',String(mapMotionPaused));
  $('mapMotionToggle').textContent=mapMotionPaused?'Reanudar conexiones':'Pausar conexiones';
  if(mapMotionPaused)$('links').pauseAnimations?.(); else $('links').unpauseAnimations?.();
});
const themeButton=$('themeToggle');
function setTheme(value){
  document.documentElement.dataset.theme=value;
  themeButton.textContent=value==='light'?'☀':'☾';
  themeButton.title=value==='light'?'Cambiar a modo oscuro':'Cambiar a modo claro';
  try{localStorage.setItem('observatorio995-theme',value)}catch(_e){}
}
let savedTheme='dark';try{savedTheme=localStorage.getItem('observatorio995-theme')||'dark'}catch(_e){}
setTheme(savedTheme==='light'?'light':'dark');
themeButton.addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='light'?'dark':'light'));
