/** One moving figure, using the same joint tree as the sim and the family glass controls. */
import { Vector3 } from 'three'
import { forward } from './ik'
import { freshCalibration, RangeWalkthrough, type Calibration } from './calibration'
import { neutral, type RigProfile } from './profile'
export class WalkthroughView {
  readonly dialog=document.createElement('dialog')
  private canvas=document.createElement('canvas')
  private title=document.createElement('h2')
  private cue=document.createElement('p')
  private status=document.createElement('p')
  private steps=document.createElement('div')
  private done=document.createElement('button')
  private tick=0
  walk:RangeWalkthrough
  constructor(public profile:RigProfile,data:Calibration,private save:(data:Calibration,reset?:boolean)=>void) {
    this.walk=new RangeWalkthrough(profile,data)
    const d=this.dialog;d.className='hw glass humanoid-calibration';d.setAttribute('aria-labelledby','range-title')
    this.title.id='range-title';this.cue.className='sim-lede';this.status.className='sim-badge';this.status.setAttribute('role','status')
    this.canvas.width=520;this.canvas.height=400;this.canvas.setAttribute('aria-label','Demonstration and measured range');this.steps.className='sim-actions range-steps'
    const actions=document.createElement('div');actions.className='sim-actions'
    const button=(name:string,run:()=>void)=>{const b=document.createElement('button');b.className='kit-action';b.type='button';b.textContent=name;b.onclick=run;return b}
    this.done=button('Done',()=>{if(this.walk.complete()){this.save(this.walk.data);this.refresh()}})
    const skip=button('Skip',()=>{this.walk.skip();this.refresh()})
    const redo=button('Redo',()=>{this.walk.redo();this.save(this.walk.data);this.refresh()})
    const reset=button('Reset calibration',()=>{this.walk.data=freshCalibration(this.profile);this.walk.done.clear();this.walk.skipped.clear();this.walk.start();this.save(this.walk.data,true);this.refresh()})
    const close=button('Close',()=>d.close())
    actions.append(redo,skip,this.done,close)
    d.append(this.title,this.cue,this.canvas,this.status,this.steps,actions,reset);document.body.append(d)
    d.addEventListener('close',()=>{this.walk.active=false;cancelAnimationFrame(this.tick)})
    this.refresh()
  }
  open(data:Calibration,profile=this.profile) {this.profile=profile;this.walk=new RangeWalkthrough(profile,data);this.walk.start();this.dialog.showModal();this.refresh();this.draw(performance.now())}
  private refresh() {
    const {walk}=this
    this.title.textContent=walk.active?`${walk.index+1} / ${walk.steps.length} · ${walk.step.name}`:'Your range is saved'
    this.cue.textContent=walk.active?walk.step.cue:'Choose a step to redo, or return to practice.'
    this.steps.replaceChildren(...walk.steps.map((s,i)=>{
      const b=document.createElement('button');b.type='button';b.className='kit-action';b.textContent=`${i+1}${walk.done.has(s.id)?' ✓':walk.skipped.has(s.id)?' –':''}`
      b.setAttribute('aria-label',`${s.name}${walk.done.has(s.id)?': done':walk.skipped.has(s.id)?': skipped':''}`);b.setAttribute('aria-current',String(walk.active&&i===walk.index))
      b.onclick=()=>{walk.redo(i);this.save(walk.data);this.refresh()};return b
    }))
  }
  private draw=(now:number)=>{
    if(!this.dialog.open)return
    const ctx=this.canvas.getContext('2d')!,style=getComputedStyle(this.dialog),accent=style.getPropertyValue('--bb-accent-text').trim()||'#c6ff34',ink=style.getPropertyValue('--bb-ink-2').trim()||'#9ba7ad'
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,t=reduced?.5:(Math.sin(now/900)+1)/2
    const q=neutral(this.profile),step=this.walk.step
    // Move the demonstrated chain together; all other parts and the scene remain still.
    const channels=[...new Set(step.joints.map(id=>id.split('.').at(-1)!))]
    const channel=channels[Math.floor(now/3000)%channels.length]
    for(const id of step.joints.filter(id=>id.endsWith(channel))) {const j=this.profile.joints.find(j=>j.id===id)!;q[id]=j.limits[0]+(j.limits[1]-j.limits[0])*t}
    const fk=forward(this.profile,q),project=(p:Vector3)=>[210+p.x*100+p.z*55,350-p.y*175]
    const shoulders=this.profile.chains.filter(c=>c.group==='arms').map(c=>c.joints[0])
    ctx.clearRect(0,0,520,400);ctx.lineCap='round'
    for(const j of this.profile.joints)if(j.parent&&j.offset.some(n=>n)&&!shoulders.includes(j.id)){
      const a=project(fk.get(j.parent)!.p),b=project(fk.get(j.id)!.p)
      ctx.strokeStyle=step.joints.includes(j.id)||step.joints.includes(j.parent)?accent:ink;ctx.lineWidth=8
      ctx.beginPath();ctx.moveTo(...a as [number,number]);ctx.lineTo(...b as [number,number]);ctx.stroke()
    }
    const line=(a:Vector3,b:Vector3,color:string,width=5)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...project(a) as [number,number]);ctx.lineTo(...project(b) as [number,number]);ctx.stroke()}
    if(shoulders.length===2)line(fk.get(shoulders[0])!.p,fk.get(shoulders[1])!.p,ink,8)
    for(const c of this.profile.chains){
      const end=fk.get(c.end)!,active=c.distal.some(id=>step.joints.includes(id)),colour=active?accent:ink
      const tip=(offset:Vector3)=>offset.applyQuaternion(end.q).add(end.p)
      if(c.group==='legs')line(end.p,tip(new Vector3(0,-.04,-.18)),colour,7)
      else{
        const a=tip(new Vector3(-.045,-.1,0)),b=tip(new Vector3(.045,-.1,0))
        line(end.p,a,colour);line(end.p,b,colour);line(a,b,colour)
      }
    }
    if(this.profile.frame){const transform=fk.get(this.profile.frame.head[1])!,centre=new Vector3(0,.08,0).applyQuaternion(transform.q).add(transform.p),head=project(centre);ctx.strokeStyle=ink;ctx.lineWidth=7;ctx.beginPath();ctx.arc(head[0],head[1],16,0,Math.PI*2);ctx.stroke();line(centre,new Vector3(0,.08,-.18).applyQuaternion(transform.q).add(transform.p),step.id==='head'?accent:ink)}
    ctx.lineWidth=8;ctx.strokeStyle=ink;ctx.globalAlpha=.18;ctx.beginPath();ctx.arc(414,206,49,-Math.PI*.75,Math.PI*.75);ctx.stroke();ctx.globalAlpha=1
    ctx.strokeStyle=accent;ctx.beginPath();ctx.arc(414,206,49,-Math.PI*.75,-Math.PI*.75+Math.PI*1.5*this.walk.progress);ctx.stroke()
    ctx.fillStyle=accent;ctx.font='600 22px Inter, sans-serif';ctx.textAlign='center';ctx.fillText(`${Math.round(this.walk.progress*100)}%`,414,214)
    this.done.disabled=!this.walk.active||this.walk.progress<5/45
    this.status.textContent=this.walk.active?(this.walk.progress?'Range captured · stop where comfortable':'Move comfortably in view of the camera'):'Only ranges and segment lengths are saved on this device.'
    this.tick=requestAnimationFrame(this.draw)
  }
}
