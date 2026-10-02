// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScoreComparison } from '../src/components/ScoreHistory'
import { comparableScores, dimensionChange, externalHttps } from '../src/lib/phase2'
import { ORDER_RESOURCES, API_RESOURCES } from '../src/data/resources'
import { SUPPORT } from '../src/config/support'
import { STANDARD_VERSION,PRECISION_VERSION } from '../shared/scoring-standard'
import type { ScoreRecord } from '../src/types'

const record = (partial: Partial<ScoreRecord> = {}): ScoreRecord => ({ id: 1, score: 60, summary: '测试', created_at: '2026-09-30T00:00:00Z',
  dimensions: [{ name: '新颖度', score: 60, comment: '有新增功能' }], validity: 'valid', standard_version: STANDARD_VERSION, angle: 'default',engine_hash:'fixture-engine',prompt_hash:'fixture-prompt',model_fingerprint:'fixture-model',schema_version:'fixture-schema',input_policy_version:'fixture-policy',comparison_group:'fixture-group',input_scope:'idea-text-v4',precision_version:PRECISION_VERSION, ...partial })

test('score comparison never turns a missing/legacy dimension into a zero-point drop', () => {
  const old = record({ validity: 'legacy', standard_version: null }), latest = record({ id: 2, dimensions: [{ name: '潜在价值', score: 80, comment: '有价值' }] })
  assert.equal(comparableScores(old, latest), false)
  assert.equal(dimensionChange(old, latest, '新颖度'), null)
  assert.equal(dimensionChange(record(), latest, '潜在价值'), null)
  const html = renderToStaticMarkup(createElement(ScoreComparison, { records: [old, latest] }))
  assert.ok(html.includes('不可比较')); assert.ok(html.includes('—'))
  assert.equal((html.match(/class="curve-line"/g) || []).length, 0)
  assert.equal(dimensionChange(record(), record({ dimensions: [{ name: '新颖度', score: 80, comment: '提升' }] }), '新颖度'), 20)
  assert.equal(comparableScores(record(), record({ angle: 'strict' })), false)
})

test('recommendation and support links require external HTTPS and the supplied support image is included', () => {
  for (const url of ['http://example.com', '//example.com', '/local', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/ a']) assert.equal(externalHttps(url), null)
  assert.equal(externalHttps('https://example.com/key'), 'https://example.com/key')
  assert.equal(ORDER_RESOURCES.length, 4); assert.equal(API_RESOURCES[0].items.length, 15)
  for (const group of [...ORDER_RESOURCES, ...API_RESOURCES]) for (const item of group.items) assert.ok(externalHttps(item.url))
  assert.ok(externalHttps(SUPPORT.url))
  assert.ok(SUPPORT.qrImage.startsWith('/support/'))
  assert.ok(existsSync(new URL(`../public${SUPPORT.qrImage}`, import.meta.url)))
})
