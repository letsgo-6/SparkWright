// SPDX-License-Identifier: MPL-2.0
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { sampleSparkSurfaceAsync } from './spark-particles'

export type SparkPhase = 'meditating' | 'entering' | 'brainstorming' | 'exiting'
export type SparkSceneHandle = { update: (phase: SparkPhase, reduced: boolean) => void; dispose: () => void }

const vertexShader = `
  attribute float seed;
  uniform float angle, energy, clock, pixelRatio, size, moving;
  varying vec3 tint;
  varying float opacity;
  void main() {
    vec3 p = position;
    float spread = smoothstep(0.72, 1.0, seed) * energy * moving;
    float rotation = angle * moving + spread * 1.8;
    float c = cos(rotation), s = sin(rotation);
    p.xz = mat2(c, -s, s, c) * p.xz;
    p.xz *= 1.0 + spread * 2.2;
    p.y += spread * (0.08 + seed * 0.15);
    p += moving * 0.004 * sin(vec3(seed * 73.0) + clock * 1.4);
    vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(size * pixelRatio * (8.0 / -viewPosition.z) * (0.65 + seed), 1.0, 5.0 * pixelRatio);
    tint = mix(color, vec3(0.58, 0.66, 1.0), energy * 0.16);
    opacity = 0.3 + seed * 0.35;
  }`
const fragmentShader = `
  varying vec3 tint;
  varying float opacity;
  void main() {
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;
    gl_FragColor = vec4(tint, opacity * pow(1.0 - radius, 1.8));
    #include <colorspace_fragment>
  }`

