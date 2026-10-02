// SPDX-License-Identifier: MPL-2.0
import type { JudgmentValue,Assessment } from '../../shared/scoring-standard'
export const fixtureInput={title:'工程测试工具',content:'每周整理资料，使用网页表单与数据库规则计算。输入资料，按规则去重归档，输出待验证清单。'}
export function fixtureAssessment(value:JudgmentValue=2):Assessment {
 return {levels:Array(12).fill(value),quotes:[],summary:'需求与机制按正文评价。'}
}
