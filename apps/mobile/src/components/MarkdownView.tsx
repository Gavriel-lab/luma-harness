/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface MarkdownViewProps {
  content: string;
  className?: string;
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content, className = '' }) => {
  // 简明安全的 Markdown 渲染器，解析加粗、斜体、列表、行内代码与代码块
  const renderFormattedText = (text: string) => {
    const lines = text.split('\n');

    return lines.map((line, idx) => {
      // Blank lines separate paragraphs; they do not need a full empty text row.
      if (!line.trim()) {
        if (idx === 0 || idx === lines.length - 1 || !lines[idx - 1].trim()) return null;
        return <div key={idx} aria-hidden="true" className="h-1" />;
      }
      // 列表项
      if (line.trim().startsWith('- ')) {
        const itemText = line.trim().slice(2);
        return (
          <li key={idx} className="ml-4 list-disc my-0.5 leading-relaxed">
            {parseInline(itemText)}
          </li>
        );
      }

      // 引用
      if (line.trim().startsWith('> ')) {
        const quoteText = line.trim().slice(2);
        return (
          <blockquote
            key={idx}
            className="border-l-2 border-stone-500/40 pl-2.5 my-1.5 italic text-stone-700 font-serif"
          >
            {parseInline(quoteText)}
          </blockquote>
        );
      }

      // 普通段落
      return (
        <p key={idx} className="leading-relaxed m-0">
          {parseInline(line)}
        </p>
      );
    });
  };

  // 解析行内样式：**加粗**、*斜体*、`代码`
  const parseInline = (text: string): React.ReactNode => {
    // 匹配 **bold**, *italic*, `code`
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      const token = match[0];
      if (token.startsWith('**') && token.endsWith('**')) {
        parts.push(
          <strong key={match.index} className="font-semibold text-stone-900 font-serif">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('*') && token.endsWith('*')) {
        parts.push(
          <em key={match.index} className="italic text-stone-800 font-serif">
            {token.slice(1, -1)}
          </em>
        );
      } else if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(
          <code
            key={match.index}
            className="px-1.5 py-0.5 rounded bg-stone-200/60 font-mono text-xs text-stone-800"
          >
            {token.slice(1, -1)}
          </code>
        );
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  return <div className={`break-words ${className}`}>{renderFormattedText(content)}</div>;
};
