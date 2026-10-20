import React from 'react';

export const CARNET = `${import.meta.env.BASE_URL}assets/carnet/`;

/**
 * 池边花园水彩。
 * garden：日记馆本身，清晰铺满；soft：翻开手记时，虚化调淡垫在纸页底下。
 */
export function DiaryBackdrop({ variant = 'soft' }: { variant?: 'garden' | 'soft' }) {
  return (
    <div className="diary-backdrop" data-variant={variant} aria-hidden="true">
      <img src={`${CARNET}garden.webp`} alt="" draggable={false} className="diary-backdrop-painting" />
      <div className="diary-backdrop-wash" />
    </div>
  );
}
