// SPDX-License-Identifier: MPL-2.0
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { EN } from '../src/i18n/en'
import { getLanguage, setLanguage, tr, uiText, uiParam, locale, validLanguage } from '../src/i18n/index'
import { dimensionLabel } from '../src/lib/phase2'
import { api, apiError, responseError } from '../src/api'
import { deadlineInfo, fmtDate } from '../src/utils'
import { ResourcesPage } from '../src/pages/ResourcesPages'
import { AuthPage } from '../src/pages/AuthPage'
import { ERROR_MESSAGES } from '../shared/error-messages'

afterEach(() => setLanguage('zh-CN'))
test('i18n language store translates system tokens and leaves user/model parameters unchanged', () => {
  setLanguage('en'); assert.equal(getLanguage(), 'en'); assert.equal(locale(), 'en-US')
  assert.equal(validLanguage('en'), true); assert.equal(validLanguage('fr'), false)
  assert.equal(tr('保存'), 'Save'); assert.equal(tr(undefined), '')
  const message = uiText('error.invalid_credentials')
  assert.equal(tr(message), 'Incorrect email or password.')
  assert.equal(tr('{0}（请 {1} 秒后重试）', [uiParam(message), 60]), 'Incorrect email or password. (Try again in 60 seconds.)')
  const data = '用户原文：保存 <script>alert(1)</script> AI原文'
  assert.equal(tr('作品「{0}」已归档', [data]).includes(data), true)
  assert.equal(tr('作品「{0}」已归档', [uiText('保存')]).includes(uiText('保存')), true)
  assert.equal(tr('__proto__'), '__proto__'); assert.equal(tr('constructor'), 'constructor')
  assert.equal(dimensionLabel('新颖度'), 'Novelty'); assert.equal(dimensionLabel(uiText('保存')), uiText('保存'))
  setLanguage('zh-CN'); assert.equal(tr(message), '邮箱或密码不正确')
})
test('i18n dictionaries preserve every placeholder and cover referenced interface literals', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort()
  for (const [key, value] of Object.entries(EN)) assert.deepEqual(placeholders(value), placeholders(key), key)
  const root = path.resolve(import.meta.dirname, '../src'), missing = new Set<string>()
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'i18n') scan(file); continue }
      if (!/\.tsx?$/.test(file)) continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ['tr', 'uiText'].includes(node.expression.getText(source))) {
          const key = node.arguments[0]
          if (key && ts.isStringLiteral(key) && /[\u4e00-\u9fff]/.test(key.text) && !Object.hasOwn(EN, key.text.trim())) missing.add(key.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  scan(root); assert.deepEqual([...missing], [])
})
test('i18n errors use codes only, unknown codes ignore secrets, and network failures are safe', async () => {
  setLanguage('en')
  const secret = 'SMTP-password sql/private.db Bearer secret-token'
  const response = Response.json({ error: { code: 'unknown_upstream_code', message: secret } }, { status: 502 })
  const error = await responseError(response, '/api/ideas/1/ai/score')
  assert.equal(error.code, 'request_failed'); assert.equal(error.status, 502)
  assert.equal(tr(error.message), 'Operation failed. Please try again.')
  assert.ok(!tr(error.message).includes(secret))
  for (const code of ['unauthorized', 'forbidden', 'plaza_muted', 'public_idea_not_found', 'conflict', 'invalid_ai_score', 'mail_unavailable']) {
    assert.equal(tr(apiError(code).message), ERROR_MESSAGES[code][1])
  }
  assert.equal(apiError('__proto__').code, 'request_failed')
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => { throw new Error(secret) }) as typeof fetch
    await assert.rejects(api.get('/api/settings'), (err: any) => err.code === 'network_error' && !err.message.includes(secret))
  } finally { globalThis.fetch = original }
})
test('i18n dates follow interface locale while Chinese prompt deadline stays Chinese', () => {
  const date = new Date(2026, 8, 29, 12)
  setLanguage('en'); assert.equal(deadlineInfo('2026-09-30', date)?.label, '1 day remaining')
  assert.equal(tr('{0} 分钟前', [1]), '1 minute ago'); assert.equal(tr('{0} 分钟前', [2]), '2 minutes ago')
  assert.equal(deadlineInfo('2026-09-30', date, 'zh-CN')?.label, '还有 1 天')
  assert.equal(fmtDate('2026-09-30'), 'Sep 30')
})
test('i18n rendered auth and resources translate UI but preserve original platform names and safe links', () => {
  setLanguage('en')
  const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, {}, element))
  const auth = render(createElement(AuthPage, { onAuthed: () => {} }))
  assert.ok(auth.includes('Email')); assert.ok(auth.includes('Password')); assert.ok(!auth.includes('登录'))
  const resources = render(createElement(ResourcesPage, { kind: 'orders' }))
  assert.ok(resources.includes('程序员客栈')); assert.ok(resources.includes('noopener noreferrer'))
  assert.ok(!resources.includes('有开发经验，希望接企业项目'))
})
