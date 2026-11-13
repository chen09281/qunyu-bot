import { HelpImage } from '../help-image.mjs';

export const tavernHelpImageSize = { width: 1080, height: 2400 };

export class TavernHelpImage extends HelpImage {
  constructor(options = {}) {
    super({ ...options, ...tavernHelpImageSize, page: new URL('./help.html', import.meta.url), label: '酒馆帮助图片' });
  }
}
