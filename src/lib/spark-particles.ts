// SPDX-License-Identifier: MPL-2.0
import { BufferAttribute, BufferGeometry, Color, Mesh, Object3D, Vector3 } from 'three'

// Sample all primitives in one coordinate frame, weighted by transformed triangle area.
export function sampleSparkSurface(source: Object3D, center: Vector3, count: number, random = Math.random) {
  source.updateWorldMatrix(true, true)
  const triangles: { a: Vector3; b: Vector3; c: Vector3; color: Color; end: number }[] = []
  let area = 0
  source.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const geometry = object.geometry as BufferGeometry
    const position = geometry.getAttribute('position'), index = geometry.index
    const length = index?.count ?? position.count
    for (let i = 0; i < length; i += 3) {
      const vertex = (offset: number) => new Vector3().fromBufferAttribute(position, index ? index.getX(offset) : offset).applyMatrix4(object.matrixWorld).sub(center)
      const a = vertex(i), b = vertex(i + 1), c = vertex(i + 2)
      const size = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2
      if (!size) continue
      const slot = geometry.groups.find((group) => i >= group.start && i < group.start + group.count)?.materialIndex ?? 0
      const material = Array.isArray(object.material) ? object.material[slot] : object.material
      area += size
      triangles.push({ a, b, c, color: (material as { color?: Color }).color?.clone() ?? new Color('#8ca5ff'), end: area })
    }
  })
  if (!triangles.length) throw new Error('spark_geometry_missing')
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), seeds = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const target = random() * area
    let low = 0, high = triangles.length - 1
    while (low < high) { const middle = (low + high) >>> 1; if (triangles[middle].end < target) low = middle + 1; else high = middle }
    const triangle = triangles[low], u = Math.sqrt(random()), v = random()
    const point = triangle.a.clone().multiplyScalar(1 - u).addScaledVector(triangle.b, u * (1 - v)).addScaledVector(triangle.c, u * v)
    point.multiplyScalar(.91 + random() * .09)
    point.add(new Vector3(random() - .5, random() - .5, random() - .5).multiplyScalar(.016))
    point.toArray(positions, i * 3)
    triangle.color.toArray(colors, i * 3)
    seeds[i] = random()
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setAttribute('seed', new BufferAttribute(seeds, 1))
  return geometry
}
