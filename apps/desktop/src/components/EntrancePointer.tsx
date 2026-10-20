import {useEffect,useRef,type RefObject} from 'react';

/** Pointer visuals are independent of the cover mask: full painting movement never erases it. */
export function EntrancePointer({sceneRef,suspended}:{sceneRef:RefObject<HTMLDivElement>;suspended:boolean}){
 const canvasRef=useRef<HTMLCanvasElement>(null),brushRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const scene=sceneRef.current,canvas=canvasRef.current,brush=brushRef.current;if(!scene||!canvas||!brush||suspended)return;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  let width=scene.clientWidth,height=scene.clientHeight,ratio=1,raf=0,active=false,fade=0,x=0,y=0,currentTurn=0,targetTurn=0,lastFrame=0;
  let anchor:{x:number;y:number}|null=null;let points:{x:number;y:number;time:number}[]=[];
  const cards=()=>Array.from(scene.querySelectorAll<HTMLElement>('.wd-region-card'));
  const clearNear=()=>cards().forEach(card=>card.classList.remove('is-near'));
  const resize=()=>{width=scene.clientWidth;height=scene.clientHeight;ratio=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));ctx.setTransform(ratio,0,0,ratio,0,0);schedule()};
  function schedule(){if(!raf)raf=requestAnimationFrame(frame)}
  function frame(now:number){
   raf=0;const dt=Math.max(1,Math.min(50,lastFrame?now-lastFrame:16));lastFrame=now;
   const delta=(targetTurn-currentTurn)*(1-Math.exp(-dt/110)),limit=dt*Math.PI/375;
   currentTurn+=Math.max(-limit,Math.min(limit,delta));
   brush!.style.transform=`translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) rotate(${(34+currentTurn*180/Math.PI).toFixed(3)}deg)`;
   ctx!.clearRect(0,0,width,height);points=points.filter(p=>now-p.time<340);fade+=(Number(active)-fade)*.12;
   if(fade>.005){const glow=ctx!.createRadialGradient(x,y,0,x,y,60);glow.addColorStop(0,`rgba(255,245,212,${fade*.13})`);glow.addColorStop(.35,`rgba(250,229,182,${fade*.085})`);glow.addColorStop(1,'rgba(255,240,210,0)');ctx!.fillStyle=glow;ctx!.fillRect(x-60,y-60,120,120)}
   if(points.length>1){ctx!.lineCap='round';ctx!.shadowBlur=9;ctx!.shadowColor='#efd9a2';for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!,age=(now-b.time)/340;ctx!.lineWidth=(1-age)*10+1;ctx!.strokeStyle=`rgba(238,217,175,${(1-age)*.12})`;ctx!.beginPath();ctx!.moveTo(a.x,a.y);ctx!.lineTo(b.x,b.y);ctx!.stroke()}ctx!.shadowBlur=0}
   if(points.length||Math.abs(targetTurn-currentTurn)>.001||Math.abs(Number(active)-fade)>.005)schedule();
  }
  const move=(event:PointerEvent)=>{
   if(event.pointerType==='touch')return;const rect=scene.getBoundingClientRect();x=(event.clientX-rect.left)*width/rect.width;y=(event.clientY-rect.top)*height/rect.height;active=true;brush.dataset.wdVisible='1';
   if(anchor){const dx=x-anchor.x,dy=y-anchor.y,distance=Math.hypot(dx,dy);if(distance>=8){const heading=Math.atan2(dy,dx),delta=Math.atan2(Math.sin(heading-targetTurn),Math.cos(heading-targetTurn));if(Math.abs(delta)>.14)targetTurn+=delta;anchor={x,y}}}else anchor={x,y};
   points.push({x,y,time:performance.now()});
   for(const card of cards()){const label=card.querySelector('.wd-region-label');if(!label)continue;const b=label.getBoundingClientRect(),dx=Math.max(b.left-event.clientX,0,event.clientX-b.right),dy=Math.max(b.top-event.clientY,0,event.clientY-b.bottom);card.classList.toggle('is-near',Math.hypot(dx,dy)<32)}schedule();
  };
  const leave=()=>{active=false;anchor=null;targetTurn=currentTurn;delete brush.dataset.wdVisible;clearNear();schedule()};
  const visibility=()=>{if(document.hidden)leave()};
  const observer=new ResizeObserver(resize);observer.observe(scene);resize();scene.addEventListener('pointermove',move);scene.addEventListener('pointerleave',leave);scene.addEventListener('pointercancel',leave);document.addEventListener('visibilitychange',visibility);
  return ()=>{observer.disconnect();scene.removeEventListener('pointermove',move);scene.removeEventListener('pointerleave',leave);scene.removeEventListener('pointercancel',leave);document.removeEventListener('visibilitychange',visibility);if(raf)cancelAnimationFrame(raf);delete brush.dataset.wdVisible;clearNear();ctx.clearRect(0,0,width,height)};
 },[sceneRef,suspended]);
 return <><canvas className="wd-pointer-light" ref={canvasRef} aria-hidden="true"/><div className="wd-brush" ref={brushRef} aria-hidden="true"/></>;
}
