(() => {
  const codeEl = document.getElementById('server-url-code');
  const copyBtn = document.getElementById('copy-server-url');
  const statusEl = document.getElementById('copy-status');
  if (!codeEl || !copyBtn) return;

  const detected = (codeEl.dataset.configured || '').trim() || window.location.origin;
  codeEl.textContent = detected;

  copyBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(detected);
      } else {
        const area = document.createElement('textarea');
        area.value = detected;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      if (statusEl) statusEl.textContent = `已复制：${detected}`;
    } catch {
      if (statusEl) statusEl.textContent = '未能自动复制，请长按上方地址手动拷贝。';
    }
  });
})();
