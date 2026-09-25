/* Blackboxes model contract v2. Pure shared browser / Node implementation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlackboxesModels = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const version = '2.0.0';
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === null || Object.prototype.toString.call(o)==='[object Object]' && (!Object.getPrototypeOf(o) || Object.getPrototypeOf(Object.getPrototypeOf(o))===null));
  const clone = o => JSON.parse(JSON.stringify(o));
  const field = (pillar,min,max,value,unit) => ({pillar,min,max,default:value,unit});
  const definitions = {
    boxem:{app:"Box'em",category:'occupation',defaultLock:'time',fields:{timeWeeks:field('time',0.5,520,4,'weeks'),costBudget:field('cost',0,1e9,8500,'USD'),qualityPercent:field('quality',10,200,88,'%'),scopePercent:field('scope',10,250,100,'%'),baseRate:field('rate',10,2000,110,'USD/hour'),minFullScopeFloor:field('floor',0,1e9,7500,'USD')}},
    orbitem:{app:"Orbit'em",category:'archetype',defaultLock:'budget',fields:{monthlyBudget:field('budget',50,500000,450,'USD/month'),availabilitySla:field('sla',90,99.999,99.9,'%'),p99LatencyMs:field('latency',1,2000,45,'ms'),computeCapacity:field('compute',10,500,100,'capacity index'),opsComplexity:field('complexity',10,250,35,'index'),securityCompliance:field('security',50,100,75,'scenario index')}},
    pulseem:{app:"Pulse'em",category:'protocol',defaultLock:'recovery',fields:{trainingStrainTrimp:field('strain',50,1500,380,'TRIMP'),autonomicRecoveryHrv:field('recovery',10,200,85,'ms'),metabolicFuelingPercent:field('fuel',20,200,100,'%'),autophagyScore:field('autophagy',20,160,100,'illustrative index'),longevityScore:field('longevity',10,150,125,'illustrative index')}},
    capem:{app:"Cap'em",category:'sector',defaultLock:'founder',fields:{capitalRaisedUsd:field('capital',10000,1e8,750000,'USD'),postMoneyValuationUsd:field('valuation',500000,5e8,7500000,'USD'),runwayMonths:field('runway',0.1,120,18,'months'),esopPoolPercent:field('esop',0,100,10,'%'),founderEquityPercent:field('founder',0,100,80,'%'),monthlyBurnUsd:field('burn',1,1e8,750000/18,'USD/month')}},
    synthem:{app:"Synth'em",category:'genre',defaultLock:'crest',fields:{harmonicDrivePercent:field('drive',0,100,75,'%'),dynamicCrestDb:field('crest',1,30,14,'dB'),pitchRatio:field('pitch',0.25,4,0.85,'ratio'),reverbDecaySec:field('reverb',0.1,12,0.8,'seconds'),vcfCutoffHz:field('cutoff',100,12000,1800,'Hz'),stereoWidthPercent:field('width',0,100,65,'%')}},
    balancem:{app:"Balanc'em",category:'archetype',defaultLock:'ehp',fields:{damagePerSecondDps:field('dps',10,5000,780,'damage/second'),effectiveHealthPoolEhp:field('ehp',100,50000,18500,'EHP'),resourceCostCooldown:field('resource',5,250,85,'cost index'),skillCeilingApm:field('skill',20,400,90,'actions/minute'),mobilitySpeed:field('mobility',10,120,50,'units/second'),critMultiplier:field('crit',1,4,1.5,'ratio')}}
  };
  Object.assign(definitions, {
    printem:{app:"Print'em",category:'scenario',defaultLock:'cost',fields:{materialGrams:field('material',0,1e6,200,'g'),materialPricePerKg:field('price',0,1e5,25,'currency/kg'),printHours:field('hours',0,1e5,5,'hours'),machineRatePerHour:field('machine',0,1e5,2,'currency/hour'),failureRatePercent:field('failure',0,99.9,25,'%'),unitCost:field('cost',0,1e12,20,'currency/successful unit')}},
    wattem:{app:"Watt'em",category:'scenario',defaultLock:'cost',fields:{powerWatts:field('power',0,1e6,1000,'W'),hoursPerDay:field('hours',0,24,4,'hours/day'),days:field('days',0,36500,30,'days'),overheadPercent:field('overhead',0,1000,25,'%'),tariffPerKwh:field('tariff',0,100,0.2,'currency/kWh'),totalCost:field('cost',0,1e12,30,'currency')}},
    reachem:{app:"Reach'em",category:'scenario',defaultLock:'signups',fields:{audience:field('audience',0,1e9,10000,'people'),clickThroughPercent:field('clicks',0,100,10,'%'),conversionPercent:field('conversion',0,100,20,'%'),shareRatePercent:field('shares',0,100,50,'%'),visitsPerShare:field('visits',0,10000,5,'visits/share'),expectedSignups:field('signups',0,1e18,375,'expected signups')}}
  });
  const equationOutputs={printem:'unitCost',wattem:'totalCost',reachem:'expectedSignups'};
  const hasEquation=engine=>own(equationOutputs,engine);
  function equationValue(engine,c){
    if(engine==='printem')return (c.materialGrams*c.materialPricePerKg/1000+c.printHours*c.machineRatePerHour)/(1-c.failureRatePercent/100);
    if(engine==='wattem')return c.powerWatts*c.hoursPerDay*c.days*(1+c.overheadPercent/100)/1000*c.tariffPerKwh;
    const direct=c.audience*c.clickThroughPercent/100*c.conversionPercent/100,k=c.shareRatePercent/100*c.visitsPerShare*c.conversionPercent/100;
    return direct*(1+k+k*k+k*k*k);
  }
  function equationMatches(engine,c){const actual=c[equationOutputs[engine]],expected=equationValue(engine,c);return Number.isFinite(expected)&&Math.abs(actual-expected)<=1e-9*Math.max(Number.MIN_VALUE,Math.abs(actual),Math.abs(expected));}
  function solveEquation(engine,c,key,errors){
    const output=equationOutputs[engine];
    if(key===output){c[key]=equationValue(engine,c);return;}
    // Each equation is continuous and nondecreasing on its documented domains.
    // Equal endpoint outputs expose a singular (underdetermined) inverse.
    const f=definitions[engine].fields[key],wanted=c[output];
    const evaluate=value=>equationValue(engine,{...c,[key]:value});
    let lo=f.min,hi=f.max;const low=evaluate(lo),high=evaluate(hi);
    if(low===high){errors.push('solveFor: singular or ambiguous inverse; change another field');return;}
    if(wanted<low||wanted>high){errors.push('solveFor: infeasible target within the selected field domain');return;}
    if(wanted===low){c[key]=lo;return;}if(wanted===high){c[key]=hi;return;}
    // Enough iterations for subnormal finite inputs; normally ends in ~55 steps.
    for(let i=0;i<1100;i++){const mid=lo+(hi-lo)/2;if(mid===lo||mid===hi)break;const value=evaluate(mid);if(value===wanted){lo=hi=mid;break;}if(value<wanted)lo=mid;else hi=mid;}
    c[key]=Math.abs(evaluate(lo)-wanted)<=Math.abs(evaluate(hi)-wanted)?lo:hi;
    if(!equationMatches(engine,c))errors.push('solveFor: inverse cannot satisfy equation at numerical precision');
  }
  for(const [engine,d] of Object.entries(definitions)) d.locks=Object.values(d.fields).map(f=>f.pillar).filter(p=>hasEquation(engine)||!['rate','floor','burn'].includes(p));
  const shaders='classic quartz emerald liquid polar magma rose nebula citrine aquamarine amethyst titanium sapphire kintsugi abyssal solar opaline damascus neonvapor carbon voidsingularity cyberpunk quantum volcanic frosted voidraid'.split(' ');
  const scales=['fontScale','spatialFontScale','nodeModelsScale','insideObjectsScale','detailCardScale'];
  const boundMap={timeWeeks:['timeMin','timeMax'],costBudget:['costMin','costMax'],qualityPercent:['qualMin','qualMax'],scopePercent:['scopeMin','scopeMax']};
  const defaultBounds={timeMin:0.5,timeMax:52,costMin:500,costMax:1000000,qualMin:10,qualMax:200,scopeMin:10,scopeMax:250};
  const aliases={boxem:{qual:'quality'},synthem:{harmonics:'drive',dynamics:'crest'},capem:{equity:'founder'}};
  // These are directed scenario curves, not reversible simultaneous equations.
  const relationships={
    orbitem:{budget:['compute','sla','latency','security','complexity'],compute:['budget','complexity','latency','security','sla'],sla:['budget','compute','complexity','security','latency'],latency:['budget','compute','complexity','sla'],complexity:['security','budget','compute'],security:['budget','complexity']},
    pulseem:{strain:['fuel','recovery','autophagy','longevity'],recovery:['longevity','strain','fuel','autophagy'],fuel:['autophagy','strain','recovery','longevity'],autophagy:['fuel','longevity','strain','recovery'],longevity:['recovery','autophagy','strain','fuel']},
    synthem:{drive:['crest','width','cutoff','reverb'],crest:['drive','cutoff','reverb'],cutoff:['crest','width','reverb'],width:['reverb','cutoff'],reverb:['width','crest'],pitch:['cutoff']},
    balancem:{dps:['ehp','skill','crit','resource','mobility'],ehp:['dps','mobility','skill','crit','resource'],mobility:['ehp','dps','skill','crit'],skill:['dps','crit','mobility','ehp'],crit:['dps','skill','ehp'],resource:['dps']}
  };
  const curveDomains={
    orbitem:{budget:[50,50000],compute:[10,500],sla:[90,99.999],latency:[2,250],complexity:[10,200],security:[50,100]},
    pulseem:{strain:[50,1200],recovery:[20,150],fuel:[20,180],autophagy:[20,160],longevity:[30,150]},
    synthem:{drive:[0,100],crest:[2,24],cutoff:[100,12000],width:[0,100],reverb:[0.1,10],pitch:[0.25,4]},
    balancem:{dps:[50,5000],ehp:[200,50000],mobility:[10,100],skill:[20,400],crit:[1,4],resource:[10,250]}
  };
  function solveTargets(engine,changed){
    const d=definition(engine),driver=pillar(engine,changed);
    if(hasEquation(engine))return d.locks.filter(p=>p!==driver);
    if(relationships[engine])return [...(relationships[engine][driver]||[])];
    if(engine==='capem')return [...({capital:['founder','valuation','esop'],valuation:['founder','capital','esop'],runway:['capital','burn'],esop:['founder','capital','valuation'],founder:['capital','valuation','esop'],burn:['runway']}[driver]||[])];
    return (engine==='boxem'?['time','cost','quality','scope']:['capital','valuation','runway','esop','founder','burn']).filter(p=>p!==driver);
  }
  const moduleFields={boxem:{reqQuality:'number'},orbitem:{category:'string',costShare:'number'},pulseem:{target:'string'},capem:{ownership:'number',type:'string'},synthem:{dspParam:'string',mixLevel:'number'},balancem:{type:'string',powerScore:'number'},printem:{},wattem:{},reachem:{}};
  function definition(engine){if(!own(definitions,engine)) throw new TypeError('Unknown engine'); return definitions[engine];}
  function defaults(engine){const d=definition(engine),c={}; for(const [k,f] of Object.entries(d.fields)) c[k]=f.default; c.lockMode=d.defaultLock; if(engine==='boxem'){c.enableFloorGuarantee=true;c.bounds=clone(defaultBounds);} return c;}
  function pillar(engine,name){const d=definition(engine);return own(d.fields,name)?d.fields[name].pillar:aliases[engine]&&own(aliases[engine],name)?aliases[engine][name]:name;}
  function inspect(value,path,errors,depth=0,seen=new Set()) {
    if(depth>20){errors.push(path+': maximum nesting exceeded');return;}
    if(typeof value==='number'&&!Number.isFinite(value)){errors.push(path+': must be finite');return;}
    if(value===null || ['string','boolean','number'].includes(typeof value))return;
    if(typeof value!=='object'){errors.push(path+': must be JSON data');return;}
    if(seen.has(value)){errors.push(path+': circular data');return;}
    if(!Array.isArray(value)&&!plain(value)){errors.push(path+': must be a plain object');return;}
    seen.add(value);
    for(const k of Object.keys(value)) {if(['__proto__','prototype','constructor'].includes(k))errors.push(path+'.'+k+': forbidden key');else inspect(value[k],path+'.'+k,errors,depth+1,seen);}
    seen.delete(value);
  }
  function isSafeAssetUrl(url){
    if(typeof url!=='string'||!url||/[\\\u0000-\u0020?#%]/.test(url)) return false;
    if(url==='procedural')return true;
    const local=url.replace(/^\.\//,'');
    if(/^models\/[a-zA-Z0-9_./-]+\.glb$/.test(local)&&!local.split('/').includes('..'))return true;
    return false;
  }
  function checkConstraints(engine,c,errors){
    const d=definition(engine);
    if(!plain(c)){errors.push('constraints: must be a plain object');return;}
    const allowed=[...Object.keys(d.fields),'lockMode','locked',...(engine==='boxem'?['bounds','enableFloorGuarantee']:[])];
    for(const k of Object.keys(c))if(!allowed.includes(k))errors.push('constraints.'+k+': unsupported field');
    for(const [k,f] of Object.entries(d.fields))if(typeof c[k]!=='number'||!Number.isFinite(c[k])||c[k]<f.min||c[k]>f.max)errors.push(`constraints.${k}: must be a finite number between ${f.min} and ${f.max}`);
    if(!d.locks.includes(c.lockMode)) errors.push('constraints.lockMode: unsupported solve target');
    if(c.locked!==undefined && (!Array.isArray(c.locked)||c.locked.some(p=>!Object.values(d.fields).some(f=>f.pillar===p))))errors.push('constraints.locked: must contain supported pillars');
    if(Array.isArray(c.locked)&&new Set(c.locked).size!==c.locked.length)errors.push('constraints.locked: duplicate pillars are not allowed');
    if(engine==='boxem'){
      if(typeof c.enableFloorGuarantee!=='boolean')errors.push('constraints.enableFloorGuarantee: must be boolean');
      if(!plain(c.bounds)){errors.push('constraints.bounds: must be a plain object');return;}
      for(const k of Object.keys(c.bounds))if(!Object.values(boundMap).flat().includes(k))errors.push('constraints.bounds.'+k+': unsupported bound');
      for(const [k,[lo,hi]] of Object.entries(boundMap)){
        const f=d.fields[k],a=c.bounds[lo],b=c.bounds[hi];
        if(!Number.isFinite(a)||!Number.isFinite(b)||a<f.min||b>f.max||a>=b)errors.push(`constraints.bounds.${lo}/${hi}: invalid ordered bounds`);
        else if(c[k]<a||c[k]>b)errors.push(`constraints.${k}: outside configured bounds`);
      }
    }
  }
  function ownershipGroup(m){return m.group || (/option|esop/i.test(m.type)?'esop':/common/i.test(m.type)?'founders':'investors');}
  function ledger(c,existing){
    const base=[{id:'founders',name:'Founders',ownership:c.founderEquityPercent,type:'Common'},{id:'investors',name:'New investors',ownership:100*c.capitalRaisedUsd/c.postMoneyValuationUsd,type:'Preferred'},{id:'esop',name:'Employee option pool',ownership:c.esopPoolPercent,type:'Options'}];
    if(!Array.isArray(existing)||!existing.length||existing.some(m=>!plain(m)||typeof m.type!=='string'||!Number.isFinite(m.ownership)))return base;
    const rows=clone(existing);
    for(const group of base){const members=rows.filter(m=>ownershipGroup(m)===group.id);const total=members.reduce((n,m)=>n+m.ownership,0);if(!members.length){if(group.ownership>0)rows.push(group);continue;}if(Math.abs(total-group.ownership)<1e-9)continue;members.forEach(m=>{m.ownership=total>0?group.ownership*m.ownership/total:group.ownership/members.length;});}
    return rows;
  }
  function defaultModules(engine,c){if(engine==='capem')return ledger(c);const m={id:'module_1',name:'Scenario component'};for(const [k,t] of Object.entries(moduleFields[engine]))m[k]=t==='number'?0:'Scenario';return [m];}
  function validate(engine,payload){
    const errors=[]; if(!own(definitions,engine))return {valid:false,errors:['engine: unknown engine']};
    inspect(payload,'payload',errors);if(errors.length)return {valid:false,errors};
    if(!plain(payload))return {valid:false,errors:['payload: must be a plain object']};
    if(engine==='orbitem'&&payload.version===undefined&&plain(payload.parameters)&&plain(payload.meta)&&typeof payload.architecture==='string'){
      payload={...clone(payload),version:'1.0.0',meta:{...payload.meta,brand:'Blackboxes',app:"Orbit'em",title:payload.architecture},visuals:payload.visuals||{shaderPreset:payload.parameters.shader||'liquid',theme:'dark'}};
      delete payload.architecture;
    }
    const d=definitions[engine],legacy=typeof payload.version==='string'&&/^1\.\d+\.\d+$/.test(payload.version);
    if(hasEquation(engine)&&payload.version!==version)return {valid:false,errors:['version: this engine supports 2.0.0 only']};
    if(hasEquation(engine)&&payload.engine===undefined)errors.push('engine: required');
    if(hasEquation(engine)&&plain(payload.meta)&&payload.meta.scenario!==undefined&&typeof payload.meta.scenario!=='string')errors.push('meta.scenario: must be a string');
    if(payload.version!==version&&!legacy)errors.push('version: supported versions are 1.x.x and 2.0.0');
    if(payload.engine!==undefined&&payload.engine!==engine)errors.push('engine: does not match requested engine');
    if(!plain(payload.meta))errors.push('meta: must be a plain object');
    else {for(const k of ['title','occupation','archetype','protocol','sector','genre','preset','author','pitchScript'])if(payload.meta[k]!==undefined&&typeof payload.meta[k]!=='string')errors.push('meta.'+k+': must be a string');if(payload.meta.brand!=='Blackboxes')errors.push('meta.brand: must be Blackboxes');if(payload.meta.app!==d.app)errors.push('meta.app: does not match engine');if(typeof payload.meta.title!=='string'||!payload.meta.title.trim()||payload.meta.title.length>200)errors.push('meta.title: required string, maximum 200 characters');}
    const raw=legacy&&payload.parameters!==undefined?payload.parameters:payload.constraints;
    if(!plain(raw))errors.push('constraints: must be a plain object');
    let c=plain(raw)?clone(raw):{};
    if(legacy&&plain(raw)){
      const required={boxem:['timeWeeks','costBudget','qualityPercent','scopePercent','baseRate'],orbitem:['monthlyBudget','availabilitySla','p99LatencyMs','opsComplexity'],pulseem:['trainingStrainTrimp','autonomicRecoveryHrv','metabolicFuelingPercent','longevityScore'],capem:['capitalRaisedUsd','postMoneyValuationUsd','runwayMonths','founderEquityPercent'],synthem:['harmonicDrivePercent','dynamicCrestDb','pitchRatio','reverbDecaySec'],balancem:['damagePerSecondDps','effectiveHealthPoolEhp','resourceCostCooldown','skillCeilingApm']};
      for(const key of [...required[engine],'lockMode'])if(!own(raw,key))errors.push('constraints.'+key+': required legacy field');
    }
    if(legacy){if(engine==='synthem'&&own(c,'filterCutoffHz')){c.vcfCutoffHz=c.filterCutoffHz;delete c.filterCutoffHz;}if(engine==='balancem'&&own(c,'criticalMultiplier')){c.critMultiplier=c.criticalMultiplier;delete c.criticalMultiplier;}c={...defaults(engine),...c};c.lockMode=pillar(engine,c.lockMode);if(engine==='capem'){if(!own(raw||{},'monthlyBurnUsd')&&c.runwayMonths>0)c.monthlyBurnUsd=c.capitalRaisedUsd/c.runwayMonths;c.founderEquityPercent=100-c.esopPoolPercent-100*c.capitalRaisedUsd/c.postMoneyValuationUsd;}}
    if(legacy)for(const k of ['shader','audioPulseActive','scopeTier','investorSharePercent','filterCutoffHz','criticalMultiplier'])delete c[k];
    checkConstraints(engine,c,errors);
    if(!Array.isArray(payload.submodules)||!payload.submodules.length||payload.submodules.length>500)errors.push('submodules: requires 1 to 500 items');
    else payload.submodules.forEach((m,i)=>{const p=`submodules[${i}]`;if(!plain(m)){errors.push(p+': must be a plain object');return;}if(typeof m.name!=='string'||!m.name.trim()||m.name.length>200)errors.push(p+'.name: required string, maximum 200 characters');if(m.id!==undefined&&(typeof m.id!=='string'||m.id.length>100))errors.push(p+'.id: must be a string');for(const [k,t]of Object.entries(moduleFields[engine])){if(typeof m[k]!==t||(t==='number'&&(!Number.isFinite(m[k])||m[k]<0)))errors.push(p+'.'+k+': must be '+t+(t==='number'?' >= 0':''));}if(engine==='boxem'&&m.reqQuality>200)errors.push(p+'.reqQuality: maximum 200');if(engine==='capem'&&m.ownership>100)errors.push(p+'.ownership: maximum 100');if(engine==='capem'&&m.group!==undefined&&!['founders','investors','esop'].includes(m.group))errors.push(p+'.group: must be founders, investors or esop');});
    const v=payload.visuals;
    if(!plain(v))errors.push('visuals: must be a plain object');
    else {if(v.sceneTheme!==undefined&&!['void','obsidian','cyberpunk','minimal','crimson','emerald'].includes(v.sceneTheme))errors.push('visuals.sceneTheme: unsupported scene theme');for(const k of ['nodeGeometry','subnodeGeometry'])if(v[k]!==undefined&&(typeof v[k]!=='string'||!['default','custom','sphere','cube','box','octahedron','tetrahedron','dodecahedron','icosahedron','torus','diamond','crystal'].includes(v[k])))errors.push('visuals.'+k+': unsupported geometry');if(!shaders.includes(v.shaderPreset))errors.push('visuals.shaderPreset: unsupported shader');if(!['dark','light'].includes(v.theme))errors.push('visuals.theme: must be dark or light');for(const k of scales)if(v[k]!==undefined&&(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<0.4||v[k]>3))errors.push('visuals.'+k+': must be between 0.4 and 3');if(v.useSpatial3DLabels!==undefined&&typeof v.useSpatial3DLabels!=='boolean')errors.push('visuals.useSpatial3DLabels: must be boolean');if(v.customNodeModels!==undefined){if(!plain(v.customNodeModels))errors.push('visuals.customNodeModels: must be object');else for(const [k,url]of Object.entries(v.customNodeModels))if(!d.locks.includes(k)||!isSafeAssetUrl(url))errors.push('visuals.customNodeModels.'+k+': URL violates security allowlist');}}
    if(engine==='capem'&&errors.length===0){const sum=c.founderEquityPercent+c.esopPoolPercent+100*c.capitalRaisedUsd/c.postMoneyValuationUsd;if(Math.abs(sum-100)>1e-6)errors.push('constraints: founder + investor + ESOP ownership must total 100%');if(Math.abs(c.runwayMonths-c.capitalRaisedUsd/c.monthlyBurnUsd)>1e-6)errors.push('constraints.runwayMonths: must equal capital / monthlyBurnUsd');if(!legacy){for(const row of ledger(c)){const sum=payload.submodules.filter(m=>ownershipGroup(m)===row.id).reduce((n,m)=>n+m.ownership,0);if(Math.abs(sum-row.ownership)>1e-6)errors.push('submodules: '+row.id+' ownership does not match constraints');}}}
    if(hasEquation(engine)&&errors.length===0&&!equationMatches(engine,c))errors.push('constraints: output does not satisfy model equation');
    if(errors.length)return {valid:false,errors};
    const sanitizedData={...clone(payload),$schema:`https://${engine}.blackboxes.net/schemas/v2.schema.json`,version,engine,meta:{[d.category]:'custom',...clone(payload.meta)},constraints:c,submodules:engine==='capem'&&legacy?ledger(c,payload.submodules):clone(payload.submodules),visuals:clone(v)};
    delete sanitizedData.parameters;
    return {valid:true,errors:[],sanitizedData};
  }
  function serialize(engine,state={},context={}){
    const d=definition(engine),errors=[];inspect(state,'state',errors);inspect(context,'context',errors);if(!plain(state)||!plain(context))errors.push('state/context: must be objects');if(errors.length){const e=new TypeError(errors.join('; '));e.errors=errors;throw e;}
    const source=plain(state.constraints)?state.constraints:state,c=defaults(engine);
    for(const k of [...Object.keys(d.fields),'lockMode','locked','bounds','enableFloorGuarantee'])if(own(source,k))c[k]=clone(source[k]);
    if(engine==='synthem'&&own(source,'filterCutoffHz')&&!own(source,'vcfCutoffHz'))c.vcfCutoffHz=source.filterCutoffHz;
    if(engine==='balancem'&&own(source,'criticalMultiplier')&&!own(source,'critMultiplier'))c.critMultiplier=source.criticalMultiplier;
    c.lockMode=pillar(engine,c.lockMode);
    if(engine==='capem'&&!own(source,'monthlyBurnUsd'))c.monthlyBurnUsd=c.capitalRaisedUsd/c.runwayMonths;
    const meta={brand:'Blackboxes',app:d.app,title:state.occupationTitle||d.app+' scenario',[d.category]:state[d.category]||'custom',...(state.meta||{}),...(context.meta||{})};
    if(state.pitchScript!==undefined&&state.pitchScript!==null&&meta.pitchScript===undefined)meta.pitchScript=state.pitchScript;
    const visuals={shaderPreset:state.activeShaderPreset||state.shader||'classic',theme:state.isDarkMode===false?'light':'dark',...(state.visuals||{})};
    for(const k of [...scales,'useSpatial3DLabels','nodeGeometry','subnodeGeometry','sceneTheme'])if(state[k]!==undefined)visuals[k]=state[k];
    if(state.nodeModels!==undefined)visuals.customNodeModels=state.nodeModels;
    Object.assign(visuals,context.visuals||{});
    let submodules=context.submodules||state.submodules||state.customSubmodules||defaultModules(engine,c);
    if(engine==='capem')submodules=ledger(c,submodules);
    const payload={$schema:`https://${engine}.blackboxes.net/schemas/v2.schema.json`,version,engine,meta,constraints:c,submodules,visuals};
    const result=validate(engine,payload);if(!result.valid){const e=new TypeError(result.errors.join('; '));e.errors=result.errors;throw e;}return result.sanitizedData;
  }
  function toState(engine,payload){const result=validate(engine,payload);if(!result.valid){const e=new TypeError(result.errors.join('; '));e.errors=result.errors;throw e;}const p=result.sanitizedData,v=p.visuals;const state={...clone(p.constraints),...clone(v),[definition(engine).category]:p.meta[definition(engine).category],shader:v.shaderPreset,activeShaderPreset:v.shaderPreset,isDarkMode:v.theme==='dark',customSubmodules:clone(p.submodules),submodules:clone(p.submodules)};if(v.customNodeModels)state.nodeModels=clone(v.customNodeModels);if(engine==='boxem')state.occupationTitle=p.meta.title;if(p.meta.pitchScript!==undefined)state.pitchScript=p.meta.pitchScript;return state;}

  const legacyCandidates = {
orbitem:     function(state, changedPillar) {
      const locked = ''; 
      
      if (changedPillar === 'budget') {
        // Budget drives available capacity across all dimensions
        const bNorm = Math.max(0.01, (state.monthlyBudget - 50) / (50000 - 50));
        if (locked !== 'compute') state.computeCapacity = Math.round(10 + Math.pow(bNorm, 0.65) * 490);
        if (locked !== 'sla') {
          const nines = 1.0 + Math.pow(bNorm, 0.5) * 4.0; // 1.0 to 5.0 nines (90% to 99.999%)
          state.availabilitySla = Number((100.0 - Math.pow(10, -nines) * 100.0).toFixed(3));
        }
        if (locked !== 'latency') state.p99LatencyMs = Math.round(250 - Math.pow(bNorm, 0.55) * 245);
        if (locked !== 'security') state.securityCompliance = Math.round(50 + Math.pow(bNorm, 0.7) * 50);
        if (locked !== 'complexity') state.opsComplexity = Math.round(10 + Math.pow(bNorm, 0.6) * 190);
      } else if (changedPillar === 'compute') {
        const cNorm = (state.computeCapacity - 10) / 490.0;
        if (locked === 'budget') {
          // Fixed budget: high compute forces latency up, SLA down, complexity down
          state.p99LatencyMs = Math.min(250, Math.round(20 + cNorm * 180));
          state.opsComplexity = Math.max(10, Math.round(180 - cNorm * 120));
          state.securityCompliance = Math.max(50, Math.round(95 - cNorm * 40));
          const nines = Math.max(1.5, 4.5 - cNorm * 2.2);
          state.availabilitySla = Number((100.0 - Math.pow(10, -nines) * 100.0).toFixed(3));
        } else {
          // Unlocked budget: compute pulls budget up, tightens latency, boosts SLA & complexity
          state.monthlyBudget = Math.round(50 + Math.pow(cNorm, 1.3) * 49950);
          state.opsComplexity = Math.round(15 + cNorm * 180);
          state.p99LatencyMs = Math.max(5, Math.round(200 - cNorm * 190));
          state.securityCompliance = Math.round(55 + cNorm * 45);
          const nines = 2.0 + cNorm * 3.0;
          state.availabilitySla = Number((100.0 - Math.pow(10, -nines) * 100.0).toFixed(3));
        }
      } else if (changedPillar === 'sla') {
        const nines = -Math.log10(Math.max(0.00001, 1 - (state.availabilitySla / 100.0)));
        const sNorm = Math.max(0.0, Math.min(1.0, (nines - 1.3) / (5.0 - 1.3)));
        if (locked === 'budget') {
          // Fixed budget: ultra SLA forces compute down and latency up
          state.computeCapacity = Math.max(10, Math.round(350 - sNorm * 300));
          state.p99LatencyMs = Math.min(250, Math.round(30 + sNorm * 160));
          state.securityCompliance = Math.round(60 + sNorm * 40);
        } else {
          state.monthlyBudget = Math.round(120 + Math.pow(sNorm, 1.8) * 49880);
          state.computeCapacity = Math.round(20 + Math.pow(sNorm, 0.8) * 480);
          state.opsComplexity = Math.round(20 + Math.pow(sNorm, 0.9) * 180);
          state.securityCompliance = Math.round(65 + sNorm * 35);
          state.p99LatencyMs = Math.max(5, Math.round(180 - sNorm * 170));
        }
      } else if (changedPillar === 'latency') {
        // Latency (2ms to 250ms, lower is faster)
        const lNorm = 1.0 - ((state.p99LatencyMs - 2) / (250 - 2));
        if (locked === 'budget') {
          state.computeCapacity = Math.max(10, Math.round(10 + lNorm * 220));
          state.opsComplexity = Math.round(20 + lNorm * 160);
          state.securityCompliance = Math.max(50, Math.round(90 - lNorm * 35));
        } else {
          state.monthlyBudget = Math.round(80 + Math.pow(lNorm, 1.6) * 49920);
          state.computeCapacity = Math.round(15 + Math.pow(lNorm, 0.9) * 480);
          state.opsComplexity = Math.round(15 + lNorm * 180);
          const nines = 2.0 + lNorm * 2.9;
          state.availabilitySla = Number((100.0 - Math.pow(10, -nines) * 100.0).toFixed(3));
        }
      } else if (changedPillar === 'complexity') {
        const compNorm = (state.opsComplexity - 10) / 190.0;
        state.securityCompliance = Math.round(50 + compNorm * 50);
        if (locked !== 'budget') {
          state.monthlyBudget = Math.round(100 + Math.pow(compNorm, 1.2) * 45000);
          state.computeCapacity = Math.round(15 + compNorm * 460);
        }
      } else if (changedPillar === 'security') {
        const secNorm = (state.securityCompliance - 50) / 50.0;
        if (locked !== 'budget') {
          state.monthlyBudget = Math.round(150 + Math.pow(secNorm, 1.4) * 40000);
          state.opsComplexity = Math.round(25 + secNorm * 165);
        }
      }
    },
pulseem:     function(state, changedPillar) {
      const locked = ''; 

      if (changedPillar === 'strain') {
        const sNorm = (state.trainingStrainTrimp - 50) / (1200 - 50);
        if (locked !== 'fuel') state.metabolicFuelingPercent = Math.round(40 + sNorm * 120);
        if (locked !== 'recovery') state.autonomicRecoveryHrv = Math.max(20, Math.round(135 - sNorm * 85));
        if (locked !== 'autophagy') state.autophagyScore = Math.round(30 + Math.pow(sNorm, 0.8) * 110);
        if (locked !== 'longevity') state.longevityScore = Math.round(50 + Math.sin(sNorm * Math.PI) * 75 + sNorm * 20);
      } else if (changedPillar === 'recovery') {
        const rNorm = (state.autonomicRecoveryHrv - 20) / (150 - 20);
        if (locked !== 'longevity') state.longevityScore = Math.round(40 + rNorm * 105);
        if (locked !== 'strain') state.trainingStrainTrimp = Math.round(100 + rNorm * 950);
        if (locked !== 'fuel') state.metabolicFuelingPercent = Math.round(50 + rNorm * 80);
        if (locked !== 'autophagy') state.autophagyScore = Math.round(40 + rNorm * 90);
      } else if (changedPillar === 'fuel') {
        const fNorm = (state.metabolicFuelingPercent - 20) / (180 - 20);
        if (locked !== 'autophagy') state.autophagyScore = Math.max(20, Math.round(155 - fNorm * 120));
        if (locked !== 'strain') state.trainingStrainTrimp = Math.round(120 + fNorm * 980);
        if (locked !== 'recovery') state.autonomicRecoveryHrv = Math.round(30 + Math.pow(fNorm, 0.7) * 110);
        if (locked !== 'longevity') state.longevityScore = Math.round(45 + Math.sin(fNorm * Math.PI * 0.9) * 85);
      } else if (changedPillar === 'autophagy') {
        const aNorm = (state.autophagyScore - 20) / (160 - 20);
        if (locked !== 'fuel') state.metabolicFuelingPercent = Math.max(20, Math.round(150 - aNorm * 115));
        if (locked !== 'longevity') state.longevityScore = Math.round(50 + Math.pow(aNorm, 0.85) * 95);
        if (locked !== 'strain') state.trainingStrainTrimp = Math.round(100 + aNorm * 650);
        if (locked !== 'recovery') state.autonomicRecoveryHrv = Math.round(45 + aNorm * 85);
      } else if (changedPillar === 'longevity') {
        const lNorm = (state.longevityScore - 30) / (150 - 30);
        if (locked !== 'recovery') state.autonomicRecoveryHrv = Math.round(35 + lNorm * 105);
        if (locked !== 'autophagy') state.autophagyScore = Math.round(35 + lNorm * 115);
        if (locked !== 'strain') state.trainingStrainTrimp = Math.round(150 + lNorm * 800);
        if (locked !== 'fuel') state.metabolicFuelingPercent = Math.round(45 + lNorm * 75);
      }
    },
synthem:     function(state, changedPillar) {
      const locked = ''; 

      if (changedPillar === 'drive') {
        const dNorm = state.harmonicDrivePercent / 100.0;
        if (locked !== 'crest') state.dynamicCrestDb = Number(Math.max(2.0, 22.0 - dNorm * 17.5).toFixed(1));
        if (locked !== 'width') state.stereoWidthPercent = Math.round(30 + dNorm * 65);
        if (locked !== 'cutoff') state.vcfCutoffHz = Math.round(400 + Math.pow(dNorm, 0.7) * 9500);
        if (locked !== 'reverb') state.reverbDecaySec = Number((0.4 + dNorm * 4.5).toFixed(1));
      } else if (changedPillar === 'crest') {
        const cNorm = (state.dynamicCrestDb - 2.0) / (24.0 - 2.0);
        if (locked !== 'drive') state.harmonicDrivePercent = Math.max(0, Math.round(100 - cNorm * 90));
        if (locked !== 'cutoff') state.vcfCutoffHz = Math.round(200 + cNorm * 10500);
        if (locked !== 'reverb') state.reverbDecaySec = Number((0.2 + cNorm * 6.5).toFixed(1));
      } else if (changedPillar === 'cutoff') {
        const fNorm = (state.vcfCutoffHz - 100) / (12000 - 100);
        if (locked !== 'crest') state.dynamicCrestDb = Number((4.0 + fNorm * 18.0).toFixed(1));
        if (locked !== 'width') state.stereoWidthPercent = Math.round(20 + fNorm * 75);
        if (locked !== 'reverb') state.reverbDecaySec = Number((0.3 + fNorm * 7.2).toFixed(1));
      } else if (changedPillar === 'width') {
        const wNorm = state.stereoWidthPercent / 100.0;
        if (locked !== 'reverb') state.reverbDecaySec = Number((0.2 + wNorm * 8.0).toFixed(1));
        if (locked !== 'cutoff') state.vcfCutoffHz = Math.round(300 + wNorm * 8500);
      } else if (changedPillar === 'reverb') {
        const rNorm = (state.reverbDecaySec - 0.1) / (10.0 - 0.1);
        if (locked !== 'width') state.stereoWidthPercent = Math.round(25 + rNorm * 70);
        if (locked !== 'crest') state.dynamicCrestDb = Number(Math.max(2.0, 18.0 - rNorm * 8.0).toFixed(1));
      } else if (changedPillar === 'pitch') {
        const pNorm = (state.pitchRatio - 0.25) / (4.0 - 0.25);
        if (locked !== 'cutoff') state.vcfCutoffHz = Math.round(200 + pNorm * 10000);
      }
    },
balancem:     function(state, changedPillar) {
      const locked = ''; 

      if (changedPillar === 'dps') {
        const dNorm = (state.damagePerSecondDps - 50) / (5000 - 50);
        if (locked !== 'ehp') state.effectiveHealthPoolEhp = Math.max(200, Math.round(42000 - Math.pow(dNorm, 0.7) * 39500));
        if (locked !== 'skill') state.skillCeilingApm = Math.round(40 + dNorm * 330);
        if (locked !== 'crit') state.critMultiplier = Number((1.2 + dNorm * 2.6).toFixed(1));
        if (locked !== 'resource') state.resourceCostCooldown = Math.round(20 + dNorm * 210);
        if (locked !== 'mobility') state.mobilitySpeed = Math.round(20 + Math.sin(dNorm * Math.PI) * 65 + dNorm * 15);
      } else if (changedPillar === 'ehp') {
        const eNorm = (state.effectiveHealthPoolEhp - 200) / (50000 - 200);
        if (locked !== 'dps') state.damagePerSecondDps = Math.max(50, Math.round(4200 - Math.pow(eNorm, 0.75) * 3950));
        if (locked !== 'mobility') state.mobilitySpeed = Math.max(10, Math.round(90 - eNorm * 72));
        if (locked !== 'skill') state.skillCeilingApm = Math.max(20, Math.round(320 - eNorm * 250));
        if (locked !== 'crit') state.critMultiplier = Number(Math.max(1.0, 3.5 - eNorm * 2.3).toFixed(1));
        if (locked !== 'resource') state.resourceCostCooldown = Math.round(40 + eNorm * 180);
      } else if (changedPillar === 'mobility') {
        const mNorm = (state.mobilitySpeed - 10) / (100 - 10);
        if (locked !== 'ehp') state.effectiveHealthPoolEhp = Math.max(200, Math.round(38000 - mNorm * 34000));
        if (locked !== 'dps') state.damagePerSecondDps = Math.round(300 + mNorm * 3800);
        if (locked !== 'skill') state.skillCeilingApm = Math.round(50 + mNorm * 310);
        if (locked !== 'crit') state.critMultiplier = Number((1.2 + mNorm * 2.4).toFixed(1));
      } else if (changedPillar === 'skill') {
        const sNorm = (state.skillCeilingApm - 20) / (400 - 20);
        if (locked !== 'dps') state.damagePerSecondDps = Math.round(200 + Math.pow(sNorm, 1.2) * 4500);
        if (locked !== 'crit') state.critMultiplier = Number((1.1 + sNorm * 2.7).toFixed(1));
        if (locked !== 'mobility') state.mobilitySpeed = Math.round(20 + sNorm * 75);
        if (locked !== 'ehp') state.effectiveHealthPoolEhp = Math.max(200, Math.round(35000 - sNorm * 31000));
      } else if (changedPillar === 'crit') {
        const cNorm = (state.critMultiplier - 1.0) / (4.0 - 1.0);
        if (locked !== 'dps') state.damagePerSecondDps = Math.round(400 + cNorm * 3900);
        if (locked !== 'skill') state.skillCeilingApm = Math.round(60 + cNorm * 300);
        if (locked !== 'ehp') state.effectiveHealthPoolEhp = Math.max(200, Math.round(32000 - cNorm * 27000));
      } else if (changedPillar === 'resource') {
        const rNorm = (state.resourceCostCooldown - 10) / (250 - 10);
        if (locked !== 'dps') state.damagePerSecondDps = Math.round(300 + rNorm * 4200);
      }
    }
}; // Populated below with the audited illustrative browser formulas.

  function solve(engine,input,options={}){
    const errors=[];if(!own(definitions,engine))return {valid:false,errors:['engine: unknown engine'],constraints:input};
    inspect(input,'constraints',errors);inspect(options,'options',errors);if(!plain(input)||!plain(options))errors.push('constraints/options: must be plain objects');
    if(errors.length)return {valid:false,errors,constraints:input};
    const d=definitions[engine],c={...defaults(engine),...clone(input)};
    if(hasEquation(engine))for(const k of Object.keys(options))if(!['changed','solveFor','locked'].includes(k))errors.push('options.'+k+': unsupported field');
    c.lockMode=pillar(engine,c.lockMode);if(engine==='capem'&&!own(input,'monthlyBurnUsd'))c.monthlyBurnUsd=c.capitalRaisedUsd/c.runwayMonths;
    for(const k of ['shader','audioPulseActive','scopeTier','investorSharePercent','filterCutoffHz','criticalMultiplier'])delete c[k];
    if(engine==='synthem'&&own(input,'filterCutoffHz')&&!own(input,'vcfCutoffHz'))c.vcfCutoffHz=input.filterCutoffHz;
    if(engine==='balancem'&&own(input,'criticalMultiplier')&&!own(input,'critMultiplier'))c.critMultiplier=input.criticalMultiplier;
    checkConstraints(engine,c,errors);
    let target=pillar(engine,options.solveFor===undefined?c.lockMode:options.solveFor);
    let changed=options.changed===undefined?null:pillar(engine,options.changed);
    const locked=options.locked===undefined?(c.locked||[]):options.locked;
    if(!Array.isArray(locked)||locked.some(k=>!Object.values(d.fields).some(f=>f.pillar===pillar(engine,k))))errors.push('locked: must be an array of supported fields or pillars');
    if(!Object.values(d.fields).some(f=>f.pillar===target))errors.push('solveFor: unsupported target');
    if(changed!==null&&!Object.values(d.fields).some(f=>f.pillar===changed))errors.push('changed: unsupported field');
    if(errors.length)return {valid:false,errors,constraints:clone(input)};
    const frozen=new Set(locked.map(k=>pillar(engine,k)));
    if(changed===target){if(options.solveFor!==undefined)errors.push('solveFor: cannot overwrite the changed input');else target=solveTargets(engine,changed).find(k=>!frozen.has(k));}
    if(frozen.has(target))errors.push('solveFor: target is locked');
    if(!target)errors.push('solveFor: no available dependent field');
    if(errors.length)return {valid:false,errors,constraints:clone(input)};
    const key=Object.keys(d.fields).find(k=>d.fields[k].pillar===target),adjustments=[];
    if(hasEquation(engine)){
      solveEquation(engine,c,key,errors);
    }else if(engine==='boxem'){
      const hours=25+55*c.scopePercent/100,q=0.6+0.4*Math.pow(c.qualityPercent/100,1.35),base=hours*c.baseRate*q,timeline=Math.pow(4/c.timeWeeks,0.45);
      const price=Math.max(base*timeline,c.enableFloorGuarantee?Math.max(c.bounds.costMin,base*0.72,c.minFullScopeFloor*c.scopePercent/100):c.bounds.costMin);
      // A floor makes the inverse non-unique. Keep a current valid solution;
      // otherwise invert the active craft multiplier and the scope-floor cap.
      const alreadyPriced=Math.abs(price-c.costBudget)<=64*Number.EPSILON*Math.max(1,price,c.costBudget);
      const factor=c.enableFloorGuarantee?Math.max(timeline,0.72):timeline;
      if(target==='cost')c.costBudget=price;
      else if(!alreadyPriced){
        if(target==='time')c.timeWeeks=4*Math.pow(base/c.costBudget,1/0.45);
        if(target==='quality')c.qualityPercent=100*Math.pow((c.costBudget/(hours*c.baseRate*factor)-0.6)/0.4,1/1.35);
        if(target==='scope'){
          c.scopePercent=100*(c.costBudget/(c.baseRate*q*factor)-25)/55;
          if(c.enableFloorGuarantee&&c.minFullScopeFloor>0)c.scopePercent=Math.min(c.scopePercent,100*c.costBudget/c.minFullScopeFloor);
        }
      }
      if(!['cost','time','quality','scope'].includes(target))errors.push('solveFor: Box supports time, cost, quality or scope');
      const solvedBase=(25+55*c.scopePercent/100)*c.baseRate*(0.6+0.4*Math.pow(c.qualityPercent/100,1.35));
      const floor=Math.max(c.bounds.costMin,solvedBase*0.72,c.minFullScopeFloor*c.scopePercent/100);
      if(c.enableFloorGuarantee&&c.costBudget+1e-7<floor)errors.push('constraints.costBudget: below configured scope/craft floor');
    }else if(engine==='capem'){
      if(target==='founder')c.founderEquityPercent=100-c.esopPoolPercent-100*c.capitalRaisedUsd/c.postMoneyValuationUsd;
      if(target==='valuation')c.postMoneyValuationUsd=100*c.capitalRaisedUsd/(100-c.founderEquityPercent-c.esopPoolPercent);
      if(target==='capital')c.capitalRaisedUsd=changed==='runway'?c.runwayMonths*c.monthlyBurnUsd:c.postMoneyValuationUsd*(100-c.founderEquityPercent-c.esopPoolPercent)/100;
      if(target==='esop')c.esopPoolPercent=100-c.founderEquityPercent-100*c.capitalRaisedUsd/c.postMoneyValuationUsd;
      if(target==='burn')c.monthlyBurnUsd=c.capitalRaisedUsd/c.runwayMonths;
      if(target==='runway'||(target!=='burn'&&changed!=='runway'&&!frozen.has('runway')))c.runwayMonths=c.capitalRaisedUsd/c.monthlyBurnUsd;
      let sum=c.founderEquityPercent+c.esopPoolPercent+100*c.capitalRaisedUsd/c.postMoneyValuationUsd;
      if(Math.abs(sum-100)>1e-7&&target==='capital'&&!frozen.has('founder')&&changed!=='founder'){c.founderEquityPercent=100-c.esopPoolPercent-100*c.capitalRaisedUsd/c.postMoneyValuationUsd;sum=100;}
      if(Math.abs(sum-100)>1e-7)errors.push('constraints: selected target cannot conserve ownership with these inputs');
      if(Math.abs(c.runwayMonths-c.capitalRaisedUsd/c.monthlyBurnUsd)>1e-7)errors.push('constraints: runway conflicts with capital and burn; choose capital, runway or burn');
    }else{
      // Directional scenario curves are illustrations, not simultaneous physical constraints.
      const driver=changed||d.locks.find(p=>solveTargets(engine,p).includes(target));
      if(!driver||!solveTargets(engine,driver).includes(target))errors.push(`solveFor: no directional relationship from ${driver||'any input'} to ${target}`);
      else {
        const candidate=clone(c),driverKey=Object.keys(d.fields).find(k=>d.fields[k].pillar===driver),[min,max]=curveDomains[engine][driver];
        // Extend an illustrative curve by saturation, never extrapolate fractional
        // powers or silently alter the user's input. Report every saturation.
        const effective=Math.max(min,Math.min(max,c[driverKey]));
        if(effective!==c[driverKey])adjustments.push({field:driverKey,input:c[driverKey],effective,reason:'Illustrative curve saturates at its documented endpoint'});
        candidate[driverKey]=effective;legacyCandidates[engine](candidate,driver);
        c[key]=candidate[key];
      }
    }
    // Only arithmetic overshoot within machine precision is snapped. Inputs were
    // checked strictly above; this cannot rescue a materially infeasible solve.
    for(const [k,f]of Object.entries(d.fields)){
      if(frozen.has(f.pillar)||f.pillar===changed||c[k]===({...defaults(engine),...input})[k]||!Number.isFinite(c[k]))continue;
      const limits=engine==='boxem'&&boundMap[k]?boundMap[k].map(name=>c.bounds[name]):[f.min,f.max];
      for(const bound of limits)if(Math.abs(c[k]-bound)<=64*Number.EPSILON*Math.max(1,Math.abs(bound)))c[k]=bound;
    }
    checkConstraints(engine,c,errors);
    for(const [k,f]of Object.entries(d.fields))if(frozen.has(f.pillar)&&c[k]!==({...defaults(engine),...input})[k])errors.push('constraints.'+k+': locked input would change');
    if(errors.length)return {valid:false,errors,constraints:clone(input)};
    return {valid:true,errors:[],constraints:c,...(adjustments.length?{adjustments}:{}),...(engine==='capem'?{submodules:ledger(c)}:{})};
  }
  return {version,definitions,defaults,validate,serialize,create:serialize,toState,solve,solveTargets,curveDomains,isSafeAssetUrl,ledger};
});
