const connectForm = document.querySelector('#connect-form');
const connection = document.querySelector('#connection');
const messageForm = document.querySelector('#message-form');
const messages = document.querySelector('#messages');
const status = document.querySelector('#status');
const messageInput = document.querySelector('#message');
const attachButton = document.querySelector('#attach-button');
const attachmentInput = document.querySelector('#attachment');
const sendButton = document.querySelector('#send-button');
const disconnectButton = document.querySelector('#disconnect-button');
const memberList = document.querySelector('#members');
const channelsNav = document.querySelector('#channels');
const joinToggle = document.querySelector('#join-toggle');
const joinForm = document.querySelector('#join-form');
const joinClose = document.querySelector('#join-close');
const hiddenChannels = document.querySelector('#hidden-channels');
const editTabs = document.querySelector('#edit-tabs');
const remember = document.querySelector('#remember');
const channels = new Map();
const members = new Map();
const encoder = new TextEncoder();
const SESSION_KEY = 'kuumirc-session';
const TAB_KEY = 'kuumirc-tabs:';
const wantedCaps = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
let caps = new Set();
let advertised = new Set();
let session;
let historyBatch = '';
let historyPending = false;
let historyMessages = [];
let historyResizeObserver;
let liveMessages = [];
const seen = new Set();
let socket;
let channel;
let nick;
let joined = false;
let requestedChannel = '';
let retryTimer;
let retryDelay = 1000;
let saslStarted = false;
let saslComplete = false;
let saslError = false;
let signedOut = false;
let authFailed = false;
let tabOrder = [];
let hiddenTabs = new Set();
let editingTabs = false;

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function renderMembers() {
  memberList.replaceChildren(...[...members.values()].sort((a, b) => a.localeCompare(b)).map(name => {
    const item = document.createElement('li');
    item.textContent = name;
    return item;
  }));
}

