// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { API_RESOURCES, ORDER_RESOURCES } from '../data/resources'
import { externalHttps } from '../lib/phase2'

export function ResourcesPage({ kind }: { kind: 'orders' | 'api' }) {
  const orders = kind === 'orders'
  useEffect(() => { document.querySelector('.main')?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }) }, [kind])
  return <div className="page resources-page"><div className="page-header"><div>
    <Link className="link-btn" to={orders ? '/orders' : '/settings'}>{tr("← 返回")}{orders ? tr("需求商单") : tr("设置")}</Link>
    <h1 className="page-title">{orders ? tr("接单平台推荐") : tr("获取 API Key")}</h1>
    <p className="page-sub">{orders ? tr("按技能浏览平台，选择适合自己的交付方向。") : tr("打开服务商控制台，注册或登录后自行创建 Key。")}</p>
  </div></div>
    <details className="context-details"><summary>{tr('使用说明与资料来源')}</summary>
    <p className="hint-banner">{tr("资料更新于 2026-09-30，实际政策请以官网为准。入口来自你提供的推荐资料；费用、免费额度、模型名称和市场数据未在此展示或核实。")}</p>
    <p className="muted resource-intro">{orders ? tr("找到需求后，可在「需求商单」保存完整链接并填写需求、预算和周期；应用按已填写的需求匹配开发工程。") : tr("创建 Key 后返回设置，按服务商文档填写 OpenAI 兼容地址和模型名称。本页不会自动配置或注册第三方账号。")}</p>
    </details>
    {(orders ? ORDER_RESOURCES : API_RESOURCES).map((group) => <section className="resource-group" key={group.title}><h2>{tr(group.title)}</h2><div className="resource-grid">
      {group.items.map((resource) => { const url = externalHttps(resource.url)
        return <article className="panel resource-card" key={resource.name}><h3>{resource.name}</h3><p className="muted">{tr(resource.audience)}</p>
          {url ? <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noopener noreferrer">{orders ? tr("访问平台") : tr("获取 Key")} {tr("↗ 外部网站")}</a> : <p className="error-text">{tr("入口网址无效")}</p>}
        </article> })}
    </div></section>)}
  </div>
}
