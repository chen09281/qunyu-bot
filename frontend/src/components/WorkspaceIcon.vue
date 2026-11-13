<script setup>
defineProps({ name: { type: String, default: 'overview' } });
const paths = {
  music: ['M9 18V5l12-2v13M9 8l12-2', 'M9 18a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3ZM21 16a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3Z'],
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  connection: ['M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4'],
  model: ['m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z'],
  tavern: ['M5 3h14l-2 9a5 5 0 0 1-10 0L5 3z', 'M12 17v4', 'M8 21h8'],
  groups: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  private: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  plugins: ['M9 3H4a1 1 0 0 0-1 1v5h2a2 2 0 1 1 0 4H3v7a1 1 0 0 0 1 1h5v-2a2 2 0 1 1 4 0v2h7a1 1 0 0 0 1-1v-5h-2a2 2 0 1 1 0-4h2V6a1 1 0 0 0-1-1h-7V3a2 2 0 1 0-4 0Z'],
  chats: ['M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z', 'M8 11h8m-8 4h5'],
  logs: ['M8 3H5a2 2 0 0 0-2 2v15a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V5a2 2 0 0 0-2-2h-3M9 2h6v4H9zM7 11h10M7 16h7'],
  security: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z', 'm8 12 3 3 5-6'],
  logout: ['M9 5H4v14h5m5-14 5 7-5 7m-6-7h11'],
  refresh: ['M20 7v5h-5M4 17v-5h5', 'M6 7a7 7 0 0 1 11.6-1.8L20 8M4 16l2.4 2.8A7 7 0 0 0 18 17'],
  check: ['m5 12 4 4L19 6'],
  checkin: ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M8 2v4m8-4v4M3 10h18', 'm8 15 2.5 2.5L16 12'],
  gameCalendar: ['M20 12v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8', 'M2 7h20v5H2zM12 22V7', 'M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7Z'],
  fun: ['M6 12h4m-2-2v4m7-1h.01M18 11h.01', 'M17 6H7a5 5 0 0 0-5 5v2a5 5 0 0 0 5 5h10a5 5 0 0 0 5-5v-2a5 5 0 0 0-5-5Z'],
  usage: ['M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  subscriptions: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z', 'M10 21h4'],
  scheduledChat: ['M12 3a9 9 0 1 0 9 9', 'M12 7v5l3 2', 'M16 3h6v6h-4l-2 2V3Z'],
  live: ['M3 12h4l3-8 4 16 3-8h4'],
  whitelist: ['M4 4h16v16H4z', 'm8 12 3 3 5-6'],
  alert: ['m12 3 10 18H2L12 3Z', 'M12 9v4m0 4h.01'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  pause: ['M8 5v14M16 5v14'],
  power: ['M12 2v10', 'M6.3 5.7a8 8 0 1 0 11.4 0'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  close: ['m6 6 12 12M6 18 18 6']
};
</script>

<template><svg class="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path v-for="(path, index) in paths[name] || paths.overview" :key="index" :d="path" /></svg></template>

<style scoped>.workspace-icon { display: inline-block; width: 20px; height: 20px; flex-shrink: 0; vertical-align: middle; }</style>
