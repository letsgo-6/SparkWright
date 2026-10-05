// SPDX-License-Identifier: MPL-2.0
import { lazy, Suspense, useEffect, useState } from 'react'
import { CommunityAuth } from './CommunityAuth'
import { community, ct } from './client'
import { useLanguage } from '../i18n'
const PersonalApp=lazy(()=>import('../App'))
export default function ClientEntry(){
  useLanguage()
  const [entered,setEntered]=useState(()=>sessionStorage.getItem('sparkwright.personal-entered')==='true')
  const enter=()=>{sessionStorage.setItem('sparkwright.personal-entered','true');setEntered(true)}
  useEffect(()=>{if(entered)return;const controller=new AbortController();void community.get('/api/community/auth/me',controller.signal).then(r=>{if(r.user&&!controller.signal.aborted)enter()}).catch(()=>{});return()=>controller.abort()},[entered])
  return entered?<Suspense fallback={<p className="welcome" role="status">{ct('正在打开个人工作区…','Opening your workspace…')}</p>}><PersonalApp/></Suspense>:<CommunityAuth onAuthed={enter} onOffline={enter}/>
}
