import { buildHealthHelpHtml } from './card.mjs';

export class HealthPlannerHelpImage {
  constructor(cardRenderer = null) {
    this.cardRenderer = cardRenderer;
    this.buffer = null;
  }

  async create() {
    if (this.buffer) return `base64://${this.buffer.toString('base64')}`;
    if (!this.cardRenderer?.available) return null;
    const { html, width, height } = buildHealthHelpHtml();
    const png = await this.cardRenderer.renderHtmlToPng({ html, width, height, scale: 1 });
    this.buffer = png;
    return `base64://${png.toString('base64')}`;
  }
}
