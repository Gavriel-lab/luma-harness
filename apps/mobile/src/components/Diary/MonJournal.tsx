/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 手机端 - 使用者自己的手记 (MonJournal)
 * 现在只是一页空白纸；提笔要等桌面小屋那边把存储做好。
 */

import React from 'react';
import { ArrowLeft, Feather } from 'lucide-react';
import { DiaryBackdrop, CARNET } from './DiaryBackdrop';
import './diary.css';

export const MonJournal: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div className="diary-room relative w-full h-full flex flex-col overflow-hidden select-none text-stone-900">
    <DiaryBackdrop />

    <header className="carnet-head carnet-head--reader">
      <button type="button" onClick={onBack} className="carnet-float-btn" aria-label="回到花园">
        <ArrowLeft className="w-4 h-4" />
      </button>
      <div className="carnet-title">
        <h1 className="font-calligraphy">Mon Journal</h1>
        <p className="font-serif">使用者的手记</p>
      </div>
      <span className="carnet-float-spacer" aria-hidden="true" />
    </header>

    <div className="diary-scroll relative z-10 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-6 no-scrollbar">
      <article className="diary-page diary-page--mine" style={{ '--page-img': `url(${CARNET}page.webp)` } as React.CSSProperties}>
        <div className="diary-page-empty">
          <p className="diary-page-empty-title">这一本还是新的</p>
          <p>想写的时候，就写在这里。</p>
          <button type="button" className="carnet-quill-btn" disabled aria-disabled="true">
            <Feather className="w-4 h-4" aria-hidden="true" />
            <span>提笔</span>
            <span className="carnet-soon">即将开放</span>
          </button>
        </div>
      </article>
    </div>
  </div>
);
