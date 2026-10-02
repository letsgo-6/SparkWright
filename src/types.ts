// SPDX-License-Identifier: MPL-2.0
import type { ComputedAssessment } from '../shared/scoring-standard'
export type IdeaStatus = 'incubating' | 'in_progress' | 'done' | 'shelved'
export type UserRole = 'owner' | 'admin' | 'user'

export interface User {
  id: number
  name: string
  email: string | null
  role: UserRole
  created_at: string
}

export const isAdmin = (user: User | null): boolean => user?.role === 'admin' || user?.role === 'owner'
export const isOwner = (user: User | null): boolean => user?.role === 'owner'

export interface AdminSystem {
  status: 'ok'
  version: string
  uptime_seconds: number
  database: 'ok'
  users_total: number
  announcements: { published: number; draft: number }
}

export interface Backup {
  id: string
  file_name: string
  size_bytes: number
  created_at: string
}

export interface Idea {
  id: number
  user_id: number
  title: string
  content: string
  deadline: string | null
  status: IdeaStatus
  created_at: string
  updated_at: string
  author?: string
  representative_score_milli?:number|null
  step_count?: number
  done_count?: number
  is_public?: number
  public_summary?: string
  tags?: string
  leaderboard_opt_in?: number
  score_public?: number
  plaza_removed_at?: string | null
  source_parent_ids?: string | null
  synthesis_contract_ok?: number | null
}

export interface PlanStep {
  id: number
  idea_id: number
  title: string
  done: number
  sort: number
}

