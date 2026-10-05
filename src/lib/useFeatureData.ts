// SPDX-License-Identifier: MPL-2.0
import {useEffect,useState} from 'react'
import {api} from '../api'

// Shared by the three new feature surfaces; each request belongs to its mounted page.
export function useFeatureData<T>(url:string, poll=0, get=api.get) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[version,setVersion]=useState(0)
  useEffect(()=>{
    let active=true,request:AbortController|null=null
    const load=async()=>{
      if(document.hidden||request) return
      const current=new AbortController();request=current;setLoading(true)
      try {const value=await get(url,current.signal);if(active&&!current.signal.aborted){setData(value);setError('')}}
      catch(e){if(active&&!current.signal.aborted){setData(null);setError(e instanceof Error?e.message:'操作失败')}}
      finally{if(active&&request===current){request=null;setLoading(false)}}
    }
    setData(null);setError('');void load()
    const visible=()=>{if(document.hidden){request?.abort();request=null;setLoading(false)}else void load()}
    document.addEventListener('visibilitychange',visible)
    const timer=poll?window.setInterval(()=>void load(),poll):null
    return()=>{active=false;request?.abort();if(timer)clearInterval(timer);document.removeEventListener('visibilitychange',visible)}
  },[url,poll,version,get])
  return {data,error,loading,reload:()=>setVersion(v=>v+1)}
}