export async function createSparkScene(host: HTMLDivElement, signal: AbortSignal, initial: SparkPhase, reducedMotion: boolean, saveData: boolean, failed: () => void): Promise<SparkSceneHandle> {
  delete host.dataset.renderFps
  let disposed = false, shaderFailed = false, frame = 0, reduced = reducedMotion, energy = initial === 'brainstorming' ? 1 : 0
  let time = 0, angle = 0, last = 0
  let rampStart = performance.now(), rampFrom = energy, rampTarget = energy
  const mobile = matchMedia('(max-width: 640px)').matches || saveData
  const scene = new THREE.Scene()
  const assets: THREE.Object3D[] = []
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !mobile, powerPreference: mobile ? 'low-power' : 'default' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1 : 1.25))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.domElement.setAttribute('aria-hidden', 'true')
  host.append(renderer.domElement)
  const camera = new THREE.PerspectiveCamera(mobile ? 30 : 34, 1, .1, 60)
  camera.position.set(0, 4.2, -12)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, .1, 0)
  controls.enablePan = false; controls.enableZoom = false
  controls.minAzimuthAngle = Math.PI - .28; controls.maxAzimuthAngle = Math.PI + .28
  controls.minPolarAngle = 1.13; controls.maxPolarAngle = 1.27
  controls.rotateSpeed = .35; controls.enabled = !reduced
  controls.update()
  scene.add(new THREE.HemisphereLight('#8898ff', '#101424', .65))
  const key = new THREE.DirectionalLight('#b0bdff', .9); key.position.set(2, 5, -4); scene.add(key)
  const rim = new THREE.DirectionalLight('#ad74e8', .6); rim.position.set(-3, 2, 4); scene.add(rim)
  const materials = new Set<THREE.Material>()
  let headMaterial: THREE.ShaderMaterial | undefined
  const particleLayers: THREE.Points[] = []
  let slowFrames = 0, measuredFrames = 0, measuredTime = 0, qualityReduced = false
  let renderedFrames=0, renderedSince=0
  const rockStates: { object: THREE.Object3D; position: THREE.Vector3; rotation: THREE.Quaternion; axis: THREE.Vector3; angle: number; speed: number }[] = []
  const orbitCenter = new THREE.Vector3()
  const headCenter = new THREE.Vector3()
  let observer: ResizeObserver | undefined
  const draw = () => {
    if (disposed || document.hidden) return
    camera.updateMatrixWorld()
    // Preserve the hero silhouette while rocks cross the foreground, without resetting their orbit.
    const hero = headCenter.clone().project(camera)
    const edge = headCenter.clone().add(new THREE.Vector3(.62, .48, 0)).project(camera)
    const heroWidth = Math.abs(edge.x - hero.x), heroHeight = Math.abs(edge.y - hero.y)
    for (const rock of rockStates) {
      const projected = rock.object.position.clone().project(camera)
      const proximity = Math.max(Math.abs(projected.x - hero.x) / (heroWidth + .08), Math.abs(projected.y - hero.y) / (heroHeight + .08))
      const opacity = .14 + .86 * THREE.MathUtils.smoothstep(proximity, .8, 1.2)
      rock.object.traverse((object) => { if (object instanceof THREE.Mesh) (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => { material.opacity = opacity }) })
    }
    renderer.render(scene, camera)
  }
  const resize = () => {
    if (disposed) return
    const width = host.clientWidth, height = host.clientHeight
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.fov = window.innerWidth <= 640 ? 30 : 34
    camera.updateProjectionMatrix()
    draw()
  }
  const onContextLost = (event: Event) => { event.preventDefault(); if (!disposed) failed() }
  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    controls.removeEventListener('change', draw); controls.dispose()
    const geometries = new Set<THREE.BufferGeometry>(), textures = new Set<THREE.Texture>()
    const collect = (object: THREE.Object3D) => {
      const renderable = object as THREE.Mesh
      if (renderable.geometry) geometries.add(renderable.geometry)
      if (renderable.material) (Array.isArray(renderable.material) ? renderable.material : [renderable.material]).forEach((material) => materials.add(material))
    }
    scene.traverse(collect); assets.forEach((asset) => asset.traverse(collect))
    materials.forEach((material) => {
      Object.values(material).forEach((value) => { if (value instanceof THREE.Texture) textures.add(value) })
      material.dispose()
    })
    geometries.forEach((geometry) => geometry.dispose()); textures.forEach((texture) => texture.dispose())
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
  }
  const animate = (now: number) => {
    if (disposed || document.hidden || reduced) return
    frame = requestAnimationFrame(animate)
    if (last && now - last < (mobile ? 30 : 15)) return
    if (last && !qualityReduced) {
      measuredTime += now - last; measuredFrames++
      if (measuredFrames >= 40) {
        if (measuredTime / measuredFrames > (mobile ? 65 : 55)) slowFrames++
        else slowFrames = 0
        measuredFrames = 0; measuredTime = 0
        if (slowFrames >= 1) {
          qualityReduced = true
          renderer.setPixelRatio(Math.min(devicePixelRatio, 1))
          particleLayers.forEach((points) => {
            points.geometry.setDrawRange(0, Math.floor(points.geometry.getAttribute('position').count * .6))
            if (points.material instanceof THREE.ShaderMaterial) points.material.uniforms.pixelRatio.value = renderer.getPixelRatio()
          })
          resize()
        }
      }
    }
    const dt = last ? Math.min((now - last) / 1000, .05) : 0
    last = now; time += dt
    energy = THREE.MathUtils.lerp(rampFrom, rampTarget, Math.min(1, (now - rampStart) / 800))
    angle += dt * (.12 + energy * 2.6)
    if (headMaterial) { headMaterial.uniforms.angle.value = angle; headMaterial.uniforms.energy.value = energy; headMaterial.uniforms.clock.value = time }
    for (let i = 0; i < rockStates.length; i++) {
      const rock = rockStates[i]
      rock.angle += dt * rock.speed * (.055 + energy * .75)
      rock.object.position.copy(rock.position).sub(orbitCenter).applyAxisAngle(THREE.Object3D.DEFAULT_UP, rock.angle).add(orbitCenter)
      rock.object.position.y += Math.sin(time * .7 + i) * .035
      rock.object.quaternion.copy(rock.rotation).multiply(new THREE.Quaternion().setFromAxisAngle(rock.axis, rock.angle * .65))
    }
    draw()
    if(!renderedSince)renderedSince=now
    if(++renderedFrames>=60){host.dataset.renderFps=(60000/(now-renderedSince)).toFixed(1);renderedFrames=0;renderedSince=now}
  }
  function visibility() {
    cancelAnimationFrame(frame); last = 0
    if (!document.hidden && !disposed) { if (reduced) draw(); else frame = requestAnimationFrame(animate) }
  }
  signal.addEventListener('abort', dispose, { once: true })
  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  renderer.debug.onShaderError = () => { shaderFailed = true; if (!disposed) failed() }
  try {
    const loader = new GLTFLoader()
    const load = async (name: string) => {
      const response = await fetch(`/spark/${name}.glb`, { signal })
      if (!response.ok) throw new Error('spark_asset_unavailable')
      const gltf = await loader.parseAsync(await response.arrayBuffer(), '/spark/')
      // Parsing can complete after navigation; dispose the late result too.
      if (disposed || signal.aborted) {
        gltf.scene.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => material.dispose()) })
        throw new DOMException('Cancelled', 'AbortError')
      }
      assets.push(gltf.scene)
      gltf.scene.traverse((object) => { const mesh = object as THREE.Mesh; if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => materials.add(material)) })
      scene.add(gltf.scene); gltf.scene.updateWorldMatrix(true, true)
      return gltf.scene
    }
    const [spark, island] = await Promise.all([load('spark'), load('island')])
    const node = (root: THREE.Object3D, name: string) => { const object = root.getObjectByName(name); if (!object) throw new Error('spark_node_missing'); return object }
    node(spark, 'SPARK_root'); node(spark, 'SPARK_tail_anchor'); node(spark, 'SPARK_glow_anchor')
    const center = node(spark, 'SPARK_head_center').getWorldPosition(new THREE.Vector3())
    headCenter.copy(center)
    const makePoints = async (source: THREE.Object3D, origin: THREE.Vector3, count: number, moving: number, size: number) => {
      const geometry = await sampleSparkSurfaceAsync(source, origin, count, signal)
      if(signal.aborted){geometry.dispose();throw new DOMException('Cancelled','AbortError')}
      const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        uniforms: { angle: { value: 0 }, energy: { value: energy }, clock: { value: 0 }, pixelRatio: { value: renderer.getPixelRatio() }, size: { value: size }, moving: { value: moving } } })
      const points = new THREE.Points(geometry, material)
      particleLayers.push(points)
      points.position.copy(origin); points.frustumCulled = false; scene.add(points)
      source.traverse((object) => { if (object instanceof THREE.Mesh) object.visible = false })
      return material
    }
    headMaterial = await makePoints(node(spark, 'SPARK_head'), center, mobile ? 6000 : 12000, reduced ? 0 : 1, 1.65)
    await makePoints(node(spark, 'SPARK_body'), node(spark, 'SPARK_body').getWorldPosition(new THREE.Vector3()), mobile ? 1200 : 3000, 0, 1.3)
    const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 64
    const glowContext = glowCanvas.getContext('2d')!
    const gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32)
    gradient.addColorStop(0, '#dcf4ff'); gradient.addColorStop(.2, '#8ac8ff88'); gradient.addColorStop(1, '#80b0ff00')
    glowContext.fillStyle = gradient; glowContext.fillRect(0, 0, 64, 64)
    const glowTexture = new THREE.CanvasTexture(glowCanvas)
    for (const name of ['SPARK_eye_L', 'SPARK_eye_R']) {
      const bounds = new THREE.Box3().setFromObject(node(spark, name))
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .65 }))
      glow.position.copy(bounds.getCenter(new THREE.Vector3())); glow.position.z -= .025; glow.scale.set(.16, .13, 1); scene.add(glow)
      node(spark, name).traverse((object) => { if (object instanceof THREE.Mesh) object.material = new THREE.MeshBasicMaterial({ color: '#e5f7ff' }) })
    }
    const ringOrigin = node(spark, 'SPARK_ring_anchor').getWorldPosition(new THREE.Vector3())
    const ringPositions = [], ringColors = []
    for (let i = 0; i < (mobile ? 500 : 1200); i++) {
      const theta = Math.random() * Math.PI * 2, radius = .42 + Math.random() * .32
      ringPositions.push(Math.cos(theta) * radius, ringOrigin.y + Math.random() * .018, Math.sin(theta) * radius)
      const color = new THREE.Color(i % 3 ? '#7088d9' : '#eaaaCE'); ringColors.push(color.r, color.g, color.b)
    }
    const ring = new THREE.BufferGeometry(); ring.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3)); ring.setAttribute('color', new THREE.Float32BufferAttribute(ringColors, 3))
    scene.add(new THREE.Points(ring, new THREE.PointsMaterial({ size: .018, vertexColors: true, transparent: true, opacity: .6, depthWrite: false, blending: THREE.AdditiveBlending })))
    node(island, 'ROCK_orbit_center').getWorldPosition(orbitCenter)
    for (let i = 1; i <= 22; i++) {
      const object = node(island, `ROCK_float_${String(i).padStart(2, '0')}`)
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        const soften = (material: THREE.Material) => { const copy = material.clone(); copy.transparent = true; copy.depthWrite = false; copy.forceSinglePass = true; return copy }
        child.material = Array.isArray(child.material) ? child.material.map(soften) : soften(child.material)
      })
      scene.attach(object)
      rockStates.push({ object, position: object.position.clone(), rotation: object.quaternion.clone(), axis: new THREE.Vector3(.3 + i % 3, 1, .4).normalize(), angle: 0, speed: .75 + (i % 7) / 10 })
    }
    const starPositions = [], starColors = []
    for (let i = 0; i < (mobile ? 450 : 1000); i++) {
      starPositions.push((Math.random() - .5) * 38, (Math.random() - .3) * 22, 8 + Math.random() * 12)
      const color = new THREE.Color(i % 5 ? '#626eaa' : '#b49be1'); starColors.push(color.r, color.g, color.b)
    }
    const stars = new THREE.BufferGeometry(); stars.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3)); stars.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3))
    scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ size: .035, vertexColors: true, transparent: true, opacity: .75, depthWrite: false })))
    observer = new ResizeObserver(resize); observer.observe(host)
    controls.addEventListener('change', draw)
    document.addEventListener('visibilitychange', visibility)
    resize()
    if (shaderFailed) throw new Error('spark_shader_unavailable')
    if (!reduced && !document.hidden) frame = requestAnimationFrame(animate)
    return {
      update(next, nextReduced) {
        reduced = nextReduced; controls.enabled = !reduced
        const nextEnergy = next === 'entering' || next === 'brainstorming' ? 1 : 0
        if (nextEnergy !== rampTarget) { rampFrom = energy; rampTarget = nextEnergy; rampStart = performance.now() }
        if (headMaterial) { headMaterial.uniforms.moving.value = reduced ? 0 : 1; if (reduced) { energy = nextEnergy; rampFrom = rampTarget = energy; headMaterial.uniforms.energy.value = energy } }
        visibility()
      },
      dispose() { signal.removeEventListener('abort', dispose); dispose() },
    }
  } catch (error) { dispose(); throw error }
}
