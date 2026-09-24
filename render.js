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

  function typeset(element) {
    typesetQueue = typesetQueue.then(loadMathJax).then(() => {
      if (element.isConnected) return window.MathJax.typesetPromise([element]);
    }).catch(() => {});
  }

  function botLink(url) {
    if (url.origin !== location.origin || url.search || url.hash) return null;
    const match = /^\/bot-api\/(quiz|question)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
    return match ? { type: match[1], id: match[2] } : null;
  }

  function appendBotCard(card, { type, id }) {
    card.className = `chat-form-card ${type}-card`;
    card.dataset.formId = id;
    const prompt = document.createElement('span');
    prompt.className = 'chat-form-prompt';
    const feedback = document.createElement('p');
    feedback.className = 'chat-form-feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    card.append(prompt, feedback);
    const api = `/bot-api/v1/${type === 'quiz' ? 'quizzes' : 'questions'}/${id}`;
    fetch(api).then(async response => {
      if (!response.ok) throw new Error();
      const view = await response.json();
      if (typeof view?.question !== 'string' || !Array.isArray(view.options) || !view.options.length) throw new Error();
      prompt.textContent = view.question;
      typeset(prompt);
      const form = document.createElement('form');
      const group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = type === 'quiz' ? 'Choose an answer' : 'Choose an option';
      group.append(legend);
      const multiSelect = type === 'quiz' && view.multiSelect === true;
      const inputs = [];
      for (const [index, option] of view.options.entries()) {
        if (typeof option?.label !== 'string' || typeof option.value !== 'string') throw new Error();
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = multiSelect ? 'checkbox' : 'radio';
        input.name = `answer-${id}`;
        input.value = option.value;
        input.id = `answer-${id}-${index}`;
        if (!multiSelect) input.required = true;
        const text = document.createElement('span');
        text.textContent = option.label;
        label.append(input, text);
        group.append(label);
        inputs.push(input);
        typeset(text);
      }
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = type === 'quiz' ? 'Submit answer' : 'Choose';
      form.append(group, submit);
      card.insertBefore(form, feedback);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const selected = inputs.filter(input => input.checked).map(input => input.value);
        if (!selected.length) return;
        submit.disabled = true;
        feedback.textContent = 'Submitting…';
        try {
          const body = type === 'quiz'
            ? { values: multiSelect ? selected : selected[0] }
            : { value: selected[0] };
          const response = await fetch(`${api}/answers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || !result) throw new Error();
          group.disabled = true;
          if (type === 'quiz') {
            feedback.textContent = `${result.correct ? 'Correct.' : 'Not quite.'}${typeof result.correctAnswer === 'string' ? ` Correct answer: ${result.correctAnswer}.` : ''}${typeof result.explanation === 'string' && result.explanation ? ` ${result.explanation}` : ''}`;
          } else {
            feedback.textContent = 'Your choice has been recorded.';
          }
          typeset(feedback);
        } catch {
          feedback.textContent = 'Could not submit answer. Try again.';
          submit.disabled = false;
        }
      });
    }).catch(() => {
      feedback.textContent = 'This quiz or question is unavailable.';
    });
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
  function localMediaUrl(value) {
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && url.pathname.startsWith('/media/')
        && !url.username && !url.password && !url.search && !url.hash ? url.href : '';
    } catch {
      return '';
    }
  }

  const legacyThumbnails = new Map();
  let legacyThumbnailObserver;

  function legacyThumbnail(source) {
    if (legacyThumbnails.has(source)) return legacyThumbnails.get(source);
    const result = new Promise(resolve => {
      const probe = document.createElement('video');
      let timer;
      let done = false;
      const finish = poster => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        probe.pause();
        probe.removeAttribute('src');
        probe.load();
        resolve(poster);
      };
      const capture = () => {
        try {
          const scale = Math.min(1, 512 / probe.videoWidth, 512 / probe.videoHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(probe.videoWidth * scale);
          canvas.height = Math.round(probe.videoHeight * scale);
          const context = canvas.getContext('2d');
          if (!context || !canvas.width || !canvas.height) return finish('');
          context.drawImage(probe, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.75));
        } catch {
          finish('');
        }
      };
      probe.muted = true;
      probe.playsInline = true;
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => {
        if (!(probe.duration > 0)) return finish('');
        try {
          probe.currentTime = Math.min(0.5, probe.duration / 2);
        } catch {
          finish('');
        }
      }, { once: true });
      probe.addEventListener('seeked', capture, { once: true });
      probe.addEventListener('error', () => finish(''), { once: true });
      timer = setTimeout(() => finish(''), 8000);
      probe.src = source;
    });
    legacyThumbnails.set(source, result);
    if (legacyThumbnails.size > 24) legacyThumbnails.delete(legacyThumbnails.keys().next().value);
    return result;
  }

  function observeLegacyVideo(video) {
    if (!('IntersectionObserver' in window)) return;
    legacyThumbnailObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.target.isConnected) {
          legacyThumbnailObserver.unobserve(entry.target);
          continue;
        }
        if (!entry.isIntersecting) continue;
        legacyThumbnailObserver.unobserve(entry.target);
        legacyThumbnail(entry.target.src).then(poster => {
          if (poster && entry.target.isConnected && !entry.target.poster) entry.target.poster = poster;
        });
      }
    }, { rootMargin: '100px' });
    legacyThumbnailObserver.observe(video);
  }
  function providerEmbed(url) {
    const host = url.hostname.toLowerCase();
    let id;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(host)) {
      id = host === 'youtu.be' ? url.pathname.slice(1) : (
        url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1]
      );
      if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return { label: 'YouTube video', src: `https://www.youtube-nocookie.com/embed/${id}`, poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, height: 225 };
    }
    if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
      id = /^\/(?:video\/)?(\d{6,12})\/?$/.exec(url.pathname)?.[1];
      if (id) return { label: 'Vimeo video', src: `https://player.vimeo.com/video/${id}`, height: 225 };
    }
    if (host === 'open.spotify.com') {
      const match = /^\/(track|album|playlist|episode)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
      if (match) return { label: 'Spotify audio', src: `https://open.spotify.com/embed/${match[1]}/${match[2]}`, height: 152 };
    }
    if (host === 'giphy.com' || host === 'www.giphy.com') {
      id = /^\/(?:embed\/([A-Za-z0-9]+)|gifs\/[^/]*-([A-Za-z0-9]+))\/?$/.exec(url.pathname);
      if (id) return { label: 'Giphy image', src: `https://giphy.com/embed/${id[1] || id[2]}`, height: 225 };
    }
    return null;
  }

  function appendLink(parent, rawUrl, url, previews) {
    if (url.origin === location.origin && url.pathname === '/draw/' && !url.hash && url.searchParams.size === 1) {
      const id = url.searchParams.get('id');
      if (/^[0-9a-f]{32}$/.test(id || '')) {
        const card = document.createElement('a');
        card.className = 'drawing-preview';
        card.href = url.href;
        card.dataset.drawingId = id;
        card.setAttribute('aria-label', 'Edit drawing');
        const image = document.createElement('img');
        image.src = `/drawings/${id}/preview`;
        image.alt = '';
        image.loading = 'lazy';
        const empty = document.createElement('span');
        empty.className = 'drawing-empty';
        empty.textContent = 'Drawing preview unavailable';
        empty.hidden = true;
        image.addEventListener('error', () => { image.hidden = true; empty.hidden = false; });
        image.addEventListener('load', () => { image.hidden = false; empty.hidden = true; });
        const label = document.createElement('span');
        label.className = 'drawing-label';
        label.textContent = 'Drawing · Tap to edit';
        card.append(image, empty, label);
        card.addEventListener('click', event => {
          if (window.openDrawing) {
            event.preventDefault();
            window.openDrawing(id);
          }
        });
        previews.push(card);
        return;
      }
    }
    const localVideo = url.pathname.startsWith('/media/videos/') && mediaKind(url) === 'video';
    const posterUrl = localVideo && url.hash.startsWith('#poster=')
      ? localMediaUrl(new URLSearchParams(url.hash.slice(1)).get('poster') || '')
      : '';
    if (localVideo) {
      rawUrl = rawUrl.split('#', 1)[0];
      url.hash = '';
    }
    const kind = mediaKind(url);
    const localUpload = url.origin === location.origin
      && (url.pathname.startsWith('/uploads/')
        || (url.pathname.startsWith('/media/') && !url.search && !url.hash));
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    link.textContent = localUpload && kind ? 'Open original' : rawUrl;
    if (!localUpload || !kind) parent.append(link);
    const embed = providerEmbed(url);
    if (embed) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `embed-preview${embed.height === 152 ? ' audio' : ''}`;
      button.setAttribute('aria-label', `Play ${embed.label}`);
      if (embed.poster) {
        const poster = document.createElement('img');
        poster.src = embed.poster;
        poster.alt = '';
        poster.loading = 'lazy';
        poster.referrerPolicy = 'no-referrer';
        button.append(poster);
      }
      const play = document.createElement('span');
      play.className = 'embed-play';
      play.setAttribute('aria-hidden', 'true');
      const caption = document.createElement('span');
      caption.className = 'embed-caption';
      caption.textContent = embed.label;
      button.append(play, caption);
      button.addEventListener('click', () => {
        const frame = document.createElement('iframe');
        frame.src = embed.src;
        frame.title = embed.label;
        frame.className = 'embed-frame';
        frame.style.height = `${embed.height}px`;
        frame.loading = 'lazy';
        frame.referrerPolicy = embed.label === 'YouTube video' ? 'origin' : 'no-referrer';
        frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-presentation');
        frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
        frame.allowFullscreen = true;
        button.replaceWith(frame);
      });
      previews.push(button);
      return;
    }
    if (!kind || (!localUpload && privateAddress(url.hostname))) return;
    if (kind === 'image') {
      const image = document.createElement('img');
      image.alt = localUpload ? 'Uploaded image preview' : rawUrl;
      image.loading = 'lazy';
      image.style.maxWidth = '20rem';
      image.style.maxHeight = '12rem';
      image.style.objectFit = 'contain';
      image.referrerPolicy = 'no-referrer';
      const preview = link.cloneNode(false);
      preview.append(image);
      if (localUpload) image.addEventListener('error', () => {
        preview.remove();
        if (!link.isConnected) parent.append(link);
      }, { once: true });
      image.src = url.href;
      previews.push(preview);
    } else {
      const media = document.createElement(kind);
      media.src = url.href;
      if (kind === 'video') {
        if (posterUrl) media.poster = posterUrl;
        else if (localUpload && url.pathname.startsWith('/uploads/') && !url.hash) observeLegacyVideo(media);
        media.playsInline = true;
      }
      media.controls = true;
      media.preload = 'none';
      media.referrerPolicy = 'no-referrer';
      media.style.maxWidth = '28rem';
      previews.push(media);
      if (localUpload) {
        link.className = 'open-original';
        previews.push(link);
      }
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
