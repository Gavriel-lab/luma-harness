import React, { useEffect, useState, type CSSProperties } from 'react';
import './homeFireflies.css';

// Fixed paths keep the same lights when the wallpaper changes, without a frame loop.
const LIGHTS = [
  { x: 12, y: 25, dx: 30, dy: -24, scale: .7, duration: 27, pulse: 8, delay: -9 },
  { x: 77, y: 20, dx: -24, dy: 32, scale: .85, duration: 32, pulse: 11, delay: -21 },
  { x: 43, y: 36, dx: 25, dy: -32, scale: .6, duration: 29, pulse: 9, delay: -17 },
  { x: 88, y: 45, dx: -36, dy: -22, scale: 1, duration: 25, pulse: 7, delay: -5 },
  { x: 20, y: 56, dx: 34, dy: 24, scale: .8, duration: 31, pulse: 10, delay: -24 },
  { x: 61, y: 59, dx: -28, dy: -35, scale: .65, duration: 34, pulse: 9, delay: -13 },
  { x: 36, y: 76, dx: 28, dy: -24, scale: 1, duration: 26, pulse: 8, delay: -19 },
  { x: 81, y: 81, dx: -30, dy: -30, scale: .75, duration: 30, pulse: 12, delay: -8 },
  { x: 10, y: 85, dx: 22, dy: -28, scale: .6, duration: 33, pulse: 10, delay: -27 },
];

export function HomeFireflies() {
  const [paused, setPaused] = useState(() => document.visibilityState === 'hidden');
  useEffect(() => {
    const sync = () => setPaused(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return (
    <div className="home-fireflies" aria-hidden="true" data-paused={paused}>
      {LIGHTS.map((light, index) => (
        <span key={index} className="home-firefly" style={{
          left: `${light.x}%`, top: `${light.y}%`,
          '--fly-x': `${light.dx}px`, '--fly-y': `${light.dy}px`, '--fly-scale': light.scale,
          '--fly-duration': `${light.duration}s`, '--fly-pulse': `${light.pulse}s`, '--fly-delay': `${light.delay}s`,
        } as CSSProperties}>
          <span className="home-firefly-glow" />
        </span>
      ))}
    </div>
  );
}
