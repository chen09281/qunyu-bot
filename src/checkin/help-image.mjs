import { HelpImage } from '../help-image.mjs';

export const helpImageSize = { width: 1080, height: 2800 };
export class CheckinHelpImage extends HelpImage {
  constructor(options = {}) {
    super({ ...options, ...helpImageSize, page: new URL('./help.html', import.meta.url), label: '签到帮助图片' });
  }
}
