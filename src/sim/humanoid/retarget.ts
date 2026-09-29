/** BODY to named joints. No camera data survives reset or enters calibration storage. */
import { Euler, Quaternion, Vector3 } from 'three'
import type { BodyFrame } from '@obpal/host'
import { applyRanges, freshCalibration, type Calibration } from './calibration'
import { bodyFrame, forward, mirrorPoints, mirrorScores, solveLimb, v } from './ik'
import { bounded, clamp, mirrorAngles, neutral, type Angles, type RigProfile } from './profile'
export interface Retargeted { q: Angles; raw: Angles; valid: Set<string>; tracked: boolean; calibrating: boolean; generation: number; residual: number; limited: boolean }
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]
export class Retargeter {
  mirror=true
  data: Calibration
  private gen=-1
  private started=-1
  private sampled=-1
  private samples=new Map<string,number[]>()
  private poles=new Map<string,Vector3>()
  private held: Angles
  private seen: Record<string,number>={}
  constructor(readonly profile: RigProfile) { this.data=freshCalibration(profile); this.held=neutral(profile) }
  reset() { this.gen=-1; this.started=-1; this.sampled=-1; this.samples.clear(); this.poles.clear(); this.seen={}; this.held=neutral(this.profile) }
  setMirror(mirror: boolean) { if (mirror!==this.mirror) {this.mirror=mirror; this.reset()} }
  step(body: BodyFrame | null, now: number): Retargeted {
    const raw=neutral(this.profile), valid=new Set<string>()
    let residual=0,limited=false
    const result=(tracked=false, calibrating=false): Retargeted=>({q:{...this.held},raw,valid,tracked,calibrating,generation:this.gen,residual,limited})
    const lost=()=>{
      for (const j of this.profile.joints) if (now-(this.seen[j.id]??-Infinity)>=250) this.held[j.id]*=.85
      this.started=-1; return result()
    }
    if (!body?.tracked || now-body.receivedAt>=250) return lost()
    if (body.gen!==this.gen) {this.reset();this.gen=body.gen}
    const points=this.mirror?mirrorPoints(body.landmarks):body.landmarks
    const confidence=body.visibility.map((n,i)=>Math.min(n,body.presence[i]))
    const scores=this.mirror?mirrorScores(confidence):confidence
    const good=(ids:readonly number[])=>ids.every(i=>scores[i]>=.5 && points[i]?.every(Number.isFinite))
    const f=this.profile.frame
    if (f && !good([...f.hips,...f.shoulders])) return lost()
    const hip=f?v(points[f.hips[0]]).add(v(points[f.hips[1]])).multiplyScalar(.5):new Vector3()
    const shoulder=f?v(points[f.shoulders[0]]).add(v(points[f.shoulders[1]])).multiplyScalar(.5):new Vector3(0,1,0)
    const pelvis=f?bodyFrame(v(points[f.hips[1]]).sub(v(points[f.hips[0]])),new Vector3(0,1,0)):new Quaternion()
    const torso=f?bodyFrame(v(points[f.shoulders[1]]).sub(v(points[f.shoulders[0]])),shoulder.clone().sub(hip)):new Quaternion()
    if (!pelvis || !torso) return lost()
    const rel=pelvis.clone().invert().multiply(torso), e=new Euler().setFromQuaternion(rel,'YXZ')
    if(f)[e.y,e.x,e.z].forEach((n,i)=>{raw[f.spine[i]]=n;valid.add(f.spine[i])})
    const newSample=body.receivedAt!==this.sampled
    if (this.started<0) this.started=now
    for (const c of this.profile.chains) {
      if (!good(c.points)) continue
      const [a,b,d]=c.points.map(i=>v(points[i]))
      const upper=b.clone().sub(a), lower=d.clone().sub(b)
      const parent=c.group==='legs'?pelvis:torso, inv=parent.clone().invert()
      const lengths=[upper.length(),lower.length()]
      if (lengths.some(n=>n<.08||n>1)) continue
      const sourceChain=this.mirror?this.profile.chains.find(other=>other.group===c.group&&other.side===-c.side)??c:c
      for (let i=0;i<2;i++) {
        const key=`${sourceChain.id}.${i?'lower':'upper'}`
        if (newSample && now-this.started<=1200 && !this.data.lengths[key]) {const samples=this.samples.get(key)??[];samples.push(lengths[i]);this.samples.set(key,samples)}
        if (now-this.started>=1000 && !this.data.lengths[key]) {const samples=this.samples.get(key);if (samples && samples.length>=10)this.data.lengths[key]=median(samples)}
      }
      const user=[this.data.lengths[`${sourceChain.id}.upper`]??lengths[0],this.data.lengths[`${sourceChain.id}.lower`]??lengths[1]]
      // Segment-wise scale preserves articulation when the user and robot have different proportions.
      const target=upper.clone().multiplyScalar(c.lengths[0]/user[0]).add(lower.clone().multiplyScalar(c.lengths[1]/user[1])).applyQuaternion(inv)
      let pole=upper.clone().applyQuaternion(inv)
      const cross=upper.clone().cross(lower)
      if (cross.lengthSq()<1e-6) pole=this.poles.get(c.id)?.clone()??new Vector3(0,0,c.bend)
      else this.poles.set(c.id,pole.clone())
      const ik=solveLimb(target,pole,...c.lengths,c.bend)
      residual=Math.max(residual,ik.residual)
      ;[ik.roll*c.side,ik.pitch,ik.yaw,ik.flex].forEach((n,i)=>{raw[c.joints[i]]=n;valid.add(c.joints[i])})
      if (good(c.tips)) {
        const lowerQ=ik.rotation.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(c.bend,0,0),ik.flex))
        const direction=c.group==='legs'?v(points[c.tips[1]]).sub(v(points[c.tips[0]])):v(points[c.tips[0]]).add(v(points[c.tips[1]])).multiplyScalar(.5).sub(d)
        direction.applyQuaternion(inv).applyQuaternion(lowerQ.clone().invert()).normalize()
        if (c.group==='legs') {
          raw[c.distal[0]]=Math.atan2(direction.y,-direction.z);raw[c.distal[1]]=Math.atan2(direction.x,Math.hypot(direction.y,direction.z))
        } else {
          const span=v(points[c.tips[1]]).sub(v(points[c.tips[0]])).applyQuaternion(inv).applyQuaternion(lowerQ.clone().invert())
          raw[c.distal[0]]=Math.atan2(span.z,Math.abs(span.x))*c.side
          raw[c.distal[1]]=Math.atan2(-direction.z,-direction.y);raw[c.distal[2]]=Math.atan2(direction.x,Math.hypot(direction.y,direction.z))
        }
        c.distal.forEach(id=>valid.add(id))
      }
    }
    if (f && good([...f.ears,f.nose])) {
      const middle=v(points[f.ears[0]]).add(v(points[f.ears[1]])).multiplyScalar(.5)
      const look=v(points[f.nose]).sub(middle).applyQuaternion(torso.clone().invert())
      raw[f.head[0]]=Math.atan2(-look.x,-look.z);raw[f.head[1]]=Math.atan2(look.y,Math.hypot(look.x,look.z))
      f.head.forEach(id=>valid.add(id))
    }
    // Saved ranges always describe the anatomical user, independent of the preview/mirror preference.
    const observed=this.mirror?mirrorAngles(this.profile,raw):raw
    const mapped=applyRanges(this.profile,observed,this.data)
    const q=bounded(this.profile,this.mirror?mirrorAngles(this.profile,mapped):mapped)
    limited=residual>.01||this.profile.joints.some(j=>valid.has(j.id)&&!this.data.ranges[this.profile.mirror?.[j.id]?.joint??j.id]&&(raw[j.id]<j.limits[0]-.02||raw[j.id]>j.limits[1]+.02))
    for (const j of this.profile.joints) {
      if (valid.has(j.id)) {this.held[j.id]=q[j.id];this.seen[j.id]=body.receivedAt}
      else if (now-(this.seen[j.id]??-Infinity)>=250)this.held[j.id]*=.85
    }
    this.sampled=body.receivedAt
    return {...result(true,now-this.started<1000),raw:observed,valid:this.mirror?new Set([...valid].map(id=>this.profile.mirror?.[id]?.joint??id)):valid}
  }
}

