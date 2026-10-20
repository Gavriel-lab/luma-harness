import React, { useEffect, useRef, useState } from 'react';
import { createPetalRenderer, type GardenFrame, type PetalRenderer, type PetalBox } from './petalGeometry';
import type { GardenMemorySummaryDto } from '../../types';

interface Props extends GardenFrame { onSelectPetal(item: GardenMemorySummaryDto, box: PetalBox): void }

export const PetalCanvas: React.FC<Props> = props => {
  const canvas = useRef<HTMLCanvasElement>(null), targets = useRef<HTMLDivElement>(null);
  const renderer = useRef<PetalRenderer | null>(null), latest = useRef(props);
  const [unavailable, setUnavailable] = useState(false);
  latest.current = props;
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    createPetalRenderer(canvas.current!, targets.current!, latest.current, (item, box) => latest.current.onSelectPetal(item, box), controller.signal)
      .then(instance => {
        if (disposed) instance.dispose();
        else { renderer.current = instance; instance.update(latest.current); }
      })
      .catch(() => { if (!disposed) setUnavailable(true); });
    return () => { disposed = true; controller.abort(); renderer.current?.dispose(); renderer.current = null; };
  }, []);
  useEffect(() => { renderer.current?.update(props); }, [props.items, props.selectedKey, props.relatedKeys, props.isNight]);
  return <>
    <canvas className="rose-petals" ref={canvas} aria-hidden="true" />
    <div className="rose-petal-targets" ref={targets} aria-label="记忆花瓣" />
    {unavailable && <p className="rose-hint">花瓣暂时无法展开，先一起看看花园。</p>}
  </>;
};
