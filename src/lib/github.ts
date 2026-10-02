// SPDX-License-Identifier: MPL-2.0
import { githubRepositoryUrl } from '../../shared/links'

// Public repository URL only. Rebuild Vite after adding the actual repository.
export const GITHUB_REPOSITORY = githubRepositoryUrl(import.meta.env.VITE_GITHUB_URL)
