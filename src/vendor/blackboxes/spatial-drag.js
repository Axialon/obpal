/* Pointer movement adjusts a canonical input; the existing model owns its tradeoff. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.BlackboxesSpatialDrag=api;})(typeof window!=='undefined'?window:globalThis,function(root){
  const clamp=value=>Math.max(0,Math.min(1,value));
  function visualMapping(engine,key,limits){
    const models=root.BlackboxesModels||(typeof require==='function'?require('./model-core'):null),field=models?.definitions[engine]?.fields[key];
    if(!field)throw new TypeError('Unknown visual field');
    const min=limits?.min??field.min,max=limits?.max??field.max,span=max-min;
    if(!Number.isFinite(min)||!Number.isFinite(max)||!Number.isFinite(span)||span<=0)throw new RangeError('Visual domain must have finite ordered bounds');
    // A fixed canonical default anchors a smooth log curve at half the radius.
    // Imported bounds excluding that reference use their midpoint instead.
    const anchor=field.default>min&&field.default<max?field.default:min+span/2,mirror=anchor-min>span/2,q=Math.min(anchor-min,max-anchor)/span;
    const bend=q===.5?null:q*q/(1-2*q);
    return {min,max,span,anchor,mirror,bend,logSpan:bend===null?null:Math.log1p(1/bend),inverse:engine==='orbitem'&&field.pillar==='latency'};
  }
  function visualFraction(map,value){
    let fraction=clamp((value-map.min)/map.span);
    if(map.bend!==null){if(map.mirror)fraction=1-fraction;fraction=Math.log1p(fraction/map.bend)/map.logSpan;if(map.mirror)fraction=1-fraction;}
    return clamp(map.inverse?1-fraction:fraction);
  }
  function visualValue(map,fraction){
    let value=clamp(fraction);if(value===.5)return map.anchor;
    if(map.inverse)value=1-value;
    if(value===0)return map.min;if(value===1)return map.max;
    if(map.bend!==null){if(map.mirror)value=1-value;value=map.bend*Math.expm1(value*map.logSpan);if(map.mirror)value=1-value;}
    return Math.max(map.min,Math.min(map.max,map.min+clamp(value)*map.span));
  }
  function radialProfile(engine,surface='index'){
    if(['printem','wattem','reachem'].includes(engine))return {min:1.55,max:2.8,hullScale:1};
    return surface==='showcase'?{min:1,max:1.85,hullScale:1/(engine==='boxem'?1.2:1.16)}:{min:1.15,max:3.2,hullScale:1/(engine==='boxem'?1.2:1.28)};
  }
  function visualRadius(engine,key,value,limits,surface='index'){
    const profile=radialProfile(engine,surface);
    return profile.min+(profile.max-profile.min)*visualFraction(visualMapping(engine,key,limits),value);
  }
  function radialProjected(event,initial,start,end){
    const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy);
    const fallback=!Number.isFinite(length)||length<1||start.w<=0||end.w<=0;
    const wA=fallback?1:start.w||1,wB=fallback?1:end.w||1,fraction=clamp(initial);
    return {x:event.clientX,y:event.clientY,initial,screenInitial:fraction*wB/((1-fraction)*wA+fraction*wB),wA,wB,
      axisX:fallback?0:dx/length,axisY:fallback?-1:dy/length,travel:fallback?180:length,fallback};
  }
  function radialValue(session,event){
    const distance=(event.clientX-session.x)*session.axisX+(event.clientY-session.y)*session.axisY;
    if(distance===0)return session.initial;
    const t=clamp(session.screenInitial+distance/session.travel);
    return clamp(t*session.wA/(session.wB*(1-t)+t*session.wA));
  }
  function start(event,engine,state,pillar,group,direction,camera,options={}){
    const entry=Object.entries(root.BlackboxesModels.definitions[engine].fields).find(([,field])=>field.pillar===pillar);
    if(!entry||!direction)return null;
    const [key,field]=entry,spec={...field};
    if(engine==='boxem'&&state.bounds){const pair={time:['timeMin','timeMax'],cost:['costMin','costMax'],quality:['qualMin','qualMax'],scope:['scopeMin','scopeMax']}[pillar];if(pair){spec.min=state.bounds[pair[0]];spec.max=state.bounds[pair[1]];}}
    group.updateMatrixWorld(true);camera.updateMatrixWorld(true);
    const project=radius=>{const position=group.localToWorld(direction.clone().multiplyScalar(radius));const clip=new root.THREE.Vector4(position.x,position.y,position.z,1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);return {x:(clip.x/clip.w+1)*root.innerWidth/2,y:(1-clip.y/clip.w)*root.innerHeight/2,w:clip.w};};
    const mapping=visualMapping(engine,key,spec),profile=radialProfile(engine,options.surface),initial=visualFraction(mapping,state[key]);
    const session=radialProjected(event,initial,project(profile.min),project(profile.max));
    Object.assign(session,{key,spec,mapping,invert:mapping.inverse,pointerId:event.pointerId,initialValue:state[key]});
    event.target.setPointerCapture?.(event.pointerId);
    return session;
  }
  function value(session,event){
    const normalized=radialValue(session,event);
    if(normalized===session.initial)return session.initialValue;
    return Number(visualValue(session.mapping,normalized).toPrecision(12));
  }
  return {visualMapping,visualFraction,visualValue,radialProfile,visualRadius,radialProjected,radialValue,projected:radialProjected,norm:radialValue,start,value};
});
