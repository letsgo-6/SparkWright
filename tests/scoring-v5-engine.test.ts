// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAssessment,validateAssessment,parseJsonStrict } from '../server/scoring-engine'
import { fixtureAssessment,fixtureInput } from './fixtures/scoring-v5'
import { formatIdeaScore,serializeIdeaScore } from '../shared/idea-score'
import { SCORE_SYSTEM,scoringStatus } from '../server/scoring-config'
import { VALUE_POINTS,STANDARD_VERSION } from '../shared/scoring-standard'

test('V5 golden levels use only the specified points and integer formula',()=>{
 for(const [level,score] of [[0,0],[1,30000],[2,55000],[3,80000],[4,100000]] as const)assert.equal(evaluateAssessment(fixtureAssessment(level)).score_milli,score)
 assert.equal(evaluateAssessment(fixtureAssessment(0)).score_milli,0)
 assert.equal(formatIdeaScore(0),'0.0');assert.equal(formatIdeaScore(null),'—')
 assert.equal(scoringStatus().engine,'v5');assert.equal(STANDARD_VERSION,'sparkwright-idea-v5.0.0')
 assert.equal(Object.hasOwn(scoringStatus(),'approved_models'),false)
})
test('V5 enumerated combinations produce all decimal tails with unrounded dimension total',()=>{
 const tails=new Set<number>();let differentFromRoundedDimensions=false
 for(let combination=0;combination<15625;combination++){
  const a=fixtureAssessment(3);let value=combination
  for(const i of [1,2,4,5,6,8]){a.levels[i]=value%5 as any;value=Math.floor(value/5)}
  const n=Array.from({length:4},(_,d)=>[40,35,25].reduce((sum,w,j)=>sum+w*VALUE_POINTS[a.levels[d*3+j]],0))
  let expected=Math.floor((n.reduce((sum,x)=>sum+x,0)+20)/40)
  if(!(n.every(x=>x>=8000)&&a.levels[7]===4))expected=Math.min(expected,899)
  const actual=evaluateAssessment(a).score_milli;assert.equal(actual,expected*100)
  tails.add((actual/100)%10)
  const roundedMean=Math.round(n.reduce((sum,x)=>sum+Math.round(x/10),0)/4)*100
  if(actual!==roundedMean&&expected<800)differentFromRoundedDimensions=true
 }
 assert.deepEqual([...tails].sort(),[0,1,2,3,4,5,6,7,8,9]);assert.equal(differentFromRoundedDimensions,true)
})
test('V5 caps use the three core requirements, unrounded dimensions and D2 benefit',()=>{
 for(const index of [0,3,9]){const a=fixtureAssessment(4);a.levels[index]=2;assert.equal(evaluateAssessment(a).score_milli,79900)}
 const d2=fixtureAssessment(4);d2.levels[7]=3;assert.equal(evaluateAssessment(d2).score_milli,89900)
 const dim=fixtureAssessment(4);dim.levels[6]=1
 assert.equal(evaluateAssessment(dim).gates.gate90,false);assert.equal(evaluateAssessment(dim).score_milli,89900)
 for(const index of [3,9]){const a=fixtureAssessment(4);a.levels[index]=0;assert.equal(evaluateAssessment(a).score_milli,49900);a.levels[index]=1;assert.equal(evaluateAssessment(a).score_milli,79900)}
 const noHiddenPenalty=fixtureAssessment(3);noHiddenPenalty.levels[8]=2
 assert.equal(evaluateAssessment(noHiddenPenalty).score_milli,78400)
})
test('V5 accepts empty quotes without surveys or prototypes; rejects bad structure and fabricated quotes',()=>{
 assert.equal(validateAssessment(fixtureAssessment(3),fixtureInput).issues.length,0)
 const a=fixtureAssessment(3);a.quotes=['每周整理资料'];assert.equal(validateAssessment(a,fixtureInput).issues.length,0)
 const invalid:any[]=[{...a,score:100},{...a,levels:a.levels.slice(1)},{...a,levels:[3.5,...a.levels.slice(1)]},{...a,levels:[5,...a.levels.slice(1)]},{...a,levels:['unknown',...a.levels.slice(1)]},{...a,quotes:['非原文证明']},{...a,quotes:['每周整理资料','每周整理资料','每周整理资料']},{...a,summary:'😀'.repeat(121)}]
 for(const value of invalid)assert.ok(validateAssessment(value,fixtureInput).issues.length>0)
 assert.match(SCORE_SYSTEM,/未提供调查、原型、收入或外部证明不扣分/)
})
test('V5 rejects duplicate JSON keys including escaped aliases',()=>{
 assert.throws(()=>parseJsonStrict('{"levels":[],"levels":[]}'))
 assert.throws(()=>parseJsonStrict('{"summary":"a","su\\u006dmary":"b"}'))
 assert.deepEqual(parseJsonStrict(' ```json\n{"levels":[]}\n``` '),{levels:[]})
})
test('V5 displays one decimal while archived precision is never relabeled',()=>{
 const legacy=serializeIdeaScore({score:90,score_milli:90125,standard_version:'sparkwright-idea-v3.0.0',validity:'valid',precision_version:'milli-v1'} as any)
 assert.equal(legacy.score,90.125);assert.equal(legacy.score_display,'90.1');assert.equal(legacy.standard_version,'sparkwright-idea-v3.0.0')
 const old41=serializeIdeaScore({score:80,score_milli:80100,standard_version:'sparkwright-idea-v4.1.0',validity:'valid',precision_version:'deci-v1'} as any)
 assert.equal(old41.score_display,'80.1')
})
