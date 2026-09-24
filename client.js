const connectForm = document.querySelector('#connect-form');
const connection = document.querySelector('#connection');
const messageForm = document.querySelector('#message-form');
const messages = document.querySelector('#messages');
const status = document.querySelector('#status');
const messageInput = document.querySelector('#message');
const sendButton = document.querySelector('#send-button');
const disconnectButton = document.querySelector('#disconnect-button');
const memberList = document.querySelector('#members');
const channelsNav = document.querySelector('#channels');
const joinToggle = document.querySelector('#join-toggle');
const joinForm = document.querySelector('#join-form');
const remember = document.querySelector('#remember');
const channels = new Map();
const members = new Map();
const encoder = new TextEncoder();
const SESSION_KEY = 'kuumirc-session';
const REMEMBER_KEY = 'kuumirc-remember';
const wantedCaps = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
let caps = new Set();
let advertised = new Set();
let session;
let historyBatch = '';
let historyPending = false;
let historyMessages = [];
let liveMessages = [];
const seen = new Set();
let socket;
let channel;
let nick;
let joined = false;
let requestedChannel = '';
let retryTimer;
let retryDelay = 1000;
let signedOut = false;
let authFailed = false;

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
      sessionStorage.removeItem(REMEMBER_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      sessionStorage.setItem(REMEMBER_KEY, 'false');
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { sessionStorage.removeItem(REMEMBER_KEY); } catch {}
}

function renderChannels() {
  channelsNav.replaceChildren(...[...channels.values()].map(name => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.classList.toggle('active', name.toLowerCase() === channel?.toLowerCase());
    button.addEventListener('click', () => selectChannel(name));
    return button;
  }));
}

function selectChannel(name) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  channel = name;
  session.channel = name;
  saveSession();
  messageInput.placeholder = `Message ${name}`;
  messageInput.disabled = true;
  sendButton.disabled = true;
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
  messages.replaceChildren();
  renderChannels();
  setStatus(`Joining ${name}…`);
  socket.send(`${channels.has(name.toLowerCase()) ? 'NAMES' : 'JOIN'} ${name}`);
}

function memberKey(name) {
  return name.replace(/^[~&@%+]+/, '').toLowerCase();
}

function addLine(name, text, event = false, time = '', id = '') {
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
  addLine(message.nick, message.text, false, message.tags.time, id);
}

function completeHistory() {
  if (!historyPending) return;
  historyPending = false;
  for (const message of historyMessages) displayChat(message);
  for (const message of liveMessages) displayChat(message);
  historyMessages = [];
  liveMessages = [];
  historyBatch = '';
  setStatus('Connected');
}

function handle(line, ws) {
  const { command, params, nick: sender, tags } = parse(line);
  const target = params[0]?.toLowerCase();
  if (command === 'CAP') {
    if (params[1] === 'LS') {
      for (const cap of (params.at(-1) || '').split(' ')) advertised.add(cap.split('=')[0]);
      if (params[2] !== '*') {
        const request = wantedCaps.filter(cap => advertised.has(cap));
        ws.send(request.length ? `CAP REQ :${request.join(' ')}` : 'CAP END');
      }
    } else if (params[1] === 'ACK') {
      caps = new Set((params.at(-1) || '').split(' '));
      ws.send('CAP END');
    } else if (params[1] === 'NAK') {
      ws.send('CAP END');
    }
  } else if (command === 'PING') {
    ws.send(`PONG :${params.at(-1)}`);
  } else if (command === '001') {
    saveSession();
    retryDelay = 1000;
    joinToggle.hidden = false;
    selectChannel(channel);
  } else if (command === '353' && params[2]?.toLowerCase() === channel.toLowerCase()) {
    for (const name of (params[3] || '').split(' ')) if (name) members.set(memberKey(name), name);
  } else if (command === '366' && params[1]?.toLowerCase() === channel.toLowerCase() && requestedChannel !== channel.toLowerCase()) {
    requestedChannel = channel.toLowerCase();
    renderMembers();
    joined = true;
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.focus();
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
      renderChannels();
      if (target === channel.toLowerCase()) {
        if (channels.size) selectChannel(channels.values().next().value);
        else {
          joined = false;
          messageInput.disabled = sendButton.disabled = true;
          members.clear();
          renderMembers();
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

function validLogin(username, password, requested) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(username)
    && /^#[^\s,\x00-\x1f]{1,63}$/.test(requested)
    && !!password && !/[\x00-\x1f\x7f]/.test(password);
}

function connect(username, password, requested, retry = false) {
  if (!validLogin(username, password, requested)) {
    setStatus('Check username, password, and channel.', true);
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
  nick = username;
  channel = requested;
  messageInput.placeholder = `Message ${channel}`;
  joined = false;
  caps = new Set();
  advertised = new Set();
  historyBatch = '';
  historyPending = false;
  historyMessages = [];
  liveMessages = [];
  seen.clear();
  channels.clear();
  renderChannels();
  joinToggle.hidden = true;
  joinForm.hidden = true;
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
    ws.send(`PASS :${password}`);
    ws.send(`NICK ${nick}`);
    ws.send(`USER ${username}/local@kuumirc 0 * :KuumIRC`);
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
    document.querySelector('#connect-button').disabled = false;
    joinToggle.hidden = true;
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
  if (!validLogin(username, password, requested) || password.length < 12 || password.length > 128) {
    setStatus('Use a valid username, channel, and password of 12–128 characters.', true);
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

messageForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!joined || !text) return;
  if (encoder.encode(`PRIVMSG ${channel} :${text}`).length > 510) {
    setStatus('Message too long for IRC.', true);
    return;
  }
  socket.send(`PRIVMSG ${channel} :${text}`);
  if (!caps.has('echo-message')) addLine(nick, text);
  messageInput.value = '';
});

joinToggle.addEventListener('click', () => {
  joinForm.hidden = !joinForm.hidden;
  if (!joinForm.hidden) document.querySelector('#join-channel').focus();
});

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = document.querySelector('#join-channel').value.trim();
  if (!/^#[^\s,\x00-\x1f]{1,63}$/.test(name)) {
    setStatus('Enter a valid #channel.', true);
    return;
  }
  joinForm.hidden = true;
  document.querySelector('#join-channel').value = '';
  selectChannel(name);
});

disconnectButton.addEventListener('click', () => {
  signedOut = true;
  clearTimeout(retryTimer);
  clearSession();
  session = undefined;
  if (socket) socket.close();
  else {
    channels.clear();
    renderChannels();
    connection.hidden = false;
    disconnectButton.hidden = joinToggle.hidden = true;
    setStatus('Not connected');
  }
});

try {
  const persistent = localStorage.getItem(SESSION_KEY);
  const saved = JSON.parse(persistent || sessionStorage.getItem(SESSION_KEY));
  remember.checked = !!persistent || sessionStorage.getItem(REMEMBER_KEY) !== 'false';
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
