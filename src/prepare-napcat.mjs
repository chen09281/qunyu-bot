import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStore, token, writePrivate } from './config.mjs';

const readJSON = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
export async function prepareNapcat(dataDir, initialPassword = '') {
  dataDir = resolve(dataDir);
  const store = await openStore(dataDir, initialPassword);
  const configDir = join(dataDir, 'napcat', 'config');
  for (const dir of [configDir, join(dataDir, 'napcat', 'qq'), join(dataDir, 'napcat', 'plugins'), join(dataDir, 'media')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = join(dataDir, 'config.before-napcat.json');
  if (!existsSync(backup)) writePrivate(backup, store.config);
  const webuiPath = join(configDir, 'webui.json'), webui = readJSON(webuiPath);
  const napcatToken = webui.token || store.config.napcatToken || token();
  const onebotToken = store.config.onebotToken || token();
  writePrivate(webuiPath, { ...webui, host: '0.0.0.0', port: 6099, token: napcatToken, loginRate: webui.loginRate || 3 });
  const httpServer = { name: 'qunyu-http', enable: true, host: '0.0.0.0', port: 3000, enableCors: false, enableWebsocket: false, messagePostFormat: 'array', token: onebotToken, debug: false };
  const httpClient = { name: 'qunyu-events', enable: true, url: 'http://qq-bot:3080/onebot/events', messagePostFormat: 'array', reportSelfMessage: false, token: store.config.webhookToken, debug: false };
  const files = new Set(['onebot11.json', ...readdirSync(configDir).filter(file => /^onebot11_\d+\.json$/.test(file))]);
  for (const file of files) {
    const path = join(configDir, file), current = readJSON(path), network = current.network || {};
    writePrivate(path, {
      ...current,
      network: {
        websocketServers: [], websocketClients: [], ...network,
        httpServers: [...(network.httpServers || []).filter(item => item.name !== httpServer.name && Number(item.port) !== 3000), httpServer],
        httpClients: [...(network.httpClients || []).filter(item => item.name !== httpClient.name), httpClient]
      }
    });
  }
  store.save({ napcatUrl: 'http://napcat:6099', napcatToken, onebotUrl: 'http://napcat:3000', onebotToken });
  return { dataDir, configDir, backup };
}
