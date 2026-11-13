import { HelpImage } from '../help-image.mjs';

export const subscriptionHelpImageSize = { width: 1080, height: 2400 };
export class SubscriptionHelpImage extends HelpImage {
  constructor(options = {}) {
    super({ ...options, ...subscriptionHelpImageSize, page: new URL('./help.html', import.meta.url), label: '订阅帮助图片' });
  }
}