function saveSession() {
  if (!session) return;
  try {
    if (remember.checked) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

function saveTabPrefs() {
  if (!session) return;
  try {
    localStorage.setItem(TAB_KEY + session.username.toLowerCase(), JSON.stringify({ order: tabOrder, hidden: [...hiddenTabs] }));
  } catch {}
}

function loadTabPrefs(username) {
  try {
    const prefs = JSON.parse(localStorage.getItem(TAB_KEY + username.toLowerCase())) || {};
    tabOrder = Array.isArray(prefs.order) ? prefs.order.filter(x => typeof x === 'string') : [];
    hiddenTabs = new Set(Array.isArray(prefs.hidden) ? prefs.hidden.filter(x => typeof x === 'string') : []);
  } catch {
    tabOrder = [];
    hiddenTabs = new Set();
  }
}

function visibleChannelKeys() {
  return [...channels.keys()].filter(key => !hiddenTabs.has(key)).sort((a, b) => tabOrder.indexOf(a) - tabOrder.indexOf(b));
}

function renderHiddenChannels() {
  hiddenChannels.replaceChildren(...[...channels].filter(([key]) => hiddenTabs.has(key)).map(([key, name]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Show ${name}`;
    button.addEventListener('click', () => {
      hiddenTabs.delete(key);
      saveTabPrefs();
      renderChannels();
      setJoinOpen(false);
      selectChannel(name);
    });
    return button;
  }));
}

function moveTab(key, step) {
  const visible = visibleChannelKeys();
  const index = visible.indexOf(key);
  const target = visible[index + step];
  if (!target) return;
  const from = tabOrder.indexOf(key);
  const to = tabOrder.indexOf(target);
  [tabOrder[from], tabOrder[to]] = [target, key];
  saveTabPrefs();
  renderChannels();
}

function hideTab(key) {
  if (visibleChannelKeys().length < 2) return;
  hiddenTabs.add(key);
  saveTabPrefs();
  renderChannels();
  if (channel?.toLowerCase() === key) selectChannel(channels.get(visibleChannelKeys()[0]));
}

function renderChannels() {
  const visible = visibleChannelKeys();
  channelsNav.replaceChildren(...visible.map((key, index) => {
    const name = channels.get(key);
    const tab = document.createElement('span');
    tab.className = 'channel-tab';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.classList.toggle('active', key === channel?.toLowerCase());
    button.addEventListener('click', () => selectChannel(name));
    tab.append(button);
    if (editingTabs) {
      for (const [step, label, arrow] of [[-1, 'left', '‹'], [1, 'right', '›']]) {
        const move = document.createElement('button');
        move.type = 'button';
        move.textContent = arrow;
        move.title = `Move ${name} ${label}`;
        move.setAttribute('aria-label', move.title);
        move.disabled = !visible[index + step];
        move.addEventListener('click', () => moveTab(key, step));
        tab.append(move);
      }
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.textContent = '×';
      hide.title = `Hide ${name} tab (stay joined)`;
      hide.setAttribute('aria-label', hide.title);
      hide.disabled = visible.length < 2;
      hide.addEventListener('click', () => hideTab(key));
      tab.append(hide);
    }
    return tab;
  }));
  renderHiddenChannels();
}

function setJoinOpen(open) {
  joinForm.hidden = !open;
  joinToggle.setAttribute('aria-expanded', String(open));
  if (open) document.querySelector('#join-channel').focus();
}

function selectChannel(name) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  channel = name;
  session.channel = name;
  saveSession();
  messageInput.placeholder = `Message ${name}`;
  messageInput.disabled = true;
  sendButton.disabled = true;
  attachButton.disabled = true;
  joined = false;
  requestedChannel = '';
  historyBatch = '';
  historyPending = false;
  historyMessages = [];
  liveMessages = [];
  seen.clear();
  members.clear();
  renderMembers();
  if (window.MathJax?.typesetClear) window.MathJax.typesetClear([messages]);
  historyResizeObserver?.disconnect();
  historyResizeObserver = undefined;
  messages.replaceChildren();
  renderChannels();
  setStatus(`Joining ${name}…`);
  socket.send(`${channels.has(name.toLowerCase()) ? 'NAMES' : 'JOIN'} ${name}`);
}

function memberKey(name) {
  return name.replace(/^[~&@%+]+/, '').toLowerCase();
}

function addLine(name, text, event = false, time = '', id = '') {
  historyResizeObserver?.disconnect();
  historyResizeObserver = undefined;
  const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  const item = document.createElement('li');
  item.className = event ? 'event' : 'line';
  if (!event) {
    const clock = document.createElement('time');
    const date = time ? new Date(time) : new Date();
    clock.textContent = (Number.isNaN(date.getTime()) ? new Date() : date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const author = document.createElement('strong');
    author.textContent = name;
    item.append(clock, author);
  }
  const body = document.createElement('span');
  if (event || !window.renderMessageContent) body.textContent = text;
  else window.renderMessageContent(body, text);
  item.append(body);
  if (id) item.dataset.msgid = id;
  messages.append(item);
  if (messages.childElementCount > 300) {
    seen.delete(messages.firstElementChild.dataset.msgid);
    messages.firstElementChild.remove();
  }
  if (bottom) messages.scrollTop = messages.scrollHeight;
}

function parse(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    for (const tag of rest.slice(1, end).split(';')) {
      const equal = tag.indexOf('=');
      tags[tag.slice(0, equal < 0 ? undefined : equal)] = equal < 0 ? '' : tag.slice(equal + 1);
    }
    rest = rest.slice(end + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const trailing = rest.indexOf(' :');
  const parts = (trailing < 0 ? rest : rest.slice(0, trailing)).split(' ');
  if (trailing >= 0) parts.push(rest.slice(trailing + 2));
  return { command: parts.shift(), params: parts, nick: prefix.split('!')[0], tags };
}

function displayChat(message) {
  const id = message.tags.msgid;
  if (id && seen.has(id)) return;
  if (id) seen.add(id);
  const action = /^\x01ACTION (.*)\x01$/.exec(message.text);
  if (action) addLine('', `* ${message.nick} ${action[1]}`, true, message.tags.time, id);
  else addLine(message.nick, message.text, false, message.tags.time, id);
}

function completeHistory() {
  if (!historyPending) return;
  historyPending = false;
  for (const message of historyMessages) displayChat(message);
  for (const message of liveMessages) displayChat(message);
  historyMessages = [];
  liveMessages = [];
  historyBatch = '';
  messages.scrollTop = messages.scrollHeight;
  if (messages.lastElementChild) {
    let previousBottom = messages.scrollHeight - messages.clientHeight;
    historyResizeObserver = new ResizeObserver(() => {
      if (messages.scrollTop >= previousBottom - 48) messages.scrollTop = messages.scrollHeight;
      previousBottom = messages.scrollHeight - messages.clientHeight;
    });
    historyResizeObserver.observe(messages.lastElementChild);
  }
  setStatus('Connected');
}

function sendSaslPayload(ws) {
  const bytes = encoder.encode(`\0${session.username}\0${session.password}`);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const payload = btoa(binary);
  for (let offset = 0; offset < payload.length; offset += 400) ws.send(`AUTHENTICATE ${payload.slice(offset, offset + 400)}`);
  if (payload.length % 400 === 0) ws.send('AUTHENTICATE +');
}
function handle(line, ws) {
  const { command, params, nick: sender, tags } = parse(line);
  const target = params[0]?.toLowerCase();
  if (command === 'CAP') {
    if (params[1] === 'LS') {
      for (const cap of (params.at(-1) || '').split(' ')) advertised.add(cap.split('=')[0]);
      if (params[2] !== '*') {
        if (!advertised.has('sasl')) {
          saslError = true;
          authFailed = true;
          clearSession();
          setStatus('Server does not support SASL authentication.', true);
          ws.close();
          return;
        }
        const request = [...new Set([...wantedCaps.filter(cap => advertised.has(cap)), 'sasl'])];
        ws.send(`CAP REQ :${request.join(' ')}`);
      }
    } else if (params[1] === 'ACK') {
      const accepted = (params.at(-1) || '').split(' ');
      caps = new Set(accepted);
      if (accepted.some(cap => cap.replace(/^-/, '').split('=')[0] === 'sasl')) {
        saslStarted = true;
        ws.send('AUTHENTICATE PLAIN');
      } else {
        saslError = authFailed = true;
        clearSession();
        setStatus('Server declined SASL authentication.', true);
        ws.close();
      }
    } else if (params[1] === 'NAK') {
      saslError = authFailed = true;
      clearSession();
      setStatus('Server declined SASL authentication.', true);
      ws.close();
    }
  } else if (command === 'AUTHENTICATE' && saslStarted && !saslComplete && params[0] === '+') {
    sendSaslPayload(ws);
    saslComplete = true;
  } else if (command === '903' && saslStarted) {
    ws.send('CAP END');
  } else if (['904', '905', '906', '907'].includes(command)) {
    saslError = authFailed = true;
    clearSession();
    setStatus('SASL authentication failed. Check username and password.', true);
    ws.close();
  } else if (command === 'PING') {
    ws.send(`PONG :${params.at(-1)}`);
  } else if (command === '001') {
    saveSession();
    retryDelay = 1000;
    joinToggle.hidden = false;
    editTabs.hidden = false;
    selectChannel(channel);
  } else if (command === '353' && params[2]?.toLowerCase() === channel.toLowerCase()) {
    for (const name of (params[3] || '').split(' ')) if (name) members.set(memberKey(name), name);
  } else if (command === '366' && params[1]?.toLowerCase() === channel.toLowerCase() && requestedChannel !== channel.toLowerCase()) {
    requestedChannel = channel.toLowerCase();
    renderMembers();
    joined = true;
    messageInput.disabled = false;
    attachButton.disabled = false;
    sendButton.disabled = false;
    if (caps.has('draft/chathistory')) {
      // ponytail: show the latest 200 messages; add pagination if longer histories are needed.
      messages.replaceChildren();
      historyPending = true;
      setStatus('Loading history…');
      ws.send(`CHATHISTORY LATEST ${channel} * 200`);
    } else {
      setStatus('Connected');
    }
  } else if (command === 'BATCH' && params[0]?.startsWith('+') && params[1] === 'chathistory' && params[2]?.toLowerCase() === channel.toLowerCase()) {
    historyBatch = params[0].slice(1);
  } else if (command === 'BATCH' && params[0] === `-${historyBatch}` && historyPending) {
    completeHistory();
  } else if (command === 'FAIL' && params[0] === 'CHATHISTORY' && historyPending) {
    completeHistory();
    setStatus(params.at(-1) || 'History unavailable', true);
  } else if ((command === 'PRIVMSG' || command === 'NOTICE') && target === channel.toLowerCase()) {
    const message = { nick: sender, text: params[1] || '', tags };
    if (historyPending) (tags.batch === historyBatch && historyBatch ? historyMessages : liveMessages).push(message);
    else displayChat(message);
  } else if (command === 'JOIN' && target?.startsWith('#')) {
    if (sender.toLowerCase() === nick.toLowerCase()) {
      channels.set(target, params[0]);
      if (!tabOrder.includes(target)) tabOrder.push(target);
      saveTabPrefs();
      renderChannels();
    }
    if (target === channel.toLowerCase()) {
      members.set(memberKey(sender), sender);
      renderMembers();
      addLine('', `${sender} joined ${channel}`, true);
    }
  } else if (command === 'PART' && target?.startsWith('#')) {
    if (sender.toLowerCase() === nick.toLowerCase()) {
      channels.delete(target);
      tabOrder = tabOrder.filter(name => name !== target);
      hiddenTabs.delete(target);
      if (channels.size && !visibleChannelKeys().length) hiddenTabs.delete(channels.keys().next().value);
      saveTabPrefs();
      renderChannels();
      if (target === channel.toLowerCase()) {
        if (channels.size) selectChannel(channels.get(visibleChannelKeys()[0]));
        else {
          joined = false;
          messageInput.disabled = sendButton.disabled = true;
          members.clear();
          renderMembers();
          historyResizeObserver?.disconnect();
          historyResizeObserver = undefined;
          messages.replaceChildren();
          setStatus('No channel joined');
        }
      }
    } else if (target === channel.toLowerCase()) {
      members.delete(memberKey(sender));
      renderMembers();
      addLine('', `${sender} left ${channel}`, true);
    }
  } else if (command === 'QUIT') {
    members.delete(memberKey(sender));
    renderMembers();
  } else if (command === 'NICK') {
    const old = members.get(memberKey(sender));
    if (old) {
      members.delete(memberKey(sender));
      members.set(memberKey(params[0]), params[0]);
      renderMembers();
    }
    if (sender.toLowerCase() === nick.toLowerCase()) nick = params[0];
  } else if (command === 'ERROR' || ['464', '433', '471', '473', '474', '475', '476', '403', '404'].includes(command)) {
    const reason = params.at(-1) || 'Connection failed';
    addLine('', reason, true);
    setStatus(reason, true);
    if (command === '464' || /invalid credentials|authentication failed|incorrect password/i.test(reason)) {
      authFailed = true;
      clearSession();
    }
    if (command === 'ERROR' || command === '464') ws.close();
  }
}

function usernameError(username) {
  if (!username) return 'Username is required.';
  if (encoder.encode(username).length > 255) return 'Username must be no more than 255 UTF-8 bytes.';
  if (/[\x00-\x1f\x7f-\x9f/@:]/u.test(username)) return 'Username cannot contain control characters or /, @, or :.';
  return '';
}

function loginError(username, password, requested) {
  return usernameError(username)
    || (!/^#[^\s,\x00-\x1f]{1,63}$/.test(requested) ? 'Enter a valid #channel.' : '')
    || (!password || /[\x00-\x1f\x7f]/.test(password) ? 'Password is required and cannot contain control characters.' : '');
}

function loginNick(username) {
  if (/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(username)) return username;
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(username)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `u${hash.toString(16).padStart(16, '0')}`;
}

function connect(username, password, requested, retry = false) {
  username = username.trim();
  const error = loginError(username, password, requested);
  if (error) {
    setStatus(error, true);
    return;
  }
  if (socket) return;
  if (!retry) {
    clearTimeout(retryTimer);
    retryDelay = 1000;
    signedOut = false;
    authFailed = false;
  }
  session = { username, password, channel: requested };
  nick = loginNick(username);
  loadTabPrefs(username);
  editingTabs = false;
  editTabs.textContent = 'Edit tabs';
  channel = requested;
  messageInput.placeholder = `Message ${channel}`;
  joined = false;
  caps = new Set();
  saslStarted = false;
  saslComplete = false;
  saslError = false;
  advertised = new Set();
  historyBatch = '';
  historyPending = false;
  historyMessages = [];
  liveMessages = [];
  seen.clear();
  channels.clear();
  renderChannels();
  joinToggle.hidden = editTabs.hidden = true;
  setJoinOpen(false);
  members.clear();
  renderMembers();
  setStatus('Connecting…');
  document.querySelector('#connect-button').disabled = true;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}/socket`, 'text.ircv3.net');
  socket = ws;
  ws.addEventListener('open', () => {
    document.querySelector('#password').value = '';
    ws.send('CAP LS 302');
    ws.send(`NICK ${nick}`);
    ws.send('USER kuumirc/local@kuumirc 0 * :KuumIRC');
    historyResizeObserver?.disconnect();
    historyResizeObserver = undefined;
    messages.replaceChildren();
    connection.open = false;
    connection.hidden = true;
    disconnectButton.hidden = false;
    setStatus('Signing in…');
  });
  ws.addEventListener('message', event => {
    if (socket === ws && typeof event.data === 'string') handle(event.data, ws);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = undefined;
    joined = false;
    historyPending = false;
    members.clear();
    renderMembers();
    messageInput.disabled = true;
    sendButton.disabled = true;
    attachButton.disabled = true;
    document.querySelector('#connect-button').disabled = false;
    joinToggle.hidden = editTabs.hidden = true;
    if (signedOut || authFailed) {
      channels.clear();
      renderChannels();
      connection.hidden = false;
      connection.open = authFailed;
      disconnectButton.hidden = true;
      if (!authFailed) setStatus('Not connected');
    } else {
      setStatus('Reconnecting…');
      retryTimer = setTimeout(() => connect(session.username, session.password, session.channel, true), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
  });
  ws.addEventListener('error', () => setStatus('Connection lost.', true));
}

connectForm.addEventListener('submit', event => {
  event.preventDefault();
  connect(
    document.querySelector('#username').value.trim(),
    document.querySelector('#password').value,
    document.querySelector('#channel').value.trim()
  );
});

document.querySelector('#register-button').addEventListener('click', async () => {
  const username = document.querySelector('#username').value.trim();
  const password = document.querySelector('#password').value;
  const requested = document.querySelector('#channel').value.trim();
  const error = loginError(username, password, requested);
  if (error || password.length < 4 || password.length > 128) {
    setStatus(error || 'Password must be 4–128 characters.', true);
    return;
  }
  const registerButton = document.querySelector('#register-button');
  const connectButton = document.querySelector('#connect-button');
  registerButton.disabled = connectButton.disabled = true;
  setStatus('Registering…');
  try {
    const response = await fetch('./register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();
    if (!response.ok) {
      setStatus(result.error || 'Registration failed.', true);
    } else {
      connect(username, password, requested);
    }
  } catch {
    setStatus('Registration unavailable.', true);
  } finally {
    registerButton.disabled = false;
    if (!socket) connectButton.disabled = false;
  }
});

function sendMessage(target, text) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !text || /[\r\n\x00]/.test(text)) return false;
  const line = `PRIVMSG ${target} :${text}`;
  if (encoder.encode(line).length > 510) {
    setStatus('Message too long for IRC.', true);
    return false;
  }
  socket.send(line);
  if (!caps.has('echo-message') && target.toLowerCase() === channel?.toLowerCase()) {
    const action = /^\x01ACTION (.*)\x01$/.exec(text);
    if (action) addLine('', `* ${nick} ${action[1]}`, true);
    else addLine(nick, text);
  }
  return true;
}

function runCommand(input) {
  const match = /^\/([a-z]+)(?:\s+(.*))?$/i.exec(input);
  const command = match?.[1].toLowerCase();
  const arg = (match?.[2] || '').trim();
  if (command === 'join' && /^#[^\s,\x00-\x1f]{1,63}$/.test(arg)) {
    hiddenTabs.delete(arg.toLowerCase());
    saveTabPrefs();
    renderChannels();
    selectChannel(arg);
  } else if (command === 'part' && channels.has((arg || channel).toLowerCase())) {
    socket.send(`PART ${channels.get((arg || channel).toLowerCase())}`);
  } else if (command === 'nick' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(arg)) {
    socket.send(`NICK ${arg}`);
  } else if (command === 'me' && arg) {
    return sendMessage(channel, `\x01ACTION ${arg}\x01`);
  } else if (command === 'clear') {
    if (window.MathJax?.typesetClear) window.MathJax.typesetClear([messages]);
    historyResizeObserver?.disconnect();
    historyResizeObserver = undefined;
    messages.replaceChildren();
    seen.clear();
  } else if (command === 'help') {
    addLine('', '/join #channel · /part [#channel] · /nick name · /me action · /clear · /help', true);
  } else {
    setStatus('Invalid command. Type /help.', true);
    return false;
  }
  return true;
}


async function postUpload(file, credentials) {
  const response = await fetch('/media-upload', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': file.type
    },
    body: file,
    cache: 'no-store'
  });
  if (response.status !== 201) throw new Error(`Upload failed (HTTP ${response.status}).`);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Upload returned an invalid response.');
  }
  const mediaUrl = validateMediaUrl(result?.url);
  const posterUrl = result?.poster == null ? null : validateMediaUrl(result.poster);
  if (!mediaUrl || (result.poster != null && !posterUrl)) throw new Error('Upload returned an invalid link.');
  return { mediaUrl, posterUrl };
}

function validateMediaUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/media/') || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function uploadAttachment(file) {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/ogg']);
  const isVideo = file.type.startsWith('video/');
  const maxSize = isVideo ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
  if (!joined || !socket || !allowed.has(file.type) || file.size > maxSize || !file.size) {
    setStatus('Use JPEG, PNG, or static WebP images up to 10 MiB, or MP4/WebM/OGG videos up to 100 MiB.', true);
    return;
  }
  const target = channel;
  const credentials = btoa(String.fromCharCode(...encoder.encode(`${session.username}:${session.password}`)));
  attachButton.disabled = true;
  setStatus('Uploading media…');
  try {
    const { mediaUrl, posterUrl } = await postUpload(file, credentials);
    if (isVideo && !posterUrl) throw new Error('Upload returned an invalid video preview.');
    const link = isVideo ? `${mediaUrl}#poster=${encodeURIComponent(posterUrl)}` : mediaUrl;
    if (!channels.has(target.toLowerCase()) || !sendMessage(target, link)) throw new Error('Uploaded, but could not send the link.');
    setStatus('Connected');
  } catch (error) {
    setStatus(error.message || 'Upload failed.', true);
  } finally {
    attachButton.disabled = !joined;
    attachmentInput.value = '';
  }
}

messageForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!joined || !text) return;
  const sent = text.startsWith('/')
    ? (text.startsWith('//') ? sendMessage(channel, text.slice(1)) : runCommand(text))
    : sendMessage(channel, text);
  if (sent) messageInput.value = '';
});

attachButton.addEventListener('click', () => attachmentInput.click());
attachmentInput.addEventListener('change', () => {
  const file = attachmentInput.files?.[0];
  if (file) uploadAttachment(file);
});

editTabs.addEventListener('click', () => {
  editingTabs = !editingTabs;
  editTabs.textContent = editingTabs ? 'Done' : 'Edit tabs';
  editTabs.setAttribute('aria-pressed', String(editingTabs));
  renderChannels();
});

joinToggle.addEventListener('click', () => setJoinOpen(joinForm.hidden));
joinClose.addEventListener('click', () => {
  setJoinOpen(false);
  joinToggle.focus();
});
joinForm.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    setJoinOpen(false);
    joinToggle.focus();
  }
});
document.addEventListener('pointerdown', event => {
  if (!joinForm.hidden && !joinForm.contains(event.target) && event.target !== joinToggle) setJoinOpen(false);
});

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = document.querySelector('#join-channel').value.trim();
  if (!/^#[^\s,\x00-\x1f]{1,63}$/.test(name)) {
    setStatus('Enter a valid #channel.', true);
    return;
  }
  hiddenTabs.delete(name.toLowerCase());
  saveTabPrefs();
  renderChannels();
  setJoinOpen(false);
  document.querySelector('#join-channel').value = '';
  selectChannel(name);
});

disconnectButton.addEventListener('click', () => {
  signedOut = true;
  clearTimeout(retryTimer);
  clearSession();
  remember.checked = false;
  session = undefined;
  if (socket) socket.close();
  else {
    channels.clear();
    renderChannels();
    connection.hidden = false;
    disconnectButton.hidden = joinToggle.hidden = editTabs.hidden = true;
    setStatus('Not connected');
  }
});

try {
  const persistent = localStorage.getItem(SESSION_KEY);
  const saved = JSON.parse(persistent || sessionStorage.getItem(SESSION_KEY));
  remember.checked = !!persistent;
  if (saved?.username && saved?.password && saved?.channel) {
    document.querySelector('#username').value = saved.username;
    document.querySelector('#channel').value = saved.channel;
    connect(saved.username, saved.password, saved.channel);
  }
} catch {
  clearSession();
}
window.addEventListener('online', () => {
  if (!socket && session && !signedOut && !authFailed) {
    clearTimeout(retryTimer);
    connect(session.username, session.password, session.channel, true);
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
