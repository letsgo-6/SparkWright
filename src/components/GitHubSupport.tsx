// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n'
import { GITHUB_REPOSITORY } from '../lib/github'

export function GitHubSupport() {
  return <div className="github-support">
    {GITHUB_REPOSITORY ? <a className="btn btn-ghost github-support-button" href={GITHUB_REPOSITORY} target="_blank" rel="noopener noreferrer"><GitHubIcon /> GitHub · Star</a>
      : <button className="btn btn-ghost" disabled>{tr('GitHub 未配置')}</button>}
    <div className="github-support-copy"><p>{tr('喜欢 SparkWright？进入 GitHub 为我点亮 Star，你们的点亮是我的最大动力 :)')}</p>
      <p className="muted small">{tr('如果 GitHub 访问不畅，可以下载免费的 Watt Toolkit 加速后再访问。')} <a href="https://steampp.net/" target="_blank" rel="noopener noreferrer">{tr('Watt Toolkit 官方下载')}</a></p>
    </div>
  </div>
}

function GitHubIcon() {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 .1.5 2.14 3.28 1.5.1-.73.39-1.24.71-1.52-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.29-.51-1.44.11-3 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.62 1.56.23 2.71.11 3 .72.79 1.16 1.8 1.16 3.03 0 4.32-2.64 5.27-5.15 5.55.4.35.77 1.04.77 2.1v3.1c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" /></svg>
}
