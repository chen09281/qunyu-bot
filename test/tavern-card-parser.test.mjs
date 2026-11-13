import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import {
  isPngBuffer,
  extractPngTextChunks,
  normalizeCardData,
  parseCharacterCard,
  embedCardIntoPng
} from '../src/tavern/card-parser.mjs';

function createDummyPng() {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // IHDR chunk: 13 bytes
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width: 1
  ihdrData.writeUInt32BE(1, 4); // height: 1
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrCrc = Buffer.alloc(4);
  ihdrCrc.writeUInt32BE(crc32(Buffer.concat([ihdrType, ihdrData])) >>> 0, 0);
  const ihdr = Buffer.concat([ihdrLen, ihdrType, ihdrData, ihdrCrc]);

  // IEND chunk: 0 bytes
  const iendLen = Buffer.alloc(4);
  iendLen.writeUInt32BE(0, 0);
  const iendType = Buffer.from('IEND', 'ascii');
  const iendCrc = Buffer.alloc(4);
  iendCrc.writeUInt32BE(crc32(iendType) >>> 0, 0);
  const iend = Buffer.concat([iendLen, iendType, iendCrc]);

  return Buffer.concat([header, ihdr, iend]);
}

test('isPngBuffer 识别 PNG 头', () => {
  assert.equal(isPngBuffer(createDummyPng()), true);
  assert.equal(isPngBuffer(Buffer.from('not a png')), false);
});

test('解析纯 JSON 格式角色卡 (Tavern V2)', () => {
  const jsonRaw = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '爱丽丝',
      description: '金发碧眼的魔法使',
      personality: '傲娇但体贴',
      scenario: '森林小屋',
      first_mes: '哼，你找本小姐有什么事？',
      mes_example: '<START>\n{{user}}: 你好\n{{char}}: 哼！',
      system_prompt: '请严格遵守魔法使的语气。',
      tags: ['傲娇', '魔法使'],
      alternate_greetings: ['你又来了呀。']
    }
  };

  const card = parseCharacterCard(Buffer.from(JSON.stringify(jsonRaw)));
  assert.equal(card.name, '爱丽丝');
  assert.equal(card.first_mes, '哼，你找本小姐有什么事？');
  assert.equal(card.tags.length, 2);
  assert.equal(card.alternate_greetings[0], '你又来了呀。');
});

test('打包卡片到 PNG 并成功从 PNG 中解析', () => {
  const rawPng = createDummyPng();
  const cardData = {
    name: '莉莉丝',
    description: '见习魅魔',
    personality: '有点冒失',
    scenario: '古堡',
    first_mes: '哇啊！召唤阵怎么跳出来个人类！',
    mes_example: '',
    system_prompt: '',
    creator_notes: '测试角色卡',
    character_book: {
      name: '古堡设定',
      entries: [
        { keys: ['古堡', '暗室'], content: '这是一座拥有五百年历史的神秘古堡。' }
      ]
    }
  };

  const embeddedPng = embedCardIntoPng(rawPng, cardData);
  assert.equal(isPngBuffer(embeddedPng), true);

  const parsed = parseCharacterCard(embeddedPng);
  assert.equal(parsed.name, '莉莉丝');
  assert.equal(parsed.first_mes, '哇啊！召唤阵怎么跳出来个人类！');
  assert.equal(parsed.creator_notes, '测试角色卡');
  assert.ok(parsed.character_book);
  assert.equal(parsed.character_book.entries.length, 1);
  assert.deepEqual(parsed.character_book.entries[0].keys, ['古堡', '暗室']);
});
