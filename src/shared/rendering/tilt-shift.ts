import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import type { ViewSettings } from './settings'

/** Filters a freshly presented canvas, never a previously filtered frame. */
export class TiltShift {
  private source?: THREE.FramebufferTexture
  private readonly scratch = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    uniforms: {
      image: { value: null }, axis: { value: new THREE.Vector2() },
      focus: { value: 0.5 }, halfWidth: { value: 0.15 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D image;
      uniform vec2 axis;
      uniform float focus;
      uniform float halfWidth;
      varying vec2 vUv;
      void main() {
        float outsideBand = max(0.0, abs(vUv.y - focus) - halfWidth);
        vec2 stepSize = axis * smoothstep(0.0, 0.25, outsideBand);
        vec4 color = vec4(0.0);
        float total = 0.0;
        for (int i = -4; i <= 4; i++) {
          float weight = exp(-float(i * i) / 8.0);
          color += texture2D(image, vUv + float(i) * stepSize) * weight;
          total += weight;
        }
        gl_FragColor = color / total;
      }
    `,
  })
  private readonly quad = new FullScreenQuad(this.material)

  render(renderer: THREE.WebGLRenderer, settings: ViewSettings) {
    const { width, height } = renderer.domElement
    if (!this.source || this.source.image.width !== width || this.source.image.height !== height) {
      this.source?.dispose()
      this.source = new THREE.FramebufferTexture(width, height)
      this.source.minFilter = this.source.magFilter = THREE.LinearFilter
      this.scratch.setSize(width, height)
    }
    const target = renderer.getRenderTarget()
    const viewport = renderer.getViewport(new THREE.Vector4())
    const scissor = renderer.getScissor(new THREE.Vector4())
    const scissorTest = renderer.getScissorTest(), autoClear = renderer.autoClear
    const uniforms = this.material.uniforms
    try {
      renderer.autoClear = false
      renderer.setRenderTarget(null)
      renderer.setScissorTest(false)
      // ponytail: display-referred blur preserves both renderers' output; use a shared HDR output stage for optical effects.
      renderer.copyFramebufferToTexture(this.source)
      uniforms.focus.value = 1 - settings.tiltShiftFocus
      uniforms.halfWidth.value = settings.tiltShiftWidth / 2
      const step = 0.003 * settings.tiltShiftStrength
      uniforms.image.value = this.source
      uniforms.axis.value.set(step * height / width, 0)
      renderer.setRenderTarget(this.scratch)
      this.quad.render(renderer)
      uniforms.image.value = this.scratch.texture
      uniforms.axis.value.set(0, step)
      renderer.setRenderTarget(null)
      const ratio = renderer.getPixelRatio()
      renderer.setViewport(0, 0, width / ratio, height / ratio)
      this.quad.render(renderer)
    } finally {
      renderer.setRenderTarget(target)
      renderer.setViewport(viewport)
      renderer.setScissor(scissor)
      renderer.setScissorTest(scissorTest)
      renderer.autoClear = autoClear
    }
  }

  dispose() {
    this.source?.dispose()
    this.source = undefined
    this.scratch.dispose()
    this.material.dispose()
    this.quad.dispose()
  }
}