/** Visual support only: contacts constrain named legs, never authorise real robot motion. */
export class FootBalance {
  private feet=new Map<string,{p:Vector3;anchor:Vector3;age:number;contact:boolean}>()
  reset() {this.feet.clear()}
  step(profile: RigProfile, source: Angles, dt: number, moving=false) {
    const q={...source}, fk=forward(profile,q), root=new Vector3(), landed:string[]=[]
    const legs=profile.chains.filter(c=>c.group==='legs')
    if (!legs.length) return {q,root,landed,contacts:[] as string[]}
    const lowest=Math.min(...legs.map(c=>fk.get(c.end)!.p.y-.08))
    root.y=clamp(-lowest,-Math.max(0,fk.get(profile.root)!.p.y-.12),.4)
    const support:Vector3[]=[]
    for (const c of legs) {
      const p=fk.get(c.end)!.p.clone().add(root);p.y-=.08
      let foot=this.feet.get(c.id)
      if (!foot) {foot={p:p.clone(),anchor:p.clone(),age:0,contact:false};this.feet.set(c.id,foot)}
      const speed=p.distanceTo(foot.p)/Math.max(.001,dt)
      if (moving||p.y>.04||speed>.2) {foot.contact=false;foot.age=0}
      if (!moving && p.y<.02 && speed<.1) {foot.age+=dt;if (!foot.contact&&foot.age>=.08){foot.contact=true;foot.anchor.copy(p);landed.push(c.id)}}
      if (foot.contact) support.push(foot.anchor)
      foot.p.copy(p)
    }
    if (support.length) {
      const margin=support.length===1?0:.02
      const minX=Math.min(...support.map(p=>p.x))-.08+margin,maxX=Math.max(...support.map(p=>p.x))+.08-margin
      const minZ=Math.min(...support.map(p=>p.z))-.14+margin,maxZ=Math.max(...support.map(p=>p.z))+.1-margin
      const com=fk.get(profile.frame?.spine[2]??profile.root)!.p
      root.x=clamp(com.x,minX,maxX)-com.x;root.z=clamp(com.z,minZ,maxZ)-com.z
      for (const c of legs) {
        const foot=this.feet.get(c.id)!
        if (!foot.contact) continue
        const hip=fk.get(c.joints[0])!.p.clone().add(root)
        const target=foot.anchor.clone().add(new Vector3(0,.08,0)).sub(hip)
        const pole=fk.get(c.joints[3])!.p.clone().add(root).sub(hip)
        const ik=solveLimb(target,pole,...c.lengths,c.bend)
        ;[ik.roll*c.side,ik.pitch,ik.yaw,ik.flex].forEach((n,i)=>q[c.joints[i]]=n)
      }
    }
    return {q:bounded(profile,q),root,landed,contacts:[...this.feet].filter(([,f])=>f.contact).map(([id])=>id)}
  }
}
