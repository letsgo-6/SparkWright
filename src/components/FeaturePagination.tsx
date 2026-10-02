// SPDX-License-Identifier: MPL-2.0
import {tr} from '../i18n/index'
export function FeaturePagination({page,total,onPage,disabled=false}:{page:number;total:number;onPage:(page:number)=>void;disabled?:boolean}) {
  const pages=Math.max(1,Math.ceil(total/20))
  return <nav className="feature-pagination" aria-label={tr('分页')}>
    <button className="btn btn-ghost" disabled={disabled||page<=1} onClick={()=>onPage(page-1)}>{tr('上一页')}</button>
    <span>{tr('第 {0} 页 · 共 {1} 条',[page,total])}</span>
    <button className="btn btn-ghost" disabled={disabled||page>=pages||page>=1000} onClick={()=>onPage(page+1)}>{tr('下一页')}</button>
  </nav>
}
