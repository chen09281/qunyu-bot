import { inflateSync, crc32 } from 'node:zlib';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * 校验是否为合法的 PNG 缓冲
 */
export function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_HEADER);
}

/**
 * 从 PNG Buffer 中提取所有文本 Chunk（包括 tEXt 和 iTXt）
 */
export function extractPngTextChunks(buf) {
  if (!isPngBuffer(buf)) return [];
  const chunks = [];
  let offset = 8;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;

    if (dataEnd + 4 > buf.length) break; // 损坏的 PNG 或提前截断

    if (type === 'tEXt') {
      const data = buf.subarray(dataOffset, dataEnd);
      const nullIdx = data.indexOf(0x00);
      if (nullIdx !== -1) {
        const keyword = data.subarray(0, nullIdx).toString('latin1');
        const text = data.subarray(nullIdx + 1).toString('latin1');
        chunks.push({ type: 'tEXt', keyword, text });
      }
    } else if (type === 'iTXt') {
      const data = buf.subarray(dataOffset, dataEnd);
      const nullIdx = data.indexOf(0x00);
      if (nullIdx !== -1) {
        const keyword = data.subarray(0, nullIdx).toString('utf8');
        let pos = nullIdx + 1;
        if (pos + 2 <= data.length) {
          const compFlag = data[pos];
          const compMethod = data[pos + 1];
          pos += 2;
          const langNull = data.indexOf(0x00, pos);
          if (langNull !== -1) {
            pos = langNull + 1;
            const transNull = data.indexOf(0x00, pos);
            if (transNull !== -1) {
              pos = transNull + 1;
              const rawTextData = data.subarray(pos);
              let text = '';
              try {
                if (compFlag === 1 && compMethod === 0) {
                  text = inflateSync(rawTextData, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8');
                } else {
                  text = rawTextData.toString('utf8');
                }
                chunks.push({ type: 'iTXt', keyword, text });
              } catch {
                // 解压失败则跳过
              }
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // 跳过 CRC (4 bytes)
  }

  return chunks;
}

/**
 * 将 Tavern 卡片数据标准化
 */
export function normalizeCardData(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('无效的角色卡格式：根对象必须是 JSON 对象');
  }

  // 优先取 Tavern V2 的 data 字段
  const data = (raw.data && typeof raw.data === 'object') ? raw.data : raw;
  const clip = (val, max = 16000) => String(val || '').trim().slice(0, max);

  const name = clip(data.name || raw.name || '未命名角色', 120) || '未命名角色';
  const description = clip(data.description || raw.description, 16000);
  const personality = clip(data.personality || raw.personality, 16000);
  const scenario = clip(data.scenario || raw.scenario, 16000);
  const firstMes = clip(data.first_mes || raw.first_mes, 16000);
  const mesExample = clip(data.mes_example || raw.mes_example, 16000);
  const systemPrompt = clip(data.system_prompt || raw.system_prompt, 16000);
  const postHistory = clip(data.post_history_instructions || raw.post_history_instructions, 16000);
  const creatorNotes = clip(data.creator_notes || raw.creatorcomment || raw.creator_notes, 8000);
  const creator = clip(data.creator || raw.creator, 120);
  const characterVersion = clip(data.character_version || raw.character_version || '1.0', 64) || '1.0';

  const alternateGreetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.slice(0, 20).map(g => clip(g, 4000)).filter(Boolean)
    : [];

  const tags = Array.isArray(data.tags)
    ? data.tags.slice(0, 50).map(t => clip(t, 64)).filter(Boolean)
    : [];

  // 内嵌世界书解析 (character_book)
  let characterBook = null;
  const rawBook = data.character_book || raw.character_book;
  if (rawBook && typeof rawBook === 'object' && Array.isArray(rawBook.entries)) {
    characterBook = {
      name: clip(rawBook.name || name + ' 的世界书', 120),
      description: clip(rawBook.description, 2000),
      entries: rawBook.entries.slice(0, 200).map((entry, idx) => ({
        id: clip(entry?.id || `entry_${idx}`, 64),
        keys: Array.isArray(entry?.keys) ? entry.keys.slice(0, 50).map(k => clip(k, 128).toLowerCase()).filter(Boolean) : [],
        secondaryKeys: Array.isArray(entry?.secondary_keys) ? entry.secondary_keys.slice(0, 50).map(k => clip(k, 128).toLowerCase()).filter(Boolean) : [],
        content: clip(entry?.content, 8000),
        enabled: entry?.enabled !== false,
        constant: Boolean(entry?.constant),
        position: String(entry?.position || 'before_char'), // before_char | after_char | depth
        order: Number.isFinite(entry?.insertion_order) ? entry.insertion_order : (idx * 10)
      })).filter(e => e.content)
    };
  }

  return {
    spec: raw.spec || 'chara_card_v2',
    spec_version: raw.spec_version || '2.0',
    name,
    description,
    personality,
    scenario,
    first_mes: firstMes,
    mes_example: mesExample,
    system_prompt: systemPrompt,
    post_history_instructions: postHistory,
    alternate_greetings: alternateGreetings,
    tags,
    creator,
    creator_notes: creatorNotes,
    character_version: characterVersion,
    character_book: characterBook
  };
}

/**
 * 从文件 buffer 中解析角色卡（支持 PNG 或 JSON）
 */
export function parseCharacterCard(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // 1. 尝试检测是否为 PNG
  if (isPngBuffer(buf)) {
    const textChunks = extractPngTextChunks(buf);
    const charaChunk = textChunks.find(c => c.keyword.toLowerCase() === 'chara');
    if (!charaChunk) {
      throw new Error('PNG 图片中未找到包含 chara 关键字的酒馆角色卡元数据');
    }

    let jsonStr = '';
    try {
      // 大部分 Tavern 卡片的 chara 是 base64 编码的 UTF-8 JSON
      jsonStr = Buffer.from(charaChunk.text, 'base64').toString('utf8');
      // 如果解析出来的不是 json，尝试直接当 json 解析
      if (!jsonStr.trim().startsWith('{')) {
        jsonStr = charaChunk.text;
      }
    } catch {
      jsonStr = charaChunk.text;
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return normalizeCardData(parsed);
    } catch (e) {
      throw new Error(`角色卡 JSON 解析失败: ${e.message}`);
    }
  }

  // 2. 尝试当做普通 JSON 解析
  try {
    const text = buf.toString('utf8');
    const parsed = JSON.parse(text);
    return normalizeCardData(parsed);
  } catch (e) {
    throw new Error(`无法识别的角色卡格式（既不是有效的 Tavern PNG 图片，也不是合法的 JSON）: ${e.message}`);
  }
}

/**
 * 将角色数据打包写入 PNG Buffer（写入 tEXt chunk: chara）
 */
export function embedCardIntoPng(pngBuf, cardData) {
  if (!isPngBuffer(pngBuf)) {
    throw new Error('输入的不是合法的 PNG 图片缓冲');
  }

  const exportObj = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: cardData.name,
      description: cardData.description,
      personality: cardData.personality,
      scenario: cardData.scenario,
      first_mes: cardData.first_mes,
      mes_example: cardData.mes_example,
      creator_notes: cardData.creator_notes,
      system_prompt: cardData.system_prompt,
      post_history_instructions: cardData.post_history_instructions,
      alternate_greetings: cardData.alternate_greetings || [],
      tags: cardData.tags || [],
      creator: cardData.creator || '',
      character_version: cardData.character_version || '1.0',
      character_book: cardData.character_book || undefined
    }
  };

  const jsonBase64 = Buffer.from(JSON.stringify(exportObj), 'utf8').toString('base64');
  const keyword = 'chara';
  const chunkData = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0x00]),
    Buffer.from(jsonBase64, 'latin1')
  ]);

  const chunkType = Buffer.from('tEXt', 'ascii');
  const chunkLen = Buffer.alloc(4);
  chunkLen.writeUInt32BE(chunkData.length, 0);

  const crcData = Buffer.concat([chunkType, chunkData]);
  const chunkCrc = Buffer.alloc(4);
  chunkCrc.writeUInt32BE(crc32(crcData) >>> 0, 0);

  const newChunk = Buffer.concat([chunkLen, chunkType, chunkData, chunkCrc]);

  // 将新 chunk 插入到 IEND 之前（或 IHDR 之后）
  // 插入在 IHDR chunk 之后即可
  const ihdrLen = pngBuf.readUInt32BE(8);
  const insertPos = 8 + 4 + 4 + ihdrLen + 4; // 8 (header) + 12 + ihdrLen

  return Buffer.concat([
    pngBuf.subarray(0, insertPos),
    newChunk,
    pngBuf.subarray(insertPos)
  ]);
}
