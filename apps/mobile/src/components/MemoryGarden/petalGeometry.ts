import type { GardenMemorySummaryDto } from '../../types';

export type PetalBox = { x: number; y: number; width: number; height: number };
export interface GardenFrame {
  items: GardenMemorySummaryDto[];
  selectedKey: string | null;
  relatedKeys: Set<string>;
  isNight: boolean;
}
export interface PetalRenderer { update(frame: GardenFrame): void; dispose(): void }

export function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// The accepted preview's Three.js renderer; only local static assets are loaded.
export async function createPetalRenderer(
  canvas: HTMLCanvasElement,
  targets: HTMLDivElement,
  initial: GardenFrame,
  onSelect: (item: GardenMemorySummaryDto, box: PetalBox) => void,
  signal?: AbortSignal,
): Promise<PetalRenderer> {
  const moduleUrl = '/assets/rose-three-r160.js';
  const THREE = await import(/* @vite-ignore */ moduleUrl);
  signal?.throwIfAborted();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-215, 215, 466, -466, 1, 2000);
  camera.position.z = 1000;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(0, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  scene.add(new THREE.AmbientLight(0xfff7ee, 2.6));
  const light = new THREE.DirectionalLight(0xfff5d9, 2);
  light.position.set(-120, 280, 500); scene.add(light);
  let texture: any;
  try { texture = await new THREE.TextureLoader().loadAsync('/assets/luma-rose-petal-v1.png'); }
  catch (error) { renderer.dispose(); renderer.forceContextLoss(); throw error; }
  if (signal?.aborted) { texture.dispose(); renderer.dispose(); renderer.forceContextLoss(); signal.throwIfAborted(); }
  texture.colorSpace = THREE.SRGBColorSpace;
  const geometry = new THREE.PlaneGeometry(1.07, 1, 10, 10);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i);
    positions.setZ(i, .24 * x * x + .12 * y * y + .025 * Math.sin(y * 6 + x * 3));
  }
  geometry.computeVertexNormals();
  const palette = [0xffeee5, 0xf7d5dc, 0xe6d4ec, 0xffe0bd, 0xf0c1d0, 0xf5efdd];
  let frame = initial, itemsIdentity: GardenMemorySummaryDto[] | null = null;
  let petals: { mesh: any; button: HTMLButtonElement; item?: GardenMemorySummaryDto; size: number; bx: number; by: number; phase: number; speed: number; sway: number; spin: number }[] = [];
  let width = 430, height = 932, time = 0, previous = 0, raf = 0, disposed = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function rebuild() {
    petals.forEach(p => { scene.remove(p.mesh); p.mesh.material.dispose(); p.button.remove(); });
    petals = [];
    for (let i = 0; i < 84; i++) {
      const item = frame.items.length ? frame.items[i % frame.items.length] : undefined;
      let seed = hashString(`${item?.key || 'wind'}:${i}`) % 2147483646 + 1;
      const random = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; };
      const material = new THREE.MeshStandardMaterial({ map: texture, color: palette[i % 6], transparent: true, alphaTest: .055, depthWrite: false, side: THREE.DoubleSide, roughness: .95, metalness: 0, opacity: i % 5 === 0 ? .9 : .76, emissive: 0x3a1812, emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(geometry, material), size = i % 5 === 0 ? 30 + random() * 16 : 14 + random() * 18;
      mesh.scale.set(size, size, size); mesh.position.z = 30 + random() * 80; scene.add(mesh);
      const button = document.createElement('button'); button.className = 'rose-petal-target';
      if (item) {
        button.setAttribute('aria-label', `拾起记忆：${item.title || '未命名记忆'}`);
        button.dataset.memoryKey = item.key;
        button.onclick = () => {
          const rect = button.getBoundingClientRect();
          onSelect(item, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        };
      } else { button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
      targets.append(button);
      petals.push({ mesh, button, item, size, bx: random(), by: random(), phase: random() * Math.PI * 2, speed: 6 + random() * 7, sway: 14 + random() * 20, spin: (random() - .5) * .15 });
    }
    itemsIdentity = frame.items;
  }
  function draw(dt: number) {
    if (!reduced.matches) time += dt * (frame.selectedKey ? .28 : 1);
    for (const p of petals) {
      const y = (p.by * (height + 100) + time * p.speed) % (height + 100) - 50;
      const x = (p.bx * width + Math.sin(time * .21 + p.phase) * p.sway + time * 2.4 + width + 50) % (width + 100) - 50;
      p.mesh.position.x = x - width / 2; p.mesh.position.y = height / 2 - y;
      p.mesh.rotation.set(Math.sin(time * .31 + p.phase) * .42, Math.sin(time * .24 + p.phase) * .95, p.phase + time * p.spin);
      const selected = !!p.item && frame.selectedKey === p.item.key;
      const related = !!p.item && frame.relatedKeys.has(p.item.key) && !selected;
      p.mesh.visible = !selected;
      p.mesh.material.emissiveIntensity = related ? .6 + .16 * Math.sin(time * 2 + p.phase) : 0;
      p.button.style.transform = `translate3d(${(x - 24).toFixed(2)}px,${(y - 24).toFixed(2)}px,0)`;
      p.button.style.visibility = selected ? 'hidden' : 'visible';
      p.button.classList.toggle('rose-related', related);
    }
    renderer.render(scene, camera);
  }
  function resize() {
    width = canvas.clientWidth; height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.left = -width / 2; camera.right = width / 2; camera.top = height / 2; camera.bottom = -height / 2;
    camera.updateProjectionMatrix(); draw(0);
  }
  function animate(now: number) {
    if (disposed) return;
    const dt = previous ? Math.min((now - previous) / 1000, .05) : 0; previous = now;
    draw(dt); raf = requestAnimationFrame(animate);
  }
  function visibility() {
    cancelAnimationFrame(raf); previous = 0;
    if (!document.hidden && !disposed) raf = requestAnimationFrame(animate);
  }
  const observer = new ResizeObserver(resize);
  rebuild(); resize(); observer.observe(canvas); document.addEventListener('visibilitychange', visibility); visibility();
  return {
    update(next) { frame = next; targets.inert = !!next.selectedKey; if (itemsIdentity !== next.items) rebuild(); draw(0); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); observer.disconnect(); document.removeEventListener('visibilitychange', visibility);
      petals.forEach(p => { p.mesh.material.dispose(); p.button.remove(); });
      geometry.dispose(); texture.dispose(); renderer.dispose(); renderer.forceContextLoss();
    },
  };
}
