import { describe,it,expect } from 'vitest'
import { Vector3 } from 'three'
import { Contacts,PracticeMode,segmentDistance,type ContactActor } from '../src/sim/humanoid/contacts'
import { ActorControl,restIntent } from '../src/sim/humanoid/controls'
import { forward } from '../src/sim/humanoid/ik'
import { HUMANOID,neutral } from '../src/sim/humanoid/profile'
const point=(x:number,y=1,z=0)=>new Vector3(x,y,z)
const actor=(id:string,x:number):ContactActor=>({id,chest:point(x,1.4),pelvis:point(x,.9),fists:[point(x+.3,1.2)],elbows:[point(x+.1,1.2)],shoulders:[point(x,1.4)],blocked:false})
describe('practice contacts',()=>{
  it('a jab reaches a nearby opponent through actual joint motion',()=>{
    const c=new Contacts(),control=new ActorControl(HUMANOID)
    const body=(id:string,x:number,yaw:number,q:Record<string,number>):ContactActor=>{
      const fk=forward(HUMANOID,q),at=(id:string)=>fk.get(id)!.p.clone().applyAxisAngle(new Vector3(0,1,0),yaw).add(new Vector3(x,0,0)),arms=HUMANOID.chains.filter(c=>c.group==='arms')
      return {id,blocked:false,chest:at('head.yaw').add(new Vector3(0,-.12,0)),pelvis:at('pelvis'),fists:arms.map(c=>at(c.end)),elbows:arms.map(c=>at(c.joints[3])),shoulders:arms.map(c=>at(c.joints[0]))}
    }
    const target=body('b',.32,Math.PI/2,neutral(HUMANOID));control.play('jab');let hits=0,closest=Infinity
    for(let i=0;i<90;i++){control.step(1/60,restIntent(),null);const a=body('a',-.32,-Math.PI/2,control.q);closest=Math.min(closest,segmentDistance(a.fists[0],a.fists[0],target.pelvis,target.chest));hits+=c.step([a,target],1/60,i/60).length}
    expect(hits,`Closest fist to torso: ${closest}`).toBe(1)
  })
  it('finds swept intersections and parallel/degenerate separation',()=>{
    expect(segmentDistance(point(-1),point(1),point(0,0),point(0,2))).toBeCloseTo(0)
    expect(segmentDistance(point(0),point(0),point(1),point(1))).toBe(1)
    expect(segmentDistance(point(-1),point(1),point(-1,2),point(1,2))).toBe(1)
  })
  it('scores a swept hit once per stroke and honours the scoring mode',()=>{
    const c=new Contacts(),a=actor('a',0),b=actor('b',.65);c.step([a,b],.1,0);a.fists[0].x=.72
    expect(c.step([a,b],.1,.2)).toHaveLength(1);expect(c.scores.a).toBe(1)
    a.fists[0].x=.6;expect(c.step([a,b],.1,.4)).toHaveLength(0)
    c.reset();c.mode=PracticeMode.Free;a.fists[0].x=.3;c.step([a,b],.1,0);a.fists[0].x=.72;expect(c.step([a,b],.1,.2)).toHaveLength(1);expect(c.scores.a).toBeUndefined()
  })
  it('records blocks without scoring',()=>{
    const c=new Contacts(),a=actor('a',0),b=actor('b',.65);b.blocked=true;b.elbows=[point(.52,1.1)];b.fists=[point(.52,1.4)]
    c.step([a,b],.1,0);a.fists[0].x=.65;expect(c.step([a,b],.1,.2)[0].blocked).toBe(true);expect(c.scores.a).toBeUndefined()
  })
  it('does not score locomotion with stationary arms',()=>{
    const c=new Contacts(),a=actor('a',0),b=actor('b',.65);c.step([a,b],.1,0)
    for(const p of [a.chest,a.pelvis,...a.fists,...a.elbows,...a.shoulders])p.x+=.3
    expect(c.step([a,b],.1,.2)).toHaveLength(0)
  })
})
