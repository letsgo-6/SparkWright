// SPDX-License-Identifier: MPL-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import { sampleSparkSurface } from '../src/lib/spark-particles'

test('Spark samples every head primitive by world triangle area and retains material colors', () => {
  const head = new Group(); head.position.set(10, 3, -4)
  for (const [size, color] of [[1, '#ff0000'], [2, '#0000ff']] as const) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, size, 0, 0, 0, size, 0], 3))
    head.add(new Mesh(geometry, new MeshBasicMaterial({ color })))
  }
  let seed = 123
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const sampled = sampleSparkSurface(head, new Vector3(10, 3, -4), 5000, random)
  const colors = sampled.getAttribute('color'), positions = sampled.getAttribute('position')
  let blue = 0
  for (let i = 0; i < colors.count; i++) {
    if (colors.getZ(i) === 1) blue++
    assert.ok(positions.getX(i) >= -.008 && positions.getX(i) <= 2.008)
    assert.ok(Math.abs(positions.getZ(i)) <= .008)
  }
  assert.ok(blue > 3800 && blue < 4200, `area share ${blue}/5000 should be close to 4/5`)
  assert.equal(colors.getX(0) + colors.getZ(0), 1)
  sampled.dispose()
  head.traverse((object) => { if (object instanceof Mesh) { object.geometry.dispose(); (object.material as MeshBasicMaterial).dispose() } })
})

test('Spark sampling rejects missing or degenerate head geometry', () => {
  assert.throws(() => sampleSparkSurface(new Group(), new Vector3(), 100), /spark_geometry_missing/)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3))
  assert.throws(() => sampleSparkSurface(new Mesh(geometry, new MeshBasicMaterial({ color: new Color('pink') })), new Vector3(), 100), /spark_geometry_missing/)
})
