// SPDX-License-Identifier: MPL-2.0
export interface Resource { name: string; url: string; audience: string }
export interface ResourceGroup { title: string; items: Resource[] }

// 分类、名称、HTTPS 地址来自第二批施工文档附录，2026-09-30 快照。
// 不保存费用、免费额度、模型名、市场统计或自动设置 AI 配置。
export const ORDER_RESOURCES: ResourceGroup[] = [
  { title: '一、开发类（小程序 / App / 网站）— 国内', items: [
    { name: '程序员客栈', url: 'https://www.proginn.com', audience: '有开发经验，希望接企业项目' },
    { name: '猪八戒网', url: 'https://www.zbj.com', audience: '浏览综合外包需求、积累交付经验' },
    { name: '一品威客', url: 'https://www.epwk.com', audience: '寻找中小型外包项目' },
    { name: '开源众包', url: 'https://zb.oschina.net', audience: '作为软件外包的补充渠道' },
    { name: '解放号', url: 'https://www.jfh.com', audience: '具备政企软件交付经验' },
    { name: '电鸭社区', url: 'https://eleduck.com', audience: '寻找远程兼职或全职' },
    { name: '闲鱼 / 小红书', url: 'https://www.goofish.com', audience: '展示轻定制服务与案例；此入口为闲鱼' },
  ] },
  { title: '二、UI / 视觉设计类 — 国内', items: [
    { name: 'UI中国', url: 'https://www.ui.cn', audience: 'UI 设计师' },
    { name: '站酷', url: 'https://www.zcool.com.cn', audience: '有作品集的视觉设计师' },
    { name: '特赞 Tezign', url: 'https://www.tezign.com', audience: '成熟设计师或工作室' },
    { name: '猪八戒/一品威客', url: 'https://www.zbj.com', audience: '浏览设计需求；此入口为猪八戒网' },
  ] },
  { title: '三、视频制作类 — 国内', items: [
    { name: '新片场', url: 'https://www.xinpianchang.com', audience: '有成片能力的剪辑师或导演' },
    { name: '巨量星图', url: 'https://xingtu.bytedance.com', audience: '抖音内容创作者' },
    { name: 'B站花火', url: 'https://huahuo.bilibili.com', audience: 'B站 UP 主' },
    { name: '小红书蒲公英', url: 'https://pgy.xiaohongshu.com', audience: '小红书博主' },
    { name: '闲鱼/淘宝', url: 'https://www.goofish.com', audience: '提供剪辑等小型服务；此入口为闲鱼' },
  ] },
  { title: '四、国际平台（需英语读写）', items: [
    { name: 'Upwork', url: 'https://www.upwork.com', audience: '开发、设计和视频自由职业者' },
    { name: 'Fiverr', url: 'https://www.fiverr.com', audience: '提供标准化小型服务' },
    { name: 'Toptal', url: 'https://www.toptal.com', audience: '经验丰富的开发人才' },
    { name: 'Freelancer', url: 'https://www.freelancer.com', audience: '寻找综合自由职业项目' },
    { name: '99designs', url: 'https://99designs.com', audience: '视觉、Logo 与品牌设计师' },
    { name: 'Dribbble', url: 'https://dribbble.com', audience: '有英文作品集的设计师' },
    { name: 'Contra', url: 'https://contra.com', audience: '已有交付经验的自由职业者' },
  ] },
]

export const API_RESOURCES: ResourceGroup[] = [{ title: 'API Key 获取入口（沿用资料顺序）', items: [
  { name: 'OpenAI', url: 'https://platform.openai.com/api-keys', audience: '官方 API 控制台' },
  { name: 'Google Gemini', url: 'https://aistudio.google.com/apikey', audience: 'Google AI Studio' },
  { name: 'xAI (Grok)', url: 'https://console.x.ai', audience: 'xAI 控制台' },
  { name: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys', audience: 'DeepSeek 开放平台' },
  { name: '阿里云百炼（通义千问）', url: 'https://bailian.console.aliyun.com', audience: '阿里云百炼控制台' },
  { name: '智谱 BigModel', url: 'https://open.bigmodel.cn', audience: '智谱开放平台' },
  { name: '月之暗面 Kimi', url: 'https://platform.kimi.com', audience: 'Kimi 开放平台' },
  { name: '火山方舟（豆包）', url: 'https://console.volcengine.com/ark', audience: '火山引擎方舟控制台' },
  { name: 'MiniMax', url: 'https://platform.minimax.cn', audience: 'MiniMax 开放平台' },
  { name: '腾讯混元', url: 'https://console.cloud.tencent.com/hunyuan', audience: '腾讯云混元控制台' },
  { name: '百度千帆（文心）', url: 'https://console.bce.baidu.com/qianfan', audience: '百度智能云千帆控制台' },
  { name: '讯飞星火', url: 'https://console.xfyun.cn', audience: '讯飞开放平台' },
  { name: '硅基流动 SiliconFlow', url: 'https://cloud.siliconflow.cn/account/ak', audience: '硅基流动 API Key 页面' },
  { name: '魔搭 ModelScope', url: 'https://modelscope.cn/my/myaccesstoken', audience: '魔搭访问令牌页面' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', audience: 'OpenRouter Key 设置页面' },
] }]
