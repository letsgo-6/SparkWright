// SPDX-License-Identifier: MPL-2.0
export const STANDARD_VERSION='sparkwright-idea-v5.0.0'
export const PROMPT_VERSION='score-v5.0.0'
export const SCHEMA_VERSION='assessment-v5.0.0'
export const INPUT_POLICY_VERSION='idea-text-v5.0.0'
export const INPUT_SCOPE='idea-text-v5'
export const PRECISION_VERSION='deci-v1'
export const SYNTHESIS_VERSION='synthesis-v5.0.0'
export const SYNTHESIS_GAIN_MILLI=3000
export const VALUE_POINTS=[0,30,55,80,100] as const
export const LOCAL_WEIGHTS=[40,35,25] as const
export const DIMENSION_KEYS=['problem','solution','differentiation','feasibility'] as const
export const DIMENSION_NAMES=['问题价值','解决方案质量','差异化','可行性'] as const
export const METRICS=[
 {id:'P1',name:'用户需求是否明确',weight:40},{id:'P2',name:'解决后收益是否具体',weight:35},{id:'P3',name:'使用场景是否合理',weight:25},
 {id:'S1',name:'核心机制能否解决需求',weight:40},{id:'S2',name:'使用流程是否形成闭环',weight:35},{id:'S3',name:'设计是否简洁、避免无效复杂度',weight:25},
 {id:'D1',name:'相比通常做法改变什么',weight:40},{id:'D2',name:'改变是否带来实质收益',weight:35},{id:'D3',name:'各机制组合是否相互增益',weight:25},
 {id:'F1',name:'技术或实施路径是否合理',weight:40},{id:'F2',name:'关键依赖是否通常可获取',weight:35},{id:'F3',name:'最小方案是否可以验证',weight:25},
] as const
export type MetricId=typeof METRICS[number]['id']
export type JudgmentValue=0|1|2|3|4
export interface TextInput {title:string;content:string}
export interface Assessment {levels:JudgmentValue[];quotes:string[];summary:string}
export interface AppliedRule {id:string;cap_milli:number;metric_ids:MetricId[]}
export interface ComputedAssessment {
 assessment:Assessment;raw_dimensions_milli:number[];base_milli:number;score_milli:number;
 dimensions:{name:string;key:string;score:number;comment:string}[];applied_rules:AppliedRule[];gates:{gate80:boolean;gate90:boolean}
}
const object=(properties:Record<string,any>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties})
export const SCORE_OUTPUT_SCHEMA:Record<string,any>=object({
 levels:{type:'array',minItems:12,maxItems:12,items:{type:'integer',minimum:0,maximum:4}},
 quotes:{type:'array',maxItems:2,items:{type:'string',minLength:2,maxLength:80}},
 summary:{type:'string',minLength:1,maxLength:120}
})
export const BATCH_OUTPUT_SCHEMA:Record<string,any>=object({items:{type:'array',minItems:3,maxItems:3,items:object({
 id:{type:'string',enum:['I','II','III']},assessment:SCORE_OUTPUT_SCHEMA,
 relation:object({both_mechanisms:{type:'boolean'},weakness_improved:{type:'boolean'},new_core_flaw:{type:'boolean'}})
})}})
export const BATCH_INSTRUCTION='批量评三个中性编号I/II/III。每项独立使用相同12项准则，不因排列顺序或组合关系加分；不知道哪个是原案或生成案。返回{"items":[{"id":"I","assessment":{"levels":[...12个整数],"quotes":[],"summary":"短解释"},"relation":{"both_mechanisms":true或false,"weakness_improved":true或false,"new_core_flaw":true或false}},...]}，每个编号恰好一次。relation对该项相对于另外两项判定：是否实际复用了两项各自的机制、是否解决至少一个具体弱点、是否新增核心缺陷；判断因果与实际改动，不按自称提升或文案长度判断。不返回分数或推理。'
export function normalizeText(title:string,content:string):TextInput {
 const clean=(s:string)=>s.replace(/\r\n?/g,'\n').normalize('NFC').trim()
 return {title:clean(title),content:clean(content)}
}
