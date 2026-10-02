// SPDX-License-Identifier: MPL-2.0
import { Agent } from 'undici'

export const DURATION_POLICY='no-deadline-v1'
// Dedicated dispatcher: keep other HTTP features and the global fetch policy unchanged.
const dispatcher=new Agent({headersTimeout:0,bodyTimeout:0,connect:{timeout:0}})
export function scoringFetch(url:string,init:RequestInit={}):Promise<Response> {
  return fetch(url,{...init,dispatcher} as RequestInit)
}
