// SPDX-License-Identifier: MPL-2.0
import type { ComputedAssessment } from '../../shared/scoring-standard'
import { METRICS,DIMENSION_NAMES,VALUE_POINTS } from '../../shared/scoring-standard'
import { tr } from '../i18n/index'
import { formatIdeaScore } from '../../shared/idea-score'
export function ScoreAssessment({value}:{value:ComputedAssessment & {manifest:Record<string,any>}}) {
  return <section className="score-assessment">
    <p className="hint-banner">{tr('V5 只评价标题与正文中的设计；缺少调查、原型或外部证明不扣分。')}</p>
    <p className="muted small">{tr('12 项各取 0–4 级，对应 0、30、55、80、100 分；关键机制缺失取 1 级，明确矛盾才取 0 级。')}</p>
    <div className="admin-table-wrap"><table className="dim-table"><thead><tr><th>{tr('子指标')}</th><th>{tr('等级')}</th><th>{tr('对应分值')}</th><th>{tr('维内权重')}</th></tr></thead><tbody>
      {METRICS.map((metric,i)=><tr key={metric.id}><td>{metric.id} · {tr(metric.name)}</td><td>{value.assessment.levels[i]}</td><td>{VALUE_POINTS[value.assessment.levels[i]]}</td><td>{metric.weight}%</td></tr>)}
    </tbody></table></div>
    {value.assessment.quotes.length>0&&<div><h4>{tr('原文短引用')}</h4>{value.assessment.quotes.map((quote,i)=><p className="sw-plain-text" key={i}>“{quote}”</p>)}</div>}
    <p className="small">{DIMENSION_NAMES.map((name,i)=>tr(name)+' '+formatIdeaScore(value.raw_dimensions_milli[i]/1000)).join(' · ')}</p>
    <p>{tr('封顶前综合分：')}{formatIdeaScore(value.base_milli/1000)} → {formatIdeaScore(value.score_milli/1000)}</p>
    {value.applied_rules.length>0&&<ul>{value.applied_rules.map(rule=><li key={rule.id}>{rule.id} · {tr('规则上限：')}{formatIdeaScore(rule.cap_milli/1000)} · {rule.metric_ids.join(', ')}</li>)}</ul>}
    <p className="muted small">{tr('V5 从未舍入维度值计算总分，最终保留一位小数；同分允许并列。')}</p>
  </section>
}
