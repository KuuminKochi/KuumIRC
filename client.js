const connectForm = document.querySelector('#connect-form');
const connection = document.querySelector('#connection');
const messageForm = document.querySelector('#message-form');
const messages = document.querySelector('#messages');
const status = document.querySelector('#status');
const channelTitle = document.querySelector('#channel-title');
const messageInput = document.querySelector('#message');
const sendButton = document.querySelector('#send-button');
const disconnectButton = document.querySelector('#disconnect-button');
const memberList = document.querySelector('#members');
const members = new Map();
const encoder = new TextEncoder();
let socket;
let channel;
let nick;
let joined = false;

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

function memberKey(name) {
  return name.replace(/^[~&@%+]+/, '').toLowerCase();
}

function addLine(name, text, event = false) {
  const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  const item = document.createElement('li');
  item.className = event ? 'event' : 'line';
  if (!event) {
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const author = document.createElement('strong');
    author.textContent = name;
    item.append(time, author);
  }
  const body = document.createElement('span');
  body.textContent = text;
  item.append(body);
  messages.append(item);
  if (messages.childElementCount > 300) messages.firstElementChild.remove();
  if (bottom) messages.scrollTop = messages.scrollHeight;
}

function parse(line) {
  let rest = line;
  if (rest.startsWith('@')) rest = rest.slice(rest.indexOf(' ') + 1);
  let prefix = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const trailing = rest.indexOf(' :');
  const parts = (trailing < 0 ? rest : rest.slice(0, trailing)).split(' ');
  if (trailing >= 0) parts.push(rest.slice(trailing + 2));
  return { command: parts.shift(), params: parts, nick: prefix.split('!')[0] };
}

function handle(line, ws) {
  const { command, params, nick: sender } = parse(line);
  const target = params[0]?.toLowerCase();
  if (command === 'PING') {
    ws.send(`PONG :${params.at(-1)}`);
  } else if (command === '001') {
    setStatus('Joining channel…');
    ws.send(`JOIN ${channel}`);
  } else if (command === '353' && params[2]?.toLowerCase() === channel.toLowerCase()) {
    for (const name of (params[3] || '').split(' ')) if (name) members.set(memberKey(name), name);
  } else if (command === '366' && params[1]?.toLowerCase() === channel.toLowerCase()) {
    renderMembers();
    joined = true;
    messageInput.disabled = false;
    sendButton.disabled = false;
    setStatus('Connected');
    messageInput.focus();
  } else if (command === 'PRIVMSG' && target === channel.toLowerCase()) {
    addLine(sender, params[1] || '');
  } else if (command === 'JOIN' && target === channel.toLowerCase()) {
    members.set(memberKey(sender), sender);
    renderMembers();
    addLine('', `${sender} joined ${channel}`, true);
  } else if (command === 'PART' && target === channel.toLowerCase()) {
    members.delete(memberKey(sender));
    renderMembers();
    addLine('', `${sender} left ${channel}`, true);
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
    if (command === 'ERROR' || command === '464') ws.close();
  }
}

connectForm.addEventListener('submit', event => {
  event.preventDefault();
  const username = document.querySelector('#username').value.trim();
  const passwordInput = document.querySelector('#password');
  const password = passwordInput.value;
  const requested = document.querySelector('#channel').value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(username) || !/^#[^\s,\x00-\x1f]{1,63}$/.test(requested) || !password || /[\x00-\x1f\x7f]/.test(password)) {
    setStatus('Check username, password, and channel.', true);
    return;
  }
  nick = username;
  channel = requested;
  channelTitle.textContent = channel;
  messageInput.placeholder = `Message ${channel}`;
  joined = false;
  members.clear();
  renderMembers();
  setStatus('Connecting…');
  document.querySelector('#connect-button').disabled = true;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}/socket`, 'text.ircv3.net');
  socket = ws;
  ws.addEventListener('open', () => {
    passwordInput.value = '';
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
    members.clear();
    renderMembers();
    messageInput.disabled = true;
    sendButton.disabled = true;
    document.querySelector('#connect-button').disabled = false;
    connection.hidden = false;
    connection.open = status.classList.contains('error');
    disconnectButton.hidden = true;
    if (!status.classList.contains('error')) setStatus('Disconnected');
  });
  ws.addEventListener('error', () => setStatus('WebSocket failed. Check the server.', true));
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
  addLine(nick, text);
  messageInput.value = '';
});

disconnectButton.addEventListener('click', () => socket?.close());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
