// Mobile transport presentation only. Canonical text and desktop streaming stay intact.
export function completedReplyPrefix(text) {
  if (typeof text !== 'string' || /^\s*\[语音\](?:\s|$)/u.test(text)) return '';
  // Keep a growing list/code block intact; preceding completed prose may appear.
  const block = /(^|\n)[\t ]*(?:`{3}|~{3}|#{1,6}\s|[-*+]\s|\d+[.)、]\s|>|\|)/m.exec(text);
  const prose = block ? text.slice(0, block.index) : text;
  const balanced = value => ['**', '__', '~~', '`', '"'].every(mark => value.split(mark).length % 2 === 1)
    && ['*', '_'].every(mark => value.replace(/\*\*|__/g, '').split(mark).length % 2 === 1)
    && [['（', '）'], ['(', ')'], ['“', '”'], ['「', '」'], ['『', '』'], ['[', ']']].every(([a, b]) => value.split(a).length === value.split(b).length);
  const boundaries = /[。！？!?]+["”’」』）)\]*_~]*[\t \r\n]*|\.(?=\s)["”’」』）)\]*_~]*[\t \r\n]*|\n[\t \r]*\n+/g;
  let end = 0;
  for (const match of prose.matchAll(boundaries)) {
    const at = match.index + match[0].length;
    if (balanced(prose.slice(0, at))) end = at;
  }
  return prose.slice(0, end).trimEnd();
}

export function deliverMobileMessages(messages) {
  return messages.map(message => message.role === 'assistant' && message.status === 'pending'
    ? { ...message, content: completedReplyPrefix(message.content) } : message);
}
