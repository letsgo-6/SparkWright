// SPDX-License-Identifier: MPL-2.0
import { apiError } from '../api'
import { getLanguage } from '../i18n'
export const cloudEdition = import.meta.env.VITE_COMMUNITY_EDITION === 'true'
export const ct = (zh: string, en: string) => getLanguage() === 'en' ? en : zh
async function send(method: string, path: string, body?: unknown, signal?: AbortSignal, directLocal=false) {
  let response: Response
  try { response=await fetch(directLocal||cloudEdition?path:`/api/community/remote${path}`,{method,signal,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}) }
  catch(e) { if(signal?.aborted)throw e;throw apiError('community_unavailable') }
  const result=await response.json().catch(()=>null)
  if(!response.ok){if(response.status===401)window.dispatchEvent(new Event('sparkwright:community-expired'));throw apiError(result?.error?.code)}
  return result
}
export const community = {get:(p:string,signal?:AbortSignal)=>send('GET',p,undefined,signal),post:(p:string,b?:unknown)=>send('POST',p,b),put:(p:string,b:unknown)=>send('PUT',p,b),patch:(p:string,b:unknown)=>send('PATCH',p,b),localPost:(p:string,b:unknown)=>send('POST',p,b,undefined,true)}
export const socketUrl=()=>`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/community/ws`
export type CommunityUser={id:number;name:string;role:'user'|'admin'|'owner';created_at:string}