export interface AiMessage {
  id: number
  idea_id: number
  user_id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface Channel {
  id: number
  type: 'public' | 'idea'
  idea_id: number | null
  name: string
  created_at: string
  idea_title?: string | null
  idea_owner_id?: number | null
  archived_at?: string | null
  online_count?: number
}

export interface ChatMessage {
  id: number
  channel_id: number
  user_id: number
  content: string
  created_at: string
  author: string
}

export interface IdeaDetail {
  idea: Idea
  steps: PlanStep[]
  aiMessages: AiMessage[]
  channel: Channel | null
  score: IdeaScore | null
  personal_score?:IdeaScore|null
  representative_status?:string
  scoring_meta?:{engine:string;standard_version:string}
  scoreCount: number
  devProject: DevProject | null
}

export interface AiSettings {
  base_url: string | null
  model: string | null
  language: 'zh-CN' | 'en'
  hasKey: boolean
  maskedKey: string | null
  keySource: 'user' | 'platform' | 'none'
  updated_at: string | null
  platformConfigured: boolean
  platformModel: string | null
}

export type Priority = 'high' | 'mid' | 'low'

export type DevStatus = 'planning' | 'active' | 'paused' | 'released' | 'archived'
export type TaskStatus = 'todo' | 'doing' | 'done'

export interface DevTask {
  id: number
  project_id: number
  title: string
  status: TaskStatus
  priority: Priority
  done: number
  sort: number
}

export interface DevLog {
  id: number
  project_id: number
  content: string
  created_at: string
}

export interface DevMilestone {
  id: number
  project_id: number
  title: string
  target_date: string | null
  done: number
  created_at: string
}

export interface DevProject {
  id: number
  user_id: number
  name: string
  description: string
  milestone: string | null
  repo_url: string | null
  tech_stack: string | null
  deadline: string | null
  priority: Priority
  status: DevStatus
  source_idea_id: number | null
  source_lead_id?: number | null
  created_at: string
  tasks: DevTask[]
  logs: DevLog[]
  milestones: DevMilestone[]
}

export type OrderStatus = 'pool' | 'taken' | 'passed'

export interface OrderMatch {
  project_id: number
  project_name: string
  score: number
  reasons: string
  kw_score: number
  ai_score: number
  hit_terms: string
}

export interface OrderLead {
  id: number
  user_id: number
  title: string
  requirement: string
  url: string
  amount: number
  deadline: string | null
  status: OrderStatus
  matched_project_id: number | null
  matched_project_name?: string | null
  match_channel?: 'kw+ai' | 'kw' | 'parse_failed' | 'no_ai' | 'none'
  match_score?: number | null
  match_hit_terms?: string | null
  match_raw: string
  matched_at: string | null
  created_at: string
  updated_at: string
  is_expired: boolean
  days_left: number | null
  matches: OrderMatch[]
}

export interface ScoreDimension {
  name: string
  score: number
  comment: string
}

export interface ScoreIdentity {
  schema_version?:string|null;input_policy_version?:string|null;engine_hash?:string|null;prompt_hash?:string|null;prompt_version?:string|null;model_fingerprint?:string|null;profile_version?:string|null;input_scope?:string|null;input_hash?:string|null;comparison_group?:string|null;precision_version?:string|null;idea_revision?:number|null;assessment?:ComputedAssessment & {manifest:Record<string,any>}|null;comparison_status?:string;tracking_status?:string
}
export interface IdeaScore extends ScoreIdentity {
  id: number
  idea_id: number
  user_id: number
  score: number
  summary: string
  dimensions: ScoreDimension[]
  model?: string | null
  angle?: 'default' | 'strict' | 'encourage' | 'compliance' | null
  standard_version?: string | null
  analysis?: Record<string, unknown> | null
  validity?: 'legacy' | 'valid'
  created_at: string
}

export interface SynthesisRun {
 id:number;idea_a_id:number|null;idea_b_id:number|null;imported_idea_id:number|null
 verdict:'candidate'|'not_synthesizable';reason_code:string;outcome:string;child:{title:string;content:string}|null
 child_score?:IdeaScore;parents?:{A:SynthesisParent|null;B:SynthesisParent|null}
 variation?:string;cached?:boolean;contributions?:{A:string;B:string}|null;improvement?:{from:'A'|'B';description:string}|null
 reuse_map?:SynthesisMapping[]|null;weakness_map?:SynthesisMapping[]|null
 contract_ok:boolean;legacy_read_only?:boolean;context_withdrawn?:boolean
 contract?:{ok:boolean;baseline:string;gain_milli:number;both_mechanisms?:boolean;weakness_improved?:boolean;no_new_core_flaw?:boolean;failures:string[];dimension_delta_milli?:number[];targeted_improvements?:string[]}
 synthesis_version?:string;input_scope?:string;budget?:{attempts:number;max_attempts:number;repairs:number};created_at?:string
}
export interface SynthesisParent {total:number;scores:ScoreDimension[];mechanism?:string;weakness?:string;mechanisms?:{id:string;quote:string|null}[];weaknesses?:{id:string;quote:string|null}[];input_scope?:string}
export interface SynthesisMapping {from?:'A'|'B';mechanism_id?:string;weakness_id?:string;parent_quote?:string;child_quote:string;action:string}
export interface ModerationUser { id: number; name: string; role: UserRole; plaza_muted_at: string | null; plaza_mute_reason: string | null }
export interface ModerationIdea { id: number; user_id: number; author: string; title: string; public_summary: string; tags: string; created_at: string; plaza_removed_at: string | null; plaza_remove_reason: string | null }

export interface DashboardData {
  ideaStats: { total: number; active: number; done: number; dueSoon: number }
  dueSoon: Pick<Idea, 'id' | 'title' | 'deadline' | 'status'>[]
  recent: Pick<Idea, 'id' | 'title' | 'updated_at' | 'status'>[]
  dev: { active: number; todo: number }
  followups: { id: number; client: string; project: string; next_follow_up: string }[]
}

export type MediaStatus = 'idea' | 'scripting' | 'making' | 'published' | 'reviewed'

export interface MediaItem {
  id: number
  user_id: number
  studio_id?: number | null
  title: string
  topic: string
  platform: string
  status: MediaStatus
  publish_date: string | null
  views: number
  likes: number
  comments: number
  source_idea_id: number | null
  created_at: string
}

export type ConsultStatus = 'talking' | 'doing' | 'delivered' | 'settled' | 'lost'

export interface ConsultItem {
  id: number
  user_id: number
  client: string
  project: string
  deliverable: string
  status: ConsultStatus
  next_follow_up: string | null
  hours: number
  amount: number
  settled_amount: number
  created_at: string
}

export interface PlazaIdea {
  id: number
  title: string
  public_summary: string
  tags: string
  status: IdeaStatus
  score: number | null
  score_public: number
  user_id: number
  author: string
  created_at: string
  like_count: number
  comment_count: number
  liked: number
}

export interface PlazaComment {
  id: number
  idea_id: number
  user_id: number
  parent_id: number | null
  content: string
  created_at: string
  author: string
}

export type NotifType = 'like' | 'comment' | 'mention' | 'followup'

export interface NotifItem {
  id: number
  type: NotifType | (string & {})
  ref_id: number | null
  actor_name: string | null
  content: string
  read: number
  created_at: string
}

export interface NotificationSummary {
  notifications_unread: number
  announcements_unread: number
  total_unread: number
}

export interface Announcement {
  id: number
  title: string
  content: string
  status: 'draft' | 'published'
  action_label: string | null
  action_url: string | null
  created_by: number
  created_at: string
  updated_at: string
  published_at: string | null
  is_read?: boolean
}

export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number }

export interface ChannelMsg {
  id: number
  channel_id: number
  user_id: number
  content: string
  created_at: string
  author: string
}


export interface RawLog {
  id: number
  idea_id: number
  kind: 'chat' | 'plan' | 'score'
  request_prompt: string
  raw_response: string
  parsed_ok: number
  created_at: string
}

export interface ScoreRecord extends ScoreIdentity {
  id: number
  score: number
  score_milli?:number|null
  score_display?:string
  precision_version?:string|null
  idea_revision?:number|null
  summary: string
  dimensions: { name: string; score: number; comment: string }[]
  created_at: string
  model?: string | null
  angle?: 'default' | 'strict' | 'encourage' | 'compliance' | null
  standard_version?: string | null
  validity?: 'legacy' | 'valid'
  analysis?: Record<string, unknown> | null
}

export interface IdeaOrderScore {
  id: number
  idea_id: number
  order_id: number
  score: number
  reasons: string
  order_title: string
  amount: number
  url: string
}
