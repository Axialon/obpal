import { Vector3 } from 'three'
import type { BodyFrame } from '@obpal/host'
import type { Vec3 } from '@obpal/core'
import { forward } from '../src/sim/humanoid/ik'
import { HUMANOID, neutral, type Angles } from '../src/sim/humanoid/profile'
export function humanoidBody(q:Angles=neutral(HUMANOID),at=100,scale=1):BodyFrame {
  const fk=forward(HUMANOID,q),points:Vec3[]=Array.from({length:33},()=>[0,0,0]),hip=fk.get('pelvis')!.p
  const point=(id:string,offset=new Vector3())=>offset.applyQuaternion(fk.get(id)!.q).add(fk.get(id)!.p).sub(hip).multiplyScalar(scale).toArray() as Vec3
  for(const c of HUMANOID.chains){
    points[c.points[0]]=point(c.joints[0]);points[c.points[1]]=point(c.joints[3]);points[c.points[2]]=point(c.end)
    if(c.group==='arms'){points[c.tips[0]]=point(c.end,new Vector3(-.025,-.1,0));points[c.tips[1]]=point(c.end,new Vector3(.025,-.1,0))}
    else{points[c.tips[0]]=point(c.end,new Vector3(0,-.05,.09));points[c.tips[1]]=point(c.end,new Vector3(0,-.05,-.18))}
  }
  points[0]=point('head.pitch',new Vector3(0,.08,-.12));points[7]=point('head.pitch',new Vector3(-.08,.08,0));points[8]=point('head.pitch',new Vector3(.08,.08,0))
  return {tracked:true,gen:1,t:at*1000,receivedAt:at,landmarks:points,visibility:Array(33).fill(1),presence:Array(33).fill(1)}
}
