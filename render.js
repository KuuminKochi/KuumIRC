(() => {
  const mathScript = new URL('./vendor/mathjax/tex-svg.js', document.baseURI).href;
  const mathRoot = new URL('./vendor/mathjax/', document.baseURI).href.replace(/\/$/, '');
  let mathReady;
  let typesetQueue = Promise.resolve();

  function loadMathJax() {
    if (mathReady) return mathReady;
    window.MathJax = {
      loader: { load: ['ui/safe'], paths: { mathjax: mathRoot } },
      startup: { typeset: false },
      tex: {
        packages: ['base'],
        inlineMath: [['$', '$'], ['\\(', '\\)']],
        displayMath: [['$$', '$$'], ['\\[', '\\]']],
        processEscapes: true
      },
      options: { safeOptions: { allow: { URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none' } } }
    };
    mathReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = mathScript;
      script.async = true;
      script.onload = () => window.MathJax.startup.promise.then(resolve, reject);
      script.onerror = () => reject(new Error('MathJax failed to load'));
      document.head.append(script);
    });
    return mathReady;
  }

  function appendText(parent, text) {
    const lines = text.split(/\r\n|\r|\n/);
    lines.forEach((line, index) => {
      if (index) parent.append(document.createElement('br'));
      if (line) parent.append(document.createTextNode(line));
    });
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function privateAddress(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m || m.slice(1).some(part => Number(part) > 255)) return false;
    const [a, b] = m.slice(1).map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }

  function mediaKind(url) {
    const path = url.pathname.toLowerCase();
    if (/\.(?:png|jpe?g|gif|webp|avif|bmp)$/.test(path)) return 'image';
    if (/\.(?:mp4|webm|ogv|mov|m4v)$/.test(path)) return 'video';
    if (/\.(?:mp3|ogg|oga|opus|wav|m4a|aac|flac)$/.test(path)) return 'audio';
    return '';
  }

  function appendLink(parent, rawUrl, url, previews) {
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    link.textContent = rawUrl;
    parent.append(link);
    const kind = mediaKind(url);
    if (!kind || privateAddress(url.hostname)) return;
    if (kind === 'image') {
      const image = document.createElement('img');
      image.src = url.href;
      image.alt = rawUrl;
      image.loading = 'lazy';
      image.style.maxWidth = '20rem';
      image.style.maxHeight = '12rem';
      image.style.objectFit = 'contain';
      image.referrerPolicy = 'no-referrer';
      const preview = link.cloneNode(false);
      preview.append(image);
      previews.push(preview);
    } else {
      const media = document.createElement(kind);
      media.src = url.href;
      media.controls = true;
      media.preload = 'none';
      media.referrerPolicy = 'no-referrer';
      media.style.maxWidth = '28rem';
      if (kind === 'video') media.playsInline = true;
      previews.push(media);
    }
  }

  window.renderMessageContent = function renderMessageContent(container, text) {
    if (!(container instanceof Element)) return;
    container.replaceChildren();
    const source = String(text ?? '');
    const previews = [];
    const tokenPattern = /\$\$[\s\S]+?\$\$|\$[^$\r\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|https:\/\/[^\s<>"']+/g;
    let cursor = 0;
    for (const match of source.matchAll(tokenPattern)) {
      const start = match.index;
      if (start > cursor) appendText(container, source.slice(cursor, start));
      const token = match[0];
      if (token.startsWith('https://')) {
        let rawUrl = token;
        while (/[.,!?;:)\]}]$/.test(rawUrl)) rawUrl = rawUrl.slice(0, -1);
        const url = safeUrl(rawUrl);
        if (url) appendLink(container, rawUrl, url, previews);
        else appendText(container, rawUrl);
        if (rawUrl.length < token.length) appendText(container, token.slice(rawUrl.length));
      } else {
        const math = document.createElement('span');
        math.textContent = token;
        container.append(math);
        typesetQueue = typesetQueue.then(loadMathJax).then(() => {
          if (math.isConnected) return window.MathJax.typesetPromise([math]);
        }).catch(() => {
          if (math.isConnected) math.textContent = token;
        });
      }
      cursor = start + token.length;
    }
    if (cursor < source.length) appendText(container, source.slice(cursor));
    if (previews.length) {
      const tray = document.createElement('div');
      tray.className = 'media-attachments';
      tray.append(...previews);
      container.append(tray);
    }
  };
})();
