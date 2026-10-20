import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { RoseGardenBackground } from './RoseGardenBackground';
import { PetalCanvas } from './PetalCanvas';
import { PetalReaderModal } from './PetalReaderModal';
import { fetchMemoryGarden, fetchMemoryGardenDetail, fetchMemoryGardenRelated } from '../../utils/apiClient';
import type { GardenMemoryDetailDto, GardenMemorySummaryDto, GardenRelatedMemoryDto } from '../../types';
import type { PetalBox } from './petalGeometry';
import './garden.css';

interface Props { isNight: boolean; customDayImg?: string | null; customNightImg?: string | null; className?: string }
interface Selection { summary: GardenMemorySummaryDto; box: PetalBox | null; initialDetail?: GardenMemoryDetailDto }

export const MemoryGarden: React.FC<Props> = ({ isNight, customDayImg, customNightImg, className = '' }) => {
  const [items, setItems] = useState<GardenMemorySummaryDto[]>([]);
  const [loading, setLoading] = useState(true), [catalogError, setCatalogError] = useState(false), [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<GardenMemoryDetailDto | null>(null), [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [related, setRelated] = useState<GardenRelatedMemoryDto[]>([]), [relatedLoading, setRelatedLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setCatalogError(false);
    fetchMemoryGarden({ limit: 84 }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setItems(data.items || []); })
      .catch(() => { if (!controller.signal.aborted) setCatalogError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(selection?.initialDetail || null); setRelated([]); setDetailError(null);
    setDetailLoading(!!selection && !selection.initialDetail); setRelatedLoading(!!selection);
    if (selection) {
      if (!selection.initialDetail) fetchMemoryGardenDetail(selection.summary.key, controller.signal)
        .then(value => { if (!controller.signal.aborted) setDetail(value); })
        .catch(() => { if (!controller.signal.aborted) setDetailError('全文暂未打开，先显示已有片段。'); })
        .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
      fetchMemoryGardenRelated(selection.summary.key, controller.signal)
        .then(value => { if (!controller.signal.aborted) setRelated(value); })
        .catch(() => { /* No invented links when recall is unavailable. */ })
        .finally(() => { if (!controller.signal.aborted) setRelatedLoading(false); });
    }
    return () => controller.abort();
  }, [selection]);

  const relatedKeys = useMemo(() => new Set(related.map(item => item.key)), [related]);
  const selectPetal = useCallback((summary: GardenMemorySummaryDto, box: PetalBox) => setSelection({ summary, box }), []);
  const close = useCallback(() => setSelection(null), []);
  const selectRelated = async (key: string) => {
    const summary = items.find(item => item.key === key);
    if (summary) { setSelection({ summary, box: null }); return; }
    const previousKey = selection?.summary.key;
    try {
      const loaded = await fetchMemoryGardenDetail(key);
      setSelection(current => current?.summary.key === previousKey ? {
        summary: { ...loaded, preview: loaded.content }, box: null, initialDetail: loaded,
      } : current);
    } catch { setDetailError('这片关联记忆暂时没有打开，请稍后再试。'); }
  };

  return <div className={`rose-garden ${className}`} data-memory-source="ExternalMemory" data-garden-state={loading ? 'loading' : catalogError ? 'offline' : 'ready'}>
    <RoseGardenBackground isNight={isNight} customDayImg={customDayImg} customNightImg={customNightImg} />
    <PetalCanvas items={items} isNight={isNight} selectedKey={selection?.summary.key || null} relatedKeys={relatedKeys} onSelectPetal={selectPetal} />
    {!selection && !catalogError && <p className="rose-hint" role="status">{loading ? '正在轻轻翻开记忆…' : items.length ? '轻触一片花瓣，听记忆回响' : '这里会慢慢开出我们的记忆'}</p>}
    {catalogError && <button className="rose-retry" onClick={() => setReload(value => value + 1)}>暂未连上桌面记忆 · 轻触重试</button>}
    <AnimatePresence>
      {selection && <PetalReaderModal key={selection.summary.key} summary={selection.summary} originBox={selection.box}
        detail={detail} related={related} isLoadingDetail={detailLoading} isLoadingRelated={relatedLoading}
        error={detailError} onClose={close} onSelectRelated={selectRelated} />}
    </AnimatePresence>
  </div>;
};
export default MemoryGarden;
