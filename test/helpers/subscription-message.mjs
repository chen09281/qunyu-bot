import { subscriptionMessage } from '../../src/subscriptions/message.mjs';
// Exercise production message assembly without launching a renderer or networking.
export const prepareMessage = (entry, item, options) => subscriptionMessage(entry, item, { ...options,
  downloadImage: async () => { throw new Error('test image unavailable'); }, renderCard: async () => 'base64://UE5H',
});
