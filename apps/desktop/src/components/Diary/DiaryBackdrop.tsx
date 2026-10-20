/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆背景层
 */
import React from 'react';

export const CARNET = `${import.meta.env.BASE_URL}assets/carnet/`;

export const DiaryBackdrop: React.FC<{ variant?: 'garden' | 'soft' }> = ({ variant = 'soft' }) => (
  <div className="diary-backdrop" data-variant={variant}>
    <img
      src={`${CARNET}garden.webp`}
      alt=""
      aria-hidden="true"
      className="diary-backdrop-painting"
    />
    <div className="diary-backdrop-wash" />
  </div>
);
