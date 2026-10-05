import { apiError } from '../api'
import { cloudEdition } from './client'
export async function communityDelete(path:string){const response=await fetch(cloudEdition?path:`/api/community/remote${path}`,{method:'DELETE',credentials:'same-origin'});if(!response.ok){const body=await response.json();throw apiError(body.error?.code)}return response.json()}
