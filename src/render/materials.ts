// Shared wall/flat material: textured, with a Doom-ish light model —
// sector light level attenuated by view distance (approximating the
// COLORMAP diminishing tables). Light arrives as a per-vertex attribute
// so one material serves quads from differently-lit sectors.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute float light;
  varying vec2 vUv;
  varying float vLight;
  varying float vDist;
  void main() {
    vUv = uv;
    vLight = light;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform float alphaTest;
  varying vec2 vUv;
  varying float vLight;
  varying float vDist;
  void main() {
    vec4 texel = texture2D(map, vUv);
    if (texel.a < alphaTest) discard;
    // Doom-ish diminishing: brighter sectors resist distance fade.
    float l = vLight / 255.0;
    float fade = clamp(vDist / 3072.0, 0.0, 1.0) * (1.0 - l * 0.75);
    float f = clamp(l * 1.05 - fade, 0.03, 1.0);
    gl_FragColor = vec4(texel.rgb * f, texel.a);
  }
`;

export function makeSurfaceMaterial(map: THREE.Texture, masked: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      alphaTest: { value: masked ? 0.5 : 0.0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
  });
}
