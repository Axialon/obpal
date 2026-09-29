import { describe,it,expect } from 'vitest'
import { Euler,Quaternion,Vector3 } from 'three'
import { bodyFrame,forward,mirrorPoints,solveLimb } from '../src/sim/humanoid/ik'
import { HUMANOID,neutral,type RigProfile } from '../src/sim/humanoid/profile'
import { Retargeter,FootBalance } from '../src/sim/humanoid/retarget'
import { humanoidBody } from './humanoid-fixture'
describe('humanoid kinematics',()=>{
  it('has 31 bounded named axes and a fixed pelvis',()=>expect(HUMANOID.joints.filter(j=>j.limits[0]!==j.limits[1])).toHaveLength(31))
  it.each([1,-1])('reconstructs reachable two-link chains with bend sign %s',bend=>{
    for(let i=1;i<=25;i++){
      const r=new Quaternion().setFromEuler(new Euler(.02*i,.01*i,.006*i,'ZXY')),flex=.1+i*.06
      const middle=new Vector3(0,-.29,0).applyQuaternion(r)
      const end=new Vector3(0,-.26,0).applyAxisAngle(new Vector3(bend,0,0),flex).applyQuaternion(r).add(middle)
      const solve=solveLimb(end,middle,.29,.26,bend)
      expect(solve.end.distanceTo(end)).toBeLessThan(.001);expect(solve.middle.distanceTo(middle)).toBeLessThan(.001)
      expect(solve.rotation.angleTo(r)).toBeLessThan(Math.PI/180);expect(solve.flex).toBeCloseTo(flex,5)
    }
  })
  it.each([[0,0,0],[0,-1,0],[0,0,-1],[100,-100,0]])('handles singular and unreachable targets %s %s %s',(x,y,z)=>{
    const result=solveLimb(new Vector3(x,y,z),new Vector3(),.3,.2)
    expect([...result.end.toArray(),...result.rotation.toArray(),result.flex].every(Number.isFinite)).toBe(true)
    expect(result.end.length()).toBeLessThan(.501)
  })
  it('mirrors twice without changing anatomical indices or coordinates',()=>{const p=humanoidBody().landmarks;expect(mirrorPoints(mirrorPoints(p))).toEqual(p)})
  it('builds a proper pelvis frame and rejects degenerate frames',()=>{
    const q=bodyFrame(new Vector3(1,0,0),new Vector3(0,1,0))!
    expect(q.angleTo(new Quaternion())).toBeCloseTo(0);expect(bodyFrame(new Vector3(),new Vector3(0,1,0))).toBeNull()
  })
  it('accepts a named non-body tree without a pelvis or head',()=>{
    const profile:RigProfile={id:'mechanism',root:'mount',height:1,chains:[],skins:[],joints:[{id:'mount',parent:null,offset:[0,0,0],axis:[0,1,0],limits:[-1,1]},{id:'tip',parent:'mount',offset:[0,0,-1],axis:[1,0,0],limits:[0,0]}]}
    expect(forward(profile,{mount:.5}).get('tip')!.p.length()).toBeCloseTo(1)
    expect(new Retargeter(profile).step(humanoidBody(),100).q.mount).toBe(0)
  })
  it('does not trust a tracked flag with missing torso confidence',()=>{
    const r=new Retargeter(HUMANOID),q=neutral(HUMANOID);q['left.arm.elbow']=1
    const first=r.step(humanoidBody(q),100),bad=humanoidBody(q,500);bad.presence[23]=0
    const lost=r.step(bad,500);expect(lost.tracked).toBe(false);expect(lost.q['right.arm.elbow']).toBeLessThan(first.q['right.arm.elbow'])
  })
  it('retargets scaled users to the same robot reach within one centimetre',()=>{
    const q=neutral(HUMANOID)
    for(const c of HUMANOID.chains){q[c.joints[0]]=.15;q[c.joints[1]]=.4;q[c.joints[2]]=.12;q[c.joints[3]]=.7}
    const expected=forward(HUMANOID,q)
    for(const scale of [.7,1,1.4]){
      const r=new Retargeter(HUMANOID);r.mirror=false
      const result=r.step(humanoidBody(q,100,scale),100),actual=forward(HUMANOID,result.q)
      for(const c of HUMANOID.chains)expect(actual.get(c.end)!.p.distanceTo(expected.get(c.end)!.p)).toBeLessThan(.01)
    }
  })
  it('holds occluded chains briefly, rests after loss and resets on a new generation',()=>{
    const r=new Retargeter(HUMANOID);r.mirror=false;const q=neutral(HUMANOID);q['left.arm.elbow']=1
    const first=r.step(humanoidBody(q),100);expect(first.tracked).toBe(true)
    const partial=humanoidBody(q,150);partial.visibility[15]=0
    expect(r.step(partial,150).q['left.arm.elbow']).toBeCloseTo(first.q['left.arm.elbow'])
    expect(r.step(null,500).q['left.arm.elbow']).toBeLessThan(first.q['left.arm.elbow'])
    const next=humanoidBody(q,550);next.gen=2;expect(r.step(next,550).generation).toBe(2)
  })
  it('does not extend freshness when the renderer rereads the same BODY sample',()=>{
    const r=new Retargeter(HUMANOID),q=neutral(HUMANOID);q['left.arm.elbow']=1
    const body=humanoidBody(q,100),first=r.step(body,100)
    expect(r.step(body,300).q['right.arm.elbow']).toBeCloseTo(first.q['right.arm.elbow'])
    expect(r.step(null,351).q['right.arm.elbow']).toBeLessThan(first.q['right.arm.elbow'])
  })
  it('never commands out-of-limit or non-finite joints',()=>{
    const r=new Retargeter(HUMANOID),body=humanoidBody()
    for(let n=0;n<40;n++){
      body.receivedAt=n;body.landmarks[15]=[n*.1,-n*.02,n*.03]
      const {q}=r.step(body,n)
      for(const j of HUMANOID.joints){expect(Number.isFinite(q[j.id])).toBe(true);expect(q[j.id]).toBeGreaterThanOrEqual(j.limits[0]);expect(q[j.id]).toBeLessThanOrEqual(j.limits[1])}
    }
  })
  it('locks feet after 80 ms and releases contacts during locomotion',()=>{
    const balance=new FootBalance(),q=neutral(HUMANOID)
    for(let i=0;i<6;i++)balance.step(HUMANOID,q,1/60)
    const stable=balance.step(HUMANOID,q,1/60);expect(stable.contacts).toHaveLength(2);expect(stable.root.y).toBeCloseTo(0,2)
    expect(balance.step(HUMANOID,q,1/60,true).contacts).toHaveLength(0)
  })
  it('grounds a deep crouch without lowering the pelvis through the floor',()=>{
    const balance=new FootBalance(),q=neutral(HUMANOID)
    for(const c of HUMANOID.chains.filter(c=>c.group==='legs')){q[c.joints[1]]=1.4;q[c.joints[3]]=2.2}
    const result=balance.step(HUMANOID,q,1/60),fk=forward(HUMANOID,result.q)
    expect(fk.get(HUMANOID.root)!.p.y+result.root.y).toBeGreaterThanOrEqual(.12)
    for(const c of HUMANOID.chains.filter(c=>c.group==='legs'))expect(fk.get(c.end)!.p.y+result.root.y-.08).toBeCloseTo(0,3)
  })
})
