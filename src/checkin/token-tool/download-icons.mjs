const paths = {
  link: '<path d="m10 13 4-4m-5 7-1 1a4.24 4.24 0 0 1-6-6l4-4a4.24 4.24 0 0 1 6 0m-1 0 1-1a4.24 4.24 0 0 1 6 6l-4 4a4.24 4.24 0 0 1-6 0"/>',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  shield: '<path d="m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  device: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  android: '<path d="m8 5-2-3m10 3 2-3M5 10h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9ZM5 10a7 7 0 0 1 14 0M2 11v6m20-6v6M8 20v2m8-2v2"/><path d="M9 7h.01M15 7h.01"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 22h8m-4-5v5M2 13h20"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-4 14h4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>',
};
export const downloadIcon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
