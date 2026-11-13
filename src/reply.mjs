// Keep useful answer text, but omit the citation appendix commonly added after web search.
export function cleanGroupReply(text) {
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map((part, index) => {
    if (index % 2) return part;
    let sources = false;
    return part.split('\n').filter(line => {
      const plain = line.replace(/^\s*(?:#{1,6}\s*|[-*]\s+)?/, '').replace(/\*\*/g, '').trim();
      if (/^(?:参考(?:资料|来源|链接|文献)|(?:信息|数据|资料)?来源|引用来源|sources?|references?)\s*[:：]?\s*$/i.test(plain)) { sources = true; return false; }
      if (sources && /^\s*#{1,6}\s+/.test(line)) sources = false;
      if (sources) return false;
      if (/^(?:参考(?:资料|来源|链接|文献)|(?:信息|数据|资料)?来源|引用来源|sources?|references?)\s*[:：]/i.test(plain)) return false;
      return !/^\s*\[\^?\d+\]:\s*/.test(line);
    }).join('\n')
      .replace(/\[(?:\^?\d+|来源|参考(?:资料|来源|链接)?|source)\]\(https?:\/\/[^\s)]+\)/gi, '')
      .replace(/\[\^?\d+(?:\s*[,，、–-]\s*\d+)*\]|【\d+(?:\s*[,，、–-]\s*\d+)*】/g, '')
      .replace(/cite[^]*/g, '')
      .replace(/[（(](?:来源|参考|source)\s*[:：][^\n）)]*[）)]/gi, '')
      .replace(/[ \t]+\n/g, '\n');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
}
