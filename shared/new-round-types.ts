// SPDX-License-Identifier: MPL-2.0
export type FeedbackStatus = 'new' | 'in_progress' | 'resolved' | 'closed'
export type FeedbackCategory = 'bug' | 'suggestion' | 'question'
export interface Feedback {
  id:number;user_id:number;category:FeedbackCategory;title:string;status:FeedbackStatus;version:number
  created_at:string;updated_at:string;closed_at:string|null;content?:string;page_path?:string|null;author?:string
}
export interface FeedbackEvent {id:number;kind:'status'|'internal_note'|'public_reply';content:string;from_status:FeedbackStatus|null;to_status:FeedbackStatus|null;created_at:string;actor?:string}
export interface FeaturePage<T> {items:T[];total:number;page:number;pageSize:number;new_total?:number;hasMore?:boolean}
export type ActivityView = '24h' | '7d' | '30d'
export interface ActivityReport {
  generated_at:string;collection_started_at:string;collection_health:'ok'|'degraded';timezone:string;view:ActivityView;bucket:'hour'|'day'
  summary:Record<ActivityView,{value:number;window_complete:boolean}>
  series:{start:string;value:number|null;coverage:'not_collected'|'partial'|'complete'}[]
}
export interface LeaderboardItem {idea_id:number;title:string;public_summary:string;tags:string;author:string;score_milli:number;score:number;score_display:string;rank:number;scored_at:string;model:string;standard_version:string;angle:string}
