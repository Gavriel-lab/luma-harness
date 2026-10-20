/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';

interface WebGLWaterRippleProps {
  imageUrl?: string | null;
  className?: string;
  onTapWater?: (x: number, y: number) => void;
}

export const WebGLWaterRipple: React.FC<WebGLWaterRippleProps> = ({
  imageUrl,
  className = '',
  onTapWater
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // 获取 WebGL 上下文
    const gl =
      canvas.getContext('webgl', {
        antialias: true,
        alpha: false,
        depth: false,
        preserveDrawingBuffer: false
      }) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    if (!gl) {
      console.warn('WebGL is not supported in this environment');
      return;
    }

    // 顶点着色器 (满屏四边形)
    const vsSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        // 翻转 Y 轴匹配纹理坐标
        v_uv.y = 1.0 - v_uv.y;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // 片元着色器：真实的径向水波折射 (Radial Displacement / Refraction) + 柔和高光
    const fsSource = `
      precision highp float;
      varying vec2 v_uv;

      uniform sampler2D u_texture;
      uniform vec2 u_center;        // 雨滴中心 (UV 坐标 0~1)
      uniform float u_progress;      // 0.0 ~ 1.0
      uniform float u_aspect;        // 屏幕宽高比 width / height
      uniform vec2 u_textureScale;   // 按原图比例居中铺满，避免拉伸
      uniform float u_maxRadius;     // 最大扩散半径 (按宽度归一化比例: ~0.42)
      uniform float u_strength;      // 折射位移强度 (轻柔液态: ~0.009)
      uniform float u_active;        // 是否在涟漪活动周期内 (0 或 1)

      void main() {
        vec2 uv = v_uv;

        if (u_active > 0.5) {
          // 纵横比校正，使得水波呈完美自然的透视轻椭圆水圈
          vec2 diff = uv - u_center;
          vec2 correctedDiff = vec2(diff.x, diff.y / 0.88);
          correctedDiff.x *= u_aspect;

          float dist = length(correctedDiff);

          // 当前主波前沿半径 (最大限制在画面宽度的 10% 左右)
          float currentRadius = u_progress * u_maxRadius;
          float d = dist - currentRadius;

          // 2～3 圈微型同心波纹 (频率 135.0，包络 0.015，完美适应 10% 微澜半径)
          float frequency = 135.0;
          float envelopeWidth = 0.015;
          float envelope = exp(-pow(d / envelopeWidth, 2.0));

          // 落点初期的微小液态凹陷 (Drop Depression)
          float centerDepression = exp(-pow(dist / 0.011, 2.0)) * smoothstep(0.28, 0.0, u_progress) * -0.36;

          // 周期时间振幅衰减 (开始轻快，末期柔和淡出至完全静止)
          float life = u_progress;
          float fadeIn = smoothstep(0.0, 0.08, life);
          float fadeOut = smoothstep(1.0, 0.55, life);
          float decay = fadeIn * fadeOut;

          // 最终波高与法线斜率
          float waveHeight = (sin(d * frequency) * envelope + centerDepression) * decay;

          // 计算水面微折射偏折向量 (Refraction Displacement)
          vec2 dir = normalize(correctedDiff + vec2(0.0001, 0.0001));
          vec2 offset = dir * waveHeight * u_strength;

          // 采样经过水面折射后的背景像素，保证背景绝不整体模糊
          uv = v_uv - offset;

          // 晨光反射柔和高光 (极低调梦幻，无玻璃刺眼感)
          vec2 lightDir = normalize(vec2(-0.4, 0.7));
          float highlight = max(0.0, dot(dir, lightDir)) * max(0.0, waveHeight) * 0.12 * decay;

          vec4 color = texture2D(u_texture, (uv - 0.5) * u_textureScale + 0.5);
          // 叠加晨光微金高光
          color.rgb += vec3(highlight * 1.0, highlight * 0.92, highlight * 0.82);

          gl_FragColor = color;
        } else {
          // 完全静止状态：高清原图直出，保持莫奈油画纯粹质感
          gl_FragColor = texture2D(u_texture, (uv - 0.5) * u_textureScale + 0.5);
        }
      }
    `;

    // 编译着色器
    const createShader = (type: number, src: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = createShader(gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    // 顶点缓冲区 (全屏四边形: -1~1)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW
    );

    const aPosition = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    // 获取 Uniform 变量位置
    const uTexture = gl.getUniformLocation(program, 'u_texture');
    const uCenter = gl.getUniformLocation(program, 'u_center');
    const uProgress = gl.getUniformLocation(program, 'u_progress');
    const uAspect = gl.getUniformLocation(program, 'u_aspect');
    const uTextureScale = gl.getUniformLocation(program, 'u_textureScale');
    const uMaxRadius = gl.getUniformLocation(program, 'u_maxRadius');
    const uStrength = gl.getUniformLocation(program, 'u_strength');
    const uActive = gl.getUniformLocation(program, 'u_active');

    gl.uniform1i(uTexture, 0);

    // 创建纹理
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // 生成纯色/基础油画备用纹理，杜绝首屏闪白
    const placeholderCanvas = document.createElement('canvas');
    placeholderCanvas.width = 430;
    placeholderCanvas.height = 932;
    const pCtx = placeholderCanvas.getContext('2d');
    if (pCtx) {
      // 莫奈水天温润色底 (#b9ced7 ~ #a4babe)
      const grad = pCtx.createLinearGradient(0, 0, 0, 932);
      grad.addColorStop(0, '#c7d7dc');
      grad.addColorStop(0.2, '#f2dfcf');
      grad.addColorStop(0.45, '#b9ced7');
      grad.addColorStop(0.75, '#a4babe');
      grad.addColorStop(1, '#8ea3a8');
      pCtx.fillStyle = grad;
      pCtx.fillRect(0, 0, 430, 932);
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      placeholderCanvas
    );

    // 加载目标油画背景图
    let imageAspect = placeholderCanvas.width / placeholderCanvas.height;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl || '/assets/lotus_pond_bg.jpg';

    const applyTexture = () => {
      imageAspect = img.naturalWidth / img.naturalHeight;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      setIsLoaded(true);
    };

    img.onload = applyTexture;
    if (img.complete && img.naturalWidth > 0) {
      applyTexture();
    }

    // 动画状态控制
    // 1. 页面首先保持静止约 0.8 秒
    // 2. 每次动画持续约 1.5～2 秒 (取 1.75 秒)
    // 3. 之后随机间隔约 3～6 秒再次出现一滴雨水
    const state = {
      startTime: performance.now(),
      nextDropTime: performance.now() + 800, // 初始 0.8 秒后第一滴
      duration: 1750, // 每次波纹持续 1.75 秒
      isActive: false,
      rippleStart: 0,
      center: { x: 0.5, y: 0.46 }, // 归一化 UV 坐标 (画面中央开阔水域)
    };

    // 触发新一滴雨水，严格限制在中央大面积水域
    const spawnRaindrop = (customX?: number, customY?: number) => {
      state.isActive = true;
      state.rippleStart = performance.now();

      if (customX !== undefined && customY !== undefined) {
        state.center = { x: customX, y: customY };
      } else {
        // 严格限制在中央开阔水面区域：
        // 避开右下荷花 (x>0.55 && y>0.65)、左侧与下方水草、顶部柳树 (y<0.25)
        // 水域范围: x: 0.36 ~ 0.64, y: 0.34 ~ 0.58
        state.center = {
          x: 0.36 + Math.random() * 0.28,
          y: 0.34 + Math.random() * 0.24,
        };
      }
    };

    let animId: number;

    const render = (now: number) => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // 移动端性能优化
      const width = Math.floor(rect.width * dpr);
      const height = Math.floor(rect.height * dpr);

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }

      // 检查雨滴生成时机
      if (!state.isActive && now >= state.nextDropTime) {
        spawnRaindrop();
      }

      // 计算当前波纹进度
      let progress = 0;
      if (state.isActive) {
        const elapsed = now - state.rippleStart;
        progress = Math.min(1.0, elapsed / state.duration);

        if (progress >= 1.0) {
          // 当前波纹结束，进入完全静止状态
          state.isActive = false;
          // 水面恢复静止后静候 0.5 秒，下一滴晨雨再次轻巧落下
          const randomPause = 500;
          state.nextDropTime = now + randomPause;
        }
      }

      const aspect = rect.width / rect.height;

      // 更新 Uniforms
      gl.uniform1f(uActive, state.isActive ? 1.0 : 0.0);
      gl.uniform1f(uProgress, progress);
      gl.uniform2f(uCenter, state.center.x, state.center.y);
      gl.uniform1f(uAspect, aspect);
      gl.uniform2f(uTextureScale, Math.min(1, aspect / imageAspect), Math.min(1, imageAspect / aspect));
      // 最大波纹半径严格限制在画面宽度的 10% 左右，绝不蔓延至全屏
      gl.uniform1f(uMaxRadius, 0.10);
      // 轻柔梦幻液态折射强度，保证不产生玻璃或果冻感
      gl.uniform1f(uStrength, 0.008);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    // 交互点击事件：在点击位置即时泛起轻微折射涟漪
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const rect = container.getBoundingClientRect();
      const clientX = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientY : (e as MouseEvent).clientY;

      const normX = (clientX - rect.left) / rect.width;
      const normY = (clientY - rect.top) / rect.height;

      // 激发水波
      spawnRaindrop(normX, normY);

      if (onTapWater) {
        onTapWater(clientX - rect.left, clientY - rect.top);
      }
    };

    container.addEventListener('mousedown', handlePointerDown);
    container.addEventListener('touchstart', handlePointerDown, { passive: true });

    return () => {
      cancelAnimationFrame(animId);
      container.removeEventListener('mousedown', handlePointerDown);
      container.removeEventListener('touchstart', handlePointerDown);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteTexture(texture);
      gl.deleteBuffer(positionBuffer);
    };
  }, [imageUrl, onTapWater]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden select-none ${className}`}
    >
      {/* 极速底图：在 WebGL 纹理就绪前瞬间呈现高清原画，杜绝任何白屏或延迟空档 */}
      {imageUrl && (
        <img
          src={imageUrl}
          alt="Water Ripple Base"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        />
      )}
      <canvas
        ref={canvasRef}
        className="relative z-10 w-full h-full block cursor-pointer"
        style={{
          // 保持清晰，绝对不允许整体 blur
          filter: 'none',
          WebkitFilter: 'none',
        }}
      />
    </div>
  );
};
